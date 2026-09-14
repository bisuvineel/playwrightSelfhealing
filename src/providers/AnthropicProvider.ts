/**
 * Anthropic Claude implementation of {@link AiProvider}, via the Messages API.
 *
 * Deliberately built on {@link postJson} rather than `@anthropic-ai/sdk`. Healing
 * needs one request — a system prompt, a user prompt, and a small JSON answer — and
 * the SDK weighs 6.6 MB across 1384 files with two dependencies of its own. Since this
 * package is distributed as a tarball that people install on locked-down machines, a
 * zero-dependency install matters more than SDK conveniences we do not use. Retries,
 * `retry-after` backoff, timeouts, and error-body extraction all live in `postJson`.
 *
 * The trade-off: credentials must come from `ANTHROPIC_API_KEY` (or be passed in).
 * The SDK's `ant auth login` profile resolution is not reimplemented here.
 *
 * Set `ANTHROPIC_BASE_URL` to route through a gateway or proxy.
 *
 * @module providers/AnthropicProvider
 */

import { AiProvider, type HealOptions } from '../core/AiProvider';
import type { HealingRequest, HealingResponse } from '../types';
import { HttpError, postJson } from './httpJson';

/** Default API root. Overridden by `ANTHROPIC_BASE_URL` or the `baseUrl` option. */
const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';

/**
 * Required API version header. Pinned rather than tracked automatically — this is the
 * one thing the SDK used to manage for us, so it is called out explicitly.
 */
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Models that think by default and accept `output_config.effort`.
 *
 * Thinking tokens are drawn from `max_tokens`, so a 500-token ceiling can be spent
 * entirely on reasoning — the request succeeds with `stop_reason: "max_tokens"` and no
 * text at all. These models get a larger budget and low effort, since healing is a
 * narrow lookup rather than a reasoning problem.
 */
const THINKING_MODEL_PATTERN =
  /^claude-(?:fable|mythos)-5|^claude-opus-(?:5|4-8|4-7|4-6)|^claude-sonnet-(?:5|4-6)/;

/** Output ceiling used on thinking-capable models. */
const THINKING_MAX_TOKENS = 4_096;

/** Output ceiling for the throwaway request made by {@link AnthropicProvider.validateConfig}. */
const VALIDATION_MAX_TOKENS = 16;

/** Optional tuning. */
export interface AnthropicProviderOptions {
  /** Per-request timeout in ms. Pair with `HEALER_TIMEOUT`. */
  timeoutMs?: number;
  /** Retry attempts for 429/5xx and network errors. Default 2. */
  maxRetries?: number;
  /** API root override. Defaults to `ANTHROPIC_BASE_URL`, then the public endpoint. */
  baseUrl?: string;
  /** Injectable `fetch`, for tests. */
  fetchImpl?: typeof fetch;
}

/** The subset of the Messages API response this provider reads. */
interface MessagesResponse {
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string;
  stop_details?: { type?: string; category?: string | null } | null;
  usage?: {
    input_tokens?: number | null;
    output_tokens?: number | null;
  };
}

/**
 * Heals selectors using Claude.
 */
export class AnthropicProvider extends AiProvider {
  private baseUrl: string;
  private timeoutMs: number;
  private maxRetries: number;
  private fetchImpl?: typeof fetch;

  /**
   * @param apiKey - Anthropic API key. Required — unlike the SDK, there is no ambient
   * credential source, so an empty key fails in {@link validateConfig}.
   * @param model - Model to heal with. Defaults to `claude-haiku-4-5`, matching the
   * framework config default: healing is a high-volume, narrowly scoped task, so the
   * cheapest capable model is the right choice. Override with `ANTHROPIC_MODEL`.
   * @param options - See {@link AnthropicProviderOptions}.
   */
  constructor(
    apiKey: string,
    model: string = 'claude-haiku-4-5',
    options: AnthropicProviderOptions = {}
  ) {
    super(apiKey, model);

    this.baseUrl = (options.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      ''
    );
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    if (options.fetchImpl !== undefined) this.fetchImpl = options.fetchImpl;

    this.logDebug(`Client ready (baseUrl=${this.baseUrl}, timeout=${this.timeoutMs}ms).`);
  }

  /**
   * Asks Claude for a replacement selector.
   *
   * @param request - Context describing the failed Playwright action.
   * @returns The suggestion, with confidence, reasoning, and real token counts.
   * @throws {Error} If the call fails, the model declines, or no usable selector
   * comes back. Throwing rather than returning an empty selector keeps the specific
   * reason in the healing record.
   */
  async heal(request: HealingRequest, options: HealOptions = {}): Promise<HealingResponse> {
    this.logDebug(
      `Healing ${request.originalAction} on "${request.originalSelector}" ` +
        `(${request.testFile}:${request.testLine}) with ${this.model}.`
    );

    let response: MessagesResponse;
    try {
      response = await postJson<MessagesResponse>({
        url: `${this.baseUrl}/messages`,
        headers: this.buildHeaders(),
        body: this.buildBody(request),
        timeoutMs: this.timeoutMs,
        maxRetries: this.maxRetries,
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
        label: 'Anthropic healing request',
        // One deadline governs the chain: when the engine stops waiting, this stops asking.
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      throw this.describeError(error, 'Healing request failed');
    }

    // A refusal is a successful HTTP call with no answer — surface it explicitly
    // rather than letting it look like a parse failure.
    if (response.stop_reason === 'refusal') {
      const category = response.stop_details?.category ?? null;
      throw new Error(
        `Claude declined the healing request${category ? ` (category: ${category})` : ''}. ` +
          'This usually means the page content tripped a safety classifier.'
      );
    }

    if (response.stop_reason === 'max_tokens') {
      this.logWarn(
        `Response hit the ${this.model} output limit — the JSON may be truncated. ` +
          'Raise maxTokens if this recurs.'
      );
    }

    // Join every text block rather than reading content[0]: on thinking-capable
    // models the first block is a thinking block, which would read as empty.
    const text = (response.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n')
      .trim();

    const parsed = this.parseResponse(text);
    if (!parsed.suggestedSelector) {
      throw new Error(
        `Claude returned no usable selector (stop_reason: ${response.stop_reason ?? 'unknown'}).`
      );
    }

    const result: HealingResponse = {
      suggestedSelector: parsed.suggestedSelector,
      confidence: parsed.confidence ?? 0,
      reasoning: parsed.reasoning ?? '',
      // Spread-in rather than assigned: `exactOptionalPropertyTypes` rejects an
      // explicit `undefined` on an optional field, and the intent check treats a
      // missing claim differently from an empty one.
      ...(parsed.expectedRole !== undefined ? { expectedRole: parsed.expectedRole } : {}),
      ...(parsed.expectedName !== undefined ? { expectedName: parsed.expectedName } : {}),
      tokenUsage: {
        input: response.usage?.input_tokens ?? 0,
        output: response.usage?.output_tokens ?? 0,
      },
      provider: `anthropic:${this.model}`,
    };

    // The suggestion itself is deliberately absent. A provider sits below the privacy
    // guard by design and has no way to redact, and the model may well have answered with
    // page text — `getByText('Smith, John')`. The engine logs the selector one layer up,
    // where it can be redacted; here the cost and the confidence are what is useful.
    this.logInfo(
      `Answered for "${request.originalSelector}" with confidence ${result.confidence} — ` +
        `${result.tokenUsage.input} in / ${result.tokenUsage.output} out tokens.`
    );
    this.logDebug(`Suggested selector: ${result.suggestedSelector}`);

    return result;
  }

  /**
   * Verifies the key and model by making one minimal request.
   *
   * A rate-limit response counts as success: 429 proves the credentials
   * authenticated, and failing startup validation over transient throttling would be
   * worse than proceeding.
   *
   * @returns True when the provider is usable.
   */
  async validateConfig(): Promise<boolean> {
    if (!this.apiKey) {
      this.logError('No API key configured — set ANTHROPIC_API_KEY in your .env file.');
      return false;
    }

    try {
      await postJson<MessagesResponse>({
        url: `${this.baseUrl}/messages`,
        headers: this.buildHeaders(),
        body: {
          model: this.model,
          max_tokens: VALIDATION_MAX_TOKENS,
          messages: [{ role: 'user', content: 'Hi' }],
        },
        timeoutMs: this.timeoutMs,
        maxRetries: 0,
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
        label: 'Anthropic validation request',
      });

      this.logInfo(`Validated credentials against ${this.model}.`);
      return true;
    } catch (error) {
      if (error instanceof HttpError && error.status === 429) {
        this.logWarn('Rate limited during validation — credentials are valid, proceeding.');
        return true;
      }

      this.logError(this.describeError(error, 'Validation failed').message);
      return false;
    }
  }

  /** Auth and version headers for every request. */
  private buildHeaders(): Record<string, string> {
    return {
      'x-api-key': this.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    };
  }

  /**
   * Assembles the Messages API body, adjusting for the model's capabilities.
   *
   * @param request - Context describing the failed action.
   * @returns The request body.
   */
  private buildBody(request: HealingRequest): Record<string, unknown> {
    const supportsEffort = THINKING_MODEL_PATTERN.test(this.model);
    const maxTokens = supportsEffort ? Math.max(this.maxTokens, THINKING_MAX_TOKENS) : this.maxTokens;

    if (supportsEffort) {
      this.logDebug(`Using effort=low with max_tokens=${maxTokens} for ${this.model}.`);
    }

    return {
      model: this.model,
      max_tokens: maxTokens,
      system: this.buildSystemPrompt(),
      messages: [{ role: 'user', content: this.buildUserPrompt(request) }],
      ...(supportsEffort ? { output_config: { effort: 'low' } } : {}),
    };
  }

  /**
   * Whether a response body is an Anthropic API error rather than something a proxy or
   * gateway produced.
   *
   * Anthropic returns `{"type":"error","error":{"type":"authentication_error",…}}`. An
   * HTML page, a plain string, or JSON without `error.type` came from somewhere else,
   * and reporting it as a bad key sends people hunting for a problem they do not have.
   *
   * @param body - Raw response body.
   * @returns True when the body has Anthropic's error shape.
   */
  private looksLikeAnthropicError(body: string): boolean {
    try {
      const parsed = JSON.parse(body) as { type?: string; error?: { type?: string } };
      return typeof parsed.error?.type === 'string' || parsed.type === 'error';
    } catch {
      return false;
    }
  }

  /**
   * Converts a transport failure into one clear message.
   *
   * Each branch names the fix, because these failures surface in a test report where
   * the reader is debugging a test, not the framework.
   *
   * @param error - Whatever was thrown.
   * @param context - Prefix describing what was being attempted.
   * @returns An `Error` ready to throw or log.
   */
  private describeError(error: unknown, context: string): Error {
    if (error instanceof HttpError) {
      switch (error.status) {
        case 401:
        case 403: {
          // A 401/403 does not prove the key is bad. Corporate proxies and gateways
          // return the same statuses, and Node's fetch ignores HTTP_PROXY, so an
          // intercepting proxy is a real possibility. Anthropic's own errors are JSON
          // with an `error.type`; anything else did not come from the API.
          if (!this.looksLikeAnthropicError(error.body)) {
            return new Error(
              `${context}: got HTTP ${error.status} from ${this.baseUrl}, but the response is not ` +
                `an Anthropic API error — something between this machine and the API answered ` +
                `instead (proxy, gateway, or captive portal). Body: ${error.message.replace(/^HTTP \d+: /, '')}`
            );
          }

          if (error.status === 401) {
            return new Error(
              `${context}: Anthropic rejected the credential (401). ` +
                'Check ANTHROPIC_API_KEY — the most common cause is a key truncated on paste. ' +
                `Run "npm run check:setup" to see its length (a real key is ~100+ characters).`
            );
          }

          return new Error(
            `${context}: this API key is not permitted to use "${this.model}" (403). ` +
              `Anthropic said: ${error.message.replace(/^HTTP 403: /, '')}`
          );
        }
        case 404:
          return new Error(
            `${context}: model "${this.model}" was not found — check ANTHROPIC_MODEL for typos.`
          );
        case 429:
          return new Error(
            `${context}: rate limited by the Anthropic API — ${error.message.replace(/^HTTP 429: /, '')}`
          );
        case 400:
          return new Error(
            `${context}: Anthropic rejected the request — ${error.message.replace(/^HTTP 400: /, '')}`
          );
        default:
          return new Error(`${context}: ${error.message}`);
      }
    }

    const detail = error instanceof Error ? error.message : String(error);
    return new Error(`${context}: ${detail}`);
  }
}
