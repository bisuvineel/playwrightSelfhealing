/**
 * Orchestrates a single healing attempt.
 *
 * The engine is the only component that knows the whole story: it gathers page
 * context, asks the provider for a replacement selector, verifies that the
 * suggestion actually resolves on the live page, records the outcome, and hands a
 * usable selector back to the caller.
 *
 * Its central contract is that {@link HealingEngine.attemptHeal} **never throws**.
 * Healing is a recovery path — if it fails, the caller must be free to surface the
 * original Playwright error, which is far more useful to the test author than a
 * secondary failure from inside the healer.
 *
 * @module core/HealingEngine
 */

import type { Page } from '@playwright/test';

import type {
  ConfirmQuestion,
  ElementCandidate,
  HealConfig,
  HealRecord,
  HealingAlternative,
  HealingRequest,
  HealingResponse,
  IntentSummary,
} from '../types';
import { getAriaSnapshot, truncateSnapshot } from '../utils/DOMSnapshot';
import { CandidateFinder } from './CandidateFinder';
import { createLogger, type Logger } from '../utils/logger';
import { HealingRecorder } from '../utils/HealingRecorder';
import { PromptBuilder } from '../utils/PromptBuilder';
import type { AiProvider } from './AiProvider';
import { HealBudget } from './HealBudget';
import { IntentVerifier, type IntentVerdict } from './IntentVerifier';
import { PrivacyBlockedError, PrivacyGuard } from './PrivacyGuard';
import { SelectorCache } from './SelectorCache';
import { SharedSelectorStore } from './SharedSelectorStore';
import { SelectorValidator, type ValidationResult } from './SelectorValidator';
import { findTestIdCandidates } from './TestIdCandidates';
import { ProviderConfigurationError } from '../providers/httpJson';

/**
 * Everything that happened during one call to {@link HealingEngine.attemptHeal}.
 *
 * `attemptHeal` returns only a selector, which is all a caller needs to retry the
 * action — but a reporter needs the whole story: what was tried, what the AI said,
 * why a suggestion was rejected, and what it cost. That is what this carries.
 */
export interface HealOutcome {
  /** The selector that failed. */
  originalSelector: string;
  /** The action being attempted when it failed. */
  action: string;
  /** Author-supplied description of the element, if any. */
  description?: string;
  /** Page URL at the time of the failure. */
  pageUrl: string;
  /** Test file and line that triggered the heal. */
  file: string;
  line: number;
  /**
   * Where the selector is actually written — normally the page object — when that is a
   * different file from {@link file}. This is the location to edit; `file` is the test
   * that exercised it.
   */
  source?: { file: string; line: number };
  /** The selector that worked, or `null` if healing did not succeed. */
  healed: string | null;
  /** One record per attempt, successful or not, in order. */
  attempts: HealRecord[];
  /** Combined token spend across every attempt. */
  tokens: { input: number; output: number; cached?: number };
  /** Why healing failed overall. Absent on success. */
  error?: string;
  /**
   * Set when the privacy policy stopped this heal before anything was transmitted —
   * a blocked route, a vetoing redactor, or preview mode. Reported as
   * `heal-blocked` rather than `heal-failed`, because "we refused to send the page"
   * and "the model could not find the element" call for different responses.
   */
  blocked?: true;
  /**
   * Set when the spend ceiling or the circuit breaker declined to pay for this heal.
   * Reported as `heal-skipped`: nothing was wrong with the page or the model, and no
   * provider call was made.
   */
  skipped?: true;
  /**
   * Set when the original selector still resolved to exactly one visible element, so no
   * heal was attempted: the selector was fine and the action failed for another reason.
   *
   * Reported as its own outcome because it is a different finding from a failed heal. A
   * failed heal says "this selector is stale and nothing replaced it"; this says "this
   * selector is *not* stale — look at timing, an overlay, or a disabled control". Sending
   * someone to rewrite a working selector is the wrong fix for a flaky page.
   */
  notStale?: true;
}

/** Per-call options for {@link HealingEngine.attemptHealDetailed}. */
export interface HealAttemptOptions {
  /**
   * Epoch milliseconds by which the heal must be over — normally the test's own timeout,
   * less a margin for the retried action. Every wait inside the heal is capped to it.
   *
   * Without it a heal spends `HEALER_TIMEOUT` per attempt whatever the test has left, so
   * a test near its timeout is killed mid-heal and reports `Test timeout exceeded` instead
   * of the Playwright error that names the stale selector. Omitted, nothing is capped.
   */
  deadline?: number;
}

/** Collaborators the engine builds itself unless they are supplied. */
export interface HealingEngineOptions {
  /** Validator used to check suggestions. Injectable for tests. */
  validator?: SelectorValidator;
  /** Recorder used to persist attempts. Injectable for tests. */
  recorder?: HealingRecorder;
  /**
   * Guard deciding what may be transmitted. Defaults to one built from
   * `config.privacy`, or to `{ redact: 'identifiers' }` when the config omits it.
   *
   * Supplying one here is the only way a caller-built engine can change the policy,
   * because `setHealingEngine()` bypasses configuration entirely.
   */
  guard?: PrivacyGuard;
  /**
   * Verifier deciding whether a healed element is the one the test meant. Defaults to
   * one built from `config.intent`, or to `enforce` when the config omits it.
   */
  verifier?: IntentVerifier;
  /**
   * Memory of selectors that already healed in this worker. Defaults to one enabled
   * unless `config.cache` is explicitly false. Injectable so a test can inspect it.
   */
  cache?: SelectorCache;
  /**
   * Spend ceiling and provider circuit breaker. Defaults to one built from
   * `config.budget`, or to unlimited when the config omits it.
   */
  budget?: HealBudget;
  /**
   * Called once per {@link HealingEngine.attemptHeal} call, after the outcome is
   * known — including when healing failed or was skipped. Used by `TestWrapper` to
   * publish details into the Playwright report. Errors thrown here are swallowed: a
   * reporting problem must not break a heal.
   */
  onOutcome?: (outcome: HealOutcome) => void;
}

/** Frames from these paths are framework internals, never the caller's test. */
const INTERNAL_FRAME_PATTERN =
  /[\\/](?:node_modules|dist[\\/](?:core|providers|utils)|src[\\/](?:core|providers|utils))[\\/]|^node:/;

/** Playwright spec-file naming, used to prefer a real test frame when present. */
const TEST_FILE_PATTERN = /\.(?:spec|test)\.[cm]?[jt]sx?$/;

/**
 * Budget for confirming a configured snapshot root exists.
 *
 * One second, for the same reason `SelectorValidator` uses one: the page is already
 * rendered by the time an action has failed on it, so a container that is present
 * resolves immediately. Spending the provider timeout here would mean a root that is
 * absent on a given page stalls every heal on that page for 30 seconds.
 */
const SNAPSHOT_ROOT_TIMEOUT_MS = 1_000;

/**
 * Timeout for probing a cached selector against the DOM.
 *
 * Shorter than the validator's own 1s default, and deliberately so: a cache probe is
 * speculative, and up to three of them run before the provider is contacted. The page
 * has already had an action time out against it, so anything present is present — a
 * cached selector that does not resolve in 250ms is not going to. Keeping this tight is
 * what makes a cache *miss* cheap enough that the cache is worth having at all.
 */
const CACHE_PROBE_TIMEOUT_MS = 250;

/**
 * Longest a worker waits for another worker's answer to the same selector.
 *
 * A heal takes a few seconds, and that is the whole wait in the common case — time this
 * worker would otherwise spend making the identical call itself. The bound only matters
 * when the other worker is stuck, and caps what that can cost.
 */
const PEER_WAIT_MAX_MS = 20_000;

/**
 * Second opinions asked per heal, across all attempts and options. Each is a small call;
 * the bound keeps a model that proposes lookalike after lookalike from multiplying them.
 */
const MAX_CONFIRMS_PER_HEAL = 3;

/** Deadline for one second-opinion call. It is a short question with a one-line answer. */
const CONFIRM_TIMEOUT_MS = 15_000;

/**
 * Adds two token counts, keeping `cached` only when either side reports it.
 *
 * @param a - First count.
 * @param b - Second count.
 * @returns Their sum.
 */
function addTokens(
  a: HealingResponse['tokenUsage'],
  b: HealingResponse['tokenUsage']
): HealingResponse['tokenUsage'] {
  const cached = (a.cached ?? 0) + (b.cached ?? 0);
  return { input: a.input + b.input, output: a.output + b.output, ...(cached > 0 ? { cached } : {}) };
}

/** Most neighbours named in a second-opinion question. */
const MAX_SIBLINGS = 8;

/**
 * The other named candidates in the same group as the chosen one: same ancestry, so the
 * same menu, form, toolbar or dialog. Empty when it stands alone; absent when the heal was
 * not a candidate, so nothing is claimed about neighbours never enumerated.
 *
 * @param candidates - The list that was offered.
 * @param selector - The chosen heal.
 * @returns `{ siblings }` to spread into the confirmation context, or nothing.
 */
function siblingsOf(
  candidates: ElementCandidate[],
  selector: string
): { siblings?: { role: string; name: string }[] } {
  const chosen = candidates.find((c) => c.selector === selector);
  if (!chosen) return {};

  const group = chosen.context.join('\u0000');
  return {
    siblings: candidates
      .filter((c) => c.id !== chosen.id && c.name !== '' && c.context.join('\u0000') === group)
      .slice(0, MAX_SIBLINGS)
      .map((c) => ({ role: c.role, name: c.name })),
  };
}

/**
 * Every quoted literal in a selector: text predicates, role names, labels.
 *
 * @param selector - A selector expression.
 * @returns The literals, as written.
 */
function selectorLiterals(selector: string): string[] {
  return [...(selector ?? '').matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((match) => match[2] ?? '');
}

/**
 * Most options tried from one answer: the model's first choice plus its runners-up.
 *
 * `AiProvider.parseResponse` already bounds the alternatives it will read, but `heal()`
 * is the extension seam for a provider this package does not ship — one of those builds
 * a {@link HealingResponse} directly and never passes through that parser. Since an
 * unbounded list turns a single heal into minutes of local validation, the limit is
 * enforced here as well as there.
 */
const MAX_OPTIONS_PER_ANSWER = 4;

/**
 * Least time worth spending on a provider call.
 *
 * Measured calls take 3-7 s. With less than this left before the test's deadline a call
 * can only be cut off, so it is not started: the heal is reported as skipped and the test
 * fails with the original Playwright error rather than a test timeout.
 */
const MIN_PROVIDER_WINDOW_MS = 3_000;

/**
 * A deadline set by {@link HealingEngine.withDeadline} passed.
 *
 * Its own class so a call cut short by the *test's* remaining time can be told apart from
 * a provider failure — the first says nothing about the provider's health and must not
 * count toward the breaker.
 */
class DeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeadlineError';
  }
}

/** A resolved source location. */
interface CallerLocation {
  file: string;
  line: number;
  /**
   * The frame closest to the failing action — normally the page object that owns the
   * locator, rather than the spec that drove it.
   *
   * Present only when it differs from the reported location. Two different questions
   * share this stack walk: *which test healed* (the spec, which is what a report wants)
   * and *where do I edit the selector* (the page object, which is what a developer
   * wants). Answering the second with the first sends people to a file that does not
   * contain the selector.
   */
  source?: { file: string; line: number };
}

/**
 * Coordinates provider calls, validation, and record keeping for one heal.
 */
export class HealingEngine {
  private config: HealConfig;
  private aiProvider: AiProvider;
  private validator: SelectorValidator;
  private recorder: HealingRecorder;
  private guard: PrivacyGuard;
  private verifier: IntentVerifier;
  private cache: SelectorCache;
  private budget: HealBudget;
  /** Short-timeout validator used only for speculative cache probes. */
  private probeValidator: SelectorValidator;
  /** Builds the candidate list offered to the model. Stateless. */
  private finder = new CandidateFinder();
  private log: Logger;
  private onOutcome?: (outcome: HealOutcome) => void;
  /**
   * Whether this worker has already mentioned that a heal had no `describe()`.
   *
   * Said once, not per heal: the advice is the same every time and repeating it on a
   * suite with hundreds of bare selectors would be noise people learn to skip.
   */
  private warnedAboutMissingDescription = false;

  /**
   * @param config - Resolved healing settings (enabled, retries, timeout, threshold).
   * @param provider - Provider that suggests replacement selectors.
   * @param options - Optional validator and recorder overrides for testing.
   */
  constructor(config: HealConfig, provider: AiProvider, options: HealingEngineOptions = {}) {
    this.config = config;
    this.aiProvider = provider;
    // The validator keeps its own short default (1s). `config.timeout` is the
    // budget for a provider call and is far too long to spend confirming that an
    // already-rendered element exists — that cost would repeat on every retry.
    this.validator = options.validator ?? new SelectorValidator();
    this.recorder = options.recorder ?? new HealingRecorder();
    // A missing policy resolves to `identifiers`, not to "send everything": an engine
    // assembled without thinking about disclosure gets the safe behaviour.
    this.guard = options.guard ?? new PrivacyGuard(config.privacy ?? { redact: 'identifiers' });
    // Same bias as the privacy default: a config assembled without thinking about this
    // gets the safe behaviour. An unchecked heal can turn a suite green on the wrong
    // element, which is harder to notice than a heal that was refused.
    this.verifier =
      options.verifier ??
      new IntentVerifier(config.intent ?? { mode: 'enforce', unverifiedConfidence: 0.9 });
    // Shared with the other workers of this run when this is a Playwright worker, so a
    // stale selector in a shared page object is bought once per run rather than once per
    // worker. Never shared across runs. See SharedSelectorStore.
    const cacheOn = config.cache ?? true;
    this.cache =
      options.cache ?? new SelectorCache(cacheOn, cacheOn ? SharedSelectorStore.forThisRun() : null);
    this.budget =
      options.budget ?? new HealBudget(config.budget ?? { maxHeals: 0, breakerThreshold: 0 });
    this.probeValidator = new SelectorValidator(CACHE_PROBE_TIMEOUT_MS);
    if (options.onOutcome !== undefined) this.onOutcome = options.onOutcome;
    this.log = createLogger('heal:engine');

    this.log.debug(`Privacy policy: ${this.guard.describe()}.`);
  }

  /**
   * Tries to find a working replacement for a selector that just failed.
   *
   * Runs up to `config.maxRetries` provider calls. Each rejected suggestion is fed
   * back into the next prompt, so the model learns within the attempt loop that a
   * selector matched nothing or matched several elements — without that feedback it
   * tends to repeat itself.
   *
   * @param page - Live page the failing action was running against.
   * @param originalSelector - The selector that failed.
   * @param action - Playwright action being attempted (`click`, `fill`, …).
   * @param description - Optional author-supplied description of the element.
   * @param error - Optional original Playwright error.
   * @returns A validated replacement selector, or `null` if healing did not succeed.
   */
  async attemptHeal(
    page: Page,
    originalSelector: string,
    action: string,
    description?: string,
    error?: Error
  ): Promise<string | null> {
    const outcome = await this.attemptHealDetailed(page, originalSelector, action, description, error);
    return outcome.healed;
  }

  /**
   * Like {@link attemptHeal}, but returns the full {@link HealOutcome}.
   *
   * This is what `TestWrapper` calls, because a report needs more than a selector: the
   * per-attempt records, the model's confidence, the rejection reason, and the token
   * spend. (Not the model's prose `reasoning` — {@link HealRecord} has no field for it.)
   * Public so it works for a caller-supplied engine too — wiring reporting through
   * construction would silently exclude anyone who builds their own.
   *
   * @param page - Live page the failing action was running against.
   * @param originalSelector - The selector that failed.
   * @param action - Playwright action being attempted.
   * @param description - Optional author-supplied description of the element.
   * @param error - Optional original Playwright error.
   * @param options - Optional deadline the heal must finish by.
   * @returns Everything that happened, including per-attempt records.
   */
  async attemptHealDetailed(
    page: Page,
    originalSelector: string,
    action: string,
    description?: string,
    error?: Error,
    options: HealAttemptOptions = {}
  ): Promise<HealOutcome> {
    const location = this.getCallerLocation();
    const collected: HealRecord[] = [];

    /**
     * Builds the outcome, notifies any listener, and hands it back.
     *
     * Every exit path goes through here, so `onOutcome` fires exactly once per call —
     * including when healing was skipped or blew up.
     */
    const outcomeOf = (
      healed: string | null,
      pageUrl: string,
      failure?: string,
      blocked?: true,
      skipped?: true
    ): HealOutcome =>
      this.notify(
        this.buildOutcome(
          {
            originalSelector,
            action,
            ...(description !== undefined ? { description } : {}),
            location,
            collected,
          },
          healed,
          pageUrl,
          failure,
          blocked,
          skipped
        )
      );

    // `collected` is passed explicitly rather than held on the instance: one engine
    // serves every test in a worker, and concurrent actions can heal at the same time.
    try {
      return await this.healLoop(
        page,
        {
          originalSelector,
          action,
          ...(description !== undefined ? { description } : {}),
          ...(error !== undefined ? { error } : {}),
          ...(options.deadline !== undefined ? { deadline: options.deadline } : {}),
        },
        collected,
        outcomeOf
      );
    } finally {
      // Every exit path — healed, refused, skipped, blocked, thrown — so a claim can never
      // leave other workers waiting on a heal that is over.
      this.cache.release(originalSelector);
    }
  }

  /**
   * Whether this worker already healed `originalSelector` earlier in the run.
   *
   * Synchronous and free — no DOM, no file read — because the wrapper asks it before
   * every action on every locator.
   *
   * @param originalSelector - The expression about to be acted on.
   * @returns True when {@link reuseKnownHeal} has something to try.
   */
  hasKnownHeal(originalSelector: string): boolean {
    return this.config.enabled && this.cache.knows(originalSelector);
  }

  /**
   * Reuses a heal this worker already made, **without first waiting for the action to
   * fail**.
   *
   * The cache saves the provider call but not the wait: before this, every later use of a
   * stale locator still ran its action to the full `actionTimeout` before the heal path
   * began. A page-object locator used thirty times in a run cost thirty timeouts. Here the
   * original is probed for a quarter of a second instead — the same probe the heal loop
   * opens with — and only when it is still stale is a cached replacement tried.
   *
   * The replacement is trusted no more than on the normal path: validated, intent-checked
   * and recorded as a `cache` heal, so it reaches the annotation, the records file and the
   * CI gate exactly as before.
   *
   * Returns `null`, having published nothing, whenever the answer is anything but a
   * reused heal — nothing cached, the original resolves, a blocked route, a candidate
   * that no longer fits. The caller then runs the action as written, which is the old
   * path unchanged. Never throws.
   *
   * @param page - Live page.
   * @param originalSelector - The expression about to be acted on.
   * @param action - The action about to run.
   * @param description - Optional author-supplied description of the element.
   * @returns The outcome of a reuse, or `null` when the normal path should run.
   */
  async reuseKnownHeal(
    page: Page,
    originalSelector: string,
    action: string,
    description?: string
  ): Promise<HealOutcome | null> {
    if (!this.hasKnownHeal(originalSelector)) return null;

    try {
      // Same staleness test as the heal loop's first step, so the two paths cannot
      // disagree about whether a selector needs healing.
      const recheck = await this.probeValidator.validateDetailed(originalSelector, page);
      if (recheck.valid) return null;

      // A blocked page is left to the normal path, which reports the block.
      const url = page.url();
      if (!this.guard.checkUrl(url).allowed) return null;

      const location = this.getCallerLocation();
      const collected: HealRecord[] = [];
      const context = {
        originalSelector,
        action,
        ...(description !== undefined ? { description } : {}),
      };

      const reused = await this.tryCache(page, context, location, collected);
      if (!reused) {
        // The normal path that follows looks again and counts its own miss.
        this.cache.retractMiss();
        return null;
      }

      return this.notify(this.buildOutcome({ ...context, location, collected }, reused, url));
    } catch (unexpected) {
      const detail = unexpected instanceof Error ? unexpected.message : String(unexpected);
      this.log.debug(`Reusing a known heal for "${originalSelector}" failed: ${detail}`);
      return null;
    }
  }

  /**
   * Hands an outcome to any `onOutcome` listener, then back to the caller.
   *
   * @param outcome - The outcome to publish.
   * @returns The same outcome.
   */
  private notify(outcome: HealOutcome): HealOutcome {
    // Notifying a listener must never affect the heal.
    try {
      this.onOutcome?.(outcome);
    } catch (listenerError) {
      const detail = listenerError instanceof Error ? listenerError.message : String(listenerError);
      this.log.debug(`onOutcome handler threw (ignored): ${detail}`);
    }

    return outcome;
  }

  /**
   * Milliseconds left before a heal's deadline, or `undefined` when it has none.
   *
   * @param deadline - Epoch milliseconds, if the caller set one.
   * @returns Time remaining, which may be negative.
   */
  private timeLeft(deadline: number | undefined): number | undefined {
    return deadline === undefined ? undefined : deadline - Date.now();
  }

  /**
   * Assembles a {@link HealOutcome} from the attempt records gathered so far.
   *
   * @param context - Identifying details of the heal.
   * @param healed - The selector that worked, or `null`.
   * @param pageUrl - URL at the time of failure.
   * @param failure - Why healing failed, when it did.
   * @param blocked - Set when the privacy policy stopped the heal.
   * @returns The outcome.
   */
  private buildOutcome(
    context: {
      originalSelector: string;
      action: string;
      description?: string;
      location: CallerLocation;
      collected: HealRecord[];
    },
    healed: string | null,
    pageUrl: string,
    failure?: string,
    blocked?: true,
    skipped?: true
  ): HealOutcome {
    const { originalSelector, action, description, location, collected } = context;

    return {
      originalSelector,
      action,
      ...(description !== undefined ? { description } : {}),
      pageUrl,
      file: location.file,
      line: location.line,
      ...(location.source !== undefined ? { source: location.source } : {}),
      healed,
      attempts: collected,
      tokens: (() => {
        const total = collected.reduce(
          (sum, record) => ({
            input: sum.input + (record.tokens?.input ?? 0),
            output: sum.output + (record.tokens?.output ?? 0),
            cached: sum.cached + (record.tokens?.cached ?? 0),
          }),
          { input: 0, output: 0, cached: 0 }
        );
        // Omitted when nothing was cached, so an outcome reads the same as before on a
        // provider or model where caching never engages.
        return total.cached > 0 ? total : { input: total.input, output: total.output };
      })(),
      ...(failure !== undefined ? { error: failure } : {}),
      ...(blocked ? { blocked } : {}),
      ...(skipped ? { skipped } : {}),
    };
  }

  /**
   * The healing loop: snapshot, ask, validate, retry with feedback.
   *
   * @param page - Live page the failing action was running against.
   * @param context - The selector, action, description, and original error.
   * @param collected - Array this call appends its attempt records to.
   * @param outcomeOf - Builds and publishes the outcome for a given result.
   * @returns The outcome of the whole loop.
   */
  private async healLoop(
    page: Page,
    context: {
      originalSelector: string;
      action: string;
      description?: string;
      error?: Error;
      deadline?: number;
    },
    collected: HealRecord[],
    outcomeOf: (
      healed: string | null,
      pageUrl: string,
      failure?: string,
      blocked?: true,
      skipped?: true
    ) => HealOutcome
  ): Promise<HealOutcome> {
    const { originalSelector, action, description, error, deadline } = context;
    const location = this.getCallerLocation();

    // 1. Respect the master switch before doing any work.
    if (!this.config.enabled) {
      this.log.debug('Healing is disabled — skipping.');
      return outcomeOf(null, '', 'healing is disabled');
    }

    // 1a. Is the selector actually stale?
    //
    // An action fails for reasons that have nothing to do with the selector: the element
    // rendered a moment late, an overlay intercepted the click, the button is disabled,
    // an animation had not settled. Healing then answers the wrong question — it goes
    // looking for a *different* element — and a different element that works is the
    // one outcome worse than a failure. Reproduced with a real browser before this check
    // existed:
    //
    //   slow render   `#save` appeared just late      → clicked "Save as template", PASSED
    //   disabled      `#submit` not enabled yet       → clicked "Submit later",     PASSED
    //   overlay       a modal covered `#save`         → a provider call, then failed
    //
    // The disabled case is the worst of them: a button that never becomes enabled is a
    // real bug, and healing masked it while performing a different action.
    //
    // The test is sound because of what staleness means. If the original selector
    // resolves to exactly one visible element, the selector *found its element*; an
    // action that still failed failed on actionability or timing. So nothing is healed
    // and the original Playwright error — which names the real cause — reaches the
    // test unchanged. Checked before the cache, the budget and any disclosure, and with
    // the short probe timeout, so a genuinely stale selector pays at most a quarter of a
    // second for it.
    try {
      const recheck = await this.probeValidator.validateDetailed(originalSelector, page);
      if (recheck.valid) {
        const reason =
          'the original selector still resolves to exactly one visible element, so it is ' +
          'not stale — the action failed for another reason (the element was slow to ' +
          'appear, covered, disabled or still moving), and healing would only find a ' +
          'different element';
        this.log.info(`Not healing "${originalSelector}": ${reason}.`);
        let url = '';
        try {
          url = page.url();
        } catch {
          // A closed page has no URL; the outcome is still worth reporting.
        }
        return { ...outcomeOf(null, url, reason), notStale: true };
      }
    } catch {
      // A recheck that cannot run is not evidence either way; heal as before.
    }

    // 1b. Privacy gate, before the page is even read. This is the one check in this
    //     class that fails CLOSED: if we cannot establish that this page is cleared
    //     for healing, we do not look at it. Reading `url()` is itself guarded,
    //     because a closed page throws and "I could not tell" must mean "do not send".
    let currentUrl = '';
    try {
      currentUrl = page.url();
    } catch (urlError) {
      const detail = urlError instanceof Error ? urlError.message : String(urlError);
      this.log.debug(`Could not read the page URL: ${detail}`);
    }

    const gate = this.guard.checkUrl(currentUrl);
    if (!gate.allowed) {
      this.log.warn(`Healing blocked by policy: ${gate.reason}.`);
      return outcomeOf(null, currentUrl, gate.reason, true);
    }

    // 1c. Reuse a selector that already healed in this worker, before spending anything.
    //     Placed after the privacy gate — a blocked page stays blocked, which costs
    //     nothing since a blocked page can never have populated the cache — and before
    //     the snapshot, because capturing the page is itself a browser round trip.
    //
    //     A cached selector is re-validated and re-intent-checked, so a hit that is
    //     wrong for this page is rejected and the normal heal proceeds.
    const reused = await this.tryCache(
      page,
      { originalSelector, action, ...(description !== undefined ? { description } : {}) },
      location,
      collected
    );
    if (reused) return outcomeOf(reused, currentUrl);

    // 1c'. Single-flight across the workers of this run. A shared cache only helps a
    //      worker that arrives after another has *finished*; measured on the demo, the
    //      duplicate heals finished within 0.1-1.8 s of each other, because tests start
    //      together and hit the same stale selector at once. So the first worker claims
    //      the selector and the rest wait for its answer. The answer is still validated
    //      and intent-checked on this worker's own page, and if it does not arrive, or
    //      does not work here, this worker heals as usual — a bounded wait, never a lost
    //      heal. The claim is released by `attemptHealDetailed` on every exit path.
    if (!this.cache.claim(originalSelector)) {
      const waitMs = Math.min(this.config.timeout, PEER_WAIT_MAX_MS);
      this.log.info(`Another worker is healing "${originalSelector}"; waiting for its answer.`);

      if (await this.cache.awaitPeer(originalSelector, waitMs)) {
        const fromPeer = await this.tryCache(
          page,
          { originalSelector, action, ...(description !== undefined ? { description } : {}) },
          location,
          collected
        );
        // The second look recorded its own hit or miss; this heal is one lookup, not two.
        this.cache.retractMiss();
        if (fromPeer) return outcomeOf(fromPeer, currentUrl);
      }

      // No usable answer arrived. Heal here, and hold the claim while doing so, so any
      // worker arriving now waits on this heal rather than starting a third.
      this.cache.claim(originalSelector);
    }

    // 1c''. Time left in the test. After the cache, which costs milliseconds and can still
    //       answer; before anything that waits on the network. A call that cannot finish
    //       before the test's own timeout only converts the Playwright error — which names
    //       the stale selector — into `Test timeout exceeded`, which names nothing.
    const remaining = this.timeLeft(deadline);
    if (remaining !== undefined && remaining < MIN_PROVIDER_WINDOW_MS) {
      const reason =
        `only ${Math.max(0, Math.round(remaining))}ms of the test's timeout was left, too ` +
        'little for a provider call — raise the test timeout, or set actionTimeout so a ' +
        'stale selector fails sooner and leaves time to heal';
      this.log.warn(`Skipping heal for "${originalSelector}": ${reason}.`);
      return outcomeOf(null, currentUrl, reason, undefined, true);
    }

    // 1d. Spend ceiling and circuit breaker — checked *after* the cache, so an exhausted
    //     budget or a dead provider degrades into "keep using what this worker already
    //     learned" rather than "stop healing entirely". A refusal here is reported as
    //     `heal-skipped`: nothing was wrong with the page or the model, we simply
    //     declined to spend.
    const refusal = this.budget.check();
    if (refusal) {
      this.log.warn(`Skipping heal for "${originalSelector}": ${refusal.reason}.`);
      return outcomeOf(null, currentUrl, refusal.reason, undefined, true);
    }

    // At least one attempt is always made when healing is on; maxRetries: 0 would
    // otherwise silently disable a feature the caller explicitly enabled.
    const attempts = Math.max(1, this.config.maxRetries);

    // Rejected suggestions from earlier attempts, replayed into the next prompt.
    const rejected: string[] = [];

    /**
     * Whether the locator carried a `describe()`.
     *
     * Recorded on *every* attempt, not only a winning one. It used to be passed on the
     * success path alone, so a failed heal always reported `described: null` however
     * carefully the test had described its element — and the reporter's "N of M heals
     * had no describe()" line silently excluded every failure, which is the population
     * where a missing description matters most, since those heals are the likeliest to
     * fail in the first place.
     */
    const described = description !== undefined && description.trim() !== '';
    let pageUrl = '';
    /**
     * Whether this heal has already been charged to the budget.
     *
     * The ceiling is expressed, configured and reported in **heals**, so it is charged
     * once per heal — the retry loop below belongs to one heal and must not be billed
     * three times for it. The breaker is the opposite and deliberately so: it counts
     * *attempts*, because that is what makes an outage visible in half a failing action
     * rather than after whole heals exhaust their retries.
     */
    let charged = false;
    /** Why the attempt loop stopped early for want of time, when it did. */
    let outOfTime: string | undefined;

    try {
      pageUrl = currentUrl || page.url();

      // The failing expression already carries its own frame path, so no extra metadata
      // is needed to know where to look — or where the answer has to point.
      const { frames } = this.validator.splitFrameChain(
        originalSelector.trim().replace(/^await\s+/, '').replace(/^(?:this\.)?page\./, '')
      );

      // 2. Capture page context once — the DOM does not change between attempts,
      //    and snapshotting is the most expensive local step. `snapshotRoot` scopes
      //    the capture to one container, which reduces both disclosure and token cost.
      const snapshotRoot = this.guard.snapshotRoot;

      // 2a. A configured root is a privacy control, so it must not fail open. If it
      //     does not resolve we block, rather than capturing a wider page than the
      //     policy asked for. Checked up front with a short budget so a root that is
      //     simply absent on this page costs a second rather than the provider timeout.
      if (snapshotRoot !== undefined && !(await this.rootResolves(page, snapshotRoot))) {
        const reason =
          `the configured snapshot root "${snapshotRoot}" did not resolve on this page, ` +
          'so the capture could not be scoped as the policy requires';
        this.log.warn(`Healing blocked: ${reason}.`);
        return outcomeOf(null, pageUrl, reason, true);
      }

      const ariaSnapshot = await getAriaSnapshot(page, {
        timeoutMs: Math.max(1, Math.min(this.config.timeout, this.timeLeft(deadline) ?? Infinity)),
        ...(snapshotRoot !== undefined ? { root: snapshotRoot } : {}),
        ...(frames.length > 0 ? { frames } : {}),
      });

      // 2b. A frame-scoped heal with no snapshot cannot be answered: capture refuses to
      //     substitute the parent document, so there is genuinely nothing to reason
      //     about. Fail here rather than paying for a call whose only possible outcome
      //     is a confidence-0 reply.
      if (frames.length > 0 && ariaSnapshot.trim() === '') {
        const reason =
          `the frame "${frames.join(' > ')}" could not be read, so there was nothing to ` +
          'describe — check the frame selector';
        this.log.warn(`Healing stopped: ${reason}.`);
        return outcomeOf(null, pageUrl, reason);
      }

      // 2c. Enumerate the page's addressable elements, and note which of the original
      //     selector's literals are gone. Both are derived from the snapshot already in
      //     hand, so neither costs a browser round-trip, and both change what is *asked*
      //     rather than how an answer is judged: the model picks an id off a verified
      //     list instead of writing locator syntax, and is told outright when the text
      //     it would otherwise echo back no longer exists.
      const named = this.config.candidates === false
        ? []
        : this.finder.find(ariaSnapshot, {
            action,
            intent: `${originalSelector} ${description ?? ''}`,
            // The snapshot was scoped to this container, so the expressions must be
            // too — otherwise uniqueness is decided inside the container and tested
            // against the whole document. See `CandidateFinder.FindOptions.scope`.
            ...(snapshotRoot !== undefined ? { scope: snapshotRoot } : {}),
          });

      // 2c'. Nameless controls — icon buttons — by their test id, which no accessibility
      //      snapshot carries. Appended, so the snapshot's candidates keep their ids.
      //      The main document only for now: a frame's test ids would need the frame
      //      chain threaded through, and a frame heal keeps its old behaviour meanwhile.
      const candidates =
        this.config.candidates === false || frames.length > 0
          ? named
          : [
              ...named,
              ...(await findTestIdCandidates(page, {
                firstId: named.length + 1,
                ...(snapshotRoot !== undefined ? { scope: snapshotRoot } : {}),
              })),
            ];
      const missingText = missingLiterals(originalSelector, ariaSnapshot);

      // 2d. Bound what actually travels. Deliberately *after* enumeration: candidates
      //     are drawn from the whole snapshot and ranked against the failing selector,
      //     so the target stays pickable by id even when the text below is cut — which
      //     is the only reason cutting it is safe. `getAriaSnapshot` refuses to shorten
      //     on its own for exactly that reason.
      //
      //     Measured on a 2,000-row grid: 324,000 characters, about 83,000 input tokens
      //     per attempt. Left unbounded that is silent cost on every heal, and on a
      //     larger grid a context-limit error that counts against the breaker.
      const ceiling = this.config.maxSnapshotChars ?? 0;
      const promptSnapshot =
        ceiling > 0 && ariaSnapshot.length > ceiling
          ? truncateSnapshot(ariaSnapshot, ceiling)
          : ariaSnapshot;

      if (promptSnapshot.length < ariaSnapshot.length) {
        this.log.warn(
          `Page snapshot is ${ariaSnapshot.length} characters; sending the first ` +
            `${ceiling} (HEALER_MAX_SNAPSHOT_CHARS). All ${candidates.length} candidate(s) ` +
            'were found before the cut, so the element can still be picked by id — but ' +
            'scoping the capture with HEALER_SNAPSHOT_ROOT will heal better and cost less.'
        );
      }

      if (candidates.length === 0) {
        this.log.debug(
          'No named elements, and no nameless ones with a test id, on this page, so the ' +
            'model will be asked to write a locator itself.'
        );
      }

      // Second opinions left for this heal, across every attempt and option. Bounded so a
      // model proposing lookalike after lookalike costs a few small calls, not one each.
      const confirmBudget = { left: MAX_CONFIRMS_PER_HEAL };

      for (let attempt = 1; attempt <= attempts; attempt++) {
        this.log.info(
          `Attempt ${attempt}/${attempts}: healing ${action} on "${originalSelector}" ` +
            `at ${location.file}:${location.line}.`
        );

        // 3. Build the request. Only the error context changes between attempts:
        //    it carries the original failure plus anything already rejected.
        const errorContext = this.buildErrorContext(error, rejected);
        const request: HealingRequest = {
          originalSelector,
          originalAction: action,
          ariaSnapshot: promptSnapshot,
          pageUrl,
          testFile: location.file,
          testLine: location.line,
          ...(description !== undefined ? { description } : {}),
          ...(errorContext !== undefined ? { error: errorContext } : {}),
          ...(candidates.length > 0 ? { candidates } : {}),
          ...(missingText.length > 0 ? { missingText } : {}),
        };

        // 3b. Redact. `request` holds the real page content and stays local — it is
        //     what the healing record and the report attachment are built from, so
        //     you still see the true selector you need to fix. `outbound` is the only
        //     thing a provider ever receives.
        //
        //     Fails CLOSED: a vetoing or broken redactor abandons the heal. This is
        //     the deliberate exception to "healing never throws" — see PrivacyGuard.
        let outbound: HealingRequest;
        try {
          outbound = this.guard.sanitizeRequest(request);
        } catch (privacyError) {
          const detail =
            privacyError instanceof PrivacyBlockedError
              ? privacyError.message
              : `redaction failed (${privacyError instanceof Error ? privacyError.message : String(privacyError)})`;
          this.log.warn(`Healing blocked before transmission: ${detail}.`);
          return outcomeOf(null, pageUrl, detail, true);
        }

        // 3c. Preview mode: write exactly what would have been sent, send nothing.
        //     Rendered from PromptBuilder, which is what all three providers use, so
        //     the file is the real payload rather than an approximation of it.
        if (this.guard.previewOnly) {
          const file = this.guard.writePreview({
            request: outbound,
            systemPrompt: PromptBuilder.buildSystemPrompt(outbound),
            userPrompt: PromptBuilder.buildUserPrompt(outbound),
            provider: this.config.provider,
            model: this.config.model,
          });

          return outcomeOf(
            null,
            pageUrl,
            `preview mode (HEALER_PRIVACY_PREVIEW) — nothing was transmitted` +
              `${file ? `; payload written to ${file}` : ''}`,
            true
          );
        }

        // 4. Ask the provider, bounded by the configured timeout. A provider that
        //    hangs must not hold the whole suite open.
        // 3d. The breaker can open *during* this heal, on an earlier attempt. Checked here
        //     as well as before the loop, because "stop calling a provider that keeps
        //     failing" has to mean stopping now — otherwise a heal with maxRetries=10 and
        //     a threshold of 5 still spends five more timeouts on a provider already known
        //     to be down, which is the exact cost the breaker exists to avoid. The heal is
        //     reported as failed rather than skipped: it *did* reach the provider, and the
        //     connection error is the honest reason. The next heal is the skipped one.
        if (this.budget.isBreakerOpen) {
          this.log.warn(
            `Abandoning the remaining attempt(s) for "${originalSelector}": the provider ` +
              'is failing and this worker has stopped calling it.'
          );
          break;
        }

        // 3e. Each call gets the provider timeout or what is left of the test, whichever is
        //     shorter. A later attempt that would start with too little left is not started:
        //     the answer could not arrive in time to be used.
        const left = this.timeLeft(deadline);
        if (left !== undefined && left < MIN_PROVIDER_WINDOW_MS) {
          outOfTime =
            `stopped after ${attempt - 1} attempt(s): only ${Math.max(0, Math.round(left))}ms ` +
            "of the test's timeout was left, too little for another provider call";
          this.log.warn(`Abandoning the remaining attempt(s) for "${originalSelector}": ${outOfTime}.`);
          break;
        }
        const callTimeout = Math.min(this.config.timeout, left ?? Infinity);
        const capped = callTimeout < this.config.timeout;

        let response: HealingResponse;
        if (!charged) {
          this.budget.spend();
          charged = true;
        }
        try {
          response = await this.withDeadline(
            (signal) => this.aiProvider.heal(outbound, { signal }),
            callTimeout,
            capped ? 'provider call (limited by the time left in the test)' : 'provider call'
          );
          // The call worked. Whatever the model said, the provider is healthy, so the
          // breaker's consecutive-failure count starts again.
          this.budget.recordProviderSuccess();
        } catch (providerError) {
          // A failed *call* — network, credential, timeout. A low-confidence answer or a
          // rejected suggestion is not a provider failure and must not trip the breaker.
          // Nor is a call cut short by the test's own deadline: the provider may have been
          // about to answer, and a breaker tripped by a tight test timeout would switch
          // healing off for the rest of the worker for the wrong reason.
          if (!(capped && providerError instanceof DeadlineError)) {
            this.budget.recordProviderFailure();
          }
          const detail = providerError instanceof Error ? providerError.message : String(providerError);

          // A configuration failure — untrusted certificate, rejected key, unknown model —
          // fails identically on every attempt and in every later heal. Retrying it cost
          // two doomed calls per stale selector per test on a real run, with the per-worker
          // breaker never tripping across four workers. So healing stops here, for this
          // heal and for the rest of the worker, and the reason carries the fix.
          if (providerError instanceof ProviderConfigurationError) {
            this.budget.disable(detail);
            collected.push(
              this.record(
                location,
                originalSelector,
                '',
                0,
                this.config.provider,
                undefined,
                false,
                detail,
                undefined,
                undefined,
                described
              )
            );
            return outcomeOf(null, pageUrl, detail);
          }

          this.log.warn(`Attempt ${attempt} failed: ${detail}`);
          collected.push(
            this.record(
              location,
              originalSelector,
              '',
              0,
              this.config.provider,
              undefined,
              false,
              detail,
              undefined,
              undefined,
              described
            )
          );
          continue;
        }

        // 4b. Turn one answer into every option worth trying, in the model's own order:
        //     its first choice, then the alternatives it offered. Each is checked against
        //     the live page in about a millisecond, so a near-miss is corrected here
        //     rather than by paying for another round-trip — the failure that prompted
        //     this had a working answer sitting in the same reply as the broken one.
        //
        //     `resolveChoices` is also where a candidate id becomes a locator, so
        //     everything below this point reasons about expressions and neither knows
        //     nor cares how the model pointed at the element.
        const choices = this.resolveChoices(response, candidates, frames);

        if (choices.length === 0) {
          // A refusal: the model looked and said nothing on the page is the element. That
          // is the answer the prompt asks for when nothing matches, and on a page where an
          // element was genuinely removed — or renamed ambiguously, with two equally
          // plausible successors — it is the *correct* answer. Recorded as what it is,
          // with the model's reasoning and the tokens it cost, and **not retried**: asking
          // the same question again after an explicit "no" only fishes for a guess, and
          // against the real claude-haiku-4-5 the second answer refused identically three
          // runs out of three.
          if (response.confidence < this.config.confidenceThreshold) {
            const why = response.reasoning ? `: ${response.reasoning}` : '';
            const reason = `the model declined — confidence ${response.confidence}${why}`;
            this.log.warn(
              `Healing declined for "${originalSelector}": the model found no element it ` +
                `would stand behind (confidence ${response.confidence}).`
            );
            collected.push(
              this.recordFromResponse(location, originalSelector, response, false, reason, undefined, described)
            );
            return outcomeOf(null, pageUrl, reason);
          }

          // Confident, but pointing at nothing usable — an id off the end of the list.
          // That is a mistake worth one more try with the reason attached.
          const reason =
            candidates.length > 0
              ? `the answer named no usable candidate id (1-${candidates.length}) and no selector`
              : 'the answer named no selector';
          this.log.warn(`Attempt ${attempt} rejected: ${reason}.`);
          collected.push(
            this.recordFromResponse(location, originalSelector, response, false, reason, undefined, described)
          );
          rejected.push(reason);
          continue;
        }

        for (const choice of choices) {
          // Which of the model's options this is, so a record and a log line say whether
          // the heal came from the first answer or from a runner-up.
          const which =
            choices.length > 1 ? `attempt ${attempt}, option ${choice.rank}/${choices.length}` : `attempt ${attempt}`;
          const response = choice.response;

          // 5a. Reject low-confidence suggestions before touching the page.
          if (response.confidence < this.config.confidenceThreshold) {
            const reason =
              `confidence ${response.confidence} is below the threshold ` +
              `${this.config.confidenceThreshold}`;
            this.log.warn(`Rejected on ${which}: ${reason}.`);
            collected.push(
            this.recordFromResponse(location, originalSelector, response, false, reason, undefined, described)
          );
            rejected.push(`${response.suggestedSelector} (${reason})`);
            continue;
          }

          // 5b. Verify the suggestion resolves to exactly one element. This is what
          //     separates a plausible selector from a working one.
          let validation: ValidationResult;
          try {
            validation = await this.validator.validateDetailed(response.suggestedSelector, page);
          } catch (validationError) {
            const detail =
              validationError instanceof Error ? validationError.message : String(validationError);
            validation = { valid: false, matches: -1, reason: `validation error: ${detail}` };
          }

          if (!validation.valid) {
            const reason = validation.reason ?? 'selector did not validate';
            // Both halves are model-derived and both can carry page text: the suggestion
            // may be `getByText('Smith, John')`, and a reason can quote the suffix it
            // refused. The record written below keeps the real values.
            this.log.warn(
              `Rejected on ${which}: ` +
                `"${this.guard.redactSelector(response.suggestedSelector)}" ` +
                `${this.guard.redactMessage(reason)}.`
            );
            collected.push(
            this.recordFromResponse(location, originalSelector, response, false, reason, undefined, described)
          );
            rejected.push(`${response.suggestedSelector} (${reason})`);
            continue;
          }

          // 5c. Verify it is the RIGHT element, not merely a working one. Validation
          //     above proves the selector resolves to one visible element; on a page with
          //     both "Place order" and "Cancel", that is true of the wrong button too.
          //     A failure here is fed back into the next prompt like any other rejection.
          const verdict = await this.verifyIntent(page, response, {
            originalSelector,
            action,
            ...(description !== undefined ? { description } : {}),
          });

          // A names-share-no-wording objection is the one gate that judges meaning by
          // string, so it cannot see a synonym (Log in → Sign in). When a second opinion
          // can be asked, that objection is handed to it rather than final; every other
          // rejection stays final. See `IntentVerdict.soft`.
          const settleBySecondOpinion = !verdict.ok && verdict.soft === true && this.canConfirm();

          if (!verdict.ok && !settleBySecondOpinion) {
            const reason = verdict.reason ?? 'did not match the intended element';
            // The intent reason quotes the element the model landed on, which is the whole
            // point of the check and also the reason this line needs redacting.
            this.log.warn(
              `Rejected on ${which} on intent: ` +
                `"${this.guard.redactSelector(response.suggestedSelector)}" — ` +
                `${this.guard.redactMessage(reason)}.`
            );
            collected.push(
              this.recordFromResponse(
                location,
                originalSelector,
                response,
                false,
                reason,
                verdict.summary,
                described
              )
            );
            rejected.push(`${response.suggestedSelector} (${reason})`);
            continue;
          }

          // 5c'. A second, narrow opinion, before anything is committed. Every check above
          //      passed on a held-out audit set for Edit profile → Edit password and
          //      Transfer $100 → Transfer $1,000: the element was real, unique, actionable
          //      and shared wording with the intent. Only judgement separates those from
          //      a rename, and the model that proposed the heal was asked to *find* one.
          //      See `HealConfig.confirm`.
          const confirmation = await this.confirmChoice(
            {
              originalSelector,
              action,
              ...(description !== undefined ? { description } : {}),
              missingText,
              pageUrl,
              suggestedSelector: response.suggestedSelector,
              observed: verdict.summary,
              // Where the element sits is part of what it is: "View" inside the Pro card.
              ancestry: candidates.find((c) => c.selector === response.suggestedSelector)?.context ?? [],
              // And what sits beside it: whether anything else there could have been the
              // old control is what decides Charter Cloud → Private Cloud beside "Settings"
              // and "Help", against the same rename beside "Dedicated Cloud".
              ...siblingsOf(candidates, response.suggestedSelector),
              required: settleBySecondOpinion,
              ...(settleBySecondOpinion && verdict.reason !== undefined ? { overruled: verdict.reason } : {}),
            },
            confirmBudget
          );
          // The record says the second opinion was asked, and — when it settled a lexical
          // objection — that the heal was verified by it rather than by wording.
          const summary: IntentSummary = { ...verdict.summary };
          if (confirmation.asked) {
            summary.checks = [...verdict.summary.checks, 'confirm'];
            if (settleBySecondOpinion && confirmation.ok) {
              summary.verified = true;
              delete summary.reason;
            }
          }
          const withConfirm: HealingResponse =
            confirmation.tokens !== undefined
              ? { ...response, tokenUsage: addTokens(response.tokenUsage, confirmation.tokens) }
              : response;

          if (!confirmation.ok) {
            const reason = confirmation.reason ?? 'a second opinion did not confirm it';
            this.log.warn(
              `Rejected on ${which} on a second opinion: ` +
                `"${this.guard.redactSelector(response.suggestedSelector)}" — ` +
                `${this.guard.redactMessage(reason)}.`
            );
            collected.push(
              this.recordFromResponse(location, originalSelector, withConfirm, false, reason, summary, described)
            );
            rejected.push(`${response.suggestedSelector} (${reason})`);
            continue;
          }

          // 5d. One last look at the original, now that the model has answered.
          //
          //     Step 1a catches every failure where the element was already there. It
          //     cannot catch one that renders *after* healing starts — at that instant the
          //     selector genuinely looks stale. But a real provider call takes seconds,
          //     and that is exactly the window a slow page finishes rendering in. If the
          //     original resolves now, the page was slow, not the selector wrong: the heal
          //     is discarded rather than committed, cached, or reported as a rewrite.
          //     Measured without this: `#save` rendered during the call and the healer
          //     clicked "Save as template" instead.
          try {
            const late = await this.probeValidator.validateDetailed(originalSelector, page);
            if (late.valid) {
              const reason =
                'the original selector began resolving while the model was answering, so the ' +
                'page was slow rather than the selector stale — the heal was discarded';
              this.log.info(`Not healing "${originalSelector}": ${reason}.`);
              collected.push(
                this.recordFromResponse(location, originalSelector, withConfirm, false, reason, summary, described)
              );
              return { ...outcomeOf(null, pageUrl, reason), notStale: true };
            }
          } catch {
            // Not evidence either way; the validated heal stands.
          }

          // 6. Record the win, remember it for the rest of the run, and hand the selector
          //    back to the caller. Remembering happens only after validation *and* the
          //    intent check have passed, so the cache never holds a selector this package
          //    would have refused.
          this.cache.remember(originalSelector, {
            selector: response.suggestedSelector,
            confidence: response.confidence,
          });

          collected.push(
            this.recordFromResponse(
              location,
              originalSelector,
              withConfirm,
              true,
              undefined,
              summary,
              described
            )
          );
          // Redacted for the log line only. The model may have chosen page text as the
          // identifier, and a log line is one of the places that reaches CI output. The
          // record written above keeps the real value.
          this.log.info(
            `Healed "${originalSelector}" -> "${this.guard.redactSelector(response.suggestedSelector)}" ` +
              `(confidence ${response.confidence}, ${response.provider}, ` +
              `${choice.source}, intent checks: ${summary.checks.join('+') || 'none'}).`
          );

          if (!this.warnedAboutMissingDescription && (description === undefined || description.trim() === '')) {
            this.warnedAboutMissingDescription = true;
            this.log.warn(
              `Healed "${originalSelector}" without a describe(). The description is the ` +
                'strongest signal the model gets, and heals without one are the likeliest ' +
                'to land on the wrong element — worth adding to the locators that matter. ' +
                'Recorded per heal as "described" in healing-records.json, and summarised ' +
                'by the reporter.'
            );
          }

          return outcomeOf(response.suggestedSelector, pageUrl);
        }
      }

      this.log.warn(`Healing failed for "${originalSelector}" after ${attempts} attempt(s).`);
      const lastReason = collected[collected.length - 1]?.error;
      return outcomeOf(
        null,
        pageUrl,
        outOfTime ?? lastReason ?? `no working selector after ${attempts} attempt(s)`,
        undefined,
        // Out of time before any call was made: nothing was spent, so it reads as skipped.
        outOfTime !== undefined && !charged ? true : undefined
      );
    } catch (unexpected) {
      // Anything not caught above — snapshot failure, closed page, recorder bug.
      // Swallowed deliberately so the original Playwright error survives.
      const detail = unexpected instanceof Error ? unexpected.message : String(unexpected);
      this.log.error(`Unexpected error while healing "${originalSelector}": ${detail}`);
      return outcomeOf(null, pageUrl, detail);
    }
  }

  /**
   * Tries the selectors this worker has already healed for this expression.
   *
   * The cheap path, and on a real suite the common one: a stale selector normally lives
   * in a page object shared by many tests, so the same rot is otherwise paid for once
   * per test that touches it. This repo's demo heals five distinct selectors eleven
   * times in a run.
   *
   * Nothing is trusted. Each candidate is validated and intent-checked exactly as a
   * fresh suggestion would be, using a short-timeout validator because the probe is
   * speculative. A candidate that is wrong for the current page simply fails and the
   * normal heal follows, which is what lets the cache key stay crude.
   *
   * Never throws: a cache failure must degrade to a normal heal, not break one.
   *
   * @param page - Live page.
   * @param context - The failing selector, the action, and any description.
   * @param location - Caller attribution for the record.
   * @param collected - Array to append the reuse record to.
   * @returns The reused selector, or `null` to proceed with a real heal.
   */
  private async tryCache(
    page: Page,
    context: { originalSelector: string; action: string; description?: string },
    location: CallerLocation,
    collected: HealRecord[]
  ): Promise<string | null> {
    const { originalSelector, action, description } = context;
    const candidates = this.cache.candidates(originalSelector);
    if (candidates.length === 0) {
      this.cache.noteMiss(originalSelector);
      return null;
    }

    for (const candidate of candidates) {
      this.cache.noteProbe();

      try {
        const validation = await this.probeValidator.validateDetailed(candidate.selector, page);
        if (!validation.valid) {
          this.log.debug(
            `Cached "${candidate.selector}" no longer works here (${validation.reason}).`
          );
          continue;
        }

        const verdict = await this.verifyIntent(
          page,
          {
            suggestedSelector: candidate.selector,
            confidence: candidate.confidence,
            reasoning: '',
            tokenUsage: { input: 0, output: 0 },
            provider: 'cache',
          },
          { originalSelector, action, ...(description !== undefined ? { description } : {}) }
        );

        if (!verdict.ok) {
          this.log.debug(
            `Cached "${candidate.selector}" was rejected on intent (${verdict.reason}).`
          );
          continue;
        }

        // Re-remembering promotes it, so the candidate that keeps working is probed
        // first next time.
        this.cache.remember(originalSelector, candidate);
        // Redacted at the call site: `noteHit` only logs the value, and the cache holds
        // no privacy policy of its own — pushing the guard down into it would give a
        // bookkeeping class a reason to know about redaction.
        this.cache.noteHit(
          originalSelector,
          this.guard.redactSelector(candidate.selector),
          candidate.selector
        );

        collected.push(
          this.record(
            location,
            originalSelector,
            candidate.selector,
            candidate.confidence,
            'cache',
            { input: 0, output: 0 },
            true,
            undefined,
            'Reused a selector that healed earlier in this worker; re-validated and ' +
              'intent-checked against the live page rather than asking the model again.',
            verdict.summary,
            description !== undefined && description.trim() !== ''
          )
        );

        return candidate.selector;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.log.debug(`Probing cached "${candidate.selector}" failed: ${detail}`);
      }
    }

    this.cache.noteMiss(originalSelector);
    return null;
  }

  /** Counters describing what this worker's cache saved. */
  cacheStats(): ReturnType<SelectorCache['stats']> {
    return this.cache.stats();
  }

  /**
   * The privacy guard in force, so callers that display a healed selector can redact it
   * the same way. Redaction governs what goes *to* a provider; a selector coming back can
   * carry page text into a log line or a report, which is a separate surface.
   */
  get privacy(): PrivacyGuard {
    return this.guard;
  }

  /** Counters describing what this worker spent, and whether the breaker tripped. */
  budgetStats(): ReturnType<HealBudget['stats']> {
    return this.budget.stats();
  }

  /**
   * Runs the intent check on a validated suggestion.
   *
   * Resolves the selector again rather than threading a locator out of
   * `validateDetailed`: building a locator is a local, network-free operation, and
   * keeping `ValidationResult` free of live Playwright objects means it stays a plain
   * serialisable value.
   *
   * Never throws. An unusable verdict would otherwise be the one thing that could turn
   * a safety check into a broken heal — but note it does not fail *open* either: a
   * selector that cannot be resolved here is rejected, because an element we cannot
   * inspect is an element we cannot vouch for.
   *
   * @param page - Live page.
   * @param response - The provider's suggestion.
   * @param intent - What the test was trying to do.
   * @returns The verdict.
   */
  private async verifyIntent(
    page: Page,
    response: HealingResponse,
    intent: { originalSelector: string; action: string; description?: string }
  ): Promise<IntentVerdict> {
    if (this.verifier.mode === 'off') {
      return { ok: true, summary: { mode: 'off', verified: false, checks: [] } };
    }

    try {
      const locator = this.validator.resolve(response.suggestedSelector, page);
      if (!locator) {
        return {
          ok: false,
          reason: 'the suggestion could not be resolved for intent checking',
          summary: { mode: this.verifier.mode, verified: false, checks: [] },
        };
      }

      return await this.verifier.verify(locator, {
        originalSelector: intent.originalSelector,
        suggestedSelector: response.suggestedSelector,
        action: intent.action,
        ...(intent.description !== undefined ? { description: intent.description } : {}),
        confidence: response.confidence,
        ...(response.expectedRole !== undefined ? { expectedRole: response.expectedRole } : {}),
        ...(response.expectedName !== undefined ? { expectedName: response.expectedName } : {}),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.log.warn(`Intent check errored (treating as a rejection): ${detail}`);
      return {
        ok: false,
        reason: `intent check failed: ${detail}`,
        summary: { mode: this.verifier.mode, verified: false, checks: [] },
      };
    }
  }

  /**
   * Checks that a configured snapshot root exists on this page.
   *
   * Deliberately a short wait rather than the provider timeout. By the time healing
   * runs, the action it is recovering from has already timed out against this page, so
   * a container that is genuinely present has long since rendered — and a root that is
   * simply absent (one selector, many pages) would otherwise stall every heal for
   * `HEALER_TIMEOUT` before failing.
   *
   * @param page - Live page.
   * @param root - Selector from the privacy policy.
   * @returns True when the root resolves. Never throws — a malformed selector is a
   * failure to resolve, which blocks the heal.
   */
  private async rootResolves(page: Page, root: string): Promise<boolean> {
    try {
      await page.locator(root).first().waitFor({
        state: 'attached',
        timeout: SNAPSHOT_ROOT_TIMEOUT_MS,
      });
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.log.debug(`Snapshot root "${root}" did not resolve: ${detail}`);
      return false;
    }
  }

  /**
   * Walks the stack to find the first frame outside the framework.
   *
   * Both halves are parsed from a single stack read: taking the file and the line
   * from separate regexes over separate stacks can pair a file with another frame's
   * line number. Framework frames (`src/core`, `src/providers`, `dist/...`,
   * `node_modules`, node internals) are skipped, and a `.spec.ts`/`.test.ts` frame
   * wins over any other candidate.
   *
   * @returns The caller's file and line, with `'unknown'`/`0` as fallbacks.
   */
  private getCallerLocation(): CallerLocation {
    const stack = new Error().stack ?? '';
    const frames = stack.split('\n').slice(1);

    let firstExternal: CallerLocation | null = null;

    for (const frame of frames) {
      const parsed = this.parseFrame(frame);
      if (!parsed) continue;
      if (INTERNAL_FRAME_PATTERN.test(parsed.file)) continue;

      // A spec file is unambiguously the caller we want. Frames run callee-first, so by
      // the time we reach it any page object between it and the action has already been
      // recorded — and that is where the selector is actually written.
      if (TEST_FILE_PATTERN.test(parsed.file)) {
        return firstExternal && firstExternal.file !== parsed.file
          ? { ...parsed, source: { file: firstExternal.file, line: firstExternal.line } }
          : parsed;
      }

      // Otherwise remember the first non-framework frame as a fallback: the caller
      // may be a page object or a helper rather than the spec itself.
      if (!firstExternal) firstExternal = parsed;
    }

    return firstExternal ?? { file: 'unknown', line: 0 };
  }

  /**
   * Extracts `file:line` from one V8 stack frame.
   *
   * Handles both `at fn (file:line:col)` and bare `at file:line:col` forms, and
   * Windows paths with drive letters (`C:\...`), which a naive `:` split breaks.
   *
   * @param frame - One line of a stack trace.
   * @returns The location, or `null` if the frame has no source position.
   */
  private parseFrame(frame: string): CallerLocation | null {
    const match = /\(?((?:[A-Za-z]:)?[^()]+?):(\d+):(\d+)\)?\s*$/.exec(frame.trim());
    if (!match?.[1] || !match[2]) return null;

    const file = match[1].replace(/^.*?\bat\s+/, '').trim();
    if (!file) return null;

    return { file, line: Number(match[2]) };
  }

  /**
   * Expands one answer into every option worth trying, in the model's own order.
   *
   * Three jobs, all so the loop above can reason about expressions alone:
   *
   * 1. **A candidate id becomes a locator.** The id indexes the list this engine
   *    offered, and the locator comes from `CandidateFinder` rather than the model —
   *    which is the whole point, since an authored locator is where a correct diagnosis
   *    used to turn into a failed heal.
   * 2. **Alternatives are flattened in.** They cost a local `count()` each, so trying
   *    them is cheaper than a retry by three orders of magnitude.
   * 3. **The frame path goes back on.** The model was shown the frame's content, so it
   *    answers in the frame's terms — a bare `getByRole('button')` that would resolve
   *    against the *parent* document if taken literally. Qualifying here means
   *    validation, the intent check, the cache, the record and the suggested rewrite all
   *    agree on one fully-qualified expression that can be pasted into a page object.
   *
   * An out-of-range id is dropped rather than clamped: `candidateId: 99` on a list of
   * twelve is not a near-miss, it is an answer about a list the model did not have, and
   * acting on the twelfth element would heal onto something nobody chose. Dropping every
   * option leaves an empty array, which the caller reports as a rejection with a reason.
   *
   * Token usage rides on the first option only. It is billed per *call*, and every
   * option here came from one call — so charging each would triple the spend a record
   * reports for a heal that used a runner-up.
   *
   * @param response - The parsed answer.
   * @param candidates - The list that was offered, for resolving ids against.
   * @param frames - Frame path from the failing expression, outermost first.
   * @returns One entry per usable option, best first.
   */
  private resolveChoices(
    response: HealingResponse,
    candidates: ElementCandidate[],
    frames: string[]
  ): { response: HealingResponse; rank: number; source: string }[] {
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));

    /** One option as the model expressed it, before it becomes a locator. */
    const options: HealingAlternative[] = [
      {
        ...(response.candidateId !== undefined ? { candidateId: response.candidateId } : {}),
        ...(response.suggestedSelector ? { suggestedSelector: response.suggestedSelector } : {}),
        confidence: response.confidence,
        reasoning: response.reasoning,
        ...(response.expectedRole !== undefined ? { expectedRole: response.expectedRole } : {}),
        ...(response.expectedName !== undefined ? { expectedName: response.expectedName } : {}),
      },
      ...(response.alternatives ?? []),
    ];

    const resolved: { response: HealingResponse; rank: number; source: string }[] = [];
    const seen = new Set<string>();

    for (const option of options) {
      let selector: string | undefined;
      let source: string;
      // The model's own claim about what it targeted, left exactly as it made it.
      //
      // Substituting the candidate's role and name here looked like an upgrade — they
      // come from the snapshot rather than the model's recollection — and silently
      // disabled a safety check. `IntentVerifier.checkSelfConsistency` records a check
      // whenever an expected role or name is present, and
      // `IntentVerifier.checkConfidenceFloor` only applies when *no* check had signal.
      // So injecting these satisfied the floor with a comparison that carries no
      // evidence about whether the element is right: it only confirms the snapshot
      // agrees with the DOM, which is nearly always true. Measured on an opaque
      // `#btn-x7f3` with no describe() and confidence 0.75 against a page offering
      // "Proceed" and "Abort", the floor of 0.9 rejected the written selector and
      // accepted the pick — onto "Abort".
      //
      // A pick makes no claim about role or name, so there is nothing to self-check and
      // the floor should apply, exactly as it did before candidates existed.
      const expectedRole = option.expectedRole;
      const expectedName = option.expectedName;

      if (option.candidateId !== undefined) {
        const candidate = byId.get(option.candidateId);
        if (!candidate?.selector) {
          this.log.debug(
            `Ignoring candidate id ${option.candidateId}: the list offered ` +
              `${candidates.length === 0 ? 'none' : `1-${candidates.length}`}.`
          );
          continue;
        }
        selector = candidate.selector;
        source = `candidate ${candidate.id}`;
      } else if (option.suggestedSelector) {
        selector = option.suggestedSelector;
        source = 'model-written selector';
      } else {
        continue;
      }

      if (resolved.length >= MAX_OPTIONS_PER_ANSWER) {
        this.log.debug(
          `Ignoring the remaining option(s): at most ${MAX_OPTIONS_PER_ANSWER} are tried per answer.`
        );
        break;
      }

      const qualified = this.validator.qualifyWithFrames(selector, frames);

      // A model that answers with both an id and that candidate's own locator, or that
      // repeats a choice as its own alternative, should not be charged two attempts at
      // the same element.
      if (seen.has(qualified)) continue;
      seen.add(qualified);

      resolved.push({
        rank: resolved.length + 1,
        source,
        response: {
          ...response,
          suggestedSelector: qualified,
          confidence: option.confidence,
          reasoning: option.reasoning,
          ...(option.candidateId !== undefined ? { candidateId: option.candidateId } : {}),
          ...(expectedRole !== undefined ? { expectedRole } : {}),
          ...(expectedName !== undefined ? { expectedName } : {}),
          // Billed once per call, not once per option tried. See the note above.
          tokenUsage:
            resolved.length === 0 ? response.tokenUsage : { input: 0, output: 0 },
          alternatives: [],
        },
      });
    }

    return resolved;
  }

  /**
   * Merges the original Playwright error with any rejected suggestions into the
   * `error` field of the next request.
   *
   * {@link HealingRequest} has no dedicated field for previous attempts, and this is
   * the field the prompt already presents as failure context — so the retry sees
   * exactly what went wrong last time.
   *
   * @param error - Original Playwright error, if any.
   * @param rejected - Descriptions of suggestions already rejected.
   * @returns The combined context, or `undefined` when there is nothing to say.
   */
  private buildErrorContext(error: Error | undefined, rejected: string[]): string | undefined {
    const parts: string[] = [];

    if (error?.message) parts.push(error.message);
    if (rejected.length) {
      parts.push(
        `Do not suggest these again — they were already rejected: ${rejected.join('; ')}.`
      );
    }

    return parts.length ? parts.join(' ') : undefined;
  }

  /**
   * Asks the provider whether a heal that passed every other check is the same control.
   * See `HealConfig.confirm`.
   *
   * Fails **closed**: an error, a timeout, an unreadable reply, a privacy veto, or an
   * exhausted budget all reject the heal, with the reason recorded. A missed heal is a red
   * test with an explanation; a wrong one is a green test doing the wrong thing.
   *
   * Two cases skip the question. The new name is the old text exactly — the element moved,
   * and there is nothing to judge. Or the provider cannot answer one — a custom provider
   * written against `heal()` alone — which leaves healing exactly as it was before this
   * existed, rather than breaking it.
   *
   * @param context - The heal, and the element as the DOM describes it.
   * @param budget - Second opinions left for this heal; decremented.
   * @returns Whether to accept it, why not, and what the question cost.
   */
  private async confirmChoice(
    context: {
      originalSelector: string;
      action: string;
      description?: string;
      missingText: string[];
      pageUrl: string;
      suggestedSelector: string;
      observed: IntentSummary;
      /** The element's named ancestors, from its candidate entry. */
      ancestry: string[];
      /**
       * The other candidates in the same group, when the element was a candidate at all.
       * Absent for a free-form heal, whose neighbours were never enumerated.
       */
      siblings?: { role: string; name: string }[];
      /**
       * True when this opinion is settling a lexical objection: anything short of a
       * clear "same" — including no provider support — keeps that objection.
       */
      required: boolean;
      /** The lexical objection being settled, kept as the reason if it stands. */
      overruled?: string;
    },
    budget: { left: number }
  ): Promise<{ ok: boolean; asked: boolean; reason?: string; tokens?: HealingResponse['tokenUsage'] }> {
    const standing = context.overruled ?? 'a second opinion did not confirm it';
    if (!this.canConfirm()) {
      return context.required ? { ok: false, asked: false, reason: standing } : { ok: true, asked: false };
    }
    const provider = this.aiProvider;

    const role = context.observed.role ?? 'element';
    const name = context.observed.name ?? '';
    const normalise = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();
    if (
      !context.required &&
      name !== '' &&
      selectorLiterals(context.originalSelector).some((literal) => normalise(literal) === normalise(name))
    ) {
      return { ok: true, asked: false };
    }

    if (budget.left <= 0) {
      return {
        ok: false,
        asked: false,
        reason: `no second opinion was left for this heal (at most ${MAX_CONFIRMS_PER_HEAL}), so it was not accepted`,
      };
    }
    budget.left -= 1;

    // Built through the same redaction as the heal itself, so the question discloses
    // nothing the heal would not have — the proposed name is treated as a candidate name.
    let question: ConfirmQuestion;
    try {
      const outbound = this.guard.sanitizeRequest({
        originalSelector: context.originalSelector,
        originalAction: context.action,
        ariaSnapshot: '',
        pageUrl: context.pageUrl,
        testFile: '',
        testLine: 0,
        ...(context.description !== undefined ? { description: context.description } : {}),
        ...(context.missingText.length > 0 ? { missingText: context.missingText } : {}),
        // The neighbours ride along as further candidates, so their names get exactly the
        // treatment the candidate list gives them — collapsed under strict, and shown to a
        // custom redactor.
        candidates: [
          { id: 1, role, name, context: context.ancestry },
          ...(context.siblings ?? []).map((sibling, index) => ({
            id: index + 2,
            role: sibling.role,
            name: sibling.name,
            context: [],
          })),
        ],
      });
      const sent = outbound.candidates?.[0];
      const siblings =
        context.siblings !== undefined ? (outbound.candidates ?? []).slice(1).map((c) => c.name) : undefined;
      question = {
        originalSelector: outbound.originalSelector,
        action: context.action,
        ...(outbound.description !== undefined ? { description: outbound.description } : {}),
        ...(outbound.missingText !== undefined ? { missingText: outbound.missingText } : {}),
        proposed: {
          role,
          name: sent?.name ?? '',
          ...(name === '' ? { locator: this.guard.redactSelector(context.suggestedSelector) } : {}),
          ...(sent && sent.context.length > 0 ? { context: sent.context } : {}),
          ...(siblings !== undefined ? { siblings } : {}),
        },
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        asked: false,
        reason: `the second-opinion question could not be sent under the privacy policy: ${detail}`,
      };
    }

    try {
      const answer = await this.withDeadline(
        (signal) =>
          provider.confirm(question, {
            signal,
            ...(this.config.confirmModel !== undefined ? { model: this.config.confirmModel } : {}),
          }),
        Math.min(this.config.timeout, CONFIRM_TIMEOUT_MS),
        'second-opinion call'
      );
      if (answer === null) {
        return context.required ? { ok: false, asked: false, reason: standing } : { ok: true, asked: false };
      }
      if (!answer.same) {
        return {
          ok: false,
          asked: true,
          reason: `a second opinion judged it a different control${answer.reason ? `: ${answer.reason}` : ''}`,
          tokens: answer.tokenUsage,
        };
      }
      return { ok: true, asked: true, tokens: answer.tokenUsage };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        asked: true,
        reason: `no second opinion could be obtained (${detail}), so the heal was not accepted`,
      };
    }
  }

  /**
   * Whether a second opinion can be asked: switched on, and a provider that can answer.
   * A provider installed with `setHealingEngine()` may be any object with `heal()`, and
   * one built on {@link AiProvider} without `complete()` reports that it cannot.
   *
   * @returns True when {@link confirmChoice} will actually ask.
   */
  private canConfirm(): boolean {
    if (this.config.confirm === false) return false;
    const provider = this.aiProvider as Partial<AiProvider> & { canConfirm?: boolean };
    return typeof provider.confirm === 'function' && provider.canConfirm === true;
  }

  /**
   * Runs work with a hard deadline, and **cancels it** when the deadline passes.
   *
   * The cancellation is the point. Losing a race only abandons a promise: the work
   * carries on. A provider retrying twice against a hung endpoint kept two further
   * attempts alive after the engine had given up, holding sockets for up to another two
   * timeouts and — worse — making requests nobody would ever read the answer to. Two
   * deadlines with no relationship to each other, where the outer had no authority over
   * the inner.
   *
   * The work is therefore handed a signal rather than a bare promise, and the deadline
   * aborts as well as rejects. A provider that ignores the signal is no worse off than
   * before, which is what keeps it optional on the {@link AiProvider} contract.
   *
   * @param start - Begins the work, given a signal that aborts at the deadline.
   * @param timeoutMs - Deadline in milliseconds.
   * @param label - Name used in the timeout message.
   * @returns The work's value.
   * @throws {Error} If the deadline passes first.
   */
  private async withDeadline<T>(
    start: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    label: string
  ): Promise<T> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;

    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new DeadlineError(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([start(controller.signal), deadline]);
    } finally {
      // Always cleared, so a resolved race cannot keep the process alive.
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Records an attempt built from a provider response.
   *
   * @param location - Test file and line that triggered the heal.
   * @param originalSelector - The selector that failed.
   * @param response - The provider's suggestion.
   * @param success - Whether the suggestion was accepted and used.
   * @param error - Why it was rejected, when `success` is false.
   * @param intent - What the intent check concluded, when it ran.
   * @param described - Whether the locator carried a `describe()`.
   * @param candidateId - Which candidate was picked, when the answer was a pick.
   */
  private recordFromResponse(
    location: CallerLocation,
    originalSelector: string,
    response: HealingResponse,
    success: boolean,
    error?: string,
    intent?: IntentSummary,
    described?: boolean
  ): HealRecord {
    return this.record(
      location,
      originalSelector,
      response.suggestedSelector,
      response.confidence,
      response.provider,
      response.tokenUsage,
      success,
      error,
      response.reasoning,
      intent,
      described,
      response.candidateId
    );
  }

  /**
   * Writes one {@link HealRecord}. Failures inside the recorder are swallowed by
   * the recorder itself, so this never interrupts a heal.
   *
   * @param location - Test file and line that triggered the heal.
   * @param originalSelector - The selector that failed.
   * @param suggestedSelector - What the AI proposed, or `''` if it never answered.
   * @param confidence - Reported confidence, 0 when unknown.
   * @param provider - Provider identifier.
   * @param tokens - Token usage, defaulting to zeros when the call failed.
   * @param success - Whether the heal worked.
   * @param error - Failure reason, when applicable.
   * @param reasoning - The model's stated justification, when it gave one.
   * @param intent - What the intent check concluded, when it ran.
   */
  private record(
    location: CallerLocation,
    originalSelector: string,
    suggestedSelector: string,
    confidence: number,
    provider: string,
    tokens: { input: number; output: number; cached?: number } | undefined,
    success: boolean,
    error?: string,
    reasoning?: string,
    intent?: IntentSummary,
    described?: boolean,
    candidateId?: number
  ): HealRecord {
    const record: HealRecord = {
      timestamp: new Date().toISOString(),
      file: location.file,
      line: location.line,
      originalSelector,
      suggestedSelector,
      confidence,
      provider,
      tokens: tokens ?? { input: 0, output: 0 },
      success,
      ...(error !== undefined ? { error } : {}),
      // Persisted from 0.3.0. Every provider already parsed this and then dropped it,
      // so the token spend bought an explanation nobody could read.
      ...(reasoning !== undefined && reasoning !== '' ? { reasoning } : {}),
      ...(intent !== undefined ? { intent } : {}),
      ...(described !== undefined ? { described } : {}),
      ...(candidateId !== undefined ? { candidateId } : {}),
    };

    this.recorder.recordHeal(record);
    return record;
  }
}

/**
 * Patterns that carry a literal the test expected to find on the page.
 *
 * XPath text predicates, Playwright's text engines, and the quoted argument of a
 * `getByText`/`getByRole` call. Deliberately narrow: only forms whose captured group
 * really is *page text*. An `#id` or a class name is not page text — it would never
 * appear in a snapshot even when the element is present, so reporting it absent would
 * be noise on every heal.
 */
const TEXT_LITERAL_PATTERNS: readonly RegExp[] = [
  // //span[text()='X'], //*[contains(text(), "X")], [.='X']
  /(?:text\(\)|\.)\s*(?:=|,)\s*(['"])(.+?)\1/g,
  // :has-text("X"), :text-is('X')
  /:(?:has-)?text(?:-is)?\(\s*(['"])(.+?)\1\s*\)/g,
  // text=X  (bare to end of expression)
  /\btext=(['"]?)(.+?)\1$/g,
  // getByText('X'), getByLabel("X"), getByPlaceholder('X'), getByTitle('X'), getByAltText('X')
  /getBy(?:Text|Label|Placeholder|Title|AltText)\(\s*(['"])(.+?)\1/g,
  // { name: 'X' }
  /\bname\s*:\s*(['"])(.+?)\1/g,
];

/** Shortest literal worth reporting absent, to keep single letters out of the prompt. */
const MIN_LITERAL_LENGTH = 2;

/**
 * Finds the literals a selector looked for that the snapshot does not contain.
 *
 * This is a fact the framework can establish by string search, and models miss it. The
 * record that prompted the check spent its first attempt answering
 * `getByText('Charter Cloud', { exact: true })` against a page whose snapshot held no
 * "Charter Cloud" anywhere — a call and a retry spent re-asserting the premise that had
 * just failed.
 *
 * Case-insensitive, because a rename that only changes capitalisation is a rename the
 * model can still see in the snapshot; claiming that text is *gone* would be wrong.
 *
 * @param selector - The selector that failed, as written in the test.
 * @param snapshot - The page snapshot that will be sent.
 * @returns The absent literals, in the order they appear in the selector, deduplicated.
 */
export function missingLiterals(selector: string, snapshot: string): string[] {
  const haystack = (snapshot ?? '').toLowerCase();
  if (haystack === '') return [];

  const missing: string[] = [];
  const seen = new Set<string>();

  for (const pattern of TEXT_LITERAL_PATTERNS) {
    // Each pattern is module-level and global, so its lastIndex has to be reset or a
    // second heal in the same worker starts scanning from wherever the first stopped.
    pattern.lastIndex = 0;

    for (const match of (selector ?? '').matchAll(pattern)) {
      const literal = (match[2] ?? '').trim();
      if (literal.length < MIN_LITERAL_LENGTH) continue;

      const key = literal.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      if (!haystack.includes(key)) missing.push(literal);
    }
  }

  return missing;
}
