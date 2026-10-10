/**
 * AI-powered self-healing Playwright framework.
 *
 * Features:
 * - Automatic selector recovery using Claude, OpenAI or Gemini. Ollama is accepted by
 *   the config but has no implementation — point `OPENAI_BASE_URL` at it, or see
 *   {@link AiProvider} to add a provider of your own.
 * - Drop-in replacement for `@playwright/test`.
 * - Zero configuration beyond a `.env` file.
 * - Complete healing audit trail in `healing-records.json`.
 *
 * Quick start:
 * ```ts
 * import { test, expect } from 'self-healing-playwright';
 *
 * test('example', async ({ page }) => {
 *   await page.goto('https://example.com');
 *   await page.locator('button').describe('Submit').click();
 * });
 * ```
 *
 * `describe()` is optional but worth adding: the description is the single
 * highest-value hint the AI receives, because it distinguishes the button you meant
 * from the four others that also say "Submit".
 *
 * Configuration — create a `.env` file with at least:
 * ```
 * HEALER_ENABLED=true
 * ANTHROPIC_API_KEY=sk-ant-...
 * ```
 * See `.env.example` for every supported variable. If the configuration is invalid,
 * healing switches itself off and logs the reason — your tests still run, unhealed,
 * rather than failing on the framework.
 *
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// Main exports — what a test file needs.
// ---------------------------------------------------------------------------

/**
 * `test` is Playwright's own `test` with a healing-aware `page` fixture; `expect` is
 * re-exported unchanged. Import both from here instead of `@playwright/test`.
 */
export { test, expect } from './core/TestWrapper';

/** A locator carrying `describe()`, for annotating intent. */
export type { HealableLocator } from './core/TestWrapper';

// ---------------------------------------------------------------------------
// Type exports — for typing your own helpers, reporters, and providers.
// ---------------------------------------------------------------------------

export type {
  HealingRequest,
  HealingResponse,
  HealRecord,
  HealConfig,
  TokenUsage,
  ProviderType,
  ActionType,
  PrivacyPolicy,
  RedactLevel,
  Redactor,
  RedactionContext,
  RedactionField,
  IntentMode,
  IntentPolicy,
  IntentSummary,
} from './types';

// ---------------------------------------------------------------------------
// Intent checking — is the healed element the RIGHT one?
//
// `SelectorValidator` proves a suggestion resolves to one visible element. That is
// also true of the wrong element: a page with "Place order" and "Cancel" has two
// unique, visible buttons. This is the gate that tells them apart, and it defaults
// to `enforce` — a green suite testing the wrong element is worse than a red one.
// ---------------------------------------------------------------------------

export { IntentVerifier } from './core/IntentVerifier';
export type { IntentContext, IntentVerdict } from './core/IntentVerifier';

/**
 * Per-worker memory of selectors that already healed, so the same rot is not paid for
 * once per test that touches it. Reused selectors are re-validated and re-intent-checked,
 * so a reuse that is wrong for the current page is rejected rather than trusted.
 */
export { SelectorCache } from './core/SelectorCache';
export type { CachedSelector, SelectorCacheStats } from './core/SelectorCache';

/**
 * Per-worker spend ceiling and provider circuit breaker — so a badly rotted suite cannot
 * quietly spend an hour of wall clock, and a provider outage is detected once rather than
 * timed out against on every action.
 */
export { HealBudget } from './core/HealBudget';
export type { HealBudgetPolicy, HealBudgetStats, BudgetRefusal } from './core/HealBudget';

// ---------------------------------------------------------------------------
// Privacy — what may leave the process.
//
// Healing describes the page to a third-party model, so this is the module that
// decides what is transmitted. Unlike the rest of the package it fails *closed*: a
// policy it cannot evaluate blocks the heal instead of sending the page. Redaction
// defaults to `identifiers`; see README's "What is transmitted" section.
// ---------------------------------------------------------------------------

export { PrivacyGuard, PrivacyBlockedError } from './core/PrivacyGuard';

// ---------------------------------------------------------------------------
// Configuration — read or validate settings yourself.
//
// `validateConfig()` is the useful one for CI: call it in a global setup file so a
// missing API key fails fast with one clear message instead of surfacing as a
// mysterious lack of healing halfway through a suite.
// ---------------------------------------------------------------------------

export {
  getConfig,
  validateConfig,
  isHealingEnabled,
  getProviderType,
  getModel,
  getLogLevel,
  ConfigError,
} from './config';

export type {
  Config,
  HealingConfig,
  ApiProviderConfig,
  OllamaConfig,
  PlaywrightConfig,
  LoggingConfig,
  BrowserType,
  LogLevel,
} from './config';

// ---------------------------------------------------------------------------
// Advanced — compose the framework yourself.
//
// Everything below is for going beyond the default `test` fixture: adding a
// provider, driving healing manually, or building reports.
// ---------------------------------------------------------------------------

/**
 * Base class for providers. Extend it and implement `heal()` and
 * `validateConfig()`; prompt construction, JSON parsing, and selector sanitising are
 * inherited. Register your provider with {@link setHealingEngine}.
 */
export { AiProvider } from './core/AiProvider';

/**
 * Per-call controls the engine passes to {@link AiProvider.heal} — currently an
 * `AbortSignal` that fires when `HEALER_TIMEOUT` passes. Needed to type the second
 * parameter when implementing a provider of your own; ignoring it is supported.
 */
export type { HealOptions } from './core/AiProvider';

/** Claude implementation of {@link AiProvider}. */
export { AnthropicProvider } from './providers/AnthropicProvider';
export type { AnthropicProviderOptions } from './providers/AnthropicProvider';

/**
 * OpenAI implementation. Set `OPENAI_BASE_URL` to target Azure OpenAI, a gateway, or
 * any server speaking the Chat Completions protocol.
 */
export { OpenAIProvider } from './providers/OpenAIProvider';
export type { OpenAIProviderOptions } from './providers/OpenAIProvider';

/** Google Gemini implementation, via the Generative Language API. */
export { GeminiProvider } from './providers/GeminiProvider';
export type { GeminiProviderOptions } from './providers/GeminiProvider';

/**
 * JSON-over-HTTP helper the REST providers share. Useful when writing a provider of
 * your own: it handles timeouts, retry-after backoff, and error-body extraction.
 */
export { postJson, HttpError, NonJsonResponseError, RequestCancelledError } from './providers/httpJson';
export type { PostJsonOptions } from './providers/httpJson';

/** Orchestrates one healing attempt: snapshot, ask, validate, record. */
export { HealingEngine } from './core/HealingEngine';
export type { HealAttemptOptions, HealingEngineOptions, HealOutcome } from './core/HealingEngine';

/**
 * Annotation types published to the Playwright report (`healed`, `heal-failed`,
 * `heal-unavailable`). Read these in a custom reporter or a CI script.
 */
export { HEAL_ANNOTATIONS } from './core/TestWrapper';

/** Reporter printing a run-level healing summary. Add it to `reporter[]`. */
export { default as HealingReporter } from './reporters/HealingReporter';
export type { HealingReporterOptions } from './reporters/HealingReporter';

/**
 * Turns a selector string — including `getByRole(...)` expressions — into a
 * Playwright locator, and checks it resolves to exactly one visible element.
 */
export { SelectorValidator } from './core/SelectorValidator';
export type { ValidationResult } from './core/SelectorValidator';

/**
 * Engine lifecycle. Use {@link setHealingEngine} to install an engine built around
 * your own provider, or `null` to disable healing for the process.
 */
export {
  initializeHealingEngine,
  resetHealingEngine,
  setHealingEngine,
  createHealingEngine,
  buildProvider,
} from './core/TestWrapper';

// ---------------------------------------------------------------------------
// Integration — adding healing to an existing framework.
//
// Pick one:
//   healingFixtures        spread into your own test.extend()
//   withHealing(test)      wrap an existing test object (use when you override `page`)
//   attachHealing(page)    call inside your own `page` fixture
//   createHealingFixtures  configure in code instead of .env
// See INTEGRATION.md for worked examples of each.
// ---------------------------------------------------------------------------

export {
  healingFixtures,
  createHealingFixtures,
  withHealing,
  attachHealing,
} from './core/TestWrapper';

/**
 * Fails a test that only passed because a selector was healed — the CI gate.
 *
 * A no-op unless `HEALER_FAIL_ON_HEAL` is set, so it is safe to call unconditionally.
 * The fixtures above already call it; you only need it yourself if you integrate via
 * {@link attachHealing} and own the fixture teardown.
 */
export { assertNoHeals } from './core/TestWrapper';

/** Whether `HEALER_FAIL_ON_HEAL` is set. */
export { isFailOnHeal } from './config';

export type { HealingFixtures, HealingOptions } from './core/TestWrapper';

/** Loads `.env` explicitly. Config accessors do this on demand, so it is rarely needed. */
export { loadEnv } from './config';

// ---------------------------------------------------------------------------
// Utilities — reporting, prompts, and page capture.
// ---------------------------------------------------------------------------

/** Reads and writes `healing-records.json`; use it to build your own reports. */
export { HealingRecorder } from './utils/HealingRecorder';
export type { HealingStatistics, HealingReport } from './utils/HealingRecorder';

/** The prompts every provider sends. Override these to change how the AI is asked. */
export { PromptBuilder } from './utils/PromptBuilder';

/** Page capture used to build healing requests. */
export { getAriaSnapshot, getDomSnapshot, truncateSnapshot } from './utils/DOMSnapshot';
export type { AriaSnapshotOptions, DomSnapshotOptions } from './utils/DOMSnapshot';

/** Level-filtered logger honouring `LOG_LEVEL`, for framework extensions. */
export { createLogger } from './utils/logger';
export type { Logger } from './utils/logger';
