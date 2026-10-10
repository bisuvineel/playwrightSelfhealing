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
 * TLS failure codes that mean "this process does not trust the certificate it was shown".
 *
 * Almost always a corporate network that inspects HTTPS by re-signing it with its own
 * root certificate. Browsers and `curl` on Windows trust that root through the operating
 * system's store; **Node does not** — it ships its own CA list. So on the same machine
 * `curl https://api.anthropic.com` answers and every heal fails. Reproduced on the
 * machine this package is developed on:
 *
 * ```
 *   curl                        → HTTP 401 in 0.77s
 *   node  fetch()               → UNABLE_TO_GET_ISSUER_CERT_LOCALLY
 *   node --use-system-ca fetch  → HTTP 401
 * ```
 *
 * Before this existed the failure read `could not reach api.anthropic.com: fetch failed`
 * — indistinguishable from an outage — and was retried with backoff on every attempt of
 * every heal, for a condition that cannot clear on its own.
 */
const TLS_TRUST_CODES: ReadonlySet<string> = new Set([
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_UNTRUSTED',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * Reads the system error code from a failed `fetch`.
 *
 * `fetch` rejects with a bare `TypeError: fetch failed` and puts the reason on `cause`,
 * sometimes one level further down. Reporting only the message discards the one piece of
 * information that says what to do.
 *
 * @param error - Whatever `fetch` rejected with.
 * @returns The code, e.g. `ENOTFOUND` or `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`.
 */
export function networkCauseCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && code !== '') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * The provider's certificate is not trusted by this Node process.
 *
 * Its own type so a caller — the setup checker, a report — can recognise it and give the
 * fix rather than a generic network message. Never retried. See {@link TLS_TRUST_CODES}.
 */
export class TlsTrustError extends Error {
  constructor(
    readonly label: string,
    readonly host: string,
    readonly code: string
  ) {
    super(
      `${label} could not reach ${host}: its TLS certificate is not trusted by Node ` +
        `(${code}). This is almost always a network that inspects HTTPS with its own ` +
        'root certificate — browsers and curl trust it through the operating system, Node ' +
        'does not. Fix: run with NODE_OPTIONS=--use-system-ca (Node 22.15+ or 23.8+), or ' +
        "set NODE_EXTRA_CA_CERTS to a PEM file holding your organisation's root " +
        'certificate. Not retried: a trust failure does not clear on its own.'
    );
    this.name = 'TlsTrustError';
  }
}

/**
 * A provider failure caused by configuration, which no retry — and no later heal in the
 * same process — can fix.
 *
 * Provider errors come in two classes, and treating them as one was measured to be
 * expensive. **Transient** failures — a 429, a 5xx, a reset connection, a timeout — can
 * clear, so they are retried and counted toward the circuit breaker. **Configuration**
 * failures — an untrusted certificate, a rejected key, a model that does not exist —
 * fail identically every time. Before this type existed they were retried like the
 * first class: a healing run on a machine behind HTTPS inspection made two doomed calls
 * per stale selector per test, and with four workers each seeing only a couple of
 * failures, the per-worker breaker never tripped at all.
 *
 * Providers flatten errors into messages for people to read, which is exactly what
 * stops an engine from telling a bad key from a timeout. This type carries the
 * classification through that flattening; the engine switches healing off for the rest
 * of the worker on the first one, with the provider's own actionable message as the
 * reason.
 */
export class ProviderConfigurationError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'ProviderConfigurationError';
  }
}

/**
 * Whether a failed provider call failed because of configuration.
 *
 * Deliberately narrow — a false positive switches healing off for the rest of a worker,
 * so only failures that cannot change within a run are included:
 *
 * - an untrusted TLS certificate ({@link TlsTrustError});
 * - 401 and 403: a rejected credential, a key without access to the model, or a proxy
 *   answering in the provider's place — none of which changes mid-run;
 * - 404: a model or deployment that does not exist;
 * - 429 with OpenAI's `insufficient_quota`: out of credit, which looks like a rate limit
 *   but will not recover on backoff;
 * - 400 carrying Gemini's `API_KEY_INVALID` (its bad-key signal is a 400, not a 401) or
 *   Anthropic's credit-balance error.
 *
 * Every other status, and every network failure that is not a certificate problem, is
 * transient and handled as before.
 *
 * @param error - Whatever the HTTP layer threw.
 * @returns True when retrying cannot help.
 */
export function isConfigurationFailure(error: unknown): boolean {
  if (error instanceof TlsTrustError) return true;
  if (!(error instanceof HttpError)) return false;

  if (error.status === 401 || error.status === 403 || error.status === 404) return true;
  if (error.status === 429) return /insufficient_quota/i.test(error.body);
  if (error.status === 400) return /API_KEY_INVALID|credit balance/i.test(error.body);

  return false;
}

/**
 * Keeps a failure's classification when a provider rewrites it for display.
 *
 * @param original - The error the HTTP layer threw.
 * @param described - The provider's human-readable rewrite of it.
 * @returns `described`, or a {@link ProviderConfigurationError} carrying its message.
 */
export function asProviderFailure(original: unknown, described: Error): Error {
  return isConfigurationFailure(original)
    ? new ProviderConfigurationError(described.message, original)
    : described;
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

      const host = new URL(url).host;
      const code = isAbort ? undefined : networkCauseCode(error);

      // A certificate the process does not trust is configuration, not weather: it
      // fails identically on every attempt, so retrying only adds backoff to every heal.
      // Thrown at once, with the fix in the message.
      if (code !== undefined && TLS_TRUST_CODES.has(code)) throw new TlsTrustError(label, host, code);

      const detail = isAbort
        ? `${label} timed out after ${timeoutMs}ms`
        : `${label} could not reach ${host}: ${
            error instanceof Error ? error.message : String(error)
          }${code !== undefined ? ` (${code})` : ''}`;

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
