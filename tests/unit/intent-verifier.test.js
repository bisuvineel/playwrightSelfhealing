/**
 * Unit tests for the intent verifier.
 *
 * Runs against `dist/` with Node's built-in runner — no browser, no API key. The live
 * element is faked with a stub exposing `ariaSnapshot()`, which is the only Playwright
 * surface `IntentVerifier` touches. That is deliberate: the module was designed to
 * depend on one narrow, well-defined call so its decision logic could be tested
 * exhaustively without a page.
 *
 *   npm run test:unit
 *
 * The case that matters most is `false-green regression` at the bottom: it reproduces
 * the exact scenario from AUDIT.md finding 2, where a heal of the order button to
 * Cancel passes every validation gate.
 */

'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { IntentVerifier } = require('../../dist/core/IntentVerifier');

/**
 * A stand-in for a Playwright locator, exposing only what the verifier reads.
 *
 * @param {string|null} snapshot - What `ariaSnapshot()` resolves to, or null to throw.
 * @returns {object} A locator-shaped stub.
 */
function locatorStub(snapshot) {
  const self = {
    first: () => self,
    ariaSnapshot: async () => {
      if (snapshot === null) throw new Error('element detached');
      return snapshot;
    },
  };
  return self;
}

/** An enforcing verifier with the shipped defaults. */
const enforcing = new IntentVerifier({ mode: 'enforce', unverifiedConfidence: 0.9 });

/**
 * Baseline intent context: healing the demo's order button.
 *
 * @param {object} [overrides] - Fields to replace.
 * @returns {object} An IntentContext.
 */
function context(overrides = {}) {
  return {
    originalSelector: '#place-order-btn',
    suggestedSelector: "getByRole('button', { name: 'Place order' })",
    action: 'click',
    description: 'the button that submits the order',
    confidence: 0.95,
    ...overrides,
  };
}

describe('IntentVerifier — action compatibility', () => {
  it('rejects a fill onto a button', async () => {
    // Playwright itself would throw here. Catching it as a rejection turns a confusing
    // mid-retry failure into feedback the model can act on.
    const verdict = await enforcing.verify(
      locatorStub('- button "Place order"'),
      context({ action: 'fill', originalSelector: '#email-input' })
    );

    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /fill\(\) cannot act on a button/);
  });

  it('accepts a fill onto a textbox', async () => {
    const verdict = await enforcing.verify(
      locatorStub('- textbox "Email address"'),
      context({
        action: 'fill',
        originalSelector: '#email-input',
        suggestedSelector: "getByLabel('Email address')",
        description: 'the field where the customer types their email address',
      })
    );

    assert.equal(verdict.ok, true, verdict.reason);
    assert.ok(verdict.summary.checks.includes('action'));
  });

  it('rejects a check onto a button', async () => {
    const verdict = await enforcing.verify(
      locatorStub('- button "Place order"'),
      context({ action: 'check', originalSelector: '#accept-terms' })
    );

    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /check\(\) cannot act on a button/);
  });

  it('accepts a check onto a checkbox', async () => {
    const verdict = await enforcing.verify(
      locatorStub('- checkbox "I accept the terms and conditions"'),
      context({
        action: 'check',
        originalSelector: '#accept-terms',
        suggestedSelector: "getByRole('checkbox')",
        description: 'the checkbox for accepting the terms and conditions',
      })
    );

    assert.equal(verdict.ok, true, verdict.reason);
  });

  it('does not constrain click, which works on almost anything', async () => {
    // Inventing a constraint for click would reject correct heals, so there is none.
    const verdict = await enforcing.verify(
      locatorStub('- link "Continue shopping"'),
      context({ originalSelector: '#continue-shopping-link' })
    );

    assert.equal(verdict.ok, true, verdict.reason);
  });
});

describe('IntentVerifier — self-consistency', () => {
  it('rejects a suggestion that resolves to a different role than claimed', async () => {
    // The model said button, the DOM says textbox. The selector is wrong regardless of
    // whether the reasoning was sound — and this cannot false-positive, because it
    // compares the model against itself.
    const verdict = await enforcing.verify(
      locatorStub('- textbox "Email address"'),
      context({ expectedRole: 'button', expectedName: 'Place order' })
    );

    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /described as a button but resolves to a textbox/);
  });

  it('rejects a suggestion that resolves to a different name than claimed', async () => {
    const verdict = await enforcing.verify(
      locatorStub('- button "Cancel"'),
      context({ expectedRole: 'button', expectedName: 'Place order' })
    );

    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /described as "Place order" but resolves to "Cancel"/);
  });

  it('tolerates paraphrasing in the claimed name', async () => {
    // Models vary casing and whitespace; rejecting on that would be noise, not safety.
    const verdict = await enforcing.verify(
      locatorStub('- button "Place order"'),
      context({ expectedRole: 'button', expectedName: 'place  ORDER' })
    );

    assert.equal(verdict.ok, true, verdict.reason);
  });

  it('still works when the model omits its claim', async () => {
    // Backward compatibility: an older model, or a custom provider whose prompt never
    // asked, must still heal — it just loses this one check.
    const verdict = await enforcing.verify(locatorStub('- button "Place order"'), context());

    assert.equal(verdict.ok, true, verdict.reason);
    assert.ok(!verdict.summary.checks.includes('self-consistency'));
  });
});

describe('IntentVerifier — role preservation', () => {
  it('rejects a role change when the original named a role', async () => {
    const verdict = await enforcing.verify(
      locatorStub('- link "Place order"'),
      context({ originalSelector: "getByRole('button', { name: 'Place order' })" })
    );

    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /targets a button but the suggestion resolves to a link/);
  });

  it('reads an implied role from a tag-qualified CSS selector', async () => {
    const verdict = await enforcing.verify(
      locatorStub('- textbox "Search"'),
      context({ originalSelector: 'button#place-order' })
    );

    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /targets a button/);
  });

  it('treats getByPlaceholder as implying an editable field', async () => {
    const verdict = await enforcing.verify(
      locatorStub('- button "Search"'),
      context({ originalSelector: "getByPlaceholder('Search products')" })
    );

    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /targets a textbox/);
  });

  it('does not invent a role for getByTestId or getByText', async () => {
    // These match across roles, so committing them to one would reject correct heals.
    for (const original of ["getByTestId('checkout')", "getByText('Checkout')"]) {
      const verdict = await enforcing.verify(
        locatorStub('- button "Checkout"'),
        context({ originalSelector: original, suggestedSelector: "getByRole('button')" })
      );
      assert.equal(verdict.ok, true, `${original}: ${verdict.reason}`);
      assert.ok(!verdict.summary.checks.includes('role'));
    }
  });
});

describe('IntentVerifier — lexical intent', () => {
  it('accepts every heal the demo suite actually performs', async () => {
    // These five are the shipped demo's real rewrites. If the lexical rule rejects any
    // of them it is too aggressive, and a check that blocks correct heals gets switched
    // off — which protects nothing.
    const demo = [
      ['#checkout-button', "getByTestId('checkout')", '- button "Checkout"', 'click'],
      ['#email-input', "getByLabel('Email address')", '- textbox "Email address"', 'fill'],
      ['#promo-field', "getByLabel('Promotion code')", '- textbox "Promotion code"', 'fill'],
      [
        '#accept-terms',
        "getByRole('checkbox')",
        '- checkbox "I accept the terms and conditions"',
        'check',
      ],
      [
        '#place-order-btn',
        "getByRole('button', { name: 'Place order' })",
        '- button "Place order"',
        'click',
      ],
    ];

    for (const [original, suggested, snapshot, action] of demo) {
      const verdict = await enforcing.verify(
        locatorStub(snapshot),
        // No description, so the selector text is the only lexical evidence — the
        // harder case, and the one that must not regress.
        {
          originalSelector: original,
          suggestedSelector: suggested,
          action,
          confidence: 0.95,
        }
      );

      assert.equal(verdict.ok, true, `${original} -> ${suggested}: ${verdict.reason}`);
    }
  });

  it('matches promo against Promotion, which exact matching got wrong', async () => {
    // The bug this rule was rewritten for: `promo` !== `promotion`, so exact token
    // matching rejected a correct heal. Prefix matching with a 4-character floor fixes
    // it without letting `can` match `cancel`.
    const verdict = await enforcing.verify(
      locatorStub('- textbox "Promotion code"'),
      {
        originalSelector: '#promo-field',
        suggestedSelector: "getByLabel('Promotion code')",
        action: 'fill',
        confidence: 0.8,
      }
    );

    assert.equal(verdict.ok, true, verdict.reason);
  });

  it('does not let a short token match a longer unrelated one', async () => {
    // `can` must not match `cancel`.
    const verdict = await enforcing.verify(locatorStub('- button "Cancel"'), {
      originalSelector: '#can-do-thing',
      suggestedSelector: "getByRole('button', { name: 'Cancel' })",
      action: 'click',
      confidence: 0.8,
    });

    assert.equal(verdict.ok, false);
  });

  it('confirms on a single shared word, but will not reject on one', async () => {
    // Asymmetric by design. `#checkout-button` yields one token, `checkout`, which
    // matches the element exactly — that is corroboration, not a coincidence, and an
    // earlier symmetric threshold suppressed it and demanded 0.9 confidence instead.
    const confirmed = await enforcing.verify(locatorStub('- button "Checkout"'), {
      originalSelector: '#checkout-button',
      suggestedSelector: "getByTestId('checkout')",
      action: 'click',
      confidence: 0.75,
    });

    assert.equal(confirmed.ok, true, confirmed.reason);
    assert.ok(confirmed.summary.checks.includes('lexical'));

    // The same single token, not matching, must NOT reject — one word is too thin to
    // refuse on, so this falls through to the confidence floor.
    const notRejected = await enforcing.verify(locatorStub('- button "Cancel"'), {
      originalSelector: '#checkout-button',
      suggestedSelector: "getByRole('button', { name: 'Cancel' })",
      action: 'click',
      confidence: 0.95,
    });

    assert.equal(notRejected.ok, true, notRejected.reason);
    assert.deepEqual(notRejected.summary.checks, ['confidence-floor']);
  });

  it('does not reject when the selector carries too little evidence', async () => {
    // `#btn-1` yields no content tokens at all, so a lexical rejection would be a
    // guess. This routes to the confidence floor instead.
    const verdict = await enforcing.verify(locatorStub('- button "Cancel"'), {
      originalSelector: '#btn-1',
      suggestedSelector: "getByRole('button', { name: 'Cancel' })",
      action: 'click',
      confidence: 0.95,
    });

    assert.equal(verdict.ok, true, verdict.reason);
    assert.ok(!verdict.summary.checks.includes('lexical'));
  });
});

describe('IntentVerifier — confidence floor', () => {
  it('demands high confidence when nothing can be verified', async () => {
    const verdict = await enforcing.verify(locatorStub('- button "Cancel"'), {
      originalSelector: '#btn-1',
      suggestedSelector: "getByRole('button', { name: 'Cancel' })",
      action: 'click',
      confidence: 0.75,
    });

    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /nothing about this heal could be verified/);
    assert.deepEqual(verdict.summary.checks, ['confidence-floor']);
  });

  it('accepts an unverifiable heal the model is certain about', async () => {
    const verdict = await enforcing.verify(locatorStub('- button "Cancel"'), {
      originalSelector: '#btn-1',
      suggestedSelector: "getByRole('button', { name: 'Cancel' })",
      action: 'click',
      confidence: 0.95,
    });

    assert.equal(verdict.ok, true, verdict.reason);
  });

  it('is configurable', async () => {
    const lenient = new IntentVerifier({ mode: 'enforce', unverifiedConfidence: 0.5 });
    const verdict = await lenient.verify(locatorStub('- button "Cancel"'), {
      originalSelector: '#btn-1',
      suggestedSelector: "getByRole('button')",
      action: 'click',
      confidence: 0.6,
    });

    assert.equal(verdict.ok, true, verdict.reason);
  });
});

describe('IntentVerifier — evidence must come from the element', () => {
  it('does not let a suggestion certify itself', async () => {
    // The weakness a failing test exposed. When the accessible name and the selector
    // text were pooled, a deceptively-named selector passed the lexical check even
    // though the element it resolved to was plainly wrong.
    const verdict = await enforcing.verify(locatorStub('- button "Cancel"'), {
      originalSelector: '#place-order-btn',
      suggestedSelector: "getByTestId('place-order-legacy')",
      action: 'click',
      description: 'the button that submits the order',
      confidence: 0.95,
    });

    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /shares no wording/);
  });

  it('falls back to the selector text only when the element has no name', async () => {
    // An icon button with no accessible name: the test id is the only wording there is,
    // so using it is better than skipping the check entirely.
    const verdict = await enforcing.verify(locatorStub('- button'), {
      originalSelector: '#close-dialog',
      suggestedSelector: "getByTestId('close-dialog')",
      action: 'click',
      confidence: 0.8,
    });

    assert.equal(verdict.ok, true, verdict.reason);
    assert.ok(verdict.summary.checks.includes('lexical'));
  });

  it('records that an unreadable element could not be described', async () => {
    const verdict = await enforcing.verify(locatorStub(null), context({ confidence: 0.75 }));

    assert.equal(verdict.summary.role, undefined);
    assert.equal(verdict.summary.name, undefined);
  });

  it('falls through to the confidence floor when nothing is readable or lexical', async () => {
    const verdict = await enforcing.verify(locatorStub(null), {
      originalSelector: '#btn-1',
      suggestedSelector: "getByRole('button')",
      action: 'click',
      confidence: 0.75,
    });

    assert.equal(verdict.ok, false);
    assert.deepEqual(verdict.summary.checks, ['confidence-floor']);
  });
});

describe('IntentVerifier — modes', () => {
  it('off accepts anything and runs no checks', async () => {
    const off = new IntentVerifier({ mode: 'off', unverifiedConfidence: 0.9 });
    const verdict = await off.verify(
      locatorStub('- button "Cancel"'),
      context({ action: 'fill' })
    );

    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.summary.checks, []);
  });

  it('warn accepts but records what would have been rejected', async () => {
    const warn = new IntentVerifier({ mode: 'warn', unverifiedConfidence: 0.9 });
    const verdict = await warn.verify(
      locatorStub('- button "Place order"'),
      context({ action: 'fill', originalSelector: '#email-input' })
    );

    assert.equal(verdict.ok, true);
    assert.match(verdict.reason, /fill\(\) cannot act on a button/);
    assert.equal(verdict.summary.verified, false);
    assert.match(verdict.summary.reason, /cannot act on a button/);
  });
});

describe('IntentVerifier — false-green regression (AUDIT.md finding 2)', () => {
  it('rejects healing the order button to Cancel', async () => {
    // The exact scenario from the audit, and it is reachable in the shipped demo:
    // `button "Cancel"` on the checkout page is unique, visible and clickable, so
    // every SelectorValidator gate passes. Demo test 3 asserts the confirmation is
    // HIDDEN after placing an order without accepting terms — which is also true after
    // clicking Cancel. The suite would have gone green having tested nothing.
    const verdict = await enforcing.verify(locatorStub('- button "Cancel"'), {
      originalSelector: '#place-order-btn',
      suggestedSelector: "getByRole('button', { name: 'Cancel' })",
      action: 'click',
      description: 'the button that submits the order',
      // Note the high confidence: the audit's title is "a *confidently* wrong heal".
      // The confidence threshold cannot catch this, which is why the check exists.
      confidence: 0.95,
    });

    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /shares no wording with the intended element/);
  });

  it('still accepts healing it to the real order button', async () => {
    const verdict = await enforcing.verify(
      locatorStub('- button "Place order"'),
      context({ suggestedSelector: "getByTestId('place-order')" })
    );

    assert.equal(verdict.ok, true, verdict.reason);
    assert.equal(verdict.summary.role, 'button');
    assert.equal(verdict.summary.name, 'Place order');
  });
});
