/**
 * Unit tests for how a heal spends time: the test's own deadline, and reusing a heal
 * without waiting out a stale selector's action timeout first.
 *
 * Two costs the heal loop used to ignore. A heal spent `HEALER_TIMEOUT` per attempt
 * whatever the test had left, so a test near its timeout was killed mid-heal and reported
 * `Test timeout exceeded` instead of the error naming the stale selector. And the cache
 * saved the provider call but not the wait: every later use of a stale locator still ran
 * to its full `actionTimeout` before the heal path began.
 *
 * Drives the real `HealingEngine` against a stub page and provider. No browser, no
 * credential, no network.
 *
 *   npm run test:unit
 */

'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { HealingEngine } = require('../../dist/core/HealingEngine');
const { HealBudget } = require('../../dist/core/HealBudget');
const { SelectorCache } = require('../../dist/core/SelectorCache');

/** Awaits `fn` with the engine's logging silenced. */
async function quietly(fn) {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

const HEALED = "getByRole('button', { name: 'Place order' })";

/**
 * A page where CSS selectors are stale and role locators resolve.
 *
 * @param {object} [options] - `originalWorks` makes `page.locator()` resolve too, as a
 * selector that is not stale would.
 * @returns {object} The stub.
 */
function pageStub({ originalWorks = false } = {}) {
  const locatorWith = (matches) => {
    const locator = {
      first: () => locator,
      last: () => locator,
      nth: () => locator,
      waitFor: async () => {},
      count: async () => matches,
      isVisible: async () => true,
      ariaSnapshot: async () => '- button "Place order"',
    };
    return locator;
  };

  const page = {
    url: () => 'https://app.test/checkout',
    locator: (selector) => (selector === 'body' ? locatorWith(1) : locatorWith(originalWorks ? 1 : 0)),
  };
  for (const method of [
    'getByRole', 'getByLabel', 'getByText',
    'getByPlaceholder', 'getByTestId', 'getByTitle', 'getByAltText',
  ]) {
    page[method] = () => locatorWith(1);
  }
  page.frameLocator = () => page;
  return page;
}

/**
 * A provider that answers with a working selector, or hangs until cancelled.
 *
 * @param {object} [options] - `hangs` makes every call wait for its abort signal.
 * @returns {object} The provider, with a `calls` counter.
 */
function providerStub({ hangs = false } = {}) {
  return {
    calls: 0,
    async heal(_request, options) {
      this.calls += 1;
      if (hangs) {
        await new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      return {
        suggestedSelector: HEALED,
        confidence: 0.95,
        reasoning: 'the submit button',
        tokenUsage: { input: 10, output: 2 },
        provider: 'stub',
      };
    },
  };
}

/**
 * A real engine wired to stubs, with a working local cache.
 *
 * @param {object} [options] - `provider`, `timeout`, `breakerThreshold`, `onOutcome`.
 * @returns {object} The engine, its provider and its budget.
 */
function engineWith({ provider, timeout = 5_000, breakerThreshold = 0, onOutcome } = {}) {
  const ai = provider ?? providerStub();
  const budget = new HealBudget({ maxHeals: 0, breakerThreshold });

  const engine = new HealingEngine(
    {
      enabled: true,
      maxRetries: 2,
      timeout,
      provider: 'stub',
      model: 'stub',
      confidenceThreshold: 0.7,
      privacy: { redact: 'identifiers' },
      intent: { mode: 'off', unverifiedConfidence: 0.9 },
      candidates: false,
    },
    ai,
    {
      recorder: { recordHeal() {} },
      cache: new SelectorCache(true, null),
      budget,
      ...(onOutcome ? { onOutcome } : {}),
    }
  );

  return { engine, ai, budget };
}

describe('a heal respects the time left in the test', () => {
  it('heals normally when the deadline leaves room', async () => {
    const { engine, ai } = engineWith();

    const outcome = await quietly(() =>
      engine.attemptHealDetailed(pageStub(), '#place-order-btn', 'click', undefined, undefined, {
        deadline: Date.now() + 60_000,
      })
    );

    assert.equal(outcome.healed, HEALED);
    assert.equal(ai.calls, 1);
  });

  it('does not start a provider call it cannot finish, and says why', async () => {
    // With a second left, a 3-7 s call can only be cut off — and a test killed mid-heal
    // reports `Test timeout exceeded`, which names nothing, instead of the stale selector.
    const { engine, ai } = engineWith();

    const outcome = await quietly(() =>
      engine.attemptHealDetailed(pageStub(), '#place-order-btn', 'click', undefined, undefined, {
        deadline: Date.now() + 1_000,
      })
    );

    assert.equal(outcome.healed, null);
    assert.equal(ai.calls, 0, 'no call should be started');
    assert.equal(outcome.skipped, true, 'nothing was spent, so it reads as skipped');
    assert.match(outcome.error, /timeout was left/);
  });

  it('still reuses a cached heal when there is no time for a call', async () => {
    // The cache costs milliseconds, so a short deadline must not block it.
    const { engine, ai } = engineWith();
    await quietly(() => engine.attemptHealDetailed(pageStub(), '#place-order-btn', 'click'));

    const outcome = await quietly(() =>
      engine.attemptHealDetailed(pageStub(), '#place-order-btn', 'click', undefined, undefined, {
        deadline: Date.now() + 500,
      })
    );

    assert.equal(outcome.healed, HEALED);
    assert.equal(ai.calls, 1, 'the second heal came from the cache');
  });

  it('cuts a call short at the deadline rather than at HEALER_TIMEOUT', async () => {
    const { engine } = engineWith({ provider: providerStub({ hangs: true }), timeout: 30_000 });

    const started = Date.now();
    const outcome = await quietly(() =>
      engine.attemptHealDetailed(pageStub(), '#place-order-btn', 'click', undefined, undefined, {
        deadline: Date.now() + 3_300,
      })
    );
    const took = Date.now() - started;

    assert.equal(outcome.healed, null);
    assert.ok(took < 10_000, `the heal took ${took}ms; it should stop near the 3.3 s deadline`);
    assert.match(outcome.error, /time left in the test|timeout was left/);
  });

  it('does not count a call cut short by the test deadline against the breaker', async () => {
    // The provider may have been about to answer. A breaker tripped by a tight test
    // timeout would switch healing off for the rest of the worker for the wrong reason.
    const { engine, budget } = engineWith({
      provider: providerStub({ hangs: true }),
      timeout: 30_000,
      breakerThreshold: 1,
    });

    await quietly(() =>
      engine.attemptHealDetailed(pageStub(), '#place-order-btn', 'click', undefined, undefined, {
        deadline: Date.now() + 3_300,
      })
    );

    assert.equal(budget.isBreakerOpen, false);
  });

  it('changes nothing when no deadline is given', async () => {
    const { engine, ai } = engineWith();

    const outcome = await quietly(() => engine.attemptHealDetailed(pageStub(), '#place-order-btn', 'click'));

    assert.equal(outcome.healed, HEALED);
    assert.equal(ai.calls, 1);
  });
});

describe('reusing a known heal without waiting for the action to fail', () => {
  it('knows nothing, and reuses nothing, before the first heal', async () => {
    const outcomes = [];
    const { engine } = engineWith({ onOutcome: (o) => outcomes.push(o) });

    assert.equal(engine.hasKnownHeal('#place-order-btn'), false);
    assert.equal(await quietly(() => engine.reuseKnownHeal(pageStub(), '#place-order-btn', 'click')), null);
    assert.equal(outcomes.length, 0, 'a non-event must not reach onOutcome');
  });

  it('reuses a heal from earlier in the worker with no provider call', async () => {
    const { engine, ai } = engineWith();
    await quietly(() => engine.attemptHealDetailed(pageStub(), '#place-order-btn', 'click'));

    assert.equal(engine.hasKnownHeal('#place-order-btn'), true);
    const outcome = await quietly(() => engine.reuseKnownHeal(pageStub(), '#place-order-btn', 'click'));

    assert.equal(outcome.healed, HEALED);
    assert.equal(outcome.attempts[0].provider, 'cache', 'recorded as a cache heal, as before');
    assert.equal(ai.calls, 1, 'only the original heal reached the provider');
  });

  it('publishes a reuse to onOutcome, so it reaches the report and the CI gate', async () => {
    const outcomes = [];
    const { engine } = engineWith({ onOutcome: (o) => outcomes.push(o) });
    await quietly(() => engine.attemptHealDetailed(pageStub(), '#place-order-btn', 'click'));

    await quietly(() => engine.reuseKnownHeal(pageStub(), '#place-order-btn', 'click'));

    assert.equal(outcomes.length, 2);
    assert.equal(outcomes[1].healed, HEALED);
  });

  it('steps aside when the original selector resolves on this page', async () => {
    // The same staleness test the heal loop opens with: a selector that finds its element
    // here is acted on as written, not swapped for a cached replacement.
    const { engine } = engineWith();
    await quietly(() => engine.attemptHealDetailed(pageStub(), '#place-order-btn', 'click'));

    const outcome = await quietly(() =>
      engine.reuseKnownHeal(pageStub({ originalWorks: true }), '#place-order-btn', 'click')
    );

    assert.equal(outcome, null);
  });

  it('steps aside on a route the privacy policy blocks, leaving the normal path to report it', async () => {
    const engine = new HealingEngine(
      {
        enabled: true, maxRetries: 1, timeout: 5_000, provider: 'stub', model: 'stub',
        confidenceThreshold: 0.7, candidates: false,
        privacy: { redact: 'identifiers', blockedPaths: ['/admin/**'] },
        intent: { mode: 'off', unverifiedConfidence: 0.9 },
      },
      providerStub(),
      { recorder: { recordHeal() {} }, cache: new SelectorCache(true, null) }
    );
    // Healed on an allowed route, so the selector is known…
    await quietly(() => engine.attemptHealDetailed(pageStub(), '#place-order-btn', 'click'));
    assert.equal(engine.hasKnownHeal('#place-order-btn'), true);

    // …and then met again on a blocked one.
    const adminPage = { ...pageStub(), url: () => 'https://app.test/admin/users' };
    assert.equal(await quietly(() => engine.reuseKnownHeal(adminPage, '#place-order-btn', 'click')), null);
  });

  it('knows nothing when the cache is off', async () => {
    const engine = new HealingEngine(
      {
        enabled: true, maxRetries: 1, timeout: 5_000, provider: 'stub', model: 'stub',
        confidenceThreshold: 0.7, candidates: false, cache: false,
        privacy: { redact: 'identifiers' },
        intent: { mode: 'off', unverifiedConfidence: 0.9 },
      },
      providerStub(),
      { recorder: { recordHeal() {} }, cache: new SelectorCache(false) }
    );
    await quietly(() => engine.attemptHealDetailed(pageStub(), '#place-order-btn', 'click'));

    assert.equal(engine.hasKnownHeal('#place-order-btn'), false);
  });
});
