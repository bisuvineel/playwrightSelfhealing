/**
 * How the HTTP layer reports a network that is in the way.
 *
 * Found on the machine this package is developed on, behind a corporate network that
 * inspects HTTPS by re-signing it with its own root certificate:
 *
 * ```
 *   curl https://api.anthropic.com   → HTTP 401 in 0.77s
 *   node fetch()                     → UNABLE_TO_GET_ISSUER_CERT_LOCALLY
 *   node --use-system-ca fetch()     → HTTP 401
 * ```
 *
 * Browsers and curl trust that root through Windows; Node trusts only its bundled list.
 * Every heal failed, and the message said `could not reach api.anthropic.com: fetch
 * failed` — indistinguishable from an outage — while each attempt was retried with
 * backoff, for a condition that cannot clear on its own. The setup checker, the tool
 * built to diagnose exactly this, pointed at proxies.
 *
 * `fetch` is stubbed with the rejection shape Node really produces (a bare `TypeError`
 * whose `cause` carries the code), so no network is touched.
 *
 *   npm run test:unit
 */

'use strict';

const assert = require('node:assert/strict');
const { describe, it, afterEach } = require('node:test');

const { postJson, networkCauseCode, TlsTrustError } = require('../../dist/providers/httpJson');

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * Makes `fetch` reject the way Node's does, counting attempts.
 *
 * @param {string} code - The system error code to put on `cause`.
 * @returns {{ calls: () => number }} An attempt counter.
 */
function failFetchWith(code) {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    const error = new TypeError('fetch failed');
    error.cause = Object.assign(new Error(`connect failed: ${code}`), { code });
    throw error;
  };
  return { calls: () => calls };
}

/** Silences the retry warnings. */
async function quiet(fn) {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

const REQUEST = {
  url: 'https://api.anthropic.com/v1/messages',
  headers: {},
  body: {},
  label: 'Anthropic healing request',
  timeoutMs: 2_000,
  maxRetries: 2,
};

describe('networkCauseCode — the reason fetch hides', () => {
  it('reads the code off cause, where fetch puts it', () => {
    const error = new TypeError('fetch failed');
    error.cause = { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' };
    assert.equal(networkCauseCode(error), 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY');
  });

  it('looks more than one level down', () => {
    const error = { cause: { cause: { code: 'ENOTFOUND' } } };
    assert.equal(networkCauseCode(error), 'ENOTFOUND');
  });

  it('returns nothing, rather than throwing, when there is no code', () => {
    assert.equal(networkCauseCode(new Error('plain')), undefined);
    assert.equal(networkCauseCode(null), undefined);
    assert.equal(networkCauseCode('a string'), undefined);
  });
});

describe('an untrusted certificate', () => {
  for (const code of ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN', 'CERT_HAS_EXPIRED']) {
    it(`is not retried, and says how to fix it (${code})`, async () => {
      const attempts = failFetchWith(code);

      await assert.rejects(
        () => quiet(() => postJson(REQUEST)),
        (error) => {
          assert.ok(error instanceof TlsTrustError, `expected TlsTrustError, got ${error.name}`);
          assert.equal(error.code, code);
          assert.equal(error.host, 'api.anthropic.com');
          // The fix, in the message — the whole point of the type.
          assert.match(error.message, /NODE_OPTIONS=--use-system-ca/);
          assert.match(error.message, /NODE_EXTRA_CA_CERTS/);
          assert.ok(!/fetch failed$/.test(error.message), 'must not read like an outage');
          return true;
        }
      );

      // A trust failure is identical on every attempt; backoff only slows every heal.
      assert.equal(attempts.calls(), 1, 'a certificate failure must not be retried');
    });
  }
});

describe('an ordinary network failure', () => {
  it('is still retried, and now names its code', async () => {
    const attempts = failFetchWith('ECONNRESET');

    await assert.rejects(
      () => quiet(() => postJson(REQUEST)),
      (error) => {
        assert.ok(!(error instanceof TlsTrustError));
        assert.match(error.message, /could not reach api\.anthropic\.com/);
        assert.match(error.message, /\(ECONNRESET\)/, 'the code used to be discarded');
        return true;
      }
    );

    // A reset connection can clear, so the retry policy is unchanged for it.
    assert.equal(attempts.calls(), 3, 'maxRetries: 2 means three attempts');
  });
});
