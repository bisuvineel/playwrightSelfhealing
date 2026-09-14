/**
 * Drop-in replacement for Playwright's `test`, with self-healing locators.
 *
 * ```ts
 * import { test, expect } from 'self-healing-playwright/core/TestWrapper';
 *
 * test('checkout', async ({ page }) => {
 *   await page.goto('/cart');
 *   await page.locator('#submit-btn').describe('the order submit button').click();
 * });
 * ```
 *
 * How it works: the `page` fixture is decorated so locator actions run inside a
 * try/catch. On failure the {@link HealingEngine} is asked for a replacement
 * selector, and the *same action with the same arguments* is retried against it. If
 * healing does not produce a working selector, the **original** Playwright error is
 * re-thrown — a test must never fail with a message from the healer instead of the
 * real failure.
 *
 * Two things are deliberate and worth knowing:
 *
 * - The engine is built **once per process**, not per test. Constructing it involves
 *   reading config, creating an SDK client, and loading the healing records file;
 *   doing that per test would add measurable overhead to every test in the suite.
 * - Healed selectors are resolved through {@link SelectorValidator}, not
 *   `page.locator()`. The AI answers with expressions like
 *   `getByRole('button', { name: 'Submit' })`, which `page.locator()` cannot parse.
 *
 * @module core/TestWrapper
 */

import {
  test as base,
  type FrameLocator,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';

import { getConfig, getModel, isFailOnHeal, type Config } from '../config';
import type {
  HealConfig,
  IntentMode,
  IntentSummary,
  PrivacyPolicy,
  ProviderType,
  RedactLevel,
  Redactor,
} from '../types';
import { HealingRecorder } from '../utils/HealingRecorder';
import { createLogger } from '../utils/logger';
import { relativeToProject } from '../utils/paths';
import type { AiProvider } from './AiProvider';
import { HealBudget } from './HealBudget';
import { HealingEngine, type HealOutcome } from './HealingEngine';
import { IntentVerifier } from './IntentVerifier';
import { PrivacyGuard } from './PrivacyGuard';
import { SelectorValidator } from './SelectorValidator';
import { AnthropicProvider } from '../providers/AnthropicProvider';
import { GeminiProvider } from '../providers/GeminiProvider';
import { OpenAIProvider } from '../providers/OpenAIProvider';

const log = createLogger('heal:test');

/**
 * Locator actions that are wrapped with healing.
 *
 * Every one of these takes a locator and interacts with a single element, so a
 * failure is exactly the case healing exists for. Methods absent from the installed
 * Playwright version are skipped at runtime rather than crashing.
 */
const HEALED_ACTIONS = [
  'click',
  'dblclick',
  'fill',
  'check',
  'uncheck',
  'hover',
  'selectOption',
  'press',
  'pressSequentially',
  'type',
  'tap',
  'focus',
  'clear',
  'selectText',
  'setInputFiles',
  'scrollIntoViewIfNeeded',
] as const;

/** `page.getBy*` helpers that are wrapped so they also produce healable locators. */
const GET_BY_METHODS = [
  'getByRole',
  'getByLabel',
  'getByText',
  'getByPlaceholder',
  'getByTestId',
  'getByTitle',
  'getByAltText',
] as const;

/** Positional refinements that keep a locator healable by extending its expression. */
const REFINEMENTS = ['first', 'last', 'nth'] as const;

/** Property used to carry the author's description along a locator. */
const DESCRIPTION_KEY = '_healerDescription';

/** Property used to carry the selector expression a locator was built from. */
const EXPRESSION_KEY = '_healerExpression';

/** A locator that can be annotated with intent for better healing. */
export interface HealableLocator extends Locator {
  /**
   * Describes what this locator is meant to find, e.g. `'the order submit button'`.
   *
   * The description is passed to the AI and is the single highest-value input for
   * healing: it distinguishes "the Submit button in the checkout form" from the four
   * other buttons that also say Submit.
   *
   * @param description - Human-readable intent.
   * @returns The same locator, for chaining.
   */
  describe(description: string): HealableLocator;
}

/** Internal view of a locator carrying healer metadata. */
type AnnotatedLocator = Locator & {
  [DESCRIPTION_KEY]?: string;
  [EXPRESSION_KEY]?: string;
};

/** Cached engine, built on first use. `null` means healing is off for this process. */
let engine: HealingEngine | null | undefined;

/** Why healing is unavailable, so each test can say so in the report. */
let unavailableReason: string | null = null;

/**
 * Annotation types published to the Playwright report.
 *
 * They appear verbatim in the HTML report and in `test-results.json`, so a reporter
 * (or a CI script) can pick them out without parsing prose.
 */
export const HEAL_ANNOTATIONS = {
  /** A selector was repaired and the action succeeded. */
  healed: 'healed',
  /** Healing ran but produced nothing usable; the original error was re-thrown. */
  failed: 'heal-failed',
  /** Healing could not run at all — no API key, bad config, provider unimplemented. */
  unavailable: 'heal-unavailable',
  /**
   * The privacy policy refused to transmit this page — a blocked route, a vetoing
   * redactor, or preview mode. Distinct from `heal-failed` on purpose: nothing left
   * the machine, so this is a policy decision to review, not a model failure to tune.
   */
  blocked: 'heal-blocked',
  /**
   * The spend ceiling or the circuit breaker declined to pay for this heal. Distinct
   * from the three above: the page was fine, the model was never asked, and the cause
   * is a cost or availability decision rather than a policy, a key, or a bad suggestion.
   */
  skipped: 'heal-skipped',
} as const;

/** Resolver shared by every retry, for turning healed expressions into locators. */
const resolver = new SelectorValidator();

/**
 * Redacts a selector for display, using the engine's own policy.
 *
 * Redaction governs what goes *to* a provider; a selector coming *back* can carry page
 * text — `getByText('Smith, John')` — into a report annotation, a failure message, and CI
 * output, which are usually readable by more people than the machine that produced them.
 * `healing-records.json` stays unredacted, so the exact rewrite is always recoverable
 * locally.
 *
 * Falls back to the raw value if no engine is resolvable, because a display helper must
 * never be the thing that breaks reporting.
 *
 * @param selector - A selector produced by the model.
 * @returns The selector as it is safe to show.
 */
function forDisplay(selector: string): string {
  try {
    return engine?.privacy.redactSelector(selector) ?? selector;
  } catch {
    return selector;
  }
}

/**
 * Redacts framework prose that quotes page content, using the engine's own policy.
 *
 * Redacting selectors was only half the surface. A heal rejected on intent reports *why*,
 * and the why quotes the element: `resolves to "Smith, John 1970-03-11"`. That string is
 * the `heal-failed` annotation, the attachment's `reason`, and the reporter's "Not healed"
 * block — the same three places a healed selector reaches, with the same readership.
 *
 * @param message - Text that may quote page content.
 * @returns The message as it is safe to show.
 */
function messageForDisplay(message: string): string {
  try {
    return engine?.privacy.redactMessage(message) ?? message;
  } catch {
    return message;
  }
}

/**
 * Redacts an element's accessible name, using the engine's own policy.
 *
 * A name is page content end to end, so it is collapsed wholesale at `strict` rather than
 * quote-by-quote. See {@link PrivacyGuard.redactName}.
 *
 * @param name - Accessible name read from the live element.
 * @returns The name as it is safe to show.
 */
function nameForDisplay(name: string): string {
  try {
    return engine?.privacy.redactName(name) ?? name;
  } catch {
    return name;
  }
}

/**
 * Redacts the page-derived fields of an intent summary, for the report attachment.
 *
 * The attachment travels with the HTML report, which is the artefact CI uploads — so the
 * observed accessible name and the rejection reason need the same treatment the selector
 * beside them already gets. `healing-records.json` keeps the unredacted copy.
 *
 * @param intent - Summary as the verifier produced it.
 * @returns A copy safe to attach.
 */
function intentForDisplay(intent: IntentSummary): IntentSummary {
  return {
    ...intent,
    ...(intent.name !== undefined ? { name: nameForDisplay(intent.name) } : {}),
    ...(intent.reason !== undefined ? { reason: messageForDisplay(intent.reason) } : {}),
  };
}

/**
 * Successful heals recorded during the current test, for the fail-on-heal gate.
 *
 * A plain module-level array rather than a map keyed by `TestInfo`. Playwright runs one
 * test at a time per worker process, and the next test's fixtures do not start until
 * this one's teardown has finished — so there is never more than one test collecting
 * here. Keying by object identity would add a way for the gate to silently never fire
 * if the two `TestInfo` references ever diverged, which is a bad failure mode for a
 * safety feature.
 *
 * Reset when the **test** changes and drained when the gate runs, so neither an unusual
 * integration path nor a test that never reaches teardown can leak heals into the next
 * test's report.
 */
let healsThisTest: HealOutcome[] = [];

/**
 * Which test {@link healsThisTest} belongs to.
 *
 * This exists because the reset used to happen on every *decoration*, and a test can
 * decorate more than once: a popup, a second tab, an OAuth window, a print preview. The
 * second `attachHealing` threw away every heal from the first page, so the CI gate reported
 * one heal where two had happened — silently, and only in tests that span pages. Measured
 * at 1 of 2 before this, 2 of 2 after.
 *
 * Keyed by `testId` and `retry` rather than by `TestInfo` object identity: a retry is a
 * different attempt and must start clean, and a string key cannot be defeated by two
 * references to the same test diverging.
 */
let healsTestKey: string | null = null;

/** Whether this worker has already reported that the CI gate could not be configured. */
let warnedAboutGateConfig = false;

/**
 * Starts, or continues, collecting heals for the current test.
 *
 * Called from every decoration entry point. Decorating twice within one test continues the
 * same collection; the first decoration of a new test starts a fresh one.
 */
function beginHealCollection(): void {
  const info = currentTestInfo();
  const key = info ? `${info.testId}#${info.retry}` : null;

  // Outside a test there is no key to compare, so reset — that is the global-setup path,
  // where nothing should carry into the first real test.
  if (info === null || key !== healsTestKey) healsThisTest = [];
  healsTestKey = key;
}

/**
 * Fails a test that only passed because a selector was healed.
 *
 * `HEALER_FAIL_ON_HEAL` exists because the healer's default behaviour is the one you
 * want locally and the one you do not want in CI. A heal means the test no longer
 * matches the application. If that is a redesign, you want the rewrite; if it is a
 * regression — someone deleted the button and the model found a plausible substitute —
 * a green suite hides it. This mode heals anyway, so the run still tells you
 * *everything* that needs fixing, then fails with the list.
 *
 * Deliberately not offered: a mode that fails only on heals the intent checks could not
 * corroborate. It sounds like a safer middle ground and is not one — the regression this
 * mode exists to catch is *by definition* a plausible substitute, so it is exactly the
 * kind of heal that passes those checks. Gating on verification quality would let the
 * case through while feeling rigorous.
 *
 * Safe to call unconditionally: it is a no-op unless `HEALER_FAIL_ON_HEAL` is set. Call
 * it after `use()` in your own fixture if you integrate via {@link attachHealing}; the
 * fixtures this package ships already call it.
 *
 * @param failOnHeal - Overrides `HEALER_FAIL_ON_HEAL`, for a programmatically
 * configured healer.
 * @throws {Error} If healing succeeded during this test and the mode is on.
 */
export function assertNoHeals(failOnHeal?: boolean): void {
  // Drained whether or not the gate is armed, so a run with the flag off cannot
  // accumulate outcomes across a whole file.
  const healed = healsThisTest;
  healsThisTest = [];

  const drained = healsThisTest;
  healsTestKey = null;

  let armed: boolean;
  try {
    armed = failOnHeal ?? isFailOnHeal();
  } catch (error) {
    // Say so. This used to return in silence on the reasoning that `getConfig()` reports a
    // malformed value elsewhere — which it does, as "healing is unavailable", a message
    // about something else entirely. Nothing told anyone their CI gate had disarmed.
    //
    // Still does not throw: failing every test over one bad value would break the rule
    // that healing can never take a suite down. But an unarmed safety gate is exactly the
    // thing that must not be quiet, so this is `error` level — visible even at
    // `LOG_LEVEL=error`, and unaffected by `HEALING_LOGS=false`.
    if (!warnedAboutGateConfig) {
      warnedAboutGateConfig = true;
      log.error(
        `HEALER_FAIL_ON_HEAL could not be read, so the CI gate is OFF and ` +
          `${drained.length} heal(s) will not fail this run. ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
    return;
  }

  if (!armed || healed.length === 0) return;

  throw new Error(describeHealGate(healed));
}

/**
 * Builds the failure message for the fail-on-heal gate.
 *
 * The point of this message is that it should be the only thing a developer needs: the
 * file and line to edit, the selector to remove, the one to put in its place, and enough
 * context to judge whether the replacement is right. Kept a pure function so it can be
 * unit-tested without a browser.
 *
 * @param healed - Successful heals from this test, in the order they happened.
 * @returns The failure message.
 */
export function describeHealGate(healed: HealOutcome[]): string {
  // The same locator can heal on several actions in one test — a page object's field
  // filled and then cleared. Report the rewrite once.
  const seen = new Set<string>();
  const unique = healed.filter((outcome) => {
    // JSON rather than a delimiter: a selector can contain very nearly any
    // character, so a hand-picked separator is a collision waiting to happen.
    const key = JSON.stringify([outcome.originalSelector, outcome.healed]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const lines = [
    `HEALER_FAIL_ON_HEAL is set and ${unique.length} selector(s) needed healing, so this`,
    'test fails deliberately. Healing still ran, so the list below is complete rather',
    'than stopping at the first one.',
    '',
    'Apply these edits and re-run:',
    '',
  ];

  for (const outcome of unique) {
    const winner = outcome.attempts[outcome.attempts.length - 1];
    // The accessible name is page content, and this message becomes a test failure —
    // which is the single most widely-read line this package produces.
    const element = winner?.intent?.role
      ? `${winner.intent.role}${winner.intent.name ? ` "${nameForDisplay(winner.intent.name)}"` : ''}`
      : 'element not described';

    // The selector is written where the locator lives — usually a page object — not in
    // the spec that drove it. Leading with the spec would send people to a file that
    // does not contain the string they need to change.
    const editAt = outcome.source ?? { file: outcome.file, line: outcome.line };
    const exercisedBy = outcome.source
      ? `  (exercised by ${relativeToProject(outcome.file)}:${outcome.line})`
      : '';

    lines.push(
      `  ${relativeToProject(editAt.file)}:${editAt.line}  (${outcome.action})${exercisedBy}`,
      `    - ${outcome.originalSelector}`,
      `    + ${forDisplay(outcome.healed ?? '')}`,
      `      confidence ${winner?.confidence ?? '?'} · ${element}` +
        `${winner?.intent?.checks?.length ? ` · verified by ${winner.intent.checks.join('+')}` : ''}`,
      ''
    );
  }

  lines.push(
    'If a replacement above looks wrong, that is the regression this mode exists to',
    'surface: healing found a plausible substitute for something that changed. Unset',
    'HEALER_FAIL_ON_HEAL to let heals pass again.'
  );

  return lines.join('\n');
}

/**
 * Maps the environment-backed {@link Config} onto the flat {@link HealConfig} the
 * engine and providers consume.
 *
 * The model lives on the provider-specific section of the config, so it has to be
 * looked up per provider rather than read from a single field.
 *
 * @param config - Full framework configuration.
 * @returns Settings for this run.
 * @throws {Error} If the selected provider has no configuration section.
 */
function toHealConfig(config: Config): HealConfig {
  const provider = config.healing.provider;

  const model =
    provider === 'anthropic'
      ? config.anthropic.model
      : provider === 'openai'
        ? config.openai?.model
        : provider === 'gemini'
          ? config.gemini?.model
          : config.ollama?.model;

  if (!model) {
    throw new Error(
      `No model configured for provider "${provider}". Set ${provider.toUpperCase()}_MODEL in your .env file.`
    );
  }

  return {
    enabled: config.healing.enabled,
    maxRetries: config.healing.maxRetries,
    timeout: config.healing.timeout,
    provider,
    model,
    confidenceThreshold: config.healing.threshold,
    privacy: config.privacy,
    intent: config.intent,
    cache: config.healing.cache,
    budget: {
      maxHeals: config.healing.maxHeals,
      breakerThreshold: config.healing.breakerThreshold,
    },
  };
}

/**
 * Builds the provider named by the configuration.
 *
 * @param config - Full framework configuration.
 * @returns A ready provider.
 * @throws {Error} If the provider is recognised by the config but not yet implemented.
 */
function createProvider(config: Config): AiProvider {
  const provider = config.healing.provider;

  return buildProvider(
    provider,
    credentialFor(apiKeyFor(provider, config), config.privacy.previewDir),
    toHealConfig(config).model,
    config.healing.timeout
  );
}

/** Stands in for a key that will never be used, so a provider can still be constructed. */
const PREVIEW_CREDENTIAL = 'preview-mode-no-call-is-made';

/**
 * The credential to build a provider with, allowing for preview mode.
 *
 * Preview mode renders what would be sent and calls nothing, so it must work with no
 * credential — otherwise "show me what this transmits" requires the very approval that
 * seeing it is meant to inform. The provider is still constructed, because the preview
 * file reports which provider and model the payload was shaped for.
 *
 * Shared by both construction paths. It used to live inside {@link createProvider} alone,
 * which meant `createHealingEngine({ previewDir })` — the programmatic equivalent — failed
 * for want of a key that would never have been used.
 *
 * @param apiKey - The credential as configured, possibly empty.
 * @param previewDir - Preview directory in force, from either source.
 * @returns The credential to hand to {@link buildProvider}.
 */
function credentialFor(apiKey: string, previewDir: string | undefined): string {
  if (apiKey) return apiKey;
  return previewDir ? PREVIEW_CREDENTIAL : apiKey;
}

/**
 * The credential configured for a provider, or an empty string when absent.
 *
 * @param provider - Provider to look up.
 * @param config - Full framework configuration.
 * @returns The API key. Empty for keyless providers.
 */
function apiKeyFor(provider: ProviderType, config: Config): string {
  switch (provider) {
    case 'anthropic':
      return config.anthropic.apiKey;
    case 'openai':
      return config.openai?.apiKey ?? '';
    case 'gemini':
      return config.gemini?.apiKey ?? '';
    case 'ollama':
      return '';
  }
}

/**
 * Constructs a provider from explicit values.
 *
 * Kept separate from {@link createProvider} so a programmatically configured healer
 * ({@link createHealingEngine}) does not have to fabricate a whole {@link Config}.
 *
 * @param provider - Which provider to build.
 * @param apiKey - Credential for it.
 * @param model - Model id.
 * @param timeoutMs - Per-request timeout.
 * @returns A ready provider.
 * @throws {Error} If the provider is recognised but not implemented.
 */
export function buildProvider(
  provider: ProviderType,
  apiKey: string,
  model: string,
  timeoutMs: number
): AiProvider {
  switch (provider) {
    case 'anthropic':
      return new AnthropicProvider(apiKey, model, { timeoutMs });

    case 'openai':
      if (!apiKey) throw new Error('HEALER_PROVIDER is "openai" but OPENAI_API_KEY is not set.');
      return new OpenAIProvider(apiKey, model, { timeoutMs });

    case 'gemini':
      if (!apiKey) throw new Error('HEALER_PROVIDER is "gemini" but GEMINI_API_KEY is not set.');
      return new GeminiProvider(apiKey, model, { timeoutMs });

    // A valid HEALER_PROVIDER value with a config section, but no implementation
    // yet — say so plainly instead of failing deeper in the stack.
    case 'ollama':
      throw new Error(
        'Provider "ollama" is configured but not implemented yet. Point OPENAI_BASE_URL at ' +
          'your Ollama server and use HEALER_PROVIDER=openai if it speaks the OpenAI protocol, ' +
          'or add a provider under src/providers/.'
      );

    default:
      throw new Error(`Unknown provider: ${String(provider)}`);
  }
}

/**
 * Builds the healing engine, or returns `null` when healing should not run.
 *
 * Config problems are reported once and then tolerated: a misconfigured healer must
 * not take the whole suite down, because the suite's job is testing the application,
 * not the healer. The tests simply run as plain Playwright.
 *
 * @returns The engine, or `null` if healing is disabled or unconfigurable.
 */
export function initializeHealingEngine(): HealingEngine | null {
  if (engine !== undefined) return engine;

  try {
    const config = getConfig();

    if (!config.healing.enabled) {
      log.info('Healing is disabled (HEALER_ENABLED=false) — running as plain Playwright.');
      unavailableReason = 'healing is disabled (HEALER_ENABLED=false)';
      engine = null;
      return engine;
    }

    const healConfig = toHealConfig(config);
    engine = new HealingEngine(healConfig, createProvider(config));

    log.info(
      `Healing enabled — provider=${healConfig.provider}, model=${healConfig.model}, ` +
        `threshold=${healConfig.confidenceThreshold}, maxRetries=${healConfig.maxRetries}.`
    );

    // What leaves the machine is worth one line per worker, at info rather than debug:
    // nobody raises the log level to find out that they transmitted a page in full.
    log.info(`Transmission policy — ${new PrivacyGuard(config.privacy).describe()}.`);

    return engine;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.error(`Healing is unavailable: ${detail}`);
    log.error('Tests will run without healing. Fix the configuration to enable it.');
    unavailableReason = detail;
    engine = null;
    return engine;
  }
}

/**
 * The current test's `TestInfo`, or `null` outside a test.
 *
 * Healing can be driven from a global setup file or a script, where there is no test
 * to annotate — hence the guard rather than a bare `test.info()`.
 */
function currentTestInfo(): TestInfo | null {
  try {
    return base.info();
  } catch {
    return null;
  }
}

/**
 * Publishes one healing outcome into the Playwright report.
 *
 * Three surfaces, because each answers a different question:
 * - an **annotation**, which shows next to the test title in the HTML report and is
 *   machine-readable in `test-results.json` — "what happened, in one line";
 * - an **attachment** carrying the full JSON: every attempt, its confidence, why it was
 *   rejected, and the token spend — "why, in detail". Note that the model's prose
 *   `reasoning` is *not* included: `HealRecord` has no field for it, so providers parse
 *   it and it is discarded;
 * - a console line, for anyone watching a terminal.
 *
 * Never throws: a reporting failure must not affect the test.
 *
 * @param outcome - What the engine did.
 * @returns Resolves once the attachment has been written.
 */
async function publishOutcome(outcome: HealOutcome): Promise<void> {
  const info = currentTestInfo();
  if (!info) return;

  // Relative paths keep the annotation readable: an absolute Windows path can be
  // longer than the message it is attached to.
  const at = `${relativeToProject(outcome.file)}:${outcome.line}`;
  const cost = `${outcome.tokens.input} in / ${outcome.tokens.output} out tokens`;

  // A blocked heal transmitted nothing, so there are no attempts, no tokens and no
  // model to blame. Report it as its own thing and stop — an attachment describing
  // zero attempts would only add noise.
  if (outcome.blocked) {
    info.annotations.push({
      type: HEAL_ANNOTATIONS.blocked,
      description:
        `${outcome.action}(): "${outcome.originalSelector}" was not sent — ` +
        // The reason quotes the page path that matched a blocked glob, which is exactly
        // the kind of route that holds an identifier: `/patients/884213701`.
        `${messageForDisplay(outcome.error ?? 'blocked by the privacy policy')} at ${at}`,
    });
    return;
  }

  // Also nothing transmitted, but for a cost or availability reason rather than a policy
  // one — worth separating, because the responses differ: raise a ceiling, or go and look
  // at why the provider is down.
  if (outcome.skipped) {
    info.annotations.push({
      type: HEAL_ANNOTATIONS.skipped,
      description:
        `${outcome.action}(): "${outcome.originalSelector}" was skipped — ` +
        `${messageForDisplay(outcome.error ?? 'the spend ceiling or circuit breaker declined')} at ${at}`,
    });
    return;
  }

  if (outcome.healed) {
    // Recorded for the fail-on-heal gate, which runs in fixture teardown so one run
    // reports every stale selector rather than stopping at the first.
    healsThisTest.push(outcome);

    const winner = outcome.attempts[outcome.attempts.length - 1];

    // What the healed element turned out to be, and which checks had evidence. An
    // accepted heal whose only "check" was the confidence floor is the one worth a
    // second look, so the report should not make it look like the others.
    const intent = winner?.intent;
    const verified = intent
      ? ` [${intent.role ?? 'unknown role'}${intent.name ? ` "${nameForDisplay(intent.name)}"` : ''}, ` +
        `checks: ${intent.checks.join('+') || 'none'}` +
        // Present in `warn` mode: the concern that would have rejected this heal, which
        // quotes the element it landed on.
        `${intent.reason ? `, WARNING: ${messageForDisplay(intent.reason)}` : ''}]`
      : '';

    // A reuse cost nothing, and saying so is the difference between a report that looks
    // like eleven expensive heals and one that shows five calls plus six free reuses.
    const via = winner?.provider === 'cache' ? ' via cache' : '';

    info.annotations.push({
      type: HEAL_ANNOTATIONS.healed,
      description:
        `${outcome.action}(): "${outcome.originalSelector}" → "${forDisplay(outcome.healed)}"${verified}${via} ` +
        `(confidence ${winner?.confidence ?? '?'}, ${outcome.attempts.length} attempt(s), ${cost}) at ${at}`,
    });
  } else {
    info.annotations.push({
      type: HEAL_ANNOTATIONS.failed,
      description:
        `${outcome.action}(): "${outcome.originalSelector}" could not be healed — ` +
        // The last rejection reason, which on an intent failure quotes the element the
        // model landed on: `resolves to "Smith, John"`.
        `${messageForDisplay(outcome.error ?? 'unknown reason')} ` +
        `(${outcome.attempts.length} attempt(s), ${cost}) at ${at}`,
    });
  }

  // The attachment is the audit trail for this one action — every attempt, what the model
  // suggested, why it was rejected, what it cost — and it is also the **machine-readable
  // channel the reporter reads**. The annotation above is prose for a human; anything
  // that needs to be counted belongs here, where rewording a sentence cannot change it.
  const label = outcome.originalSelector.replace(/[^\w.-]+/g, '_').slice(0, 40) || 'selector';
  const winner = outcome.attempts[outcome.attempts.length - 1];

  try {
    // Awaited, unlike before: the reporter now depends on this landing, so
    // fire-and-forget would leave the totals at the mercy of a race.
    await info.attach(`healing-${outcome.action}-${label}.json`, {
      contentType: 'application/json',
      body: JSON.stringify(
        {
          action: outcome.action,
          originalSelector: outcome.originalSelector,
          description: outcome.description ?? null,
          // Redacted like the annotation: the attachment travels with the HTML report.
          // healing-records.json keeps the unredacted value.
          healedSelector: outcome.healed === null ? null : forDisplay(outcome.healed),
          outcome: outcome.healed ? 'healed' : 'not healed',
          /** True when this heal reused a selector instead of asking the provider. */
          cached: winner?.provider === 'cache',
          reason: outcome.error === undefined ? null : messageForDisplay(outcome.error),
          pageUrl: outcome.pageUrl,
          location: at,
          // Where the selector is written, when that differs from the test that ran it.
          definedAt: outcome.source
            ? `${relativeToProject(outcome.source.file)}:${outcome.source.line}`
            : at,
          tokens: outcome.tokens,
          described: winner?.described ?? null,
          // Every page-derived field, not just the selector. The rejection reason quotes
          // the element, the model's `reasoning` describes it in prose, and `intent.name`
          // is its accessible name verbatim — all three travel with the HTML report.
          attempts: outcome.attempts.map((attempt) => ({
            ...attempt,
            suggestedSelector: forDisplay(attempt.suggestedSelector),
            ...(attempt.error !== undefined ? { error: messageForDisplay(attempt.error) } : {}),
            ...(attempt.reasoning !== undefined
              ? { reasoning: messageForDisplay(attempt.reasoning) }
              : {}),
            ...(attempt.intent !== undefined ? { intent: intentForDisplay(attempt.intent) } : {}),
          })),
        },
        null,
        2
      ),
    });
  } catch (error) {
    // Reporting must never break a heal.
    const detail = error instanceof Error ? error.message : String(error);
    log.debug(`Could not attach healing detail: ${detail}`);
  }
}

/**
 * Discards the cached engine, so the next test rebuilds it from configuration.
 */
export function resetHealingEngine(): void {
  engine = undefined;
}

/**
 * Installs a pre-built engine, bypassing configuration entirely.
 *
 * Call this at module scope in a spec file, before any test runs. Two uses:
 * plugging in a provider this package does not ship (Anthropic, OpenAI and Gemini are
 * implemented; `ollama` is accepted by the config but has none), and injecting a stub
 * provider when testing the framework itself.
 *
 * @param custom - Engine to use, or `null` to disable healing for this process.
 * @param reason - When disabling, why — surfaced on each test as the
 * `heal-unavailable` annotation so the report explains itself.
 */
export function setHealingEngine(custom: HealingEngine | null, reason?: string): void {
  engine = custom;

  if (custom) {
    unavailableReason = null;
    log.info('Using a caller-supplied healing engine.');
  } else {
    unavailableReason = reason ?? 'healing was disabled by the caller';
    log.info(`Healing disabled by the caller: ${unavailableReason}`);
  }
}

/**
 * Serialises a `getBy*` call back into the source expression the healer speaks.
 *
 * The engine records and validates selectors as text, so a locator built by
 * `page.getByRole('button', { name: 'Submit' })` needs that call rendered back into
 * a string. {@link SelectorValidator} parses exactly this form.
 *
 * @param method - The `getBy*` method that was called.
 * @param args - Arguments it was called with.
 * @returns The equivalent source expression.
 */
function describeGetByCall(method: string, args: unknown[]): string {
  const rendered = args.map((arg) => {
    if (typeof arg === 'string' || arg instanceof RegExp) return renderValue(arg);
    if (arg && typeof arg === 'object') return renderOptions(arg as Record<string, unknown>);
    return '';
  });

  return `${method}(${rendered.filter(Boolean).join(', ')})`;
}

/**
 * Options the validator reads back, rendered first so the common form stays stable.
 *
 * Everything else is rendered *after* these rather than dropped — see
 * {@link renderOptions}.
 */
const PRIMARY_OPTIONS = ['name', 'exact', 'level'] as const;

/**
 * Renders an options object back into source.
 *
 * This string is what the healing record, the report and the CI gate's `-` line call "the
 * selector that failed", so it has to be the code that is actually in the page object.
 * Rendering only `name`, `exact` and `level` — the three the validator reads back — meant
 * `getByRole('button', { pressed: true })` was reported as `getByRole('button')`, and
 * someone following the gate's instructions searched their source for a string that was
 * not there.
 *
 * So every option is rendered. The ones the validator understands come first, keeping the
 * common output byte-identical to before; the rest follow in their own order. An option
 * whose value cannot be written back as source — `has` and `hasNot` take a *Locator* —
 * becomes `…`, which is honest about there being something there rather than pretending
 * there was not.
 *
 * @param options - The options object as the caller passed it.
 * @returns The rendered object literal, or `''` when there is nothing to show.
 */
function renderOptions(options: Record<string, unknown>): string {
  const parts: string[] = [];
  const seen = new Set<string>();

  const add = (key: string): void => {
    if (seen.has(key) || !(key in options)) return;
    seen.add(key);

    const value = options[key];
    if (value === undefined) return;

    parts.push(`${key}: ${renderValue(value) ?? '…'}`);
  };

  for (const key of PRIMARY_OPTIONS) add(key);
  for (const key of Object.keys(options)) add(key);

  return parts.length ? `{ ${parts.join(', ')} }` : '';
}

/**
 * Renders one option value as source, or `null` when it cannot be.
 *
 * @param value - The value as passed.
 * @returns Source text, or `null` for anything that is not a primitive or a regex.
 */
function renderValue(value: unknown): string | null {
  if (typeof value === 'string') return `'${value.replace(/'/g, "\\'")}'`;
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (value instanceof RegExp) return value.toString();
  return null;
}

/**
 * Wraps one locator action so a failure triggers healing.
 *
 * The retry replays the *same method with the same arguments* against the healed
 * locator, so `fill('text', { timeout: 1000 })` heals into an identical call. On any
 * healing failure the original error is re-thrown unchanged.
 *
 * @param locator - Locator being decorated.
 * @param action - Name of the method to wrap.
 * @param page - Page the locator belongs to, needed for the snapshot.
 * @param healingEngine - Engine to consult.
 */
function wrapAction(
  locator: AnnotatedLocator,
  action: string,
  page: Page,
  healingEngine: HealingEngine
): void {
  const target = locator as unknown as Record<string, unknown>;
  if (typeof target[action] !== 'function') return; // Not in this Playwright version.

  /**
   * Invokes the real method so Playwright still labels its errors correctly.
   *
   * Playwright builds messages like `locator.click: Timeout 800ms exceeded` from the
   * *name of the function that called it*. Any indirection leaks into that label —
   * `.bind()` yields `locator.boundClick`, `.apply()` yields `locator.apply`,
   * `.call()` yields `locator.call`. Removing our override for the duration of the
   * call means the invocation is a plain `locator.click(...)` again. The property is
   * restored synchronously, before the returned promise is awaited, so there is no
   * window in which the locator is unwrapped.
   */
  const callOriginal = (args: unknown[]): Promise<unknown> => {
    delete target[action];
    try {
      // Written as `obj[key]!(...)` rather than `original.call(locator, ...)`. The `!` is
      // erased at compile time, so what runs is a plain property call and the label stays
      // `locator.click` — whereas `.call()` renames it to `locator.call`, exactly as the
      // note above warns. Satisfying `noUncheckedIndexedAccess` by hoisting the method into
      // a variable and invoking it is the one refactor this line must not have.
      const methods = locator as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
      return methods[action]!(...args);
    } finally {
      target[action] = wrapped;
    }
  };

  const wrapped = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
    try {
      return await callOriginal(args);
    } catch (error) {
      const selector = locator[EXPRESSION_KEY] ?? '';
      const description = locator[DESCRIPTION_KEY];

      log.debug(`${action}() failed on "${selector}" — attempting to heal.`);

      const originalError = error instanceof Error ? error : new Error(String(error));

      // attemptHeal never throws; it returns null when it cannot help. Wrapping it in
      // a step makes the heal visible in the report timeline and the trace viewer,
      // rather than looking like unexplained dead time inside the failing action.
      // attemptHealDetailed never throws and returns the full outcome, which is what
      // the report needs. Publishing here rather than through an engine callback means
      // a caller-supplied engine (setHealingEngine) reports identically.
      const heal = async (): Promise<string | null> => {
        const outcome = await healingEngine.attemptHealDetailed(
          page,
          selector,
          action,
          description,
          originalError
        );
        await publishOutcome(outcome);
        return outcome.healed;
      };

      const healed = currentTestInfo()
        ? await base.step(`heal ${action}() on "${selector}"`, heal, { box: true })
        : await heal();

      if (!healed) throw error;

      // Resolve through the validator: the AI answers with getBy* expressions that
      // page.locator() cannot parse.
      const replacement = resolver.resolve(healed, page);
      if (!replacement) {
        log.error(`Healed selector "${healed}" could not be resolved — rethrowing.`);
        throw error;
      }

      log.info(`Retrying ${action}() with healed selector "${forDisplay(healed)}".`);

      const retryTarget = replacement as unknown as Record<
        string,
        ((...a: unknown[]) => Promise<unknown>) | undefined
      >;
      if (typeof retryTarget[action] !== 'function') throw error;

      // Property-call form again, so a failure on the retry is also labelled with
      // the real action name. `replacement` is undecorated, so nothing to remove.
      return await retryTarget[action]!(...args);
    }
  };

  // Keeps the wrapper's own name accurate in stack traces.
  Object.defineProperty(wrapped, 'name', { value: action, configurable: true });
  target[action] = wrapped;
}

/**
 * Attaches healing to a locator: metadata, `describe()`, wrapped actions, and
 * refinements that stay healable.
 *
 * @param locator - Locator to decorate.
 * @param expression - Source expression this locator was built from.
 * @param page - Page the locator belongs to.
 * @param healingEngine - Engine to consult on failure.
 * @returns The same locator, typed as {@link HealableLocator}.
 */
function decorateLocator(
  locator: Locator,
  expression: string,
  page: Page,
  healingEngine: HealingEngine
): HealableLocator {
  const annotated = locator as AnnotatedLocator;
  annotated[EXPRESSION_KEY] = expression;

  // `describe()` is Playwright's own API — it returns a new locator whose
  // description appears in the trace viewer and in reports. Capture it before
  // overriding so that behaviour is preserved rather than replaced: we chain through
  // to it, then attach the description to the result for the healer as well.
  const nativeDescribe = (annotated as unknown as Record<string, unknown>)['describe'] as
    | ((description: string) => Locator)
    | undefined;

  (annotated as unknown as Record<string, unknown>)['describe'] = function (
    this: AnnotatedLocator,
    description: string
  ): HealableLocator {
    if (!nativeDescribe) {
      // Playwright older than 1.53 has no describe(); keep the healer's behaviour.
      this[DESCRIPTION_KEY] = description;
      return this as HealableLocator;
    }

    const described = nativeDescribe.call(this, description);
    const decorated = decorateLocator(described, expression, page, healingEngine);
    (decorated as AnnotatedLocator)[DESCRIPTION_KEY] = description;
    return decorated;
  };

  for (const action of HEALED_ACTIONS) {
    wrapAction(annotated, action, page, healingEngine);
  }

  // first()/last()/nth() return new locator objects, which would otherwise lose
  // healing. Re-decorate them with the refinement appended to the expression — a
  // form SelectorValidator can parse back.
  for (const refinement of REFINEMENTS) {
    const target = annotated as unknown as Record<string, unknown>;
    const original = target[refinement];
    if (typeof original !== 'function') continue;

    const originalRefinement = original as (...args: unknown[]) => Locator;

    const wrappedRefinement = function (this: unknown, ...args: unknown[]): HealableLocator {
      const refined = originalRefinement.apply(locator, args);
      const suffix = refinement === 'nth' ? `.nth(${String(args[0] ?? 0)})` : `.${refinement}()`;
      const decorated = decorateLocator(refined, `${expression}${suffix}`, page, healingEngine);

      // Carry any description across the refinement.
      const description = annotated[DESCRIPTION_KEY];
      if (description !== undefined) (decorated as AnnotatedLocator)[DESCRIPTION_KEY] = description;

      return decorated;
    };

    Object.defineProperty(wrappedRefinement, 'name', { value: refinement, configurable: true });
    target[refinement] = wrappedRefinement;
  }

  return annotated as HealableLocator;
}

/**
 * Renders a selector as a single-quoted JavaScript string literal.
 *
 * @param value - Raw selector text.
 * @returns The literal, escaped.
 */
function quote(value: string): string {
  return `'${value.replace(/'/g, "\\'")}'`;
}

/**
 * Renders a `locator()` call back into the expression the healer speaks.
 *
 * A bare CSS string when there are no options, which is the overwhelmingly common case and
 * keeps every existing record and report line unchanged. With options — `hasText`, `has` —
 * the explicit call form, because `.row` alone is not the locator the test built and the
 * CI gate would otherwise print an edit for a line that says something else.
 *
 * @param selector - The CSS or engine string.
 * @param options - Options the caller passed, if any.
 * @returns The source expression.
 */
function describeLocatorCall(selector: string, options?: unknown): string {
  const rendered =
    options && typeof options === 'object' ? renderOptions(options as Record<string, unknown>) : '';

  return rendered ? `locator(${quote(selector)}, ${rendered})` : selector;
}

/**
 * Decorates a `FrameLocator` so locators built inside an iframe still heal.
 *
 * Everything inside an iframe used to be beyond the healer's reach, which covers most
 * payment widgets, embedded reports and SSO flows. `FrameLocator` exposes the same
 * builder surface as `Page` — `locator()`, the seven `getBy*` helpers, and a nested
 * `frameLocator()` — so the same decoration works, with one difference: the expression
 * has to carry the frame path.
 *
 * ```
 * page.frameLocator('#pay').getByLabel('Card number')
 *   → expression: "frameLocator('#pay').getByLabel('Card number')"
 * ```
 *
 * That form is real Playwright source, so a suggested rewrite can be pasted straight into
 * a page object — and `SelectorValidator` parses it back, descending the same frames
 * before resolving the leaf.
 *
 * `locator()` is rendered as the **explicit call form** rather than a bare CSS string,
 * because `frameLocator('#pay').#card` would be ambiguous to parse.
 *
 * @param frame - The frame locator to decorate, mutated in place.
 * @param prefix - Expression prefix naming the frames reached so far.
 * @param page - Page the frame belongs to, needed for the snapshot.
 * @param healingEngine - Engine to consult on failure.
 * @returns The same frame locator.
 */
function decorateFrameLocator(
  frame: FrameLocator,
  prefix: string,
  page: Page,
  healingEngine: HealingEngine
): FrameLocator {
  const target = frame as unknown as Record<string, unknown>;

  const originalLocator = frame.locator.bind(frame);
  target['locator'] = (selector: string, options?: Parameters<FrameLocator['locator']>[1]) => {
    // Always the explicit call form here, options or not: `frameLocator('#f').#card` would
    // be ambiguous to parse back.
    const rendered =
      options && typeof options === 'object' ? renderOptions(options as Record<string, unknown>) : '';
    const call = rendered
      ? `locator(${quote(selector)}, ${rendered})`
      : `locator(${quote(selector)})`;

    return decorateLocator(originalLocator(selector, options), `${prefix}.${call}`, page, healingEngine);
  };

  for (const method of GET_BY_METHODS) {
    const original = target[method];
    if (typeof original !== 'function') continue;

    const bound = (original as (...args: unknown[]) => Locator).bind(frame);
    target[method] = (...args: unknown[]): HealableLocator =>
      decorateLocator(bound(...args), `${prefix}.${describeGetByCall(method, args)}`, page, healingEngine);
  }

  // Frames nest: a payment form inside a consent frame. The prefix accumulates so the
  // resolver can walk the whole path back.
  const originalFrameLocator = frame.frameLocator.bind(frame);
  target['frameLocator'] = (selector: string): FrameLocator =>
    decorateFrameLocator(
      originalFrameLocator(selector),
      `${prefix}.frameLocator(${quote(selector)})`,
      page,
      healingEngine
    );

  return frame;
}

/**
 * Replaces `page.locator` and the `page.getBy*` family with healing versions.
 *
 * Both entry points are covered because the prompts tell the model to prefer
 * role-based locators — if only `page.locator()` healed, tests written the
 * recommended way would not.
 *
 * @param page - Page to decorate, mutated in place.
 * @param healingEngine - Engine to consult on failure.
 */
function decoratePage(page: Page, healingEngine: HealingEngine): void {
  const target = page as unknown as Record<string, unknown>;

  // page.locator(selector, options?)
  const originalLocator = page.locator.bind(page);
  target['locator'] = (selector: string, options?: Parameters<Page['locator']>[1]): HealableLocator =>
    decorateLocator(
      originalLocator(selector, options),
      describeLocatorCall(selector, options),
      page,
      healingEngine
    );

  // page.getByRole(...) and friends.
  for (const method of GET_BY_METHODS) {
    const original = target[method];
    if (typeof original !== 'function') continue;

    const bound = (original as (...args: unknown[]) => Locator).bind(page);

    target[method] = (...args: unknown[]): HealableLocator =>
      decorateLocator(bound(...args), describeGetByCall(method, args), page, healingEngine);
  }

  // page.frameLocator(...) — without this, nothing inside an iframe heals.
  if (typeof target['frameLocator'] === 'function') {
    const originalFrameLocator = page.frameLocator.bind(page);
    target['frameLocator'] = (selector: string): FrameLocator =>
      decorateFrameLocator(
        originalFrameLocator(selector),
        `frameLocator(${quote(selector)})`,
        page,
        healingEngine
      );
  }
}

/**
 * Attaches healing to a page, or records why it could not be.
 *
 * The single place both the ready-made {@link test} and the composable
 * {@link healingFixtures} go through, so every integration path behaves identically.
 *
 * @param page - Page to decorate, mutated in place.
 * @param testInfo - Current test, annotated when healing is unavailable.
 * @param healingEngine - Engine to use. Defaults to the process-wide one.
 * @returns The same page, for convenience.
 */
export function applyHealing(
  page: Page,
  testInfo: TestInfo,
  healingEngine: HealingEngine | null = initializeHealingEngine()
): Page {
  beginHealCollection();

  if (healingEngine) {
    decoratePage(page, healingEngine);
  } else {
    // Say so in the report rather than only in stdout: a suite that quietly stopped
    // healing looks identical to one that never needed to.
    testInfo.annotations.push({
      type: HEAL_ANNOTATIONS.unavailable,
      description: unavailableReason ?? 'healing engine was not available',
    });
  }

  return page;
}

/**
 * Attaches healing to a page outside a fixture.
 *
 * For frameworks that build their own `page` — a custom context, stored auth state, a
 * page-object base class — call this on the page you produce. Reporting works exactly as
 * it does through the shipped fixtures: heal outcomes are published from the wrapped
 * actions, and an *unavailable* healer is annotated here.
 *
 * ```ts
 * page: async ({ browser }, use) => {
 *   const context = await browser.newContext({ storageState: 'auth.json' });
 *   const page = await context.newPage();
 *   await use(attachHealing(page));
 * }
 * ```
 *
 * @param page - Page to decorate, mutated in place.
 * @param healingEngine - Engine to use. Defaults to the process-wide one.
 * @returns The same page.
 */
export function attachHealing(
  page: Page,
  healingEngine: HealingEngine | null = initializeHealingEngine()
): Page {
  beginHealCollection();

  if (healingEngine) {
    decoratePage(page, healingEngine);
    return page;
  }

  // Annotated here rather than only in `applyHealing`. `heal-unavailable` is the one
  // outcome published from *construction* instead of from a wrapped action, so without
  // this the integration path documented for custom fixtures silently lost it — a suite
  // that quietly stopped healing looked identical to one that never needed to. There is no
  // `testInfo` parameter, so it is resolved the same way `publishOutcome` does, which also
  // makes this safe to call from a global setup file where there is no test at all.
  currentTestInfo()?.annotations.push({
    type: HEAL_ANNOTATIONS.unavailable,
    description: unavailableReason ?? 'healing engine was not available',
  });

  return page;
}

/** Fixture shape contributed by {@link healingFixtures}. */
export interface HealingFixtures {
  page: Page;
}

/**
 * Healing fixtures to spread into an existing `test.extend` call.
 *
 * ```ts
 * import { test as base } from '@playwright/test';
 * import { healingFixtures, type HealingFixtures } from 'self-healing-playwright';
 *
 * export const test = base.extend<HealingFixtures & MyFixtures>({
 *   ...healingFixtures,
 *   api: async ({}, use) => { … },
 * });
 * ```
 *
 * **If your framework already overrides `page`**, do not use this — two `page`
 * definitions in one `extend` call means one silently wins. Use {@link withHealing}
 * instead, which layers on top, or call {@link attachHealing} inside your own fixture.
 */
export const healingFixtures = {
  page: async (
    { page }: { page: Page },
    use: (page: Page) => Promise<void>,
    testInfo: TestInfo
  ): Promise<void> => {
    await use(applyHealing(page, testInfo));
    // After the body, so one run reports every stale selector. A throw here fails a
    // test whose body passed, and is reported *alongside* a body failure rather than
    // replacing it — verified against Playwright.
    assertNoHeals();
  },
};

/**
 * Adds healing on top of an existing `test` object, preserving every fixture it has.
 *
 * Use this when your framework customises `page` itself, or when `test` comes from a
 * shared package you cannot edit:
 *
 * ```ts
 * import { withHealing } from 'self-healing-playwright';
 * import { test as companyTest } from '@company/test-base';
 *
 * export const test = withHealing(companyTest);
 * ```
 *
 * Because this extends *on top of* the supplied test, it receives whatever `page` that
 * test produces — nothing is overwritten.
 *
 * @param existing - Any Playwright test object.
 * @returns The same test with a healing-aware `page`.
 */
export function withHealing<T extends TestTypeLike>(existing: T): T {
  return (existing as TestTypeLike).extend({
    page: async (
      { page }: { page: Page },
      use: (page: Page) => Promise<void>,
      testInfo: TestInfo
    ) => {
      await use(applyHealing(page, testInfo));
      assertNoHeals();
    },
  }) as T;
}

/**
 * Structural type for "something with `.extend()`".
 *
 * Playwright's `TestType` is generic over its fixtures, and naming it concretely here
 * would force callers to line up type parameters they should not have to think about.
 */
interface TestTypeLike {
  extend(fixtures: Record<string, unknown>): unknown;
}

/**
 * Settings for a programmatically configured healer.
 *
 * Anything omitted falls back to the environment (`.env` / `process.env`), so this can
 * be used to override one value or to configure everything in code — useful for
 * frameworks that do not use dotenv at all.
 */
export interface HealingOptions {
  /** Master switch. Defaults to `HEALER_ENABLED`. */
  enabled?: boolean;
  /** Which provider to use. Defaults to `HEALER_PROVIDER`. */
  provider?: ProviderType;
  /** Model id. Defaults to the provider's `*_MODEL` variable. */
  model?: string;
  /** Credential. Defaults to the provider's `*_API_KEY` variable. */
  apiKey?: string;
  /** Minimum confidence, 0-1. Defaults to `HEALER_THRESHOLD`. */
  threshold?: number;
  /** Healing attempts per failed action. Defaults to `HEALER_MAX_RETRIES`. */
  maxRetries?: number;
  /** Provider timeout in ms. Defaults to `HEALER_TIMEOUT`. */
  timeout?: number;
  /**
   * Fail a test that only passed because a selector was healed. Defaults to
   * `HEALER_FAIL_ON_HEAL` (off). Recommended for CI — see {@link assertNoHeals}.
   */
  failOnHeal?: boolean;
  /**
   * Reuse selectors that already healed in this worker. Defaults to `HEALER_CACHE`
   * (on). Turn it off to make every heal go to the provider.
   */
  cache?: boolean;
  /**
   * Heals that may reach the provider, per worker. Defaults to `HEALER_MAX_HEALS`
   * (100). `0` removes the ceiling. Cached reuses do not count.
   */
  maxHeals?: number;
  /**
   * Consecutive provider failures before this worker stops calling out. Defaults to
   * `HEALER_BREAKER_THRESHOLD` (5). `0` disables the breaker.
   */
  breakerThreshold?: number;
  /**
   * Where to write healing records. Defaults to `HEALING_RECORDS_PATH`, then to
   * `healing-records.json` in the working directory.
   *
   * Worth setting: the file holds **unredacted** page content and lands in your project
   * root, so point it outside the repository or add it to `.gitignore`.
   */
  recordsPath?: string;
  /**
   * Most recent records to keep. Defaults to `HEALER_RECORDS_MAX` (1000). `0` keeps
   * everything, which is not the same as switching the file off — see {@link records}.
   *
   * The file is re-read and rewritten on every heal, so this is a permanent per-heal cost:
   * roughly 14ms at 1000 records and 117ms at 10,000.
   */
  recordsMax?: number;
  /**
   * Whether to write records at all. Defaults to `HEALER_RECORDS` (on).
   *
   * Turning it off keeps every other report surface — annotations, the attachment, the CI
   * gate, the run summary — and loses only the unredacted copy of the rewrite, which is
   * what you read when `redact: 'strict'` has collapsed it everywhere else.
   */
  records?: boolean;

  // --- What may be transmitted -------------------------------------------------
  //
  // Healing describes the page to a third-party model. These control what that
  // description contains, and which pages are eligible at all. Each defaults to its
  // environment variable; the redaction default is `identifiers`, not `off`.

  /** Redaction level. Defaults to `HEALER_REDACT` (`identifiers`). */
  redact?: RedactLevel;
  /**
   * Callback applied after pattern redaction, able to veto transmission by returning
   * `null`. The extension point for a scrubber of your own — a local classifier, a
   * corporate DLP library, a per-route rule. See {@link Redactor}.
   */
  redactor?: Redactor;
  /** Extra redaction patterns, appended to the built-in set. */
  redactPatterns?: RegExp[];
  /**
   * Origins cleared for healing. When non-empty this is an allowlist and healing is
   * refused everywhere else. Defaults to `HEALER_ALLOWED_ORIGINS`.
   */
  allowedOrigins?: string[];
  /** Path globs healing never runs on. Defaults to `HEALER_BLOCKED_PATHS`. */
  blockedPaths?: string[];
  /**
   * CSS selector to scope the page snapshot to. Defaults to `HEALER_SNAPSHOT_ROOT`.
   * The cheapest control here: it shrinks what is captured *and* the token bill.
   */
  snapshotRoot?: string;
  /**
   * Write the payload each heal would send into this directory and contact no
   * provider. Defaults to `HEALER_PRIVACY_PREVIEW`. No heal can succeed in this mode.
   */
  previewDir?: string;

  // --- Is it the right element? ------------------------------------------------
  //
  // A suggestion resolving to one visible element is not necessarily the element the
  // test meant. See `core/IntentVerifier`.

  /**
   * How strictly to check a healed element against the test's intent. Defaults to
   * `HEALER_INTENT_CHECK` (`enforce`). Use `warn` to adopt the checks on an existing
   * suite without turning it red.
   */
  intentCheck?: IntentMode;
  /**
   * Confidence required when nothing about a heal can be verified. Defaults to
   * `HEALER_UNVERIFIED_CONFIDENCE` (0.9).
   */
  unverifiedConfidence?: number;

  /** A fully built engine, bypassing everything above. */
  engine?: HealingEngine;
}

/**
 * Merges explicit privacy options over the environment-derived policy.
 *
 * Kept separate so the precedence is visible in one place: an option that was passed
 * wins, anything omitted falls through to configuration, and the redaction *level*
 * can only be lowered deliberately — there is no path here that quietly turns
 * redaction off.
 *
 * @param options - Caller-supplied healing options.
 * @param fromConfig - Policy resolved from the environment.
 * @returns The effective policy.
 */
function resolvePrivacyPolicy(options: HealingOptions, fromConfig: PrivacyPolicy): PrivacyPolicy {
  const patterns = [...(fromConfig.customPatterns ?? []), ...(options.redactPatterns ?? [])];
  const allowedOrigins = options.allowedOrigins ?? fromConfig.allowedOrigins;
  const blockedPaths = options.blockedPaths ?? fromConfig.blockedPaths;
  const snapshotRoot = options.snapshotRoot ?? fromConfig.snapshotRoot;
  const previewDir = options.previewDir ?? fromConfig.previewDir;
  const redactor = options.redactor ?? fromConfig.redactor;

  return {
    redact: options.redact ?? fromConfig.redact,
    ...(patterns.length ? { customPatterns: patterns } : {}),
    ...(allowedOrigins?.length ? { allowedOrigins } : {}),
    ...(blockedPaths?.length ? { blockedPaths } : {}),
    ...(snapshotRoot ? { snapshotRoot } : {}),
    ...(previewDir ? { previewDir } : {}),
    ...(redactor ? { redactor } : {}),
  };
}

/**
 * Builds an engine from explicit options, falling back to the environment.
 *
 * @param options - See {@link HealingOptions}.
 * @returns The engine, or `null` when healing is disabled or unconfigurable.
 */
export function createHealingEngine(options: HealingOptions = {}): HealingEngine | null {
  if (options.engine) return options.engine;

  try {
    // The preview directory is handed to `getConfig` because it decides whether a
    // credential is required, and this is the only place that knows a caller supplied one.
    // Without it, configuring preview mode in code failed on a missing key while the
    // identical setting in `.env` worked.
    const config = getConfig(options.previewDir ? { previewDir: options.previewDir } : {});
    const base = toHealConfig(config);

    // `config.healing.provider` is the typed union; `base.provider` is the flattened
    // string on HealConfig, so the union comes from the config rather than from base.
    const provider: ProviderType = options.provider ?? config.healing.provider;
    const model = options.model ?? (provider === config.healing.provider ? base.model : getModel(provider));
    const enabled = options.enabled ?? base.enabled;

    if (!enabled) {
      unavailableReason = 'healing is disabled';
      return null;
    }

    const privacy = resolvePrivacyPolicy(options, config.privacy);
    const intent = {
      mode: options.intentCheck ?? config.intent.mode,
      unverifiedConfidence: options.unverifiedConfidence ?? config.intent.unverifiedConfidence,
    };

    const healConfig: HealConfig = {
      enabled,
      provider,
      model,
      confidenceThreshold: options.threshold ?? base.confidenceThreshold,
      maxRetries: options.maxRetries ?? base.maxRetries,
      timeout: options.timeout ?? base.timeout,
      privacy,
      intent,
      cache: options.cache ?? base.cache ?? true,
      budget: {
        maxHeals: options.maxHeals ?? base.budget?.maxHeals ?? 0,
        breakerThreshold: options.breakerThreshold ?? base.budget?.breakerThreshold ?? 0,
      },
    };

    // `privacy.previewDir` is the merged value, so an environment setting and an option
    // both reach the same allowance.
    const apiKey = credentialFor(options.apiKey ?? apiKeyFor(provider, config), privacy.previewDir);

    return new HealingEngine(healConfig, buildProvider(provider, apiKey, model, healConfig.timeout), {
      // Built explicitly rather than left to the engine's defaults, so a policy
      // assembled from options is the one actually enforced.
      guard: new PrivacyGuard(privacy),
      verifier: new IntentVerifier(intent),
      budget: new HealBudget(healConfig.budget!),
      // Built explicitly whenever any records option is given, so all three reach the
      // recorder — passing only the path would have left `recordsMax` and `records`
      // readable from the environment but not from code.
      ...(options.recordsPath !== undefined ||
      options.recordsMax !== undefined ||
      options.records !== undefined
        ? {
            recorder: new HealingRecorder(
              options.recordsPath ?? process.env.HEALING_RECORDS_PATH ?? 'healing-records.json',
              options.recordsMax,
              options.records
            ),
          }
        : {}),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.error(`Healing is unavailable: ${detail}`);
    unavailableReason = detail;
    return null;
  }
}

/**
 * Healing fixtures configured in code rather than from `.env`.
 *
 * ```ts
 * export const test = base.extend<HealingFixtures>({
 *   ...createHealingFixtures({ provider: 'openai', model: 'gpt-4o', threshold: 0.8 }),
 * });
 * ```
 *
 * The engine is built once and reused for every test in the worker.
 *
 * @param options - See {@link HealingOptions}.
 * @returns A spreadable fixture object.
 */
export function createHealingFixtures(options: HealingOptions = {}): typeof healingFixtures {
  let configured: HealingEngine | null | undefined;

  return {
    page: async (
      { page }: { page: Page },
      use: (page: Page) => Promise<void>,
      testInfo: TestInfo
    ): Promise<void> => {
      if (configured === undefined) configured = createHealingEngine(options);
      await use(applyHealing(page, testInfo, configured));
      assertNoHeals(options.failOnHeal);
    },
  };
}

/**
 * Playwright `test` with healing wired into the `page` fixture.
 *
 * Use this for a new suite. For an existing framework, prefer
 * {@link healingFixtures} or {@link withHealing} so your own fixtures survive.
 *
 * When healing is disabled or unconfigurable the page is handed over untouched, so
 * there is zero overhead and zero behaviour change on that path.
 */
export const test = base.extend({
  page: healingFixtures.page,
});

export { expect } from '@playwright/test';
