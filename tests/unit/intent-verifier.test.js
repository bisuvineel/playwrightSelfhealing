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
 * @param {Record<string, string>} [attributes] - The element's attributes, read through
 * `evaluate()`. Omitted, the stub has no `evaluate` at all, as a locator that cannot run
 * script would not — which must cost the check nothing but the attributes.
 * @returns {object} A locator-shaped stub.
 */
function locatorStub(snapshot, attributes) {
  const self = {
    first: () => self,
    ariaSnapshot: async () => {
      if (snapshot === null) throw new Error('element detached');
      return snapshot;
    },
    ...(attributes !== undefined
      ? { evaluate: async (fn, names) => names.map((name) => attributes[name] ?? null) }
      : {}),
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
    const notRejected = await enforcing.verify(locatorStub('- button "Continue"'), {
      originalSelector: '#checkout-button',
      suggestedSelector: "getByRole('button', { name: 'Continue' })",
      action: 'click',
      confidence: 0.95,
    });

    assert.equal(notRejected.ok, true, notRejected.reason);
    assert.deepEqual(notRejected.summary.checks, ['confidence-floor']);
  });

  it('rejects an opposing action however thin the intent — checkout onto Cancel', async () => {
    // This used to be the example above, and it passed: one word was too thin to refuse
    // on, and 0.95 cleared the floor. A test that checks out never means Cancel.
    const verdict = await enforcing.verify(locatorStub('- button "Cancel"'), {
      originalSelector: '#checkout-button',
      suggestedSelector: "getByRole('button', { name: 'Cancel' })",
      action: 'click',
      confidence: 0.95,
    });

    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /opposing action \(cancel\)/);
  });

  it('rejects an opposing action that shares an object noun — Delete record for save the record', async () => {
    // "record" is shared, which was enough to pass before this rule.
    const named = await enforcing.verify(locatorStub('- button "Delete record"'), {
      originalSelector: '#save-btn',
      suggestedSelector: "getByRole('button', { name: 'Delete record' })",
      action: 'click',
      description: 'save the record',
      confidence: 0.95,
    });
    assert.equal(named.ok, false);
    assert.match(named.reason, /opposing action \(delete\)/);

    // The nameless form: a trash icon known only by its test id.
    const icon = await enforcing.verify(locatorStub('- button', { 'data-testid': 'delete-record' }), {
      originalSelector: '#save-btn',
      suggestedSelector: '[data-testid="delete-record"]',
      action: 'click',
      description: 'save the record',
      confidence: 0.95,
    });
    assert.equal(icon.ok, false);
    assert.match(icon.reason, /opposing action \(delete\)/);
  });

  it('allows an opposing action the test itself names', async () => {
    const verdict = await enforcing.verify(locatorStub('- button', { 'data-testid': 'delete-record' }), {
      originalSelector: '#trash-icon',
      suggestedSelector: '[data-testid="delete-record"]',
      action: 'click',
      description: 'delete the record',
      confidence: 0.9,
    });
    assert.equal(verdict.ok, true, verdict.reason);
  });

  it('verifies a nameless icon by its test id — the close button', async () => {
    const verdict = await enforcing.verify(locatorStub('- button', { 'data-testid': 'close' }), {
      originalSelector: '#close-x',
      suggestedSelector: '[data-testid="close"]',
      action: 'click',
      description: 'the close button in the corner',
      confidence: 0.85,
    });
    assert.equal(verdict.ok, true, verdict.reason);
    assert.ok(verdict.summary.checks.includes('lexical'));
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
    assert.match(verdict.reason, /shares no wording|opposing action/);
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

  it("counts the element's own test id when its name is a synonym the check cannot see", async () => {
    // Measured on the corpus: "Place order" became "Complete purchase" and the correct
    // heal was rejected, although the element said data-testid="submit" and the test
    // described "the button that submits the order".
    const verdict = await enforcing.verify(
      locatorStub('- button "Complete purchase"', { 'data-testid': 'submit' }),
      context({ suggestedSelector: "getByRole('button', { name: 'Complete purchase' })" })
    );

    assert.equal(verdict.ok, true, verdict.reason);
    assert.ok(verdict.summary.checks.includes('lexical'));
  });

  it('does not count an id that only restates the name — Cancel with id="order-cancel"', async () => {
    // The threat the lexical check exists for. `order` must not rescue a button named Cancel.
    const verdict = await enforcing.verify(
      locatorStub('- button "Cancel"', { id: 'order-cancel' }),
      context({ suggestedSelector: "getByRole('button', { name: 'Cancel' })" })
    );

    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /shares no wording|opposing action/);
  });

  it('admits no identifier at all for an opposing action the intent does not mention', async () => {
    // An id independent of the name, and about the order — still not enough to heal
    // "place the order" onto Delete.
    const verdict = await enforcing.verify(
      locatorStub('- button "Delete"', { 'data-testid': 'order-actions' }),
      context({ suggestedSelector: "getByRole('button', { name: 'Delete' })" })
    );

    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /shares no wording|opposing action/);
  });

  it('does not rescue even a plausible synonym among opposing actions — Cancel → Discard', async () => {
    // Deliberately conservative: the attributes would say "cancel", and the heal may well
    // be right, but among destructive names a red test with a reason beats a guess.
    const verdict = await enforcing.verify(
      locatorStub('- button "Discard"', { 'data-testid': 'cancel-edit' }),
      {
        originalSelector: '#cancel-edit-btn',
        suggestedSelector: "getByRole('button', { name: 'Discard' })",
        action: 'click',
        description: 'cancel the edit',
        confidence: 0.9,
      }
    );

    assert.equal(verdict.ok, false);
  });

  it('does not count XPath syntax as intent — the tab rename that was rejected', async () => {
    // Measured on the corpus: `//div[@role='tab'][text()='Customers']` yielded the intent
    // "customer, role, tab, text", enough words to reject the correct "Clients".
    const verdict = await enforcing.verify(locatorStub('- tab "Clients"'), {
      originalSelector: "//div[@role='tab'][text()='Customers']",
      suggestedSelector: "getByRole('tab', { name: 'Clients' })",
      action: 'click',
      description: 'the customers tab',
      confidence: 0.85,
    });

    assert.equal(verdict.ok, true, verdict.reason);
    assert.ok(verdict.summary.checks.includes('role'), 'the explicit @role is the evidence');
  });

  it("reads an explicit role from the element's own step only", async () => {
    const onElement = await enforcing.verify(locatorStub('- button "Clients"'), {
      originalSelector: "//div[@role='tab'][text()='Customers']",
      suggestedSelector: "getByRole('button', { name: 'Clients' })",
      action: 'click',
      confidence: 0.95,
    });
    assert.equal(onElement.ok, false);
    assert.match(onElement.reason, /targets a tab but the suggestion resolves to a button/);

    // `tablist` belongs to the container, not the element, so it implies nothing.
    const onContainer = await enforcing.verify(locatorStub('- tab "Clients"'), {
      originalSelector: "//div[@role='tablist']//div[text()='Customers']",
      suggestedSelector: "getByRole('tab', { name: 'Clients' })",
      action: 'click',
      confidence: 0.95,
    });
    assert.equal(onContainer.ok, true, onContainer.reason);
    assert.ok(!onContainer.summary.checks.includes('role'));
  });

  it('reads the tag of the last XPath or CSS step, not the first', async () => {
    const verdict = await enforcing.verify(locatorStub('- link "Export"'), {
      originalSelector: "//main//button[text()='Export PDF']",
      suggestedSelector: "getByRole('link', { name: 'Export' })",
      action: 'click',
      confidence: 0.95,
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /targets a button/);

    // `nav a`: the element is the link, not the nav.
    const css = await enforcing.verify(locatorStub('- link "Reports"'), {
      originalSelector: 'nav a.reports-link',
      suggestedSelector: "getByRole('link', { name: 'Reports' })",
      action: 'click',
      confidence: 0.95,
    });
    assert.equal(css.ok, true, css.reason);
    assert.ok(css.summary.checks.includes('role'));
  });

  it('keeps role and name when the attributes cannot be read', async () => {
    const verdict = await enforcing.verify(locatorStub('- button "Place order"'), context());

    assert.equal(verdict.ok, true, verdict.reason);
    assert.equal(verdict.summary.name, 'Place order');
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
    assert.match(verdict.reason, /shares no wording with the intended element|opposing action/);
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

describe('self-consistency — an observation that is not really a role', () => {
  it('does not reject a text node against a container role the model named', async () => {
    // From a healing record. Clicking `//li/span[text()='Charter Cloud']` on a menu
    // built as `<li><a><span>Charter Cloud</span></a></li>`, the model answered
    // getByText('Charter Cloud', { exact: true }) — which resolved to one visible
    // element, the right one — and reported expectedRole "listitem", describing the
    // element by the container it sits in, as a person would. The observed role of a
    // bare text node is `text`, so the claim could never match and a correct heal was
    // thrown away.
    const verdict = await enforcing.verify(locatorStub('- text: Charter Cloud'), {
        originalSelector: "//li/span[text()='Charter Cloud']",
        suggestedSelector: "getByText('Charter Cloud', { exact: true })",
        action: 'click',
        description: 'Click on Segment Charter Cloud',
        confidence: 0.9,
        expectedRole: 'listitem',
      });

    assert.equal(verdict.ok, true, verdict.reason);
    assert.ok(
      !verdict.summary.checks.includes('self-consistency'),
      'a non-role observation carries no evidence, so it must not be recorded as a check'
    );
  });

  it('treats generic, none and presentation the same way', async () => {
    for (const role of ['generic', 'none', 'presentation']) {
      const verdict = await enforcing.verify(locatorStub(`- ${role} "Charter Cloud"`), {
          originalSelector: "//li/span[text()='Charter Cloud']",
          suggestedSelector: "getByText('Charter Cloud', { exact: true })",
          action: 'click',
          confidence: 0.9,
          expectedRole: 'listitem',
        });
      assert.equal(verdict.ok, true, `${role}: ${verdict.reason}`);
    }
  });

  it('still catches a real role that contradicts the claim', async () => {
    // The case this check exists for is untouched: a heal that lands on a textbox after
    // describing a button observes a real role, and is still refused.
    const verdict = await enforcing.verify(locatorStub('- textbox "Email"'), {
        originalSelector: '#place-order-btn',
        suggestedSelector: "getByRole('textbox', { name: 'Email' })",
        action: 'click',
        confidence: 0.95,
        expectedRole: 'button',
        expectedName: 'Place order',
      });

    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /described as a button but resolves to a textbox/);
  });
});
