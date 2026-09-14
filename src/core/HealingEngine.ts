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
  HealConfig,
  HealRecord,
  HealingRequest,
  HealingResponse,
  IntentSummary,
} from '../types';
import { getAriaSnapshot } from '../utils/DOMSnapshot';
import { createLogger, type Logger } from '../utils/logger';
import { HealingRecorder } from '../utils/HealingRecorder';
import { PromptBuilder } from '../utils/PromptBuilder';
import type { AiProvider } from './AiProvider';
import { HealBudget } from './HealBudget';
import { IntentVerifier, type IntentVerdict } from './IntentVerifier';
import { PrivacyBlockedError, PrivacyGuard } from './PrivacyGuard';
import { SelectorCache } from './SelectorCache';
import { SelectorValidator, type ValidationResult } from './SelectorValidator';

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
  tokens: { input: number; output: number };
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
    this.cache = options.cache ?? new SelectorCache(config.cache ?? true);
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
   * @returns Everything that happened, including per-attempt records.
   */
  async attemptHealDetailed(
    page: Page,
    originalSelector: string,
    action: string,
    description?: string,
    error?: Error
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
    ): HealOutcome => {
      const outcome = this.buildOutcome(
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
      );

      // Notifying a listener must never affect the heal.
      try {
        this.onOutcome?.(outcome);
      } catch (listenerError) {
        const detail = listenerError instanceof Error ? listenerError.message : String(listenerError);
        this.log.debug(`onOutcome handler threw (ignored): ${detail}`);
      }

      return outcome;
    };

    // `collected` is passed explicitly rather than held on the instance: one engine
    // serves every test in a worker, and concurrent actions can heal at the same time.
    return this.healLoop(
      page,
      {
        originalSelector,
        action,
        ...(description !== undefined ? { description } : {}),
        ...(error !== undefined ? { error } : {}),
      },
      collected,
      outcomeOf
    );
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
      tokens: collected.reduce(
        (sum, record) => ({
          input: sum.input + (record.tokens?.input ?? 0),
          output: sum.output + (record.tokens?.output ?? 0),
        }),
        { input: 0, output: 0 }
      ),
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
    context: { originalSelector: string; action: string; description?: string; error?: Error },
    collected: HealRecord[],
    outcomeOf: (
      healed: string | null,
      pageUrl: string,
      failure?: string,
      blocked?: true,
      skipped?: true
    ) => HealOutcome
  ): Promise<HealOutcome> {
    const { originalSelector, action, description, error } = context;
    const location = this.getCallerLocation();

    // 1. Respect the master switch before doing any work.
    if (!this.config.enabled) {
      this.log.debug('Healing is disabled — skipping.');
      return outcomeOf(null, '', 'healing is disabled');
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
        timeoutMs: this.config.timeout,
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
          ariaSnapshot,
          pageUrl,
          testFile: location.file,
          testLine: location.line,
          ...(description !== undefined ? { description } : {}),
          ...(errorContext !== undefined ? { error: errorContext } : {}),
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
            systemPrompt: PromptBuilder.buildSystemPrompt(),
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

        let response: HealingResponse;
        if (!charged) {
          this.budget.spend();
          charged = true;
        }
        try {
          response = await this.withDeadline(
            (signal) => this.aiProvider.heal(outbound, { signal }),
            this.config.timeout,
            'provider call'
          );
          // The call worked. Whatever the model said, the provider is healthy, so the
          // breaker's consecutive-failure count starts again.
          this.budget.recordProviderSuccess();
        } catch (providerError) {
          // A failed *call* — network, credential, timeout. A low-confidence answer or a
          // rejected suggestion is not a provider failure and must not trip the breaker.
          this.budget.recordProviderFailure();
          const detail = providerError instanceof Error ? providerError.message : String(providerError);
          this.log.warn(`Attempt ${attempt} failed: ${detail}`);
          collected.push(
            this.record(location, originalSelector, '', 0, this.config.provider, undefined, false, detail)
          );
          continue;
        }

        // 4b. Put the frame path back on the answer. The model was shown the frame's
        //     content, so it answers in the frame's terms — a bare `getByRole('button')`
        //     that would resolve against the *parent* document if taken literally.
        //     Qualifying here means validation, the intent check, the cache, the record
        //     and the suggested rewrite all agree on one fully-qualified expression that
        //     can be pasted straight into a page object.
        response = {
          ...response,
          suggestedSelector: this.validator.qualifyWithFrames(response.suggestedSelector, frames),
        };

        // 5a. Reject low-confidence suggestions before touching the page.
        if (response.confidence < this.config.confidenceThreshold) {
          const reason =
            `confidence ${response.confidence} is below the threshold ` +
            `${this.config.confidenceThreshold}`;
          this.log.warn(`Attempt ${attempt} rejected: ${reason}.`);
          collected.push(this.recordFromResponse(location, originalSelector, response, false, reason));
          rejected.push(`${response.suggestedSelector} (${reason})`);
          continue;
        }

        // 5b. Verify the suggestion resolves to exactly one element. This is what
        //     separates a plausible selector from a working one.
        let validation: ValidationResult;
        try {
          validation = await this.validator.validateDetailed(response.suggestedSelector, page);
        } catch (validationError) {
          const detail = validationError instanceof Error ? validationError.message : String(validationError);
          validation = { valid: false, matches: -1, reason: `validation error: ${detail}` };
        }

        if (!validation.valid) {
          const reason = validation.reason ?? 'selector did not validate';
          // Both halves are model-derived and both can carry page text: the suggestion
          // may be `getByText('Smith, John')`, and a reason can quote the suffix it
          // refused. The record written below keeps the real values.
          this.log.warn(
            `Attempt ${attempt} rejected: ` +
              `"${this.guard.redactSelector(response.suggestedSelector)}" ` +
              `${this.guard.redactMessage(reason)}.`
          );
          collected.push(this.recordFromResponse(location, originalSelector, response, false, reason));
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

        if (!verdict.ok) {
          const reason = verdict.reason ?? 'did not match the intended element';
          // The intent reason quotes the element the model landed on, which is the whole
          // point of the check and also the reason this line needs redacting.
          this.log.warn(
            `Attempt ${attempt} rejected on intent: ` +
              `"${this.guard.redactSelector(response.suggestedSelector)}" — ` +
              `${this.guard.redactMessage(reason)}.`
          );
          collected.push(
            this.recordFromResponse(location, originalSelector, response, false, reason, verdict.summary)
          );
          rejected.push(`${response.suggestedSelector} (${reason})`);
          continue;
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
            response,
            true,
            undefined,
            verdict.summary,
            description !== undefined && description.trim() !== ''
          )
        );
        // Redacted for the log line only. The model may have chosen page text as the
        // identifier, and a log line is one of the places that reaches CI output. The
        // record written above keeps the real value.
        this.log.info(
          `Healed "${originalSelector}" -> "${this.guard.redactSelector(response.suggestedSelector)}" ` +
            `(confidence ${response.confidence}, ${response.provider}, ` +
            `intent checks: ${verdict.summary.checks.join('+') || 'none'}).`
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

      this.log.warn(`Healing failed for "${originalSelector}" after ${attempts} attempt(s).`);
      const lastReason = collected[collected.length - 1]?.error;
      return outcomeOf(
        null,
        pageUrl,
        lastReason ?? `no working selector after ${attempts} attempt(s)`
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
        this.cache.noteHit(originalSelector, this.guard.redactSelector(candidate.selector));

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
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
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
      described
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
    tokens: { input: number; output: number } | undefined,
    success: boolean,
    error?: string,
    reasoning?: string,
    intent?: IntentSummary,
    described?: boolean
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
    };

    this.recorder.recordHeal(record);
    return record;
  }
}
