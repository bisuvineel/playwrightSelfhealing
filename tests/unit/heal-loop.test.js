/**
 * Unit tests for the healing loop itself — the retry/budget/breaker interaction.
 *
 * Everything else in `tests/unit` exercises one collaborator. This drives the real
 * `HealingEngine` against a stub page and a stub provider, because the behaviour worth
 * pinning here only exists in the *relationship* between them: how many times one failing
 * selector reaches the provider, what that costs the budget, and what the breaker counts.
 *
 * The distinction the ceiling turns on is easy to get wrong and was: `HEALER_MAX_HEALS` is
 * named, configured, documented and reported in **heals**, while the retry loop makes up to
 * `HEALER_MAX_RETRIES` calls per heal. Charging each call made a ceiling of 100 mean 50.
 * The breaker is the deliberate opposite — it counts attempts, so an outage shows up in
 * half a failing action rather than after whole heals exhaust their retries.
 *
 * No browser, no credential, no network.
 *
 *   npm run test:unit
 */

'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { HealingEngine } = require('../../dist/core/HealingEngine');
const { HealBudget } = require('../../dist/core/HealBudget');
const { SelectorCache } = require('../../dist/core/SelectorCache');

/** Silences the engine, which is deliberately loud on rejection paths. */
function quiet(fn) {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return fn();
  } finally {
    Object.assign(console, saved);
  }
}

/**
 * A page stub good enough for capture and validation.
 *
 * @param {object} [options] - `matches` controls how many elements a selector resolves to;
 * 0 makes every suggestion fail validation, so every retry runs.
 * @returns {object} The stub.
 */
function pageStub({ matches = 0 } = {}) {
  const locator = {
    first: () => locator,
    last: () => locator,
    nth: () => locator,
    waitFor: async () => {},
    count: async () => matches,
    isVisible: async () => true,
    ariaSnapshot: async () => '- button "Place order"',
  };

  const page = { url: () => 'https://app.test/checkout' };
  for (const method of [
    'locator', 'getByRole', 'getByLabel', 'getByText',
    'getByPlaceholder', 'getByTestId', 'getByTitle', 'getByAltText',
  ]) {
    page[method] = () => locator;
  }
  page.frameLocator = () => page;
  return page;
}

/**
 * A provider that answers, or fails, on demand.
 *
 * @param {object} [options] - `fails` makes every call throw, as an outage would.
 * @returns {object} The provider, with a `calls` counter.
 */
function providerStub({ fails = false } = {}) {
  return {
    calls: 0,
    async heal() {
      this.calls += 1;
      if (fails) throw new Error('connect ECONNREFUSED');
      return {
        suggestedSelector: "getByRole('button', { name: 'Place order' })",
        confidence: 0.95,
        reasoning: 'the submit button',
        tokenUsage: { input: 10, output: 2 },
        provider: 'stub',
      };
    },
  };
}

/**
 * Builds a real engine wired to stubs.
 *
 * @param {object} [options] - `maxRetries`, `maxHeals`, `breakerThreshold`, `provider`.
 * @returns {object} The engine and the provider it will call.
 */
function engineWith({ maxRetries = 3, maxHeals = 0, breakerThreshold = 0, provider } = {}) {
  const ai = provider ?? providerStub();

  const engine = new HealingEngine(
    {
      enabled: true,
      maxRetries,
      timeout: 5_000,
      provider: 'stub',
      model: 'stub',
      confidenceThreshold: 0.7,
      privacy: { redact: 'identifiers' },
      // Off, so a rejection is always the validator's doing and the count is unambiguous.
      intent: { mode: 'off', unverifiedConfidence: 0.9 },
      cache: false,
    },
    ai,
    {
      recorder: { recordHeal() {} },
      cache: new SelectorCache(false),
      budget: new HealBudget({ maxHeals, breakerThreshold }),
    }
  );

  return { engine, ai };
}

/**
 * Runs one heal against a page where nothing validates, so every retry is used.
 *
 * @param {object} engine - Engine to drive.
 * @returns {Promise<object>} The outcome.
 */
function healOnce(engine) {
  return quiet(() => engine.attemptHealDetailed(pageStub(), '#place-order-btn', 'click'));
}

describe('the spend ceiling counts heals, not provider calls', () => {
  it('charges one heal however many retries it takes', async () => {
    const { engine, ai } = engineWith({ maxRetries: 3 });

    await healOnce(engine);

    // Three calls, because nothing validated and each rejection fed the next prompt.
    assert.equal(ai.calls, 3);
    // One heal, because that is the unit the ceiling is expressed in.
    assert.equal(engine.budgetStats().spent, 1);
  });

  it('lets a ceiling of N through N heals, not N ÷ maxRetries of them', async () => {
    // The regression this exists for: with the counter on attempts, maxHeals=2 and
    // maxRetries=3 allowed a single heal before refusing everything.
    const { engine } = engineWith({ maxRetries: 3, maxHeals: 2 });

    const first = await healOnce(engine);
    const second = await healOnce(engine);
    const third = await healOnce(engine);

    assert.equal(first.skipped, undefined);
    assert.equal(second.skipped, undefined);
    assert.equal(third.skipped, true, 'the third should be refused, not the second');

    const stats = engine.budgetStats();
    assert.equal(stats.spent, 2);
    assert.equal(stats.refusedByBudget, 1);
  });

  it('reports a refusal as skipped, with the ceiling named', async () => {
    const { engine, ai } = engineWith({ maxRetries: 2, maxHeals: 1 });

    await healOnce(engine);
    const callsAfterFirst = ai.calls;
    const refused = await healOnce(engine);

    assert.equal(refused.skipped, true);
    assert.equal(refused.healed, null);
    assert.match(refused.error, /HEALER_MAX_HEALS/);
    assert.equal(ai.calls, callsAfterFirst, 'a refused heal must not reach the provider');
  });
});

describe('the breaker counts attempts, which is how an outage is caught early', () => {
  it('trips inside a single heal when the provider is down', async () => {
    // Deliberately not the same unit as the ceiling. With threshold 2 and 3 retries, the
    // breaker opens partway through the first failing action rather than after two whole
    // heals have burned six timeouts.
    const { engine, ai } = engineWith({
      maxRetries: 3,
      breakerThreshold: 2,
      provider: providerStub({ fails: true }),
    });

    await healOnce(engine);

    assert.equal(ai.calls, 2, 'the third attempt should not have been made');
    assert.equal(engine.budgetStats().breakerOpen, true);
  });

  it('refuses the next heal without calling out, and says the provider failed', async () => {
    const { engine, ai } = engineWith({
      maxRetries: 3,
      breakerThreshold: 2,
      provider: providerStub({ fails: true }),
    });

    await healOnce(engine);
    const after = ai.calls;
    const refused = await healOnce(engine);

    assert.equal(ai.calls, after);
    assert.equal(refused.skipped, true);
    assert.match(refused.error, /failed 2 times in a row/);
  });

  it('does not trip on a provider that answers, however the answer is judged', async () => {
    // A rejected suggestion is not a provider failure — the provider is working fine, and
    // a breaker that opened here would disable healing for entirely the wrong reason.
    const { engine } = engineWith({ maxRetries: 3, breakerThreshold: 2 });

    await healOnce(engine);
    await healOnce(engine);

    assert.equal(engine.budgetStats().breakerOpen, false);
  });
});
