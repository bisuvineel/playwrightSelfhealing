/**
 * Unit tests for the spend ceiling and the circuit breaker.
 *
 * Two failures these guard against. **Runaway cost:** a suite with 400 rotted selectors
 * used to make 400 provider calls with no ceiling — the money is modest, the wall clock is
 * not. **An outage:** with the provider unreachable, every failing action still waited
 * `HEALER_TIMEOUT` × `HEALER_MAX_RETRIES` before giving up, so a five-minute suite became
 * an hour and every test failed anyway.
 *
 * The distinction worth testing hardest is what counts as a provider failure. A model
 * answering with low confidence is not one — the provider is working fine — and a breaker
 * that tripped on an unsure model would disable healing for the wrong reason.
 *
 *   npm run test:unit
 */

'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { HealBudget } = require('../../dist/core/HealBudget');

/** Silences the warnings these tests deliberately trigger. */
function quiet(fn) {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return fn();
  } finally {
    Object.assign(console, saved);
  }
}

describe('HealBudget — the spend ceiling', () => {
  it('allows heals up to the ceiling and refuses the next', () => {
    const budget = new HealBudget({ maxHeals: 3, breakerThreshold: 0 });

    for (let i = 0; i < 3; i++) {
      assert.equal(budget.check(), null, `heal ${i + 1} should be allowed`);
      quiet(() => budget.spend());
    }

    const refusal = budget.check();
    assert.equal(refusal?.kind, 'budget');
    assert.match(refusal.reason, /ceiling of 3/);
    assert.match(refusal.reason, /HEALER_MAX_HEALS/);
  });

  it('says cached selectors still apply, because they do', () => {
    // The ceiling is checked after the cache, so an exhausted budget degrades into "keep
    // using what this worker already learned" rather than "stop healing".
    const budget = new HealBudget({ maxHeals: 1, breakerThreshold: 0 });
    quiet(() => budget.spend());

    assert.match(budget.check().reason, /cached selectors still apply/);
  });

  it('treats 0 as no ceiling', () => {
    const budget = new HealBudget({ maxHeals: 0, breakerThreshold: 0 });
    for (let i = 0; i < 500; i++) budget.spend();
    assert.equal(budget.check(), null);
  });

  it('counts refusals so the summary can report them', () => {
    const budget = new HealBudget({ maxHeals: 1, breakerThreshold: 0 });
    quiet(() => budget.spend());
    budget.check();
    budget.check();

    assert.equal(budget.stats().refusedByBudget, 2);
    assert.equal(budget.stats().spent, 1);
  });

  it('counts a spend on the way out, not on success', () => {
    // An attempt that failed still cost wall-clock time and possibly tokens.
    const budget = new HealBudget({ maxHeals: 2, breakerThreshold: 0 });
    budget.spend();
    budget.recordProviderFailure();

    assert.equal(budget.stats().spent, 1);
  });
});

describe('HealBudget — the circuit breaker', () => {
  it('opens after the configured number of consecutive failures', () => {
    const budget = new HealBudget({ maxHeals: 0, breakerThreshold: 3 });

    budget.recordProviderFailure();
    budget.recordProviderFailure();
    assert.equal(budget.isBreakerOpen, false, 'two failures should not be enough');

    quiet(() => budget.recordProviderFailure());
    assert.equal(budget.isBreakerOpen, true);

    const refusal = budget.check();
    assert.equal(refusal?.kind, 'breaker');
    assert.match(refusal.reason, /failed 3 times in a row/);
  });

  it('resets the count on a call that worked', () => {
    // "Consecutive" has to mean consecutive, or a long suite with occasional blips would
    // eventually trip the breaker for no reason.
    const budget = new HealBudget({ maxHeals: 0, breakerThreshold: 3 });

    budget.recordProviderFailure();
    budget.recordProviderFailure();
    budget.recordProviderSuccess();
    budget.recordProviderFailure();
    budget.recordProviderFailure();

    assert.equal(budget.isBreakerOpen, false);
  });

  it('stays open once tripped, rather than half-opening', () => {
    // A test run lasts minutes. Probing a dead provider again mid-run buys a slow retry
    // and no information; the breaker resets when the worker does.
    const budget = new HealBudget({ maxHeals: 0, breakerThreshold: 1 });
    quiet(() => budget.recordProviderFailure());
    budget.recordProviderSuccess();

    assert.equal(budget.isBreakerOpen, true);
    assert.equal(budget.check()?.kind, 'breaker');
  });

  it('treats 0 as no breaker', () => {
    const budget = new HealBudget({ maxHeals: 0, breakerThreshold: 0 });
    for (let i = 0; i < 100; i++) budget.recordProviderFailure();

    assert.equal(budget.isBreakerOpen, false);
    assert.equal(budget.check(), null);
  });

  it('reports the breaker before the budget', () => {
    // When the provider is down, saying so is more useful than reporting a ceiling that
    // was never the problem.
    const budget = new HealBudget({ maxHeals: 1, breakerThreshold: 1 });
    quiet(() => budget.spend());
    quiet(() => budget.recordProviderFailure());

    assert.equal(budget.check()?.kind, 'breaker');
  });

  it('counts breaker refusals separately from budget ones', () => {
    const budget = new HealBudget({ maxHeals: 0, breakerThreshold: 1 });
    quiet(() => budget.recordProviderFailure());
    budget.check();

    assert.equal(budget.stats().refusedByBreaker, 1);
    assert.equal(budget.stats().refusedByBudget, 0);
    assert.equal(budget.stats().breakerOpen, true);
  });
});

describe('HealBudget — defaults and description', () => {
  it('is inert when built with no policy', () => {
    // An engine assembled without a budget must behave as it did before this existed.
    const budget = new HealBudget();
    for (let i = 0; i < 50; i++) {
      budget.spend();
      budget.recordProviderFailure();
    }

    assert.equal(budget.check(), null);
    assert.equal(budget.isBreakerOpen, false);
    assert.match(budget.describe(), /no ceiling/);
    assert.match(budget.describe(), /no breaker/);
  });

  it('describes an active policy', () => {
    const described = new HealBudget({ maxHeals: 100, breakerThreshold: 5 }).describe();
    assert.match(described, /ceiling 100 provider-backed heal\(s\) per worker/);
    assert.match(described, /breaker after 5 consecutive failure\(s\)/);
  });

  it('resets', () => {
    const budget = new HealBudget({ maxHeals: 1, breakerThreshold: 1 });
    quiet(() => budget.spend());
    quiet(() => budget.recordProviderFailure());
    budget.reset();

    assert.deepEqual(budget.stats(), {
      spent: 0,
      refusedByBudget: 0,
      refusedByBreaker: 0,
      breakerOpen: false,
    });
    assert.equal(budget.check(), null);
  });
});
