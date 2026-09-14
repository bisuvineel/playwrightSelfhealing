/**
 * Unit tests for the fail-on-heal gate.
 *
 * The gate's decision logic is trivial — did anything heal, is the flag set — so what
 * is worth testing is the **message**, because the message is the whole feature. A CI
 * failure that says "healing happened" is useless; one that says which file, which line,
 * which selector to remove and what to put in its place is a patch waiting to be
 * applied.
 *
 *   npm run test:unit
 */

'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { describeHealGate, assertNoHeals } = require('../../dist/core/TestWrapper');

/**
 * A healed outcome, shaped as `HealingEngine` produces it.
 *
 * @param {object} [overrides] - Fields to replace.
 * @returns {object} A HealOutcome.
 */
function outcome(overrides = {}) {
  return {
    originalSelector: '#place-order-btn',
    action: 'click',
    pageUrl: 'http://localhost/checkout',
    file: 'pages/CheckoutPage.ts',
    line: 34,
    healed: "getByRole('button', { name: 'Place order' })",
    tokens: { input: 700, output: 90 },
    attempts: [
      {
        timestamp: '2026-08-23T12:00:00.000Z',
        file: 'pages/CheckoutPage.ts',
        line: 34,
        originalSelector: '#place-order-btn',
        suggestedSelector: "getByRole('button', { name: 'Place order' })",
        confidence: 0.95,
        provider: 'anthropic:claude-haiku-4-5',
        tokens: { input: 700, output: 90 },
        success: true,
        intent: {
          mode: 'enforce',
          verified: true,
          checks: ['lexical'],
          role: 'button',
          name: 'Place order',
        },
      },
    ],
    ...overrides,
  };
}

describe('fail-on-heal gate — the message is the feature', () => {
  it('names the file and line to edit', () => {
    const message = describeHealGate([outcome()]);
    assert.match(message, /pages\/CheckoutPage\.ts:34/);
  });

  it('shows the edit as a removal and an addition', () => {
    const message = describeHealGate([outcome()]);
    assert.match(message, /- #place-order-btn/);
    assert.match(message, /\+ getByRole\('button', \{ name: 'Place order' \}\)/);
  });

  it('carries enough context to judge whether the replacement is right', () => {
    // Without this, a developer has to open the records file to decide whether to
    // accept the rewrite — which defeats the point of putting it in the failure.
    const message = describeHealGate([outcome()]);
    assert.match(message, /confidence 0\.95/);
    assert.match(message, /button "Place order"/);
    assert.match(message, /verified by lexical/);
  });

  it('names the action, since the same selector can heal on several', () => {
    const message = describeHealGate([outcome({ action: 'fill' })]);
    assert.match(message, /\(fill\)/);
  });

  it('states why the run failed and how to turn it off', () => {
    const message = describeHealGate([outcome()]);
    assert.match(message, /HEALER_FAIL_ON_HEAL is set/);
    assert.match(message, /Unset\s+HEALER_FAIL_ON_HEAL/);
  });

  it('says a wrong-looking replacement is the point, not a nuisance', () => {
    // The mode exists to surface regressions. If the message reads as pure noise,
    // people switch it off and the regression ships anyway.
    const message = describeHealGate([outcome()]);
    assert.match(message, /regression this mode exists to\s+surface/);
  });
});

describe('fail-on-heal gate — completeness', () => {
  it('reports every stale selector, not just the first', () => {
    // The reason the gate runs in teardown rather than at the heal site: one run should
    // give you the whole list of edits.
    const message = describeHealGate([
      outcome({ originalSelector: '#checkout-button', healed: "getByTestId('checkout')" }),
      outcome({ originalSelector: '#email-input', healed: "getByLabel('Email address')" }),
      outcome({ originalSelector: '#promo-field', healed: "getByLabel('Promotion code')" }),
    ]);

    assert.match(message, /3 selector\(s\) needed healing/);
    for (const selector of ['#checkout-button', '#email-input', '#promo-field']) {
      assert.ok(message.includes(selector), `${selector} missing from the message`);
    }
  });

  it('reports a repeated rewrite once', () => {
    // A page object's field filled and then cleared heals twice with the same rewrite.
    const message = describeHealGate([
      outcome({ originalSelector: '#email-input', healed: "getByLabel('Email')", action: 'fill' }),
      outcome({ originalSelector: '#email-input', healed: "getByLabel('Email')", action: 'clear' }),
    ]);

    assert.match(message, /1 selector\(s\) needed healing/);
    assert.equal(message.split('#email-input').length - 1, 1);
  });

  it('keeps distinct rewrites of the same selector', () => {
    // Two different answers for one selector is worth seeing, not collapsing.
    const message = describeHealGate([
      outcome({ originalSelector: '#btn', healed: "getByTestId('a')" }),
      outcome({ originalSelector: '#btn', healed: "getByTestId('b')" }),
    ]);

    assert.match(message, /2 selector\(s\) needed healing/);
    assert.ok(message.includes("getByTestId('a')"));
    assert.ok(message.includes("getByTestId('b')"));
  });
});

describe('fail-on-heal gate — degrades honestly', () => {
  it('does not pretend to describe an element it could not read', () => {
    const bare = outcome();
    delete bare.attempts[0].intent;

    const message = describeHealGate([bare]);
    assert.match(message, /element not described/);
    assert.ok(!message.includes('verified by'));
  });

  it('survives an outcome with no attempts recorded', () => {
    const message = describeHealGate([outcome({ attempts: [] })]);
    assert.match(message, /confidence \?/);
    assert.match(message, /#place-order-btn/);
  });
});

describe('fail-on-heal gate — arming', () => {
  it('is a no-op when the flag is off, so it is safe to call unconditionally', () => {
    // The shipped fixtures call this on every test. If it threw whenever anything
    // healed, the feature would be permanently on.
    assert.doesNotThrow(() => assertNoHeals(false));
  });

  it('does not throw when nothing healed, even when armed', () => {
    assert.doesNotThrow(() => assertNoHeals(true));
  });
});

describe('fail-on-heal gate — points at the file to edit', () => {
  it('prefers the page object over the spec that drove it', () => {
    // The selector is written in the page object. Leading with the spec would send a
    // developer to a file that does not contain the string they need to change.
    const message = describeHealGate([
      outcome({
        file: 'tests/checkout.spec.ts',
        line: 22,
        source: { file: 'pages/CartPage.ts', line: 37 },
      }),
    ]);

    assert.match(message, /pages\/CartPage\.ts:37/);
    assert.match(message, /exercised by tests\/checkout\.spec\.ts:22/);
    // The edit location must come first on the line, not the spec.
    assert.ok(
      message.indexOf('pages/CartPage.ts:37') < message.indexOf('tests/checkout.spec.ts:22')
    );
  });

  it('shows one location when the selector lives in the spec', () => {
    const message = describeHealGate([
      outcome({ file: 'tests/checkout.spec.ts', line: 22, source: undefined }),
    ]);

    assert.match(message, /tests\/checkout\.spec\.ts:22/);
    assert.ok(!message.includes('exercised by'));
  });
});
