/**
 * Configuration loading and validation for the self-healing Playwright framework.
 *
 * All settings come from environment variables (typically a local `.env` file).
 * `getConfig()` is the single entry point that turns `process.env` into a typed,
 * validated {@link Config}; everything else in this module is a thin convenience
 * wrapper around it.
 *
 * @module config
 */

import * as fs from 'fs';

import * as dotenv from 'dotenv';

import type {
  IntentMode,
  IntentPolicy,
  PrivacyPolicy,
  ProviderType,
  RedactLevel,
} from './types';

/** Whether `.env` has already been loaded into `process.env` in this process. */
let envLoaded = false;

/**
 * Loads `.env` on first use.
 *
 * Deliberately lazy. Doing this at module load meant that merely importing this
 * package mutated the consumer's `process.env` — unacceptable for a library dropped
 * into someone else's framework, where env handling may already be owned by their
 * own setup. Set `HEALER_SKIP_DOTENV=1` to opt out entirely.
 *
 * `quiet` suppresses dotenv's startup banner, which would otherwise print once per
 * Playwright worker.
 */
function ensureEnvLoaded(): void {
  if (envLoaded) return;
  envLoaded = true;

  if (['1', 'true', 'yes'].includes((process.env.HEALER_SKIP_DOTENV ?? '').toLowerCase())) {
    return;
  }

  dotenv.config({ quiet: true });
}

/**
 * Loads `.env` explicitly, for callers that want it before reading any setting.
 *
 * Rarely needed — every config accessor loads it on demand.
 */
export function loadEnv(): void {
  ensureEnvLoaded();
}

/** Re-exported from `./types`, which owns the canonical provider union. */
export type { ProviderType, PrivacyPolicy, RedactLevel, IntentMode, IntentPolicy };

/** Browsers supported by Playwright. */
export type BrowserType = 'chromium' | 'firefox' | 'webkit';

/** Log verbosity, ordered from least to most verbose. */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/** Healing behaviour: whether to heal, with which provider, and how hard to try. */
export interface HealingConfig {
  /** Master switch. When false, no healing is attempted and failures propagate. */
  enabled: boolean;
  /** Provider used to suggest replacement locators. */
  provider: ProviderType;
  /** Minimum confidence (0-1) a suggested locator must have to be used. */
  threshold: number;
  /** How many times a single failing action is retried with healed locators. */
  maxRetries: number;
  /** Per-healing-request timeout in milliseconds. */
  timeout: number;
  /**
   * Heals that may reach the provider, per **worker**. 0 means no ceiling.
   *
   * Playwright workers are separate processes, so the effective ceiling for a run is this
   * times the worker count. Cached reuses cost nothing and do not count against it.
   */
  maxHeals: number;
  /**
   * Consecutive provider failures before this worker stops calling out. 0 disables it.
   *
   * Counted in attempts, so an outage is caught in roughly
   * `threshold / HEALER_MAX_RETRIES` failing actions instead of waiting for whole heals
   * to exhaust their retries.
   */
  breakerThreshold: number;
  /**
   * Reuse a selector that already healed in this worker instead of asking again.
   *
   * A stale selector normally lives in a shared page object, so the same rot is paid
   * for once per test that touches it. Reused selectors are re-validated and
   * re-intent-checked against the live DOM, so a reuse that is wrong for the current
   * page is rejected and a normal heal follows.
   */
  cache: boolean;
  /**
   * When true, a test that needed healing **fails** even though healing worked.
   *
   * The healer's default behaviour is the one you want locally and the one you do not
   * want in CI: a heal means the test no longer matches the application, and if the
   * change was a regression rather than a redesign, a green suite hides it. This turns
   * every heal into a failure carrying the exact edits to make.
   */
  failOnHeal: boolean;
}

/** Credentials and model for a hosted, API-key-based provider. */
export interface ApiProviderConfig {
  apiKey: string;
  model: string;
}

/** Connection details for a locally hosted Ollama server. */
export interface OllamaConfig {
  url: string;
  model: string;
}

/** Browser launch options passed through to Playwright. */
export interface PlaywrightConfig {
  browser: BrowserType;
  headless: boolean;
  /** Convenience flag: when true, forces a headed run regardless of `headless`. */
  showBrowser: boolean;
}

/** Logging behaviour for the framework and for healing events specifically. */
export interface LoggingConfig {
  level: LogLevel;
  /**
   * Whether the healer narrates each attempt on the console.
   *
   * Governs `info` and `debug` output from the `heal:*` loggers only. Warnings and errors
   * always get through, and **records are never affected** — silencing an audit trail with
   * a logging switch would be a way to make problems invisible rather than quiet.
   */
  healingLogs: boolean;
}

/** Fully resolved, validated framework configuration. */
export interface Config {
  healing: HealingConfig;
  /** What may be transmitted to a provider. See {@link PrivacyPolicy}. */
  privacy: PrivacyPolicy;
  /** How strictly healed elements are checked against intent. See {@link IntentPolicy}. */
  intent: IntentPolicy;
  anthropic: ApiProviderConfig;
  openai?: ApiProviderConfig;
  gemini?: ApiProviderConfig;
  ollama?: OllamaConfig;
  playwright: PlaywrightConfig;
  logging: LoggingConfig;
}

/** Raised when the environment cannot be turned into a valid {@link Config}. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Default values applied when the corresponding environment variable is unset. */
const DEFAULTS = {
  enabled: true,
  // On by default: it changes cost, not outcomes. A reused selector is re-validated and
  // re-intent-checked exactly as a fresh suggestion is, so the only difference is that
  // the provider was not asked. Turn it off with HEALER_CACHE=false when investigating
  // healing behaviour and you want every heal to go to the model.
  cache: true,
  // A ceiling generous enough never to bother an ordinary suite, and low enough that a
  // badly rotted one cannot quietly spend an hour of wall clock. Per worker, so the run
  // total is this times `workers` — documented rather than hidden.
  maxHeals: 100,
  // Five consecutive failed attempts is roughly two and a half failing actions at the
  // default retry count: long enough not to trip on one flaky call, short enough that a
  // real outage costs minutes rather than the whole suite.
  breakerThreshold: 5,
  // Off by default: failing a test that healed successfully is the right behaviour in
  // CI and the wrong behaviour while writing tests, and the package cannot tell which
  // it is in. INTEGRATION.md recommends turning it on for CI specifically.
  failOnHeal: false,
  provider: 'anthropic' as ProviderType,
  threshold: 0.7,
  maxRetries: 2,
  timeout: 30_000,
  browser: 'chromium' as BrowserType,
  headless: true,
  showBrowser: false,
  logLevel: 'info' as LogLevel,
  healingLogs: true,
  ollamaUrl: 'http://localhost:11434',
  // Secure by default. Healing sends page content to a third party, so the shipped
  // behaviour removes structured identifiers rather than requiring every consumer to
  // remember to switch it on. Set HEALER_REDACT=off to restore the pre-0.3.0 behaviour.
  redact: 'identifiers' as RedactLevel,
  // Safety-first, for the same reason as `redact`: a heal onto the wrong element turns
  // a suite green while it tests something else, which is harder to notice than a heal
  // that was refused. `HEALER_INTENT_CHECK=warn` keeps the checks visible without
  // enforcing them, and `off` restores the pre-0.3.0 behaviour.
  intentCheck: 'enforce' as IntentMode,
  // Applies only when no check could find any signal — an opaque selector with no
  // describe(). Deliberately well above the 0.7 suggestion threshold: if nothing about
  // a heal can be corroborated, the model's own certainty is all there is.
  unverifiedConfidence: 0.9,
} as const;

/**
 * Mirrors `HealingRecorder`'s own default, purely so `validateConfig()` can report it.
 *
 * Duplicated rather than imported: the recorder deliberately reads its settings straight
 * from the environment so it keeps working when the rest of the configuration is invalid,
 * and importing it here to read one number would couple config loading to file I/O.
 */
const DEFAULT_RECORDS_MAX = 1_000;

const REDACT_LEVELS: readonly RedactLevel[] = ['off', 'identifiers', 'strict'];
const INTENT_MODES: readonly IntentMode[] = ['off', 'warn', 'enforce'];

/** Default model per provider, used when `<PROVIDER>_MODEL` is unset. */
const DEFAULT_MODELS: Record<ProviderType, string> = {
  // Haiku is the default because healing is a high-volume, narrowly scoped task: read a
  // page snapshot, name one element. A cheaper model keeps the cost per failed action in
  // the fractions-of-a-cent range, which matters when a suite heals dozens of times.
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-4o',
  gemini: 'gemini-2.0-flash',
  ollama: 'llama3.1',
};

const PROVIDERS: readonly ProviderType[] = ['anthropic', 'openai', 'gemini', 'ollama'];
const BROWSERS: readonly BrowserType[] = ['chromium', 'firefox', 'webkit'];
const LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug'];

const TRUTHY = ['1', 'true', 'yes', 'on'];
const FALSY = ['0', 'false', 'no', 'off'];

/**
 * Reads an environment variable, treating empty/whitespace-only values as unset.
 *
 * @param name - Environment variable name.
 * @returns The trimmed value, or `undefined` when absent or blank.
 */
function readEnv(name: string): string | undefined {
  ensureEnvLoaded();

  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Parses a boolean environment variable, accepting `true/false`, `1/0`,
 * `yes/no` and `on/off` in any casing.
 *
 * @param name - Environment variable name, used in the error message.
 * @param fallback - Value returned when the variable is unset.
 * @throws {ConfigError} If the value is set but not recognisable as a boolean.
 */
function parseBoolean(name: string, fallback: boolean): boolean {
  const value = readEnv(name);
  if (value === undefined) return fallback;

  const normalized = value.toLowerCase();
  if (TRUTHY.includes(normalized)) return true;
  if (FALSY.includes(normalized)) return false;

  throw new ConfigError(
    `${name} must be one of ${[...TRUTHY, ...FALSY].join(', ')} (got "${value}").`
  );
}

/**
 * Parses a numeric environment variable and enforces an inclusive range.
 *
 * @param name - Environment variable name, used in the error message.
 * @param fallback - Value returned when the variable is unset.
 * @param min - Smallest allowed value.
 * @param max - Largest allowed value.
 * @param integer - When true, rejects non-integer values.
 * @throws {ConfigError} If the value is not a finite number within range.
 */
function parseNumber(
  name: string,
  fallback: number,
  min: number,
  max: number,
  integer = false
): number {
  const value = readEnv(name);
  if (value === undefined) return fallback;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ConfigError(`${name} must be a number (got "${value}").`);
  }
  if (integer && !Number.isInteger(parsed)) {
    throw new ConfigError(`${name} must be a whole number (got "${value}").`);
  }
  if (parsed < min || parsed > max) {
    throw new ConfigError(`${name} must be between ${min} and ${max} (got ${parsed}).`);
  }
  return parsed;
}

/**
 * Parses an environment variable constrained to a fixed set of values.
 *
 * @param name - Environment variable name, used in the error message.
 * @param allowed - The permitted values.
 * @param fallback - Value returned when the variable is unset.
 * @throws {ConfigError} If the value is set but not in `allowed`.
 */
function parseEnum<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const value = readEnv(name);
  if (value === undefined) return fallback;

  const normalized = value.toLowerCase() as T;
  if (!allowed.includes(normalized)) {
    throw new ConfigError(`${name} must be one of ${allowed.join(', ')} (got "${value}").`);
  }
  return normalized;
}

/**
 * Parses a comma-separated environment variable into a list.
 *
 * @param name - Environment variable name.
 * @returns The non-empty trimmed entries, or an empty array when unset.
 */
function parseList(name: string): string[] {
  const value = readEnv(name);
  if (value === undefined) return [];

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Loads extra redaction patterns from a JSON file.
 *
 * Regexes are miserable to write inside an environment variable — delimiters and
 * backslashes fight the shell and `.env` parsing — so anything beyond the built-in
 * set comes from a file. Two accepted shapes:
 *
 * ```json
 * ["\\bMRN\\d{6}\\b", "\\bNHS[0-9 ]{10,12}\\b"]
 * [{ "pattern": "\\bMRN\\d{6}\\b", "flags": "gi" }]
 * ```
 *
 * A malformed file is a hard {@link ConfigError} rather than a warning. Silently
 * ignoring it would mean a team believing their patterns are applied while nothing is
 * redacted — the one failure mode a privacy control must not have.
 *
 * @param file - Path from `HEALER_REDACT_PATTERNS_FILE`.
 * @returns Compiled patterns, all global.
 * @throws {ConfigError} If the file is unreadable, malformed, or holds a bad regex.
 */
function loadRedactPatterns(file: string): RegExp[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`HEALER_REDACT_PATTERNS_FILE "${file}" could not be read: ${detail}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`HEALER_REDACT_PATTERNS_FILE "${file}" is not valid JSON: ${detail}`);
  }

  if (!Array.isArray(parsed)) {
    throw new ConfigError(
      `HEALER_REDACT_PATTERNS_FILE "${file}" must hold a JSON array of patterns.`
    );
  }

  return parsed.map((entry, index) => {
    const source = typeof entry === 'string' ? entry : (entry as { pattern?: unknown })?.pattern;
    const flags = typeof entry === 'string' ? 'g' : (entry as { flags?: unknown })?.flags ?? 'g';

    if (typeof source !== 'string' || source.length === 0) {
      throw new ConfigError(
        `HEALER_REDACT_PATTERNS_FILE "${file}", entry ${index}: expected a regex string, or an ` +
          'object with a "pattern" string.'
      );
    }

    if (typeof flags !== 'string') {
      throw new ConfigError(
        `HEALER_REDACT_PATTERNS_FILE "${file}", entry ${index}: "flags" must be a string.`
      );
    }

    try {
      // The guard replaces every match, so a non-global pattern would only redact the
      // first occurrence — almost never what was meant.
      return new RegExp(source, flags.includes('g') ? flags : `${flags}g`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ConfigError(
        `HEALER_REDACT_PATTERNS_FILE "${file}", entry ${index}: invalid regex ${JSON.stringify(source)} — ${detail}`
      );
    }
  });
}

/**
 * Assembles the transmission policy from the environment.
 *
 * @returns The resolved {@link PrivacyPolicy}.
 * @throws {ConfigError} If any privacy variable is malformed.
 */
function readPrivacyPolicy(): PrivacyPolicy {
  const redact = parseEnum('HEALER_REDACT', REDACT_LEVELS, DEFAULTS.redact);
  const patternsFile = readEnv('HEALER_REDACT_PATTERNS_FILE');
  const snapshotRoot = readEnv('HEALER_SNAPSHOT_ROOT');
  const previewDir = readEnv('HEALER_PRIVACY_PREVIEW');
  const allowedOrigins = parseList('HEALER_ALLOWED_ORIGINS');
  const blockedPaths = parseList('HEALER_BLOCKED_PATHS');

  // `HEALER_REDACT=off` with a patterns file is not a contradiction: `off` disables the
  // built-in rules, and the caller's own patterns still apply. That combination means
  // "apply only my rules", which is a reasonable thing to want — and it is also what a
  // per-fixture `redact: 'off'` override produces when the environment supplies a
  // patterns file, so rejecting it would break a legitimate composition.

  return {
    redact,
    ...(patternsFile ? { customPatterns: loadRedactPatterns(patternsFile) } : {}),
    ...(allowedOrigins.length ? { allowedOrigins } : {}),
    ...(blockedPaths.length ? { blockedPaths } : {}),
    ...(snapshotRoot ? { snapshotRoot } : {}),
    ...(previewDir ? { previewDir } : {}),
  };
}

/**
 * Assembles the intent-checking policy from the environment.
 *
 * @returns The resolved {@link IntentPolicy}.
 * @throws {ConfigError} If either variable is malformed.
 */
function readIntentPolicy(): IntentPolicy {
  return {
    mode: parseEnum('HEALER_INTENT_CHECK', INTENT_MODES, DEFAULTS.intentCheck),
    unverifiedConfidence: parseNumber(
      'HEALER_UNVERIFIED_CONFIDENCE',
      DEFAULTS.unverifiedConfidence,
      0,
      1
    ),
  };
}

/** Environment variable that holds the API key for each hosted provider. */
const API_KEY_VARS: Record<Exclude<ProviderType, 'ollama'>, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

/**
 * Ensures the selected provider has the credentials it needs to run.
 *
 * Only the *selected* provider is checked — the others stay optional so a single
 * `.env` can carry several sets of credentials without all of them being present.
 *
 * @param config - The assembled configuration to check.
 * @throws {ConfigError} If the selected provider is missing its API key or URL.
 */
function assertProviderCredentials(config: Config): void {
  const provider = config.healing.provider;

  if (provider === 'ollama') {
    if (!config.ollama?.url) {
      throw new ConfigError(
        'HEALER_PROVIDER is "ollama" but OLLAMA_URL is not set. ' +
          `Set OLLAMA_URL (e.g. ${DEFAULTS.ollamaUrl}) in your .env file.`
      );
    }
    return;
  }

  const hasKey =
    provider === 'anthropic'
      ? Boolean(config.anthropic.apiKey)
      : Boolean(config[provider]?.apiKey);

  if (!hasKey) {
    const envVar = API_KEY_VARS[provider];
    throw new ConfigError(
      `HEALER_PROVIDER is "${provider}" but ${envVar} is not set. ` +
        `Add ${envVar}=<your-key> to your .env file, or switch HEALER_PROVIDER ` +
        `to a provider you have credentials for.`
    );
  }
}

/** Facts a caller knows that the environment does not, which change validation. */
export interface ConfigContext {
  /**
   * A preview directory the *caller* is about to configure, from
   * `createHealingEngine({ previewDir })` rather than `HEALER_PRIVACY_PREVIEW`.
   *
   * It participates in the credential check exactly as the environment variable does. The
   * check exists because a provider is about to be called; in preview mode none is, and
   * requiring a key to discover what would be transmitted puts the audit trail behind the
   * very approval it exists to inform. Which of the two sources set it is not a difference
   * that should change the answer.
   */
  previewDir?: string;
}

/**
 * Builds the typed configuration from `process.env`, applying defaults and
 * validating every value it reads.
 *
 * Optional provider sections (`openai`, `gemini`, `ollama`) are only present when
 * the environment supplies credentials for them, or when they are the selected
 * provider. When healing is disabled, credential checks are skipped so tests can
 * run without any API key.
 *
 * @param context - Facts the caller knows that the environment does not. See
 * {@link ConfigContext}.
 * @returns A fully populated {@link Config}.
 * @throws {ConfigError} If any variable is malformed, or if the selected provider
 * lacks credentials while healing is enabled.
 */
export function getConfig(context: ConfigContext = {}): Config {
  try {
    const provider = parseEnum('HEALER_PROVIDER', PROVIDERS, DEFAULTS.provider);

    const healing: HealingConfig = {
      enabled: parseBoolean('HEALER_ENABLED', DEFAULTS.enabled),
      provider,
      threshold: parseNumber('HEALER_THRESHOLD', DEFAULTS.threshold, 0, 1),
      maxRetries: parseNumber('HEALER_MAX_RETRIES', DEFAULTS.maxRetries, 0, 10, true),
      timeout: parseNumber('HEALER_TIMEOUT', DEFAULTS.timeout, 1_000, 600_000, true),
      failOnHeal: parseBoolean('HEALER_FAIL_ON_HEAL', DEFAULTS.failOnHeal),
      cache: parseBoolean('HEALER_CACHE', DEFAULTS.cache),
      maxHeals: parseNumber('HEALER_MAX_HEALS', DEFAULTS.maxHeals, 0, 100_000, true),
      breakerThreshold: parseNumber(
        'HEALER_BREAKER_THRESHOLD',
        DEFAULTS.breakerThreshold,
        0,
        1_000,
        true
      ),
    };

    const showBrowser = parseBoolean('SHOW_BROWSER', DEFAULTS.showBrowser);
    const playwright: PlaywrightConfig = {
      browser: parseEnum('BROWSER', BROWSERS, DEFAULTS.browser),
      // A request to watch the browser wins over any headless setting.
      headless: showBrowser ? false : parseBoolean('HEADLESS', DEFAULTS.headless),
      showBrowser,
    };

    const logging: LoggingConfig = {
      level: parseEnum('LOG_LEVEL', LOG_LEVELS, DEFAULTS.logLevel),
      healingLogs: parseBoolean('HEALING_LOGS', DEFAULTS.healingLogs),
    };

    const config: Config = {
      healing,
      privacy: readPrivacyPolicy(),
      intent: readIntentPolicy(),
      anthropic: {
        apiKey: readEnv('ANTHROPIC_API_KEY') ?? '',
        model: readEnv('ANTHROPIC_MODEL') ?? DEFAULT_MODELS.anthropic,
      },
      playwright,
      logging,
    };

    const openaiKey = readEnv('OPENAI_API_KEY');
    if (openaiKey || provider === 'openai') {
      config.openai = {
        apiKey: openaiKey ?? '',
        model: readEnv('OPENAI_MODEL') ?? DEFAULT_MODELS.openai,
      };
    }

    const geminiKey = readEnv('GEMINI_API_KEY');
    if (geminiKey || provider === 'gemini') {
      config.gemini = {
        apiKey: geminiKey ?? '',
        model: readEnv('GEMINI_MODEL') ?? DEFAULT_MODELS.gemini,
      };
    }

    const ollamaUrl = readEnv('OLLAMA_URL');
    if (ollamaUrl || provider === 'ollama') {
      config.ollama = {
        url: ollamaUrl ?? DEFAULTS.ollamaUrl,
        model: readEnv('OLLAMA_MODEL') ?? DEFAULT_MODELS.ollama,
      };
    }

    // Credentials only matter if we are actually going to call a provider. Preview
    // mode never does — and requiring a key to find out what would be transmitted
    // would put the audit trail behind exactly the approval it exists to support.
    // A preview directory passed by the caller counts the same as one in the
    // environment: the reason to skip the check is that no call will be made, and that
    // is equally true whichever set it.
    const previewing = context.previewDir ?? config.privacy.previewDir;
    if (healing.enabled && !previewing) {
      assertProviderCredentials(config);
    }

    return config;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`Failed to load configuration: ${detail}`);
  }
}

/**
 * Validates the environment and reports the outcome on the console.
 *
 * Intended for startup scripts and Playwright global setup: call it once so
 * misconfiguration surfaces as one clear message instead of an obscure failure
 * in the middle of a test run.
 *
 * @throws {ConfigError} If the configuration is invalid.
 */
export function validateConfig(): void {
  let config: Config;

  try {
    config = getConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[config] Invalid configuration: ${message}`);
    throw error instanceof ConfigError ? error : new ConfigError(message);
  }

  if (!config.healing.enabled) {
    console.warn(
      '[config] Healing is disabled (HEALER_ENABLED=false) — tests will run as plain Playwright.'
    );
    return;
  }

  const { provider } = config.healing;
  const model = getModel(provider);
  console.log(
    `[config] Configuration valid — provider=${provider}, model=${model}, ` +
      `threshold=${config.healing.threshold}, maxRetries=${config.healing.maxRetries}, ` +
      `browser=${config.playwright.browser} (${config.playwright.headless ? 'headless' : 'headed'}).`
  );

  // Healing transmits page content to a third party, so what is being sent is part of
  // "the configuration is valid" — not a detail to discover later.
  const { privacy } = config;
  const routes =
    privacy.allowedOrigins?.length || privacy.blockedPaths?.length
      ? `${privacy.allowedOrigins?.length ?? 0} allowed origin(s), ` +
        `${privacy.blockedPaths?.length ?? 0} blocked path(s)`
      : 'every page (no route policy set)';

  console.log(
    `[config] Privacy — redact=${privacy.redact}, snapshot root=` +
      `${privacy.snapshotRoot ?? 'body'}, healing may run on ${routes}.`
  );

  if (privacy.redact === 'off') {
    console.warn(
      '[config] HEALER_REDACT=off — page snapshots will be transmitted in full, ' +
        'including any personal data on screen. See "What is transmitted" in README.md.'
    );
  }
  if (privacy.previewDir) {
    console.warn(
      `[config] HEALER_PRIVACY_PREVIEW is set (${privacy.previewDir}) — no provider will be ` +
        'called and no heal can succeed.'
    );
  }

  console.log(
    `[config] Intent checking — mode=${config.intent.mode}, ` +
      `unverified heals need confidence >= ${config.intent.unverifiedConfidence}.`
  );

  console.log(
    `[config] Spend controls — ` +
      `${config.healing.maxHeals > 0 ? `ceiling ${config.healing.maxHeals} provider-backed heal(s) per worker` : 'no ceiling'}, ` +
      `${config.healing.breakerThreshold > 0 ? `breaker after ${config.healing.breakerThreshold} consecutive failure(s)` : 'no breaker'}, ` +
      `cache ${config.healing.cache ? 'on' : 'off'}.`
  );

  // Read straight from the environment by `HealingRecorder`, so it never reaches the
  // typed config — which also meant it was the one healer setting this summary could not
  // report. Printed here anyway: a validation summary that silently omits a setting is
  // how a typo survives.
  const records = process.env.HEALER_RECORDS_MAX;
  const usable = records === undefined || records.trim() === '' ||
    (Number.isInteger(Number(records)) && Number(records) >= 0);

  // Read straight from the environment by `HealingRecorder`, so neither reaches the typed
  // config — which also meant they were the settings this summary could not report. A
  // validation summary that silently omits a setting is how a typo survives.
  const recordsOff = ['0', 'false', 'no', 'off'].includes(
    (process.env.HEALER_RECORDS ?? '').trim().toLowerCase()
  );

  console.log(
    `[config] Records — ` +
      (recordsOff
        ? 'off (HEALER_RECORDS=false); the unredacted rewrite will not be kept'
        : `keeping the ${usable ? (records?.trim() || String(DEFAULT_RECORDS_MAX)) : String(DEFAULT_RECORDS_MAX)} most recent` +
          `${usable ? '' : ` (HEALER_RECORDS_MAX="${records}" is not a whole number, so it was ignored)`}`) +
      `${config.logging.healingLogs ? '' : '; HEALING_LOGS=false, so per-heal narration is silenced'}.`
  );

  if (config.healing.failOnHeal) {
    console.log(
      '[config] HEALER_FAIL_ON_HEAL is set — a test that needed healing will fail, with ' +
        'the selector edits in its failure message.'
    );
  }

  if (config.intent.mode === 'off') {
    console.warn(
      '[config] HEALER_INTENT_CHECK=off — any suggestion resolving to one visible element ' +
        'is accepted, including the wrong one, so a test can pass while exercising the ' +
        'wrong path. See "Is it the right element?" in README.md.'
    );
  }
}

/**
 * Whether a successful heal should still fail the test.
 *
 * Read directly from the environment rather than through {@link getConfig}, so the
 * fixture teardown that enforces it stays cheap and keeps working even when other
 * settings are invalid — the same reasoning as {@link isHealingEnabled}.
 *
 * @returns True when `HEALER_FAIL_ON_HEAL` is set. Defaults to false.
 * @throws {ConfigError} If the value is set but is not a boolean.
 */
export function isFailOnHeal(): boolean {
  return parseBoolean('HEALER_FAIL_ON_HEAL', DEFAULTS.failOnHeal);
}

/**
 * Whether self-healing is switched on.
 *
 * Reads `HEALER_ENABLED` directly so it stays usable even when other settings are
 * invalid — useful for guard clauses on hot paths.
 *
 * @returns True when healing is enabled (the default).
 * @throws {ConfigError} If `HEALER_ENABLED` is set to a non-boolean value.
 */
export function isHealingEnabled(): boolean {
  return parseBoolean('HEALER_ENABLED', DEFAULTS.enabled);
}

/**
 * The configured log verbosity.
 *
 * Reads `LOG_LEVEL` directly rather than building the whole config, so logging
 * keeps working while other settings are still being validated.
 *
 * @returns The configured level, defaulting to `info`.
 * @throws {ConfigError} If `LOG_LEVEL` names an unknown level.
 */
export function getLogLevel(): LogLevel {
  return parseEnum('LOG_LEVEL', LOG_LEVELS, DEFAULTS.logLevel);
}

/**
 * The provider selected by `HEALER_PROVIDER`.
 *
 * @returns The selected provider, defaulting to `anthropic`.
 * @throws {ConfigError} If `HEALER_PROVIDER` names an unknown provider.
 */
export function getProviderType(): ProviderType {
  return parseEnum('HEALER_PROVIDER', PROVIDERS, DEFAULTS.provider);
}

/**
 * The model configured for a provider.
 *
 * @param provider - Provider to look up. Defaults to the selected provider.
 * @returns The configured model id, or the provider's built-in default.
 * @throws {ConfigError} If `provider` is not a known provider name.
 */
export function getModel(provider?: string): string {
  const target = (provider?.toLowerCase() ?? getProviderType()) as ProviderType;

  if (!PROVIDERS.includes(target)) {
    throw new ConfigError(
      `Unknown provider "${provider}". Expected one of ${PROVIDERS.join(', ')}.`
    );
  }

  const envVar = `${target.toUpperCase()}_MODEL`;
  return readEnv(envVar) ?? DEFAULT_MODELS[target];
}
