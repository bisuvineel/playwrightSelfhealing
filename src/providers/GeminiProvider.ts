/**
 * Google Gemini implementation of {@link AiProvider}, via the Generative Language API.
 *
 * Prompts, JSON extraction, and selector sanitising come from the base class, so this
 * file only builds the request, reads the response, and translates failures.
 *
 * Two shape differences from the other providers are worth knowing: the system prompt
 * travels in `systemInstruction` rather than as a message, and the API key goes in a
 * header (`x-goog-api-key`) rather than a bearer token. The key is deliberately kept
 * out of the URL so it cannot leak into logs or error messages.
 *
 * @module providers/GeminiProvider
 */

import { AiProvider, type HealOptions } from '../core/AiProvider';
import type { HealingRequest, HealingResponse } from '../types';
import { HttpError, postJson } from './httpJson';

/** Default API root. Overridden by `GEMINI_BASE_URL` or the `baseUrl` option. */
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Thinking-capable models spend output tokens on reasoning before writing any visible
 * text, so a small ceiling can be consumed entirely by thinking — leaving a response
 * with `finishReason: MAX_TOKENS` and no content.
 */
const THINKING_MODEL_PATTERN = /(?:2\.5|thinking)/i;

/** Output ceiling used for thinking-capable models. */
const THINKING_MAX_TOKENS = 4_096;

/** Optional tuning. */
export interface GeminiProviderOptions {
  /** Per-request timeout in ms. Pair with `HEALER_TIMEOUT`. */
  timeoutMs?: number;
  /** Retry attempts for 429/5xx and network errors. Default 2. */
  maxRetries?: number;
  /** API root override. Defaults to `GEMINI_BASE_URL`, then the public endpoint. */
  baseUrl?: string;
  /**
   * Ask the API for a JSON response. On by default because the prompt requires JSON;
   * disable for models that reject `responseMimeType`.
   */
  jsonMode?: boolean;
  /** Injectable `fetch`, for tests. */
  fetchImpl?: typeof fetch;
}

/** The subset of the generateContent response this provider reads. */
interface GenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
}

/**
 * Heals selectors using Google Gemini models.
 */
export class GeminiProvider extends AiProvider {
  private baseUrl: string;
  private timeoutMs: number;
  private maxRetries: number;
  private jsonMode: boolean;
  private fetchImpl?: typeof fetch;

  /**
   * @param apiKey - Gemini API key. Required.
   * @param model - Model id, e.g. `gemini-2.0-flash`. Defaults to `gemini-2.0-flash`.
   * @param options - See {@link GeminiProviderOptions}.
   */
  constructor(
    apiKey: string,
    model: string = 'gemini-2.0-flash',
    options: GeminiProviderOptions = {}
  ) {
    super(apiKey, model);

    this.baseUrl = (options.baseUrl ?? process.env.GEMINI_BASE_URL ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      ''
    );
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.jsonMode = options.jsonMode ?? true;
    if (options.fetchImpl !== undefined) this.fetchImpl = options.fetchImpl;

    if (THINKING_MODEL_PATTERN.test(this.model)) {
      this.maxTokens = Math.max(this.maxTokens, THINKING_MAX_TOKENS);
      this.logDebug(`Thinking-capable model detected — raising maxTokens to ${this.maxTokens}.`);
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

    let response: GenerateContentResponse;
    try {
      response = await postJson<GenerateContentResponse>({
        url: this.endpoint('generateContent'),
        headers: { 'x-goog-api-key': this.apiKey },
        body: this.buildBody(request),
        timeoutMs: this.timeoutMs,
        maxRetries: this.maxRetries,
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
        label: 'Gemini healing request',
        // One deadline governs the chain: when the engine stops waiting, this stops asking.
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      throw this.describeError(error, 'Healing request failed');
    }

    // A blocked prompt returns 200 with no candidates at all.
    if (response.promptFeedback?.blockReason) {
      throw new Error(
        `Gemini blocked the healing prompt (${response.promptFeedback.blockReason}). ` +
          'The page content likely tripped a safety filter.'
      );
    }

    const candidate = response.candidates?.[0];

    if (candidate?.finishReason === 'SAFETY' || candidate?.finishReason === 'PROHIBITED_CONTENT') {
      throw new Error(`Gemini declined the healing request (${candidate.finishReason}).`);
    }
    if (candidate?.finishReason === 'MAX_TOKENS') {
      this.logWarn(
        `Response hit the ${this.model} output limit — the JSON may be truncated. ` +
          'Raise maxTokens if this recurs.'
      );
    }

    // Join every text part: a response can be split across parts, and thinking
    // models emit non-text parts that must be skipped rather than read as empty.
    const text = (candidate?.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('')
      .trim();

    const parsed = this.parseResponse(text);
    if (!parsed.suggestedSelector) {
      throw new Error(
        `Gemini returned no usable selector (finishReason: ${candidate?.finishReason ?? 'unknown'}).`
      );
    }

    // Thinking tokens are billed as output but reported separately.
    const output =
      (response.usageMetadata?.candidatesTokenCount ?? 0) +
      (response.usageMetadata?.thoughtsTokenCount ?? 0);

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
        input: response.usageMetadata?.promptTokenCount ?? 0,
        output,
      },
      provider: `gemini:${this.model}`,
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
      this.logError('No API key configured — set GEMINI_API_KEY in your .env file.');
      return false;
    }

    try {
      await postJson<GenerateContentResponse>({
        url: this.endpoint('generateContent'),
        headers: { 'x-goog-api-key': this.apiKey },
        body: {
          contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
          generationConfig: { maxOutputTokens: 16 },
        },
        timeoutMs: this.timeoutMs,
        maxRetries: 0,
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
        label: 'Gemini validation request',
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

  /**
   * Builds a model endpoint URL.
   *
   * The model is part of the path here, unlike the other providers. `models/` is
   * prepended only when the caller has not already included it, so both
   * `gemini-2.0-flash` and `models/gemini-2.0-flash` work.
   *
   * @param method - API method, e.g. `generateContent`.
   * @returns The absolute URL.
   */
  private endpoint(method: string): string {
    const model = this.model.startsWith('models/') ? this.model : `models/${this.model}`;
    return `${this.baseUrl}/${model}:${method}`;
  }

  /**
   * Builds the generateContent body.
   *
   * @param request - Context describing the failed action.
   * @returns The request body.
   */
  private buildBody(request: HealingRequest): Record<string, unknown> {
    return {
      systemInstruction: { parts: [{ text: this.buildSystemPrompt() }] },
      contents: [{ role: 'user', parts: [{ text: this.buildUserPrompt(request) }] }],
      generationConfig: {
        maxOutputTokens: this.maxTokens,
        ...(this.jsonMode ? { responseMimeType: 'application/json' } : {}),
      },
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
        case 400:
          // Gemini reports an invalid key as 400 API_KEY_INVALID, not 401.
          if (/api[_ ]?key/i.test(error.body)) {
            return new Error(`${context}: invalid Gemini API key — check GEMINI_API_KEY.`);
          }
          return new Error(
            `${context}: Gemini rejected the request — ${error.message.replace(/^HTTP 400: /, '')} ` +
              '(if this mentions responseMimeType, construct the provider with { jsonMode: false }).'
          );
        case 401:
        case 403:
          return new Error(
            `${context}: Gemini denied access (${error.status}). Check that GEMINI_API_KEY is valid ` +
              'and that the Generative Language API is enabled for the project.'
          );
        case 404:
          return new Error(
            `${context}: model "${this.model}" was not found — check GEMINI_MODEL for typos.`
          );
        case 429:
          return new Error(
            `${context}: rate limited or out of quota (429) — ${error.message.replace(/^HTTP 429: /, '')}`
          );
        default:
          return new Error(`${context}: ${error.message}`);
      }
    }

    const detail = error instanceof Error ? error.message : String(error);
    return new Error(`${context}: ${detail}`);
  }
}
