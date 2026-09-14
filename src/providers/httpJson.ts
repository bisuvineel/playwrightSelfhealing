/**
 * Minimal JSON-over-HTTP client shared by the REST-based providers.
 *
 * Deliberately not an SDK. Healing needs exactly one call per provider — a chat
 * completion with a system and a user message — so pulling in `openai` and
 * `@google/genai` would add two heavyweight dependencies (and their version
 * churn) to every install for a few hundred bytes of request body. What the SDKs
 * give you that matters here is retry handling and typed errors, and both are
 * reproduced below.
 *
 * @module providers/httpJson
 */

import { createLogger } from '../utils/logger';

const log = createLogger('heal:http');

/** Status codes worth retrying: rate limits and transient server faults. */
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

/** Options for {@link postJson}. */
export interface PostJsonOptions {
  /** Absolute endpoint URL. */
  url: string;
  /** Request body, serialised as JSON. */
  body: unknown;
  /** Extra headers merged over `content-type: application/json`. */
  headers?: Record<string, string>;
  /** Abort the request after this many milliseconds. */
  timeoutMs?: number;
  /** Retry attempts for retryable statuses and network errors. Default 2. */
  maxRetries?: number;
  /** Injectable `fetch`, for tests. Defaults to the global. */
  fetchImpl?: typeof fetch;
  /** Label used in log lines and error messages. */
  label?: string;
  /**
   * Aborts the whole call — the request in flight, any backoff being waited out, and any
   * retry not yet started.
   *
   * `timeoutMs` bounds one **attempt**; this bounds the **chain**. Without it, a caller
   * that stopped waiting could not stop the retries: an engine giving up after 30s left a
   * hung request plus two more attempts running unobserved, for up to another minute of
   * open sockets. Two deadlines with no relationship to each other, where the outer one
   * had no authority over the inner.
   */
  signal?: AbortSignal;
}

/** A non-2xx response, carrying the status and the provider's own message. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * A 2xx response whose body was not JSON — usually an HTML error page injected by a
 * proxy or captive portal. Distinct from a network failure so it is not reported as
 * one, and not retried: the endpoint answered, it just answered with the wrong thing.
 */
export class NonJsonResponseError extends Error {
  constructor(
    readonly body: string,
    message: string
  ) {
    super(message);
    this.name = 'NonJsonResponseError';
  }
}

/**
 * Extracts the human-readable message from a provider error body.
 *
 * OpenAI returns `{ error: { message } }`, Gemini `{ error: { message, status } }`,
 * and both occasionally return HTML from a proxy. Falls back to the raw text.
 *
 * @param body - Raw response body.
 * @returns The most specific message available.
 */
function describeErrorBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string };
    if (typeof parsed.error === 'string') return parsed.error;
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // Not JSON — fall through.
  }

  const collapsed = body.replace(/\s+/g, ' ').trim();
  return collapsed.length > 200 ? `${collapsed.slice(0, 200)}…` : collapsed || 'no response body';
}

/**
 * Blocks for `ms`, or until `signal` aborts, without holding a timer the runtime tracks.
 *
 * The abort path matters: a backoff is the longest a cancelled call would otherwise sit
 * doing nothing before noticing it had been cancelled.
 *
 * @param ms - Milliseconds to wait.
 * @param signal - Cuts the wait short when it aborts.
 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  // Checked before the listener is attached. `addEventListener('abort', …)` does **not**
  // fire on a signal that has already aborted, so a chain cancelled during the previous
  // attempt would otherwise sit out the whole backoff before noticing.
  if (signal?.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };

    const timer = setTimeout(finish, ms);
    // Do not keep the process alive purely for a backoff sleep.
    if (typeof timer.unref === 'function') timer.unref();

    signal?.addEventListener('abort', finish, { once: true });
  });
}

/**
 * Raised when the caller's signal aborted the chain.
 *
 * Distinct from a timeout so a reader is not told the request ran out of time when in fact
 * something upstream stopped caring about it.
 */
export class RequestCancelledError extends Error {
  constructor(label: string) {
    super(`${label} was cancelled`);
    this.name = 'RequestCancelledError';
  }
}

/**
 * POSTs JSON and parses the JSON response.
 *
 * Retries retryable statuses and network errors with exponential backoff, honouring
 * a `retry-after` header when the server sends one. A timeout aborts the request
 * rather than leaving it hanging, because a stalled heal would consume the whole
 * test timeout.
 *
 * @param options - See {@link PostJsonOptions}.
 * @returns The parsed response body.
 * @throws {HttpError} On a non-retryable status, or after retries are exhausted.
 * @throws {Error} On network failure, timeout, or unparseable JSON.
 */
export async function postJson<T>(options: PostJsonOptions): Promise<T> {
  const {
    url,
    body,
    headers = {},
    timeoutMs = 30_000,
    maxRetries = 2,
    fetchImpl = globalThis.fetch,
    label = 'request',
    signal,
  } = options;

  if (typeof fetchImpl !== 'function') {
    throw new Error(
      'No fetch implementation available. Node 18 or newer is required, or pass fetchImpl explicitly.'
    );
  }

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Checked before each attempt, not only inside the catch: a chain cancelled during a
    // backoff must not start the next request at all.
    if (signal?.aborted) throw new RequestCancelledError(label);

    // A fresh controller per attempt: an aborted signal cannot be reused. The caller's
    // signal is forwarded onto it, so one abort reaches the request actually in flight.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const forwardAbort = (): void => controller.abort();
    signal?.addEventListener('abort', forwardAbort, { once: true });

    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();

      if (!response.ok) {
        const detail = describeErrorBody(text);
        const error = new HttpError(response.status, text, `HTTP ${response.status}: ${detail}`);

        if (!RETRYABLE.has(response.status) || attempt === maxRetries) throw error;

        // Prefer the server's own guidance on when to come back.
        const retryAfter = Number(response.headers.get('retry-after'));
        const backoff = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1_000
          : 2 ** attempt * 500;

        log.warn(`${label} failed with ${response.status}; retrying in ${backoff}ms.`);
        lastError = error;
        await delay(backoff, signal);
        continue;
      }

      try {
        return JSON.parse(text) as T;
      } catch {
        throw new NonJsonResponseError(
          text,
          `${label} returned a non-JSON body: ${describeErrorBody(text)}`
        );
      }
    } catch (error) {
      // Answered, but not with JSON — surface as-is rather than as a network error.
      if (error instanceof NonJsonResponseError) throw error;

      if (error instanceof HttpError) {
        if (!RETRYABLE.has(error.status) || attempt === maxRetries) throw error;
        lastError = error;
        continue;
      }

      // An AbortError is ours either way — the per-attempt timeout, or the caller's
      // signal forwarded onto it. Only the caller's is final: a timeout is what retries
      // exist for, whereas a cancelled chain must stop asking immediately.
      const isAbort = error instanceof Error && error.name === 'AbortError';
      if (isAbort && signal?.aborted) throw new RequestCancelledError(label);

      const detail = isAbort
        ? `${label} timed out after ${timeoutMs}ms`
        : `${label} could not reach ${new URL(url).host}: ${
            error instanceof Error ? error.message : String(error)
          }`;

      const wrapped = new Error(detail);
      if (attempt === maxRetries) throw wrapped;

      const backoff = 2 ** attempt * 500;
      log.warn(`${detail}; retrying in ${backoff}ms.`);
      lastError = wrapped;
      await delay(backoff, signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }

  throw lastError ?? new Error(`${label} failed for an unknown reason.`);
}
