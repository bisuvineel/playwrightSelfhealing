/**
 * Unit tests for the selector validator's core rules.
 *
 * Two jobs, both untested until now. **Translation**: the prompts ask for
 * `getByRole('button', { name: 'OK' })`, which `page.locator()` cannot accept, so the
 * expression is parsed and mapped onto the matching builder call — including a regex
 * name, `exact`, `level`, and trailing `.first()`/`.nth(n)`. **Rejection**: a suggestion
 * must resolve to exactly one visible element, because Playwright's strict mode would
 * throw on an ambiguous one and an invisible one would time out.
 *
 * The page is a recording stub. `resolve()` only ever calls builder methods, so a stub
 * captures exactly what a real Playwright page would be asked to do — and lets the
 * argument parsing be checked precisely, which a live browser would obscure.
 *
 * Frame handling lives in `frame-locator.test.js`.
 *
 *   npm run test:unit
 */

'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { SelectorValidator } = require('../../dist/core/SelectorValidator');

const validator = new SelectorValidator();

/** Silences the validator's warnings on deliberately malformed input. */
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
 * A page stub that records which builder was called with which arguments.
 *
 * @returns {object} The stub, with a `calls` array.
 */
function pageStub() {
  const calls = [];
  const locator = { __locator: true, first: () => locator, last: () => locator, nth: (n) => ({ __nth: n }) };

  const page = { calls };
  for (const method of [
    'locator', 'getByRole', 'getByLabel', 'getByText',
    'getByPlaceholder', 'getByTestId', 'getByTitle', 'getByAltText',
  ]) {
    page[method] = (...args) => {
      calls.push({ method, args });
      return locator;
    };
  }
  page.frameLocator = () => page;
  return page;
}

/** Resolves an expression and returns the single builder call it produced. */
function callFor(expression) {
  const page = pageStub();
  quiet(() => validator.resolve(expression, page));
  return page.calls[0];
}

describe('isValidSyntax — a cheap pre-filter, not an authority', () => {
  it('accepts ordinary CSS', () => {
    for (const selector of ['#id', '.cls', 'button', '[name="email"]', '.card .title', 'a[href^="/x"]']) {
      assert.equal(validator.isValidSyntax(selector), true, selector);
    }
  });

  it('accepts getBy* expressions', () => {
    assert.equal(validator.isValidSyntax("getByRole('button', { name: 'OK' })"), true);
    assert.equal(validator.isValidSyntax("await page.getByLabel('Email')"), true);
    assert.equal(validator.isValidSyntax("this.page.getByTestId('x')"), true);
  });

  it('accepts non-CSS engines by their own grammar', () => {
    for (const selector of ['//button[1]', 'xpath=//div', 'text=Submit', 'id=main', 'css=.x']) {
      assert.equal(validator.isValidSyntax(selector), true, selector);
    }
  });

  it('rejects unbalanced brackets, parentheses and quotes', () => {
    for (const selector of ['div[', "getByRole('button'", 'a)', "getByText('unclosed", '[name="x']) {
      assert.equal(validator.isValidSyntax(selector), false, selector);
    }
  });

  it('rejects a dangling combinator', () => {
    for (const selector of ['div >', '> div', '.a +', ', .b', '.a ~']) {
      assert.equal(validator.isValidSyntax(selector), false, selector);
    }
  });

  it('rejects nothing at all', () => {
    assert.equal(validator.isValidSyntax(''), false);
    assert.equal(validator.isValidSyntax('   '), false);
  });

  it('does not mistake an escaped quote for an unbalanced one', () => {
    assert.equal(validator.isValidSyntax(String.raw`getByText('it\'s here')`), true);
  });

  it('runs in Node, where there is no document', () => {
    // A `document.querySelector()` probe would throw ReferenceError and mark every
    // selector invalid — the reason the structural checks above exist.
    assert.equal(typeof globalThis.document, 'undefined');
    assert.equal(validator.isValidSyntax('#anything'), true);
  });
});

describe('resolve — mapping expressions onto builder calls', () => {
  it('passes plain CSS to locator()', () => {
    assert.deepEqual(callFor('#checkout-button'), { method: 'locator', args: ['#checkout-button'] });
  });

  it('passes XPath to locator(), which handles it natively', () => {
    assert.deepEqual(callFor('//button[@id="x"]'), { method: 'locator', args: ['//button[@id="x"]'] });
  });

  it('maps each getBy* helper onto its own builder', () => {
    assert.deepEqual(callFor("getByTestId('checkout')"), { method: 'getByTestId', args: ['checkout'] });
    assert.equal(callFor("getByLabel('Email address')").method, 'getByLabel');
    assert.equal(callFor("getByText('Order placed')").method, 'getByText');
    assert.equal(callFor("getByPlaceholder('Search')").method, 'getByPlaceholder');
    assert.equal(callFor("getByTitle('Close')").method, 'getByTitle');
    assert.equal(callFor("getByAltText('Logo')").method, 'getByAltText');
  });

  it('strips the wrappers models habitually add', () => {
    for (const expression of [
      "await getByTestId('x')",
      "page.getByTestId('x')",
      "this.page.getByTestId('x')",
      "await page.getByTestId('x')",
    ]) {
      assert.deepEqual(callFor(expression), { method: 'getByTestId', args: ['x'] }, expression);
    }
  });

  it('reads a quoted string name', () => {
    const call = callFor("getByRole('button', { name: 'Place order' })");
    assert.equal(call.method, 'getByRole');
    assert.equal(call.args[0], 'button');
    assert.equal(call.args[1].name, 'Place order');
  });

  it('reconstructs a regex name rather than dropping it', () => {
    // Dropping it would leave a bare getByRole('button') that matches every button on
    // the page — an ambiguous locator presented as a precise one.
    const call = callFor("getByRole('button', { name: /place order/i })");
    assert.ok(call.args[1].name instanceof RegExp);
    assert.equal(call.args[1].name.source, 'place order');
    assert.equal(call.args[1].name.flags, 'i');
  });

  it('reads exact and level', () => {
    const call = callFor("getByRole('heading', { name: 'Cart', exact: true, level: 2 })");
    assert.equal(call.args[1].exact, true);
    assert.equal(call.args[1].level, 2);
    assert.equal(call.args[1].name, 'Cart');
  });

  it('forwards exact to the text-based helpers', () => {
    assert.equal(callFor("getByLabel('Email', { exact: true })").args[1].exact, true);
  });

  it('handles a name containing a comma or braces', () => {
    // Argument splitting has to respect quotes, or "Smith, John" becomes two arguments.
    assert.equal(callFor("getByRole('button', { name: 'Edit Smith, John' })").args[1].name, 'Edit Smith, John');
    assert.equal(callFor("getByText('Total {gross}')").args[0], 'Total {gross}');
  });

  it('handles an escaped quote inside a name', () => {
    assert.equal(callFor(String.raw`getByText('it\'s here')`).args[0], "it's here");
  });

  it('ignores an unparseable regex rather than sending a broken one', () => {
    const call = callFor("getByRole('button', { name: /[unclosed/ })");
    assert.equal(call.args[1].name, undefined);
  });

  it('returns null for a malformed getBy* call', () => {
    const page = pageStub();
    assert.equal(quiet(() => validator.resolve("getByRole(button)", page)), null);
    assert.equal(quiet(() => validator.resolve("getByRole('button'", page)), null);
  });
});

describe('resolve — positional refinements', () => {
  it('applies .first() and .last()', () => {
    const page = pageStub();
    const first = quiet(() => validator.resolve("getByRole('button').first()", page));
    assert.equal(page.calls[0].method, 'getByRole');
    assert.ok(first);
  });

  it('applies .nth(n) with the index', () => {
    const page = pageStub();
    const nth = quiet(() => validator.resolve("getByRole('button').nth(2)", page));
    assert.deepEqual(nth, { __nth: 2 });
  });

  it('refines a plain CSS selector too', () => {
    const page = pageStub();
    quiet(() => validator.resolve('.row.nth(1)', page));
    // The refinement is stripped before the remainder reaches locator().
    assert.equal(page.calls[0].args[0], '.row');
  });

  it('does not mistake a CSS pseudo-class for a refinement', () => {
    assert.deepEqual(callFor('li:nth-child(2)'), { method: 'locator', args: ['li:nth-child(2)'] });
  });

  it('applies every refinement in a chain, in source order', () => {
    // `.nth(2).first()` is legal Playwright, and TestWrapper produces it whenever a
    // refined locator is refined again. Peeling only the last one used to drop .nth(2)
    // silently, which resolved to the FIRST row rather than the third.
    const page = pageStub();
    const calls = [];
    const chainable = {
      first: () => (calls.push('first'), chainable),
      last: () => (calls.push('last'), chainable),
      nth: (n) => (calls.push(`nth(${n})`), chainable),
    };
    page.getByRole = () => chainable;

    quiet(() => validator.resolve("getByRole('row').nth(2).first()", page));
    assert.deepEqual(calls, ['nth(2)', 'first']);
  });
});

describe('resolve — a chain it cannot express is refused, never truncated', () => {
  // A model asked for one locator sometimes answers with a chain. The parser reads the
  // leading call; before this it threw the rest away, so
  // `getByRole('row').filter(...).getByRole('button')` resolved to the ROW — and on a
  // page with one row that validates, and the healer acts on the wrong element while
  // the report displays the full chain. Refusing feeds the reason into the next prompt.
  const chains = [
    "getByRole('row').filter({ hasText: 'Smith' }).getByRole('button')",
    "getByRole('button', { name: 'Pay' }).filter({ visible: true })",
    "getByText('x').locator('..')",
    "locator('.row').filter({ hasText: 'x' })",
    "getByRole('row').and(page.getByRole('button'))",
    "getByRole('row').or(page.getByRole('button'))",
  ];

  for (const chain of chains) {
    it(`refuses ${chain}`, () => {
      assert.equal(quiet(() => validator.resolve(chain, pageStub())), null);
      assert.ok(validator.unsupportedSuffix(chain), 'the suffix should be named');
    });
  }

  it('names the offending suffix rather than the whole expression', () => {
    assert.equal(
      validator.unsupportedSuffix("getByRole('button').filter({ visible: true })"),
      '.filter({ visible: true })'
    );
  });

  it('reports the suffix as the rejection reason, so the retry can learn from it', async () => {
    const result = await quiet(() =>
      validator.validateDetailed("getByRole('row').filter({ hasText: 'x' })", pageStub())
    );
    assert.equal(result.valid, false);
    assert.match(result.reason, /\.filter\(\{ hasText: 'x' \}\)/);
  });

  it('leaves supported shapes alone', () => {
    const supported = [
      "getByRole('button', { name: 'Pay' })",
      "getByRole('row').nth(2).first()",
      "frameLocator('#pay').getByRole('button').first()",
      "locator('#card')",
      '#place-order-btn',
      "//button[@id='x']",
    ];

    for (const expression of supported) {
      assert.equal(validator.unsupportedSuffix(expression), null, expression);
    }

    // `.nth(2).first()` is covered by its own test above — this stub's nth() returns a
    // terminal value, so it cannot be refined again.
    for (const expression of supported.filter((e) => !e.includes('.nth('))) {
      assert.ok(quiet(() => validator.resolve(expression, pageStub())), expression);
    }
  });

  it('refuses an option it cannot forward, rather than resolving something broader', () => {
    // Same rule as the trailing chain, one level in. Every one of these NARROWS the match,
    // so dropping it resolves a bigger set than the expression describes.
    assert.deepEqual(validator.unhonouredOptions("getByRole('button', { pressed: true })"), ['pressed']);
    assert.deepEqual(
      validator.unhonouredOptions("getByRole('checkbox', { checked: false, name: 'Terms' })"),
      ['checked']
    );
    // locator()'s options are not forwarded at all, so the object is named as a whole.
    assert.deepEqual(validator.unhonouredOptions("locator('.row', { hasText: 'Smith' })"), ['options']);
  });

  it('honours name, exact and level without complaint', () => {
    for (const expression of [
      "getByRole('button', { name: 'Pay' })",
      "getByRole('button', { name: 'Pay', exact: true })",
      "getByRole('heading', { level: 2, name: 'Total' })",
      "getByText('Total')",
      "locator('.row')",
      '#place-order-btn',
    ]) {
      assert.deepEqual(validator.unhonouredOptions(expression), [], expression);
    }
  });

  it('does not read an option key out of an accessible name', () => {
    // A name is free text. `{ name: 'Total, b: c' }` would otherwise look like an option
    // called `b` and reject a perfectly good suggestion.
    assert.deepEqual(validator.unhonouredOptions("getByRole('button', { name: 'a, b: c' })"), []);
    assert.deepEqual(validator.unhonouredOptions("getByRole('button', { name: /pay: now/i })"), []);
  });

  it('names the option in the rejection reason, so the retry can drop it', async () => {
    const result = await quiet(() =>
      validator.validateDetailed("getByRole('button', { pressed: true })", pageStub())
    );
    assert.equal(result.valid, false);
    assert.match(result.reason, /"pressed"/);
    assert.match(result.reason, /accessible name/);
  });

  it('leaves bare CSS and XPath to Playwright, whatever they contain', () => {
    // These have their own grammars; this validator is not the authority on them.
    assert.equal(validator.unsupportedSuffix('div > .row:has(> button)'), null);
    assert.equal(validator.unsupportedSuffix("//tr[td='Smith']/button"), null);
  });
});

describe('validateDetailed — the rejection rules', () => {
  /**
   * A locator stub with a fixed match count and visibility.
   *
   * @param {object} shape - `count`, `visible`, and optional throwers.
   * @returns {object} A page stub whose locator() returns it.
   */
  function pageWith({ count = 1, visible = true, countThrows = false, visibleThrows = false } = {}) {
    const locator = {
      first: () => locator,
      waitFor: async () => {},
      count: async () => {
        if (countThrows) throw new Error('detached');
        return count;
      },
      isVisible: async () => {
        if (visibleThrows) throw new Error('detached');
        return visible;
      },
    };
    return { locator: () => locator };
  }

  it('accepts exactly one visible element', async () => {
    const result = await quiet(() => validator.validateDetailed('#x', pageWith({ count: 1, visible: true })));
    assert.equal(result.valid, true);
    assert.equal(result.matches, 1);
  });

  it('rejects nothing matched', async () => {
    const result = await quiet(() => validator.validateDetailed('#x', pageWith({ count: 0 })));
    assert.equal(result.valid, false);
    assert.match(result.reason, /matched no elements/);
  });

  it('rejects more than one match, because strict mode would throw', async () => {
    const result = await quiet(() => validator.validateDetailed('#x', pageWith({ count: 3 })));
    assert.equal(result.valid, false);
    assert.equal(result.matches, 3);
    assert.match(result.reason, /matched 3 elements — must match exactly one/);
  });

  it('rejects an attached but invisible element', async () => {
    // Usually the right kind of element in the wrong place — a template or closed modal.
    const result = await quiet(() => validator.validateDetailed('#x', pageWith({ visible: false })));
    assert.equal(result.valid, false);
    assert.match(result.reason, /not visible/);
  });

  it('rejects an empty selector without touching the page', async () => {
    const result = await validator.validateDetailed('   ', pageWith());
    assert.equal(result.valid, false);
    assert.match(result.reason, /empty/);
  });

  it('rejects a syntactically impossible selector before querying', async () => {
    const result = await validator.validateDetailed('div[', pageWith());
    assert.equal(result.valid, false);
    assert.match(result.reason, /not syntactically valid/);
  });

  it('reports a reason rather than throwing when counting fails', async () => {
    const result = await quiet(() => validator.validateDetailed('#x', pageWith({ countThrows: true })));
    assert.equal(result.valid, false);
    assert.match(result.reason, /could not evaluate/);
  });

  it('reports a reason rather than throwing when the visibility check fails', async () => {
    const result = await quiet(() => validator.validateDetailed('#x', pageWith({ visibleThrows: true })));
    assert.equal(result.valid, false);
    assert.match(result.reason, /visibility check failed/);
  });

  it('never throws, whatever the page does', async () => {
    const hostile = {
      locator: () => {
        throw new Error('page is closed');
      },
    };
    const result = await quiet(() => validator.validateDetailed('#x', hostile));
    assert.equal(result.valid, false);
    assert.match(result.reason, /rejected by Playwright/);
  });
});

describe('validateMultiple — first candidate that works', () => {
  it('returns the first that validates and stops there', async () => {
    let asked = 0;
    const page = {
      locator: (selector) => {
        asked++;
        const count = selector === '#good' ? 1 : 0;
        const locator = {
          first: () => locator,
          waitFor: async () => {},
          count: async () => count,
          isVisible: async () => true,
        };
        return locator;
      },
    };

    const winner = await quiet(() => validator.validateMultiple(['#bad', '#good', '#alsogood'], page));
    assert.equal(winner, '#good');
    assert.equal(asked, 2, 'should not have tried anything after the winner');
  });

  it('returns null when none work', async () => {
    const locator = { first: () => locator, waitFor: async () => {}, count: async () => 0, isVisible: async () => true };
    const winner = await quiet(() => validator.validateMultiple(['#a', '#b'], { locator: () => locator }));
    assert.equal(winner, null);
  });
});

describe('validateDetailed — why a getByRole miss was a miss', () => {
  /**
   * A page stub whose getByRole() locator always matches nothing.
   *
   * The count is what matters here: the hint under test is only reached after the
   * expression has already resolved to zero elements, so a real page carrying an
   * aria-labelled container never sees it.
   *
   * @returns {object} The stub page.
   */
  function pageMatchingNothing() {
    const locator = {
      first: () => locator,
      waitFor: async () => {},
      count: async () => 0,
      isVisible: async () => false,
    };
    const root = {
      getByRole: () => locator,
      getByText: () => locator,
      locator: () => locator,
      frameLocator: () => root,
    };
    return root;
  }

  it('explains a name paired with a container role, which is why nav heals failed', async () => {
    // The real failure: `//li/a/span[text()='Charter Cloud']` healed to
    // getByRole('listitem', { name: 'Private Cloud' }) — right element, wrong role.
    const result = await quiet(() =>
      validator.validateDetailed("getByRole('listitem', { name: 'Private Cloud' })", pageMatchingNothing())
    );

    assert.equal(result.valid, false);
    assert.equal(result.matches, 0);
    assert.match(result.reason, /matched no elements/);
    assert.match(result.reason, /takes no accessible name from its contents/);
    assert.ok(result.reason.includes('Private Cloud'), 'should quote the name that excluded it');
    assert.match(result.reason, /link, button/, 'should point at the roles that do carry a name');
  });

  it('says nothing extra when the role does take a name from its contents', async () => {
    const result = await quiet(() =>
      validator.validateDetailed("getByRole('link', { name: 'Private Cloud' })", pageMatchingNothing())
    );

    assert.equal(result.valid, false);
    assert.equal(result.reason, 'matched no elements');
  });

  it('says nothing extra when no name was given — the role alone is legitimate', async () => {
    const result = await quiet(() =>
      validator.validateDetailed("getByRole('listitem')", pageMatchingNothing())
    );

    assert.equal(result.reason, 'matched no elements');
  });

  it('sees through await, page. and frameLocator wrappers', async () => {
    const result = await quiet(() =>
      validator.validateDetailed(
        "await page.frameLocator('#shell').getByRole('navigation', { name: 'Reports' })",
        pageMatchingNothing()
      )
    );

    assert.match(result.reason, /takes no accessible name/);
  });

  it('reads a regex name too', async () => {
    const result = await quiet(() =>
      validator.validateDetailed("getByRole('region', { name: /Summary/i })", pageMatchingNothing())
    );

    assert.match(result.reason, /takes no accessible name/);
    assert.ok(result.reason.includes('/Summary/i'));
  });

  it('leaves non-getByRole misses alone', async () => {
    const result = await quiet(() =>
      validator.validateDetailed("getByText('Charter Cloud', { exact: true })", pageMatchingNothing())
    );

    assert.equal(result.reason, 'matched no elements');
  });
});

describe('resolve — a scoping chain of getBy* calls', () => {
  /**
   * A stub whose locators are themselves builders, so a chain can be recorded.
   *
   * `Locator` exposes the same builder surface as `Page`, which is exactly what makes
   * chaining resolvable rather than a special case.
   *
   * @returns {object} The stub, with a flat `calls` log of `method(args)` at each depth.
   */
  function chainStub() {
    const calls = [];

    /**
     * @param {number} depth - How deep in the chain this level sits.
     * @returns {object} A builder that logs and returns the next level.
     */
    function level(depth) {
      const node = {
        __depth: depth,
        first: () => (calls.push(`${depth}:first`), node),
        last: () => (calls.push(`${depth}:last`), node),
        nth: (n) => (calls.push(`${depth}:nth(${n})`), node),
      };
      for (const method of [
        'locator', 'getByRole', 'getByLabel', 'getByText',
        'getByPlaceholder', 'getByTestId', 'getByTitle', 'getByAltText',
      ]) {
        node[method] = (...args) => {
          calls.push(`${depth}:${method}(${args.map((a) => JSON.stringify(a)).join(', ')})`);
          return level(depth + 1);
        };
      }
      node.frameLocator = () => node;
      return node;
    }

    const page = level(0);
    page.calls = calls;
    return page;
  }

  it('resolves the scoped form CandidateFinder writes for a repeated name', () => {
    // Two links named "Settings" under different landmarks have no other unique
    // expression, so refusing this shape refused the whole class of duplicate names.
    const page = chainStub();
    const result = quiet(() =>
      validator.resolve(
        "getByRole('navigation', { name: 'Account' }).getByRole('link', { name: 'Settings', exact: true })",
        page
      )
    );

    assert.ok(result, 'the chain should resolve');
    assert.deepEqual(page.calls, [
      '0:getByRole("navigation", {"name":"Account"})',
      '1:getByRole("link", {"name":"Settings","exact":true})',
    ]);
  });

  it('binds a refinement to the segment it follows, not to the whole chain', () => {
    // `.nth(2)` here means the third listitem, then the link inside it. Applying it at
    // the end instead would take the third *link*, which is a different element.
    const page = chainStub();
    quiet(() => validator.resolve("getByRole('listitem').nth(2).getByRole('link')", page));

    // Depths are the node each call was made *on*: the listitem locator is level 1, so
    // `nth(2)` narrowing it — and the link being built from the narrowed result — is
    // exactly the binding this asserts.
    assert.deepEqual(page.calls, [
      '0:getByRole("listitem", {})',
      '1:nth(2)',
      '1:getByRole("link", {})',
    ]);
  });

  it('walks three levels deep', () => {
    const page = chainStub();
    quiet(() =>
      validator.resolve(
        "getByRole('table').getByRole('row', { name: 'Smith' }).getByRole('cell', { name: 'Active' })",
        page
      )
    );
    assert.equal(page.calls.length, 3);
  });

  it('still refuses a chain it would resolve differently from Playwright', () => {
    for (const chain of [
      "getByRole('row').filter({ hasText: 'x' }).getByRole('button')",
      "getByRole('row').getByRole('cell').filter({ hasText: 'x' })",
      "getByText('x').locator('..')",
    ]) {
      assert.equal(quiet(() => validator.resolve(chain, chainStub())), null, chain);
      assert.ok(validator.unsupportedSuffix(chain), `${chain}: the suffix should be named`);
    }
  });

  it('keeps the leading dot on the suffix it refuses, at any depth', () => {
    // The reason reaches a model as the text to stop writing, so it has to read as code.
    assert.equal(
      validator.unsupportedSuffix("getByRole('row').getByRole('cell').filter({ hasText: 'x' })"),
      ".filter({ hasText: 'x' })"
    );
  });

  it('checks unhonoured options in every segment, not just the first', () => {
    // An option dropped from a scoping call resolves a broader scope — the same
    // failure as a truncated chain, one level out.
    const offenders = validator.unhonouredOptions(
      "getByRole('row', { name: 'Smith' }).getByRole('button', { pressed: true })"
    );
    assert.deepEqual(offenders, ['pressed']);
  });

  it('accepts a chain as syntactically valid', () => {
    assert.equal(
      validator.isValidSyntax("getByRole('navigation', { name: 'A' }).getByRole('link', { name: 'B' })"),
      true
    );
  });
});
