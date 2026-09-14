/**
 * Shared type definitions for the self-healing Playwright framework.
 *
 * This module is the single source of truth for the data that flows between the
 * healing core, the AI providers, and the on-disk healing records. It contains
 * types only — no runtime logic — so it can be imported from anywhere without
 * side effects.
 *
 * @module types
 */

/**
 * AI providers that can be asked to suggest a replacement locator.
 *
 * All three implemented providers call their REST APIs directly, so the package has no
 * SDK dependencies.
 *
 * - `anthropic` — Claude via the Messages API (the default).
 * - `openai` — OpenAI via Chat Completions.
 * - `gemini` — Google Gemini via the Generative Language API.
 * - `ollama` — a locally hosted model served by Ollama.
 */
export type ProviderType = 'anthropic' | 'openai' | 'gemini' | 'ollama';

/**
 * Playwright actions the healer knows how to retry with a new locator.
 *
 * These are the actions that take a selector and interact with a single element.
 * {@link HealingRequest.originalAction} is deliberately a plain `string` so an
 * unrecognised action can still be reported and logged rather than crashing the
 * healer; use this alias where you want the compiler to constrain the value.
 */
export type ActionType = 'click' | 'fill' | 'check' | 'selectOption' | 'hover';

/**
 * Tokens consumed by a single provider call.
 *
 * Structurally identical to the inline `{ input, output }` shapes it replaces, so
 * it can be used interchangeably with them.
 */
export interface TokenUsage {
  /** Prompt tokens sent to the provider (page snapshot, context, instructions). */
  input: number;
  /** Completion tokens returned by the provider. */
  output: number;
}

/**
 * How strictly a healed element is checked against the test's intent.
 *
 * - `off` — no intent checking. A suggestion resolving to one visible element is used,
 *   whatever element it is. This is the pre-0.3.0 behaviour.
 * - `warn` — every check runs, concerns are recorded, annotated and logged, but the
 *   heal proceeds. For adopting the checks on an existing suite without turning it red.
 * - `enforce` — a failed check rejects the suggestion and feeds the reason into the
 *   next attempt. **The default**, because a green suite testing the wrong element is
 *   worse than a red one.
 */
export type IntentMode = 'off' | 'warn' | 'enforce';

/** Intent-checking settings. See `core/IntentVerifier`. */
export interface IntentPolicy {
  /** How strictly to check. See {@link IntentMode}. */
  mode: IntentMode;
  /**
   * Confidence required when *nothing* about a heal can be verified — an opaque
   * selector with no `describe()`, where no check has anything to test. Those heals
   * are the likeliest to be wrong and the hardest to check, so the bar rises.
   */
  unverifiedConfidence: number;
}

/**
 * What intent checking concluded about one suggestion.
 *
 * Persisted on the {@link HealRecord} so an accepted heal can be audited later: which
 * checks actually had evidence to work with, and what the element turned out to be.
 */
export interface IntentSummary {
  /** Mode in force when the check ran. */
  mode: IntentMode;
  /** Whether every applicable check passed. */
  verified: boolean;
  /**
   * Names of the checks that had signal — `action`, `self-consistency`, `role`,
   * `lexical`, or `confidence-floor`. An empty list, or `confidence-floor` alone,
   * means nothing about the element's identity could be confirmed.
   */
  checks: string[];
  /** Computed ARIA role of the healed element, when it could be read. */
  role?: string;
  /** Accessible name of the healed element, when it could be read. */
  name?: string;
  /** Why the check failed, or in `warn` mode what would have failed it. */
  reason?: string;
}

/**
 * How aggressively outbound text is redacted before it reaches a provider.
 *
 * - `off` — nothing is removed. Only appropriate when the page cannot hold sensitive
 *   data, or when the provider endpoint is inside your own trust boundary.
 * - `identifiers` — structured identifiers (emails, card- and SSN-shaped numbers,
 *   GUIDs, tokens, long account numbers, dates, postcodes) are replaced, and URL
 *   query strings are dropped. **The default.** It cannot catch names or free text.
 * - `strict` — additionally collapses the accessible name of every element that is not
 *   actionable, and the value of every element that is. Catches names and free text,
 *   at some cost to healing accuracy on text-heavy pages.
 *
 * See `core/PrivacyGuard` for exactly what each level does.
 */
export type RedactLevel = 'off' | 'identifiers' | 'strict';

/**
 * Which part of a request a redactor is being asked about.
 *
 * `testFile` is the source location of the failing action, already normalised to a
 * project-relative path before a redactor sees it. It is named separately because a
 * caller may reasonably want to strip it entirely — a repository layout is disclosure
 * of a different kind from page content, and some organisations treat it as such.
 */
export type RedactionField =
  | 'snapshot'
  | 'error'
  | 'url'
  | 'selector'
  | 'description'
  | 'testFile';

/** Context handed to a custom redactor alongside the text. */
export interface RedactionContext {
  /** Which field of the request this text came from. */
  field: RedactionField;
  /** The real (unredacted) page URL, so a redactor can apply per-route policy. */
  pageUrl: string;
}

/**
 * A caller-supplied redactor.
 *
 * Return the text to transmit, or `null` to veto transmission entirely — the shape
 * for "my classifier says this page holds records, send nothing". A veto, a thrown
 * error, and a non-string return are all treated as a block: healing is abandoned and
 * the original Playwright error is re-thrown.
 */
export type Redactor = (text: string, context: RedactionContext) => string | null;

/**
 * What may leave the process, and what is stripped before it does.
 *
 * Enforced by `core/PrivacyGuard` at the single point where a {@link HealingRequest}
 * is assembled. Unlike the rest of this package, these controls fail **closed**: a
 * policy that cannot be evaluated blocks the heal rather than transmitting.
 */
export interface PrivacyPolicy {
  /** Redaction level. See {@link RedactLevel}. */
  redact: RedactLevel;
  /** Extra patterns applied after the built-in set. */
  customPatterns?: RegExp[];
  /**
   * Origins cleared for healing. When non-empty this is an **allowlist**: healing is
   * refused anywhere else. An entry is either a full origin
   * (`https://app.example.com`) or a host, optionally led by `*.` for subdomains.
   */
  allowedOrigins?: string[];
  /**
   * Path globs healing never runs on, whatever the origin. Supports `?`, `*` and
   * `**`; a trailing `/**` also matches the bare prefix. Takes precedence over
   * {@link allowedOrigins}, so a cleared application can still exclude its record
   * pages.
   */
  blockedPaths?: string[];
  /**
   * CSS selector the page snapshot is scoped to, instead of `body`. The cheapest
   * control available: it reduces what is captured in the first place, and cuts token
   * cost at the same time.
   */
  snapshotRoot?: string;
  /**
   * Directory for preview files. When set, every heal writes the payload it *would*
   * have sent and contacts no provider, so no heal can succeed.
   */
  previewDir?: string;
  /** Callback applied after pattern redaction, able to veto. See {@link Redactor}. */
  redactor?: Redactor;
}

/**
 * Everything the AI needs to propose a replacement for a locator that no longer
 * matches an element on the page.
 *
 * Built by the healing core at the moment a Playwright action fails, before any
 * provider is contacted.
 *
 * **A provider only ever sees the redacted copy** produced by
 * `PrivacyGuard.sanitizeRequest`. The unredacted original stays local, so healing
 * records and report attachments still show the real selector you need to fix.
 */
export interface HealingRequest {
  /** The selector that failed, exactly as written in the test. */
  originalSelector: string;
  /**
   * The Playwright action being attempted — `click`, `fill`, `check`, and so on.
   * Typed as `string` rather than {@link ActionType} so unknown actions can still
   * be captured; see {@link ActionType} for the actions the healer handles.
   */
  originalAction: string;
  /**
   * The page's accessibility snapshot (`page.locator(...).ariaSnapshot()` or
   * equivalent), serialised as YAML-like text. This is the primary evidence the
   * AI uses to find the intended element.
   */
  ariaSnapshot: string;
  /**
   * Optional PNG screenshot of the page, for providers with vision support.
   *
   * **Never populated, and never transmitted.** The engine does not capture
   * screenshots, and `PrivacyGuard.sanitizeRequest` drops this field
   * unconditionally — a channel that would ship pixels off the machine should not
   * start working by accident because someone wired up a caller. Sending images
   * requires a deliberate change to the guard, not just to a provider.
   */
  screenshot?: Buffer;
  /** URL of the page at the time of failure, for context and for record keeping. */
  pageUrl: string;
  /** Path of the spec file containing the failing action. */
  testFile: string;
  /** 1-based line number of the failing action within {@link testFile}. */
  testLine: number;
  /**
   * Optional human-readable description of the element's intent — for example
   * `"the Submit button in the checkout form"`. Supplied by the test author to
   * disambiguate similar-looking elements.
   */
  description?: string;
  /**
   * Optional message from the original Playwright failure (timeout, strict-mode
   * violation, and so on). Helps the AI distinguish "element is missing" from
   * "selector matches several elements".
   */
  error?: string;
}

/**
 * A provider's answer to a {@link HealingRequest}.
 *
 * A response is only acted on when {@link HealingResponse.confidence} meets the
 * configured {@link HealConfig.confidenceThreshold}.
 */
export interface HealingResponse {
  /** The replacement selector to retry the action with. */
  suggestedSelector: string;
  /**
   * How confident the provider is in the suggestion, from 0 (a guess) to 1
   * (certain). Values outside 0-1 should be treated as invalid.
   */
  confidence: number;
  /**
   * Short natural-language explanation of why this element was chosen. Surfaced
   * in logs and in the healing report so a human can audit the decision.
   */
  reasoning: string;
  /**
   * The ARIA role the model believes its selector targets, when it reported one.
   *
   * Cross-checked against the live element by `IntentVerifier`: if the selector the
   * model wrote resolves to something other than what it described, the model
   * contradicted itself and the suggestion is discarded. Optional, so a model that
   * omits it — or a custom provider that does not ask for it — still works.
   */
  expectedRole?: string;
  /** The accessible name the model believes its selector targets. See {@link expectedRole}. */
  expectedName?: string;
  /** Tokens spent producing this suggestion. */
  tokenUsage: TokenUsage;
  /**
   * Which provider produced the suggestion. A `string` rather than
   * {@link ProviderType} so custom or experimental providers can identify
   * themselves freely.
   */
  provider: string;
}

/**
 * One healing attempt as persisted to `healing-records.json`.
 *
 * Records are append-only and cover both successful and failed attempts, so the
 * file doubles as an audit log and as the input for suggesting permanent
 * selector fixes back into the test source.
 */
export interface HealRecord {
  /** When the attempt finished, as an ISO 8601 timestamp. */
  timestamp: string;
  /** Path of the spec file that contained the failing action. */
  file: string;
  /** 1-based line number of the failing action within {@link HealRecord.file}. */
  line: number;
  /** The selector that failed. */
  originalSelector: string;
  /**
   * The selector the AI proposed. Present even when
   * {@link HealRecord.success} is false, so rejected suggestions can be reviewed.
   */
  suggestedSelector: string;
  /** Confidence reported with the suggestion, from 0 to 1. */
  confidence: number;
  /**
   * The model's stated justification for this suggestion.
   *
   * Previously parsed by every provider and then discarded, which meant the token
   * spend bought an explanation nobody could read. It is the natural evidence for
   * auditing a questionable heal, so it is now persisted.
   *
   * Free-form model prose, and it may quote page content — so treat it as sensitive if
   * you surface it anywhere but locally.
   */
  reasoning?: string;
  /** What intent checking concluded. Absent when the check was disabled. */
  intent?: IntentSummary;
  /**
   * Whether the locator carried a `describe()` when it healed.
   *
   * The description is the strongest signal the model gets, and it is optional — so the
   * records could not previously tell a well-informed heal from a guess. Heals without
   * one are likelier to land on the wrong element, which is exactly the case worth being
   * able to find afterwards.
   */
  described?: boolean;
  /** Provider that produced the suggestion. */
  provider: string;
  /** Tokens spent on this attempt — used for cost reporting. */
  tokens: TokenUsage;
  /**
   * Whether the healed selector actually worked: the suggestion cleared the
   * confidence threshold *and* the retried action succeeded.
   */
  success: boolean;
  /**
   * Why the attempt failed, when {@link HealRecord.success} is false — a provider
   * error, a below-threshold confidence, or a retry that still could not find the
   * element. Absent on success.
   */
  error?: string;
}

/**
 * Resolved healing settings handed to the core and to providers.
 *
 * This is the flattened, per-run view of the healing options: it pairs the
 * behavioural settings with the concrete provider and model chosen for this run.
 * It is derived from the environment-backed configuration in `./config` — see
 * `HealingConfig` there for the raw shape read from `.env`.
 */
export interface HealConfig {
  /** When false, no provider is contacted and failures propagate unchanged. */
  enabled: boolean;
  /** Maximum number of healing attempts for a single failing action. */
  maxRetries: number;
  /** Timeout in milliseconds for one provider call. */
  timeout: number;
  /** Provider to use, normally one of {@link ProviderType}. */
  provider: string;
  /** Model identifier passed to the provider, e.g. `claude-haiku-4-5`. */
  model: string;
  /**
   * Minimum {@link HealingResponse.confidence} required before a suggestion is
   * retried, from 0 to 1. Suggestions below this are recorded as failures.
   */
  confidenceThreshold: number;
  /**
   * What may leave the process. Optional so existing callers that build a
   * `HealConfig` by hand still compile — but note the default is
   * `{ redact: 'identifiers' }`, **not** "no redaction". A config assembled without
   * thinking about this gets the safe behaviour rather than the permissive one.
   */
  privacy?: PrivacyPolicy;
  /**
   * How strictly healed elements are checked against intent. Optional for the same
   * reason as {@link privacy}, and with the same bias: omitting it gives `enforce`,
   * not `off`.
   */
  intent?: IntentPolicy;
  /**
   * Spend ceiling and provider circuit breaker for this worker. Optional; omitting it
   * means no ceiling and no breaker, which is how the package behaved before 0.4.0.
   */
  budget?: { maxHeals: number; breakerThreshold: number };
  /**
   * Reuse a selector that already healed in this worker rather than asking again.
   *
   * Defaults to **on** when omitted, unlike the two policies above — because unlike
   * them it changes cost rather than behaviour. A reused selector is re-validated and
   * re-intent-checked against the live DOM, so the only difference from a fresh heal is
   * that the provider was not contacted.
   */
  cache?: boolean;
}
