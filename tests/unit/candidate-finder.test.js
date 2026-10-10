/**
 * Unit tests for candidate enumeration.
 *
 * The point of this module is that a candidate cannot fail to resolve, so these tests
 * are mostly about what it *refuses* to offer: a node the snapshot showed without a
 * name, a role that is not a role, a disabled control, and a duplicate no ancestor can
 * tell apart. `candidate-finder.live.test.js` proves the expressions really do resolve
 * against a browser; this file pins the rules.
 *
 *   npm run test:unit
 */

'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { CandidateFinder } = require('../../dist/core/CandidateFinder');

const finder = new CandidateFinder();

/** The snapshot from the failure that prompted this module: menu renamed and moved. */
const NAV_SNAPSHOT = `
- banner:
  - navigation "Main":
    - list:
      - listitem:
        - link "Private Cloud":
          - /url: "#/priv"
      - listitem:
        - link "Dedicated Cloud":
          - /url: "#/ded"
  - navigation "Account":
    - list:
      - listitem:
        - link "Settings":
          - /url: "#/set"
- main:
  - heading "Home" [level=1]
  - link "Settings":
    - /url: "#/set"
  - button "Continue"
  - button "Archived" [disabled]
  - text: Search
  - searchbox "Search"
`;

/**
 * Looks a candidate up by role and name.
 *
 * @param {object[]} candidates - The list to search.
 * @param {string} role - Role to match.
 * @param {string} name - Accessible name to match.
 * @returns {object|undefined} The candidate, if offered.
 */
const pick = (candidates, role, name) =>
  candidates.find((c) => c.role === role && c.name === name);

describe('CandidateFinder — what it offers', () => {
  it('writes the locator the model got wrong, for the element the model got right', () => {
    // The whole reason this module exists: the model identified "Private Cloud"
    // correctly and then answered getByRole('listitem', { name: ... }), which the
    // accessible-name computation excludes. Here the authoring is not its job.
    const candidates = finder.find(NAV_SNAPSHOT);
    const target = pick(candidates, 'link', 'Private Cloud');

    assert.ok(target, 'the renamed menu item should be offered');
    assert.equal(target.selector, "getByRole('link', { name: 'Private Cloud', exact: true })");
    assert.deepEqual(target.context, ['banner', 'navigation "Main"'].slice(1));
  });

  it('numbers candidates from 1, in document order', () => {
    const candidates = finder.find(NAV_SNAPSHOT);
    assert.deepEqual(
      candidates.map((c) => c.id),
      candidates.map((_, i) => i + 1)
    );
    // "Private Cloud" is serialised before "Continue", so it must be offered first.
    assert.ok(
      pick(candidates, 'link', 'Private Cloud').id < pick(candidates, 'button', 'Continue').id
    );
  });

  it('offers a named container, because the snapshot proves it has a name', () => {
    // `navigation "Account"` is addressable by name even though `navigation` takes no
    // name from its contents — the aria-label is why the snapshot prints one.
    const target = pick(finder.find(NAV_SNAPSHOT), 'navigation', 'Account');
    assert.ok(target);
    assert.equal(target.selector, "getByRole('navigation', { name: 'Account', exact: true })");
  });

  it('never offers a node the snapshot showed without a name', () => {
    // This is the failure class, stated as an invariant: no name, no candidate.
    const candidates = finder.find(NAV_SNAPSHOT);
    for (const role of ['listitem', 'list', 'banner', 'main']) {
      assert.equal(pick(candidates, role, undefined), undefined, `${role} must not be offered`);
      assert.ok(
        candidates.every((c) => c.role !== role || c.name),
        `every offered ${role} must carry a name`
      );
    }
    assert.ok(candidates.every((c) => c.name && c.name.trim()), 'no candidate may be nameless');
  });

  it('skips the text pseudo-role, which is not a role at all', () => {
    // `- text: Search` is a bare text node; getByRole('text', ...) resolves nothing.
    assert.equal(finder.find(NAV_SNAPSHOT).find((c) => c.role === 'text'), undefined);
  });

  it('skips a disabled control, because the action would only time out on it', () => {
    assert.equal(pick(finder.find(NAV_SNAPSHOT), 'button', 'Archived'), undefined);
  });

  it('scopes a duplicate to the nearest ancestor that separates it', () => {
    // Two links named "Settings". The one under nav "Account" is reachable by scoping;
    // the one in `main` has no named ancestor, so it is dropped rather than offered
    // ambiguously.
    const settings = finder.find(NAV_SNAPSHOT).filter((c) => c.name === 'Settings');

    assert.equal(settings.length, 1, 'only the separable duplicate should be offered');
    assert.equal(
      settings[0].selector,
      "getByRole('navigation', { name: 'Account' })." +
        "getByRole('link', { name: 'Settings', exact: true })"
    );
  });

  it('always sets exact, so its uniqueness claim is the one Playwright will see', () => {
    // A name matches as a substring by default: { name: 'Cloud' } would also match
    // "Private Cloud", and the tally that decided uniqueness did not allow for that.
    for (const candidate of finder.find(NAV_SNAPSHOT)) {
      assert.match(candidate.selector, /exact: true \}\)$/, candidate.selector);
    }
  });
});

describe('CandidateFinder — parsing the snapshot format', () => {
  it('reads a name containing an escaped quote', () => {
    const candidates = finder.find('- button "Say \\"hello\\""');
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].name, 'Say "hello"');
    // And re-escapes it for the expression, so the literal round-trips.
    assert.equal(candidates[0].selector, `getByRole('button', { name: 'Say "hello"', exact: true })`);
  });

  it('escapes an apostrophe in a name', () => {
    const candidates = finder.find(`- link "Bob's account"`);
    assert.equal(candidates[0].selector, `getByRole('link', { name: 'Bob\\'s account', exact: true })`);
  });

  it('reads a name through trailing attributes', () => {
    const candidates = finder.find('- heading "Overview" [level=2]');
    assert.equal(candidates[0].name, 'Overview');
    assert.equal(candidates[0].role, 'heading');
  });

  it('ignores /url and other property lines', () => {
    const candidates = finder.find('- link "Home":\n  - /url: "/home"');
    assert.equal(candidates.length, 1);
  });

  it('returns nothing for an empty or nameless snapshot', () => {
    assert.deepEqual(finder.find(''), []);
    assert.deepEqual(finder.find('- list:\n  - listitem:\n    - text: hello'), []);
  });

  it('never throws on input that is not a snapshot at all', () => {
    for (const junk of ['', '\n\n', 'not a snapshot', '- ', '"', '- "unclosed']) {
      assert.ok(Array.isArray(finder.find(junk)), JSON.stringify(junk));
    }
  });
});

describe('CandidateFinder — the cap', () => {
  /**
   * A snapshot of `count` buttons, one of which is the interesting one.
   *
   * @param {number} count - How many filler buttons to generate.
   * @returns {string} Snapshot text.
   */
  function crowded(count) {
    const lines = ['- main:'];
    for (let i = 0; i < count; i++) lines.push(`  - button "Filler ${i}"`);
    lines.push('  - link "Private Cloud"');
    return lines.join('\n');
  }

  it('honours the limit', () => {
    assert.equal(finder.find(crowded(200), { limit: 10 }).length, 10);
    assert.deepEqual(finder.find(crowded(5), { limit: 0 }), []);
  });

  it('drops the least relevant, not the tail of the document', () => {
    // The target is serialised last. A naive slice would cut exactly the element the
    // heal needs, so relevance decides what survives the cap.
    const candidates = finder.find(crowded(200), {
      limit: 5,
      action: 'click',
      intent: "//li/a/span[text()='Charter Cloud']",
    });

    assert.equal(candidates.length, 5);
    assert.ok(
      candidates.some((c) => c.name === 'Private Cloud'),
      'the element sharing vocabulary with the intent should survive'
    );
  });

  it('renumbers ids contiguously after the cap, still in document order', () => {
    const candidates = finder.find(crowded(50), { limit: 7, intent: 'cloud' });
    assert.deepEqual(candidates.map((c) => c.id), [1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('CandidateFinder — ranking is not fooled by selector syntax', () => {
  /**
   * A crowded page plus two lookalikes: one named after the *syntax* of the failing
   * selector, one the real target.
   *
   * @param {number} count - Filler buttons.
   * @returns {string} Snapshot text.
   */
  function crowded(count) {
    const lines = ['- main:'];
    for (let i = 0; i < count; i++) lines.push(`  - button "Filler ${i}"`);
    lines.push('  - button "Span text element"');
    lines.push('  - link "Charter Cloud"');
    return lines.join('\n');
  }

  it('does not score a candidate on the words in an XPath', () => {
    // `//li/a/span[text()='Charter Cloud']` contains `span` and `text`, which are
    // grammar rather than vocabulary. Scored naively they ranked "Span text element"
    // above the menu item the test was actually after.
    const kept = finder.find(crowded(300), {
      limit: 2,
      action: 'click',
      intent: "//li/a/span[text()='Charter Cloud']",
    });

    assert.ok(
      kept.some((c) => c.name === 'Charter Cloud'),
      `the real target should survive the cap: ${JSON.stringify(kept.map((c) => c.name))}`
    );
    assert.equal(
      kept.find((c) => c.name === 'Span text element'),
      undefined,
      'a name matching the selector grammar must not outrank the target'
    );
  });

  it('still scores on real vocabulary from the description', () => {
    const kept = finder.find(crowded(300), {
      limit: 2,
      action: 'click',
      intent: '#btn-x7f3 the Charter Cloud segment link',
    });
    assert.ok(kept.some((c) => c.name === 'Charter Cloud'));
  });
});
