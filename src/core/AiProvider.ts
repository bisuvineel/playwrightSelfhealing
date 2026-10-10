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
import type {
  ConfirmAnswer,
  ConfirmQuestion,
  HealingAlternative,
  HealingRequest,
  HealingResponse,
} from '../types';
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
  /**
   * A model to use for this one call instead of the configured one. Used by the
   * second-opinion check, which measured far better on a stronger model: on 28 audit
   * questions, `claude-haiku-4-5` refused 8 real renames, `claude-sonnet-5` none, and
   * neither accepted a single trap.
   */
  model?: string;
}

/**
 * Most alternatives accepted from one answer.
 *
 * The prompt asks for two, and nothing but this made that a limit. Every option is
 * checked against the live page, and a *failing* check costs a one-second
 * `waitFor({ state: 'attached' })` — so a model that answers with forty turns one heal
 * into eighty-two seconds of wall clock and eighty-two records, measured. Against a
 * test timeout that exists to accommodate healing at all, that is a denial of service
 * on the suite triggerable by model output alone.
 *
 * Three rather than two: one more than asked for is forgiving of a model that rounds
 * up, while still bounded.
 */
const MAX_ALTERNATIVES = 3;

/**
 * Configured-to-served model pairs already reported, so the recommendation to pin is
 * made once per process rather than on every heal.
 */
const reportedDrift = new Set<string>();

/** Shape a provider is asked to return, before we add usage and provider name. */
interface RawHealingSuggestion {
  suggestedSelector?: unknown;
  candidateId?: unknown;
  confidence?: unknown;
  reasoning?: unknown;
  expectedRole?: unknown;
  expectedName?: unknown;
  alternatives?: unknown;
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
   * One plain text exchange with the model: a system prompt and a user prompt in, the
   * reply text out. Implemented by every provider this package ships; optional, so a
   * provider written against the `heal()` contract alone still compiles and works — it
   * simply cannot give the second opinion {@link confirm} asks for.
   *
   * @param system - System prompt.
   * @param user - User prompt.
   * @param options - Per-call controls.
   * @returns The reply text, its cost, and the provider and model that served it.
   */
  protected complete?(
    system: string,
    user: string,
    options?: HealOptions
  ): Promise<{ text: string; tokenUsage: HealingResponse['tokenUsage']; provider: string }>;

  /** Whether this provider can answer {@link confirm} — it implements {@link complete}. */
  get canConfirm(): boolean {
    return typeof this.complete === 'function';
  }

  /**
   * Asks the second-opinion question: is the proposed element the same control the test
   * meant? See `HealConfig.confirm`.
   *
   * Strict in what counts as yes: only a JSON `"same": true`. Anything else — `false`, a
   * string, prose, a missing field — is no, because the cost of a wrong "yes" is a test
   * that passes while doing the wrong thing.
   *
   * @param question - The redacted question.
   * @param options - Per-call controls.
   * @returns The answer, or `null` when this provider cannot answer such a question.
   * @throws {Error} When the call fails, or the reply holds no JSON object.
   */
  async confirm(question: ConfirmQuestion, options: HealOptions = {}): Promise<ConfirmAnswer | null> {
    if (typeof this.complete !== 'function') return null;

    const reply = await this.complete(
      PromptBuilder.buildConfirmSystemPrompt(),
      PromptBuilder.buildConfirmPrompt(question),
      options
    );

    const match = /\{[\s\S]*\}/.exec(reply.text);
    let parsed: { same?: unknown; reason?: unknown };
    try {
      parsed = JSON.parse(match?.[0] ?? '') as { same?: unknown; reason?: unknown };
    } catch {
      throw new Error('the second-opinion reply held no JSON object');
    }

    return {
      same: parsed.same === true,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      tokenUsage: reply.tokenUsage,
      provider: reply.provider,
    };
  }

  /**
   * The system prompt: role, selector preferences, and the required response format.
   *
   * Delegates to {@link PromptBuilder} so every provider asks the same question in
   * the same output format — otherwise a confidence score would mean different
   * things depending on which model produced it. Override only if a provider needs
   * genuinely different wording.
   *
   * @param request - The request being answered, which decides between the candidate
   * prompt and the full one.
   * @returns The system prompt text.
   */
  protected buildSystemPrompt(request?: HealingRequest): string {
    return PromptBuilder.buildSystemPrompt(request);
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
   * The user prompt split at the point a prompt cache can reuse up to: the page, then
   * the failure. `page + question` is exactly {@link buildUserPrompt}.
   *
   * For providers that place explicit cache breakpoints. One that overrides
   * {@link buildUserPrompt} should override this too, or its breakpoints will sit on
   * text it no longer sends. See {@link PromptBuilder.buildUserPromptParts}.
   *
   * @param request - Context describing the failed action.
   * @returns The page-derived part, then the failure-specific part.
   */
  protected buildUserPromptParts(request: HealingRequest): { page: string; question: string } {
    return PromptBuilder.buildUserPromptParts(request);
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

    // A pick off the candidate list. Read before the selector, because when a model
    // sends both — some do, helpfully restating the candidate's locator — the id is the
    // half this package can verify against the list it offered.
    const candidateId = this.readCandidateId(parsed.candidateId);
    if (candidateId !== null) result.candidateId = candidateId;

    // Selector: one of these two fields is what a heal proceeds on. Missing *both* is
    // the error; missing one because the other answered is not.
    if (typeof parsed.suggestedSelector === 'string') {
      const selector = this.sanitizeSelector(parsed.suggestedSelector);
      if (selector) {
        result.suggestedSelector = selector;
      } else if (candidateId === null) {
        this.logError('Model returned an empty suggestedSelector.');
      }
    } else if (parsed.suggestedSelector !== undefined) {
      this.logError(`suggestedSelector must be a string, got ${typeof parsed.suggestedSelector}.`);
    } else if (candidateId === null) {
      // Not an error. A reply that names no element is a refusal — the answer the prompt
      // asks for when nothing on the page matches — and the engine reports it as one,
      // with the model's reasoning. Logged at error level it read as a malfunction on
      // every correct refusal. A reply with no JSON at all never reaches this line.
      this.logDebug('The model named no element; treating the answer as a refusal.');
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

    const alternatives = this.readAlternatives(parsed.alternatives);
    if (alternatives.length > 0) result.alternatives = alternatives;

    this.logDebug(
      `Parsed suggestion: ${
        result.candidateId !== undefined
          ? `candidate=${result.candidateId}`
          : `selector=${result.suggestedSelector ?? '<none>'}`
      }, confidence=${result.confidence}, alternatives=${alternatives.length}.`
    );

    return result;
  }

  /**
   * Reads a candidate id, accepting the forms models write it in.
   *
   * A numeric string (`"12"`) and `12` mean the same thing, and so does `"#12"` — the
   * list is rendered with numbers, and models sometimes quote or decorate them. What is
   * refused is anything that is not a positive whole number, because the engine uses it
   * to index a list and a bad index must be a rejection with a reason rather than an
   * off-by-something.
   *
   * Zero is refused too: the list is 1-based, so `0` means the model counted from the
   * wrong end and its answer cannot be trusted to be the element it described.
   *
   * @param raw - The `candidateId` field as parsed from JSON.
   * @returns The id, or `null` when the field was absent or unusable.
   */
  private readCandidateId(raw: unknown): number | null {
    if (raw === undefined || raw === null) return null;

    const value = typeof raw === 'string' ? Number(raw.trim().replace(/^#/, '')) : raw;

    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      this.logWarn(`Ignoring an unusable candidateId (${JSON.stringify(raw)}).`);
      return null;
    }

    return value;
  }

  /**
   * Reads the runner-up list, keeping only entries that could actually be tried.
   *
   * Lenient by design. An alternative is a bonus — it is tried locally and costs
   * nothing when it is wrong — so one malformed entry drops itself rather than the
   * whole field. An entry with neither an id nor a selector has nothing to try and is
   * discarded; a missing confidence becomes 0, which the engine's threshold will judge
   * like any other.
   *
   * @param raw - The `alternatives` field as parsed from JSON.
   * @returns The usable alternatives, in the order the model ranked them.
   */
  private readAlternatives(raw: unknown): HealingAlternative[] {
    if (raw === undefined) return [];

    if (!Array.isArray(raw)) {
      this.logDebug(`Ignoring alternatives of type ${typeof raw}.`);
      return [];
    }

    const alternatives: HealingAlternative[] = [];

    for (const entry of raw) {
      if (alternatives.length >= MAX_ALTERNATIVES) {
        this.logDebug(
          `Ignoring ${raw.length - alternatives.length} further alternative(s); ` +
            `at most ${MAX_ALTERNATIVES} are tried.`
        );
        break;
      }
      if (typeof entry !== 'object' || entry === null) continue;

      const item = entry as RawHealingSuggestion;
      const candidateId = this.readCandidateId(item.candidateId);
      const selector =
        typeof item.suggestedSelector === 'string'
          ? this.sanitizeSelector(item.suggestedSelector)
          : '';

      if (candidateId === null && !selector) continue;

      const rawConfidence =
        typeof item.confidence === 'string' ? Number(item.confidence) : item.confidence;
      const confidence =
        typeof rawConfidence === 'number' && Number.isFinite(rawConfidence)
          ? Math.min(1, Math.max(0, rawConfidence))
          : 0;

      alternatives.push({
        ...(candidateId !== null ? { candidateId } : {}),
        ...(selector ? { suggestedSelector: selector } : {}),
        confidence,
        reasoning:
          typeof item.reasoning === 'string' && item.reasoning.trim()
            ? this.collapseWhitespace(item.reasoning)
            : 'No reasoning provided by the model.',
        ...(typeof item.expectedRole === 'string' && item.expectedRole.trim()
          ? { expectedRole: this.collapseWhitespace(item.expectedRole).toLowerCase() }
          : {}),
        ...(typeof item.expectedName === 'string' && item.expectedName.trim()
          ? { expectedName: this.collapseWhitespace(item.expectedName) }
          : {}),
      });
    }

    return alternatives;
  }

  /**
   * The model a response was actually served by, for the healing record.
   *
   * A model name in configuration is often an **alias** that the provider resolves to a
   * dated snapshot, and can later resolve to a different one: `gpt-4o` has moved across
   * snapshots, and Anthropic serves `claude-haiku-4-5` as `claude-haiku-4-5-20251001`
   * (verified against the live API). A test suite whose heals are decided by a model
   * that changes underneath it gets different answers on an unchanged commit, and
   * nothing records why.
   *
   * So the record carries what was *served*, which makes a snapshot change visible in
   * `healing-records.json`, and the first time the two differ this recommends pinning
   * the served one. It deliberately does not pin for you: a snapshot name cannot be
   * guessed reliably, and a pinned snapshot eventually retires — at which point the
   * first heal fails fast with a clear "model not found".
   *
   * @param served - The model name the response reported, if any.
   * @param recommendPin - False where the configured name is not a model at all — an
   * Azure deployment label, which pins its version server-side.
   * @returns The name to record: the served model when reported, else the configured one.
   */
  protected servedModel(served: string | undefined, recommendPin = true): string {
    const actual = typeof served === 'string' && served.trim() !== '' ? served.trim() : this.model;

    if (recommendPin && actual !== this.model && actual.startsWith(this.model)) {
      const key = `${this.providerName}:${this.model}->${actual}`;
      if (!reportedDrift.has(key)) {
        reportedDrift.add(key);
        this.logWarn(
          `"${this.model}" is an alias, served here as "${actual}". Aliases can move to a ` +
            'newer snapshot, which changes heal decisions on an unchanged commit. For ' +
            `reproducible heals, set the model to "${actual}".`
        );
      }
    }

    return actual;
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
