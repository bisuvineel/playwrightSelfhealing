/**
 * OpenAI implementation of {@link AiProvider}, via the Chat Completions API.
 *
 * Prompts, JSON extraction, and selector sanitising come from the base class, so this
 * file only builds the request, reads the response, and translates failures.
 *
 * Set `OPENAI_BASE_URL` to point at a compatible endpoint — Azure OpenAI, a gateway,
 * or a local server that speaks the same protocol.
 *
 * @module providers/OpenAIProvider
 */

import { AiProvider, type HealOptions } from '../core/AiProvider';
import type { HealingRequest, HealingResponse } from '../types';
import { HttpError, postJson } from './httpJson';

/** Default API root. Overridden by `OPENAI_BASE_URL` or the `baseUrl` option. */
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/**
 * Reasoning models spend completion tokens on internal reasoning before writing any
 * visible text, so a 500-token ceiling can be consumed entirely by thinking — the
 * request succeeds with `finish_reason: "length"` and empty content. These get a
 * larger budget, mirroring the handling in {@link AnthropicProvider}.
 */
const REASONING_MODEL_PATTERN = /^(?:o\d|gpt-5)/i;

/** Output ceiling used for reasoning models. */
const REASONING_MAX_TOKENS = 4_096;

/** Optional tuning. */
export interface OpenAIProviderOptions {
  /** Per-request timeout in ms. Pair with `HEALER_TIMEOUT`. */
  timeoutMs?: number;
  /** Retry attempts for 429/5xx and network errors. Default 2. */
  maxRetries?: number;
  /** API root override. Defaults to `OPENAI_BASE_URL`, then the public endpoint. */
  baseUrl?: string;
  /** Organisation header, if your account requires one. */
  organization?: string;
  /**
   * Ask the API to guarantee a JSON object response. On by default because the
   * prompt requires JSON; disable for models or gateways that reject the parameter.
   */
  jsonMode?: boolean;
  /** Injectable `fetch`, for tests. */
  fetchImpl?: typeof fetch;
}

/** The subset of the Chat Completions response this provider reads. */
interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

/**
 * Heals selectors using OpenAI chat models.
 */
export class OpenAIProvider extends AiProvider {
  private baseUrl: string;
  private timeoutMs: number;
  private maxRetries: number;
  private organization?: string;
  private jsonMode: boolean;
  private fetchImpl?: typeof fetch;

  /**
   * @param apiKey - OpenAI API key. Required; there is no ambient credential source.
   * @param model - Chat model id, e.g. `gpt-4o`. Defaults to `gpt-4o`.
   * @param options - See {@link OpenAIProviderOptions}.
   */
  constructor(apiKey: string, model: string = 'gpt-4o', options: OpenAIProviderOptions = {}) {
    super(apiKey, model);

    this.baseUrl = (options.baseUrl ?? process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      ''
    );
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.jsonMode = options.jsonMode ?? true;
    if (options.organization !== undefined) this.organization = options.organization;
    if (options.fetchImpl !== undefined) this.fetchImpl = options.fetchImpl;

    if (REASONING_MODEL_PATTERN.test(this.model)) {
      this.maxTokens = Math.max(this.maxTokens, REASONING_MAX_TOKENS);
      this.logDebug(`Reasoning model detected — raising maxTokens to ${this.maxTokens}.`);
    }

    this.logDebug(`Client ready (baseUrl=${this.baseUrl}, timeout=${this.timeoutMs}ms).`);
  }

  /**
   * Asks the model for a replacement selector.
   *
   * @param request - Context describing the failed Playwright action.
   * @returns The suggestion, with confidence, reasoning, and token counts.
   * @throws {Error} If the call fails or no usable selector comes back.
   */
  async heal(request: HealingRequest, options: HealOptions = {}): Promise<HealingResponse> {
    this.logDebug(
      `Healing ${request.originalAction} on "${request.originalSelector}" with ${this.model}.`
    );

    let response: ChatCompletionResponse;
    try {
      response = await postJson<ChatCompletionResponse>({
        url: `${this.baseUrl}/chat/completions`,
        headers: this.buildHeaders(),
        body: this.buildBody(request),
        timeoutMs: this.timeoutMs,
        maxRetries: this.maxRetries,
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
        label: 'OpenAI healing request',
        // One deadline governs the chain: when the engine stops waiting, this stops asking.
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      throw this.describeError(error, 'Healing request failed');
    }

    const choice = response.choices?.[0];
    const text = choice?.message?.content ?? '';

    if (choice?.finish_reason === 'length') {
      this.logWarn(
        `Response hit the ${this.model} output limit — the JSON may be truncated. ` +
          'Raise maxTokens if this recurs.'
      );
    }
    if (choice?.finish_reason === 'content_filter') {
      throw new Error(
        'OpenAI filtered the healing response. The page content likely tripped a content filter.'
      );
    }

    const parsed = this.parseResponse(text);
    if (!parsed.suggestedSelector) {
      throw new Error(
        `OpenAI returned no usable selector (finish_reason: ${choice?.finish_reason ?? 'unknown'}).`
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
        input: response.usage?.prompt_tokens ?? 0,
        output: response.usage?.completion_tokens ?? 0,
      },
      provider: `openai:${this.model}`,
    };

    // The suggestion is logged at debug only — see the note in AnthropicProvider.heal.
    this.logInfo(
      `Answered for "${request.originalSelector}" with confidence ${result.confidence} — ` +
        `${result.tokenUsage.input} in / ${result.tokenUsage.output} out tokens.`
    );
    this.logDebug(`Suggested selector: ${result.suggestedSelector}`);

    return result;
  }

  /**
   * Verifies the key and model with one minimal request.
   *
   * A rate-limit response counts as success: a 429 proves the credentials
   * authenticated, and failing startup over transient throttling would be worse.
   *
   * @returns True when the provider is usable.
   */
  async validateConfig(): Promise<boolean> {
    if (!this.apiKey) {
      this.logError('No API key configured — set OPENAI_API_KEY in your .env file.');
      return false;
    }

    try {
      await postJson<ChatCompletionResponse>({
        url: `${this.baseUrl}/chat/completions`,
        headers: this.buildHeaders(),
        body: {
          model: this.model,
          messages: [{ role: 'user', content: 'Hi' }],
          max_completion_tokens: 16,
        },
        timeoutMs: this.timeoutMs,
        maxRetries: 0,
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
        label: 'OpenAI validation request',
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

  /** Auth and routing headers for every request. */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.apiKey}` };
    if (this.organization) headers['openai-organization'] = this.organization;
    return headers;
  }

  /**
   * Builds the Chat Completions body.
   *
   * `max_completion_tokens` is used rather than the older `max_tokens`: reasoning
   * models reject `max_tokens` outright, and current chat models accept both.
   * `response_format: json_object` makes the API enforce the JSON the prompt asks
   * for, which removes the most common parse failure.
   *
   * @param request - Context describing the failed action.
   * @returns The request body.
   */
  private buildBody(request: HealingRequest): Record<string, unknown> {
    return {
      model: this.model,
      messages: [
        { role: 'system', content: this.buildSystemPrompt() },
        { role: 'user', content: this.buildUserPrompt(request) },
      ],
      max_completion_tokens: this.maxTokens,
      ...(this.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    };
  }

  /**
   * Turns a transport failure into one actionable message.
   *
   * @param error - Whatever was thrown.
   * @param context - Prefix describing what was attempted.
   * @returns An `Error` ready to throw or log.
   */
  private describeError(error: unknown, context: string): Error {
    if (error instanceof HttpError) {
      switch (error.status) {
        case 401:
          return new Error(`${context}: invalid OpenAI API key — check OPENAI_API_KEY.`);
        case 403:
          return new Error(
            `${context}: this key is not permitted to use "${this.model}" (403). ` +
              'Some models require a verified organisation.'
          );
        case 404:
          return new Error(
            `${context}: model "${this.model}" was not found — check OPENAI_MODEL for typos.`
          );
        case 429:
          return new Error(
            `${context}: rate limited or out of quota (429) — ${error.message.replace(/^HTTP 429: /, '')}`
          );
        case 400:
          // Usually an unsupported parameter for the chosen model.
          return new Error(
            `${context}: OpenAI rejected the request — ${error.message.replace(/^HTTP 400: /, '')} ` +
              '(if this mentions response_format, construct the provider with { jsonMode: false }).'
          );
        default:
          return new Error(`${context}: ${error.message}`);
      }
    }

    const detail = error instanceof Error ? error.message : String(error);
    return new Error(`${context}: ${detail}`);
  }
}
