/**
 * Abstract base class shared by every AI healing provider.
 *
 * The healing flow is the same regardless of which model answers, so it lives
 * here once:
 *
 * 1. A Playwright action fails, and the core builds a {@link HealingRequest}
 *    holding the dead selector plus evidence about the current page (an
 *    accessibility snapshot, optionally a screenshot, the URL, and the test
 *    location).
 * 2. {@link AiProvider.buildSystemPrompt} establishes the role and — critically —
 *    pins the exact JSON shape we expect back, so responses are machine-readable.
 * 3. {@link AiProvider.buildUserPrompt} renders the request into that prompt.
 * 4. The subclass performs the provider-specific network call in
 *    {@link AiProvider.heal}.
 * 5. {@link AiProvider.parseResponse} pulls the JSON object out of whatever the
 *    model actually returned (models like to wrap JSON in prose or code fences)
 *    and validates each field.
 * 6. The subclass attaches token usage and its own name, and returns a complete
 *    {@link HealingResponse}. The core then decides — using the confidence
 *    threshold — whether to retry the action with the suggested selector.
 *
 * Subclasses only supply steps 4 and 6.
 *
 * @module core/AiProvider
 */

import type { LogLevel } from '../config';
import type { HealingRequest, HealingResponse } from '../types';
import { createLogger } from '../utils/logger';
import { PromptBuilder } from '../utils/PromptBuilder';

/**
 * Per-call controls the engine passes to a provider.
 *
 * Optional, and a provider that ignores them still works — which is the point, since
 * `heal()` is the extension seam for a provider this package does not ship.
 */
export interface HealOptions {
  /**
   * Aborts the call, including any retries the provider has not started yet.
   *
   * The engine bounds every heal with `HEALER_TIMEOUT`. Without a signal, hitting that
   * deadline abandoned the promise but left the request running: a provider retrying twice
   * against a hung endpoint kept two more attempts alive, unobserved, holding sockets for
   * up to another two timeouts. The engine had stopped waiting; nothing had stopped asking.
   */
  signal?: AbortSignal;
}

/** Shape a provider is asked to return, before we add usage and provider name. */
interface RawHealingSuggestion {
  suggestedSelector?: unknown;
  confidence?: unknown;
  reasoning?: unknown;
  expectedRole?: unknown;
  expectedName?: unknown;
}

/**
 * Base class for all healing providers.
 *
 * Concrete providers (Anthropic, OpenAI, Gemini, Ollama) extend this and
 * implement {@link heal} and {@link validateConfig}.
 */
export abstract class AiProvider {
  /** Credential for the provider. Empty for local providers such as Ollama. */
  protected apiKey: string;

  /** Model identifier passed on every request, e.g. `claude-haiku-4-5`. */
  protected model: string;

  /**
   * Output-token ceiling for a healing call. A suggestion is one selector plus a
   * sentence of reasoning, so this is intentionally small; subclasses may raise it
   * if their model needs more room.
   */
  protected maxTokens: number = 500;

  /**
   * @param apiKey - Provider credential. May be empty for providers that need no
   * key (Ollama); a warning is logged in that case rather than throwing, so local
   * runs work without credentials.
   * @param model - Model identifier. Required — an empty model would fail later
   * inside the provider SDK with a far less obvious message.
   * @throws {Error} If `model` is missing or blank.
   */
  constructor(apiKey: string, model: string) {
    this.apiKey = (apiKey ?? '').trim();
    this.model = (model ?? '').trim();

    if (!this.model) {
      throw new Error(
        `${this.constructor.name}: a model identifier is required (received ${JSON.stringify(model)}).`
      );
    }

    if (!this.apiKey) {
      // Not fatal: some providers are keyless (a local server) and others resolve
      // credentials from the environment themselves. Subclasses that do need a key
      // should report it from validateConfig(), where the message can be specific.
      this.logWarn(
        'No API key supplied — only valid for keyless providers or SDKs that resolve ' +
          'credentials from the environment.'
      );
    }

    this.logDebug(`Initialised with model "${this.model}", maxTokens=${this.maxTokens}.`);
  }

  /**
   * Short lower-case provider name, derived from the class name
   * (`AnthropicProvider` becomes `anthropic`). Used for log prefixes and for the
   * `provider` field on {@link HealingResponse} and healing records.
   */
  protected get providerName(): string {
    return this.constructor.name.replace(/Provider$/, '').toLowerCase();
  }

  /**
   * Asks the model for a replacement selector.
   *
   * Implementations should call the provider with
   * {@link buildSystemPrompt}/{@link buildUserPrompt}, run the raw text through
   * {@link parseResponse}, and return a complete {@link HealingResponse} with
   * real token counts. Network and API failures should be thrown so the core can
   * record them; a well-formed but unusable answer (no selector) should also throw
   * rather than return a fabricated selector.
   *
   * @param request - Context describing the failed action.
   * @param options - Per-call controls. Optional, so a provider written before these
   * existed — or one that has no use for them — still satisfies this contract.
   * @returns The provider's suggestion, with confidence, reasoning, and usage.
   */
  abstract heal(request: HealingRequest, options?: HealOptions): Promise<HealingResponse>;

  /**
   * Checks that this provider can actually be reached with the current settings —
   * credentials present, endpoint reachable, model available.
   *
   * Called during startup validation so misconfiguration surfaces before a test
   * run rather than at the first failed assertion. Should resolve `false` (and
   * log the reason) rather than throw.
   *
   * @returns True when the provider is usable.
   */
  abstract validateConfig(): Promise<boolean>;

  /**
   * The system prompt: role, selector preferences, and the required response format.
   *
   * Delegates to {@link PromptBuilder} so every provider asks the same question in
   * the same output format — otherwise a confidence score would mean different
   * things depending on which model produced it. Override only if a provider needs
   * genuinely different wording.
   *
   * @returns The system prompt text.
   */
  protected buildSystemPrompt(): string {
    return PromptBuilder.buildSystemPrompt();
  }

  /**
   * Renders a {@link HealingRequest} into the user prompt.
   *
   * @param request - Context describing the failed action.
   * @returns The user prompt text.
   */
  protected buildUserPrompt(request: HealingRequest): string {
    return PromptBuilder.buildUserPrompt(request);
  }

  /**
   * Renders the vision variant, for providers that can accept a screenshot.
   *
   * The image is not embedded in the returned text — the caller attaches
   * `request.screenshot` as a separate content block. See
   * {@link PromptBuilder.buildVisionPrompt}.
   *
   * @param request - Context describing the failed action.
   * @param imageBase64 - Base64 image the caller will attach separately.
   * @returns The vision prompt text.
   */
  protected buildVisionPrompt(request: HealingRequest, imageBase64: string): string {
    return PromptBuilder.buildVisionPrompt(request, imageBase64);
  }

  /**
   * Extracts and validates the suggestion from a model's raw text response.
   *
   * Returns a {@link Partial} because token usage and the provider name are known
   * to the caller, not to the parser. Never throws: a malformed response is a
   * normal outcome, so problems are logged and the corresponding field is left
   * absent. Callers must treat a missing `suggestedSelector` as a failed heal.
   *
   * @param text - Raw text returned by the model.
   * @returns The fields that could be parsed. Empty when nothing usable was found.
   */
  protected parseResponse(text: string): Partial<HealingResponse> {
    const result: Partial<HealingResponse> = {};

    if (typeof text !== 'string' || text.trim().length === 0) {
      this.logError('Model returned an empty response.');
      return result;
    }

    const json = this.extractJsonObject(text);
    if (!json) {
      this.logError(
        `Could not find a JSON object in the response: ${this.preview(text)}`
      );
      return result;
    }

    let parsed: RawHealingSuggestion;
    try {
      parsed = JSON.parse(json) as RawHealingSuggestion;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logError(`Response was not valid JSON (${detail}): ${this.preview(json)}`);
      return result;
    }

    // Selector: the one field a heal cannot proceed without.
    if (typeof parsed.suggestedSelector === 'string') {
      const selector = this.sanitizeSelector(parsed.suggestedSelector);
      if (selector) {
        result.suggestedSelector = selector;
      } else {
        this.logError('Model returned an empty suggestedSelector.');
      }
    } else if (parsed.suggestedSelector !== undefined) {
      this.logError(`suggestedSelector must be a string, got ${typeof parsed.suggestedSelector}.`);
    } else {
      this.logError('Response is missing suggestedSelector.');
    }

    // Confidence: accept numeric strings, clamp to 0-1, and treat a missing or
    // unusable value as 0 so a bad answer can never clear the threshold.
    const rawConfidence =
      typeof parsed.confidence === 'string' ? Number(parsed.confidence) : parsed.confidence;

    if (typeof rawConfidence === 'number' && Number.isFinite(rawConfidence)) {
      const clamped = Math.min(1, Math.max(0, rawConfidence));
      if (clamped !== rawConfidence) {
        this.logWarn(`Confidence ${rawConfidence} is outside 0-1; clamped to ${clamped}.`);
      }
      result.confidence = clamped;
    } else {
      if (parsed.confidence !== undefined) {
        this.logWarn(`Confidence was not a number (${JSON.stringify(parsed.confidence)}); treating as 0.`);
      }
      result.confidence = 0;
    }

    if (typeof parsed.reasoning === 'string' && parsed.reasoning.trim()) {
      result.reasoning = this.collapseWhitespace(parsed.reasoning);
    } else {
      result.reasoning = 'No reasoning provided by the model.';
    }

    // The model's own account of what its selector targets, cross-checked against the
    // live element by `IntentVerifier`. Both are optional: a model that ignores the
    // instruction, or a custom provider whose prompt never asked, still heals — it just
    // loses the self-consistency check. So a missing value is silent, while a value of
    // the wrong type is worth saying out loud.
    if (typeof parsed.expectedRole === 'string' && parsed.expectedRole.trim()) {
      result.expectedRole = this.collapseWhitespace(parsed.expectedRole).toLowerCase();
    } else if (parsed.expectedRole !== undefined) {
      this.logDebug(`Ignoring expectedRole of type ${typeof parsed.expectedRole}.`);
    }

    if (typeof parsed.expectedName === 'string' && parsed.expectedName.trim()) {
      result.expectedName = this.collapseWhitespace(parsed.expectedName);
    } else if (parsed.expectedName !== undefined) {
      this.logDebug(`Ignoring expectedName of type ${typeof parsed.expectedName}.`);
    }

    this.logDebug(
      `Parsed suggestion: selector=${result.suggestedSelector ?? '<none>'}, ` +
        `confidence=${result.confidence}.`
    );

    return result;
  }

  /**
   * Normalises a selector emitted by a model into something Playwright can use.
   *
   * Models tend to decorate selectors — wrapping them in code fences or quotes,
   * appending semicolons, or splitting them across lines. This strips that
   * packaging without altering the selector's meaning: internal single spaces are
   * significant in CSS (descendant combinator) and in accessible names, so they
   * are preserved.
   *
   * @param selector - Raw selector string from the model.
   * @returns The cleaned selector, or an empty string if nothing was left.
   */
  protected sanitizeSelector(selector: string): string {
    if (typeof selector !== 'string') return '';

    let cleaned = selector.trim();

    // ```css ... ``` or ``` ... ```
    const fenced = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/.exec(cleaned);
    if (fenced?.[1] !== undefined) cleaned = fenced[1].trim();

    cleaned = this.collapseWhitespace(cleaned);

    // Drop a trailing statement terminator, e.g. `page.getByRole('button');`
    cleaned = cleaned.replace(/;+$/, '').trim();

    // Unwrap matching outer quotes, e.g. `"[name=\"email\"]"` -> `[name="email"]`.
    // Only safe when every inner occurrence of that quote is backslash-escaped;
    // otherwise the outer characters are part of the selector, not packaging, and
    // `[name="email"]` (which starts with `[`) is never touched at all.
    const first = cleaned[0];
    const last = cleaned[cleaned.length - 1];
    if (cleaned.length >= 2 && first === last && (first === '"' || first === "'" || first === '`')) {
      const inner = cleaned.slice(1, -1);
      const hasBareQuote = new RegExp(String.raw`(^|[^\\])${first}`).test(inner);
      if (!hasBareQuote) {
        cleaned = inner.replace(/\\(["'`\\])/g, '$1').trim();
      }
    }

    if (!cleaned) {
      this.logWarn(`Selector "${selector}" was empty after sanitising.`);
    }

    return cleaned;
  }

  /**
   * Finds the first complete JSON object in a block of text.
   *
   * Scans for balanced braces while tracking string literals and escapes, so
   * braces inside the `reasoning` string do not end the object early. This is more
   * reliable than a greedy regex when the model adds prose or a code fence around
   * its answer.
   *
   * @param text - Raw model output.
   * @returns The JSON substring, or `null` if no balanced object was found.
   */
  private extractJsonObject(text: string): string | null {
    const start = text.indexOf('{');
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i++) {
      const char = text[i];

      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }

      if (char === '"') inString = true;
      else if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }

    return null; // Unbalanced — likely a truncated response.
  }

  /** Collapses newlines, tabs, and runs of spaces into single spaces. */
  private collapseWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
  }

  /** Shortens text for log messages so a huge response cannot flood the console. */
  private preview(value: string, limit = 300): string {
    const collapsed = this.collapseWhitespace(value);
    return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}… (truncated)`;
  }

  /**
   * Writes a log line when the configured `LOG_LEVEL` is verbose enough.
   *
   * Every message is prefixed with the provider name so interleaved output from
   * parallel workers stays attributable.
   *
   * @param level - Severity of this message.
   * @param message - Text to log.
   */
  protected log(level: LogLevel, message: string): void {
    // Built per call rather than cached, so `providerName` reflects the subclass
    // even when logging from the base constructor.
    createLogger(`heal:${this.providerName}`).log(level, message);
  }

  /** Logs at `error` level. @param message - Text to log. */
  protected logError(message: string): void {
    this.log('error', message);
  }

  /** Logs at `warn` level. @param message - Text to log. */
  protected logWarn(message: string): void {
    this.log('warn', message);
  }

  /** Logs at `info` level. @param message - Text to log. */
  protected logInfo(message: string): void {
    this.log('info', message);
  }

  /** Logs at `debug` level. @param message - Text to log. */
  protected logDebug(message: string): void {
    this.log('debug', message);
  }
}
