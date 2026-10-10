/**
 * Proves the one claim the candidate design rests on:
 *
 *   **every locator `CandidateFinder` writes resolves to exactly one element.**
 *
 * That invariant is what lets the model answer with an id instead of selector syntax,
 * and it cannot be proved against a stub — it is a claim about ARIA name computation,
 * which only a browser implements. So this test drives a real Chromium, captures a real
 * `ariaSnapshot()`, and validates every candidate through the real `SelectorValidator`.
 *
 * `candidate-finder.test.js` covers the parsing and cap rules without a browser.
 *
 * Lives in `tests/live/` rather than `tests/unit/` because it drives a real browser.
 * `node --test` runs files in parallel, and the recorder's concurrency tests budget
 * their lock acquisition in wall-clock time — three Chromium launches alongside them
 * was enough to make those fail intermittently. `npm run test:live` runs this directory
 * with `--test-concurrency=1`, after the unit suite.
 *
 *
 * Skipped, not failed, when no browser is installed: a contributor without
 * `npx playwright install` should still be able to run the suite.
 *
 *   npm run test:live
 */

'use strict';

const assert = require('node:assert/strict');
const { describe, it, before, after } = require('node:test');

const { CandidateFinder } = require('../../dist/core/CandidateFinder');
const { SelectorValidator } = require('../../dist/core/SelectorValidator');

const finder = new CandidateFinder();
const validator = new SelectorValidator();

/** Pages worth proving the invariant against, each with its own trap. */
const PAGES = {
  // The failure that prompted the module: nav renamed and moved to the right, plus a
  // duplicate link name across two landmarks.
  'renamed navigation': `
    <header style="display:flex;justify-content:flex-end">
      <nav aria-label="Main"><ul>
        <li><a href="#/priv"><span>Private Cloud</span></a></li>
        <li><a href="#/ded"><span>Dedicated Cloud</span></a></li>
      </ul></nav>
      <nav aria-label="Account"><ul>
        <li><a href="#/set"><span>Settings</span></a></li>
      </ul></nav>
    </header>
    <main><h1>Home</h1><a href="#/set">Settings</a><button>Continue</button></main>`,

  // Names where one is a prefix of another — the case `exact: true` exists for.
  'prefix names': `
    <main>
      <button>Submit</button>
      <button>Submit report</button>
      <button>Submit report and close</button>
    </main>`,

  // Form controls, whose names come from labels rather than contents.
  'labelled form': `
    <form>
      <label for="e">Email</label><input id="e" type="email">
      <label for="p">Promotion code</label><input id="p">
      <label><input type="checkbox"> Accept terms</label>
      <label for="s">Country</label>
      <select id="s"><option>France</option><option>Germany</option></select>
      <button type="submit">Place order</button>
      <button disabled>Cancel order</button>
    </form>`,

  // A table, where cells and rows repeat names across columns.
  'table': `
    <table>
      <tr><th>Item</th><th>Status</th></tr>
      <tr><td>Widget</td><td>Active</td></tr>
      <tr><td>Gadget</td><td>Active</td></tr>
    </table>`,

  // Names carrying the characters that break naive quoting.
  'awkward names': `
    <main>
      <button>Bob's account</button>
      <button>Say "hello"</button>
      <button>50% off</button>
      <a href="#/x">Back \\ forward</a>
    </main>`,
};

const { chromium } = require('@playwright/test');

let browser;
let unavailable;

before(async () => {
  try {
    browser = await chromium.launch();
  } catch (error) {
    // Only a missing browser binary is a legitimate skip. Anything else is a bug in
    // this file or in the package, and silently skipping it would hide the very
    // failure the suite exists to catch — so it is rethrown.
    const message = error.message ?? String(error);
    if (!/Executable doesn't exist|playwright install|browserType\.launch/i.test(message)) throw error;
    unavailable = message.split('\n')[0];
  }
});

after(async () => {
  if (browser) await browser.close();
});

describe('CandidateFinder — every candidate resolves, against a real browser', () => {
  for (const [label, html] of Object.entries(PAGES)) {
    it(`holds on the "${label}" page`, async (t) => {
      if (!browser) return t.skip(`no browser available: ${unavailable}`);

      const page = await browser.newPage();
      try {
        await page.setContent(html);
        const snapshot = await page.locator('body').ariaSnapshot();
        const candidates = finder.find(snapshot);

        assert.ok(candidates.length > 0, `should find candidates:\n${snapshot}`);

        for (const candidate of candidates) {
          const result = await validator.validateDetailed(candidate.selector, page);
          assert.ok(
            result.valid,
            `[${candidate.id}] ${candidate.role} "${candidate.name}"\n` +
              `  ${candidate.selector}\n` +
              `  rejected: ${result.reason} (matches=${result.matches})\n` +
              `snapshot:\n${snapshot}`
          );
        }
      } finally {
        await page.close();
      }
    });
  }

  it('offers the renamed menu item that the model could not address', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    const page = await browser.newPage();
    try {
      await page.setContent(PAGES['renamed navigation']);
      const candidates = finder.find(await page.locator('body').ariaSnapshot(), {
        action: 'click',
        intent: "//li/a/span[text()='Charter Cloud']",
      });

      const target = candidates.find((c) => c.name === 'Private Cloud');
      assert.ok(target, 'the renamed item should be offered');

      // The element the real heal wanted, addressed by an expression the model never
      // had to write — and proved unique on the live page.
      const result = await validator.validateDetailed(target.selector, page);
      assert.equal(result.valid, true, result.reason);
      assert.equal(result.matches, 1);
    } finally {
      await page.close();
    }
  });

  it('never offers the disabled control, which an action would only time out on', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    const page = await browser.newPage();
    try {
      await page.setContent(PAGES['labelled form']);
      const candidates = finder.find(await page.locator('body').ariaSnapshot());
      assert.equal(candidates.find((c) => c.name === 'Cancel order'), undefined);
      assert.ok(candidates.find((c) => c.name === 'Place order'), 'the enabled one stays');
    } finally {
      await page.close();
    }
  });
});

describe('CandidateFinder — names YAML forces the snapshot to quote', () => {
  it('offers elements whose names hold a colon, hash or brace', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    // The snapshot is YAML, so an entry containing an indicator is emitted as
    // `- 'button "Total: 42"'` with the whole entry inside the quotes. The parser used
    // to require the role immediately after `- `, so every one of these was silently
    // skipped — and "Total: 42" / "Status: Active" is ordinary interface text, not an
    // edge case.
    const names = ['Total: 42', 'a: b: c', 'hash #tag', 'brace {x}', "Bob's: total", 'plain'];

    const page = await browser.newPage();
    try {
      await page.setContent(
        '<main>' + names.map((n) => `<button>${n.replace(/&/g, '&amp;')}</button>`).join('') + '</main>'
      );

      const snapshot = await page.locator('body').ariaSnapshot();
      const candidates = finder.find(snapshot);

      for (const name of names) {
        const candidate = candidates.find((c) => c.name === name);
        assert.ok(candidate, `"${name}" was not offered.\nsnapshot:\n${snapshot}`);

        const result = await validator.validateDetailed(candidate.selector, page);
        assert.equal(result.valid, true, `${candidate.selector}: ${result.reason}`);
      }
    } finally {
      await page.close();
    }
  });

  it('reads a quoted container and keeps its children nested under it', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    // A container's trailing colon sits outside the closing quote, so the unwrap has to
    // find that quote from the right — and the depth bookkeeping must survive it, or
    // the ancestry used to disambiguate duplicates is wrong.
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <nav aria-label="Main: primary"><a href="#a">Settings</a></nav>
        <nav aria-label="Account: mine"><a href="#b">Settings</a></nav>`);

      const snapshot = await page.locator('body').ariaSnapshot();
      const candidates = finder.find(snapshot);
      const settings = candidates.filter((c) => c.name === 'Settings');

      assert.equal(settings.length, 2, `both should be reachable.\nsnapshot:\n${snapshot}`);
      for (const candidate of settings) {
        assert.match(candidate.selector, /^getByRole\('navigation'/, candidate.selector);
        const result = await validator.validateDetailed(candidate.selector, page);
        assert.equal(result.valid, true, `${candidate.selector}: ${result.reason}`);
      }
    } finally {
      await page.close();
    }
  });
});

describe('CandidateFinder — elements with text but no accessible name', () => {
  it('offers a clickable list item that nothing names', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    // From a healing record: a menu built as `<li><span>Charter Cloud</span></li>` with
    // a click handler. `listitem` takes no accessible name from its contents and the
    // span has no role, so nothing on the page is addressable by role — the first pass
    // offered no candidate at all and the heal fell to a free-form answer.
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <nav><ul>
          <li><span>Charter Cloud</span></li>
          <li><span>Dedicated Cloud</span></li>
        </ul></nav>`);

      const snapshot = await page.locator('body').ariaSnapshot();
      const candidates = finder.find(snapshot, { action: 'click' });
      const target = candidates.find((c) => c.name === 'Charter Cloud');

      assert.ok(target, `nothing offered for a nameless list item.\nsnapshot:\n${snapshot}`);
      assert.equal(target.selector, "getByText('Charter Cloud', { exact: true })");

      const result = await validator.validateDetailed(target.selector, page);
      assert.equal(result.valid, true, result.reason);
      assert.equal(result.matches, 1, 'getByText with exact collapses the ancestor chain');
    } finally {
      await page.close();
    }
  });

  it('prefers the role when the element has a name, and does not offer both', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    // With the anchor present the same menu *is* addressable by role, which is the more
    // durable handle. Offering a text candidate as well would spend prompt space and
    // invite the weaker pick.
    const page = await browser.newPage();
    try {
      await page.setContent('<nav><ul><li><a href="#/c"><span>Charter Cloud</span></a></li></ul></nav>');

      const candidates = finder.find(await page.locator('body').ariaSnapshot(), { action: 'click' });
      const forName = candidates.filter((c) => c.name === 'Charter Cloud');

      assert.equal(forName.length, 1, 'exactly one candidate per element');
      assert.equal(forName[0].selector, "getByRole('link', { name: 'Charter Cloud', exact: true })");
    } finally {
      await page.close();
    }
  });

  it('never offers coalesced text, which belongs to no single element', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    // Playwright merges adjacent text into one `- text:` entry, so this form yields
    // `- text: Accept terms Country` — text no element has. Offering it broke the
    // guarantee the prompt makes about every candidate resolving.
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <form>
          <label><input type="checkbox"> Accept terms</label>
          <label for="s">Country</label><select id="s"><option>FR</option></select>
        </form>`);

      const snapshot = await page.locator('body').ariaSnapshot();
      assert.match(snapshot, /- text: Accept terms Country/, 'the fixture should still coalesce');

      const candidates = finder.find(snapshot);
      assert.equal(
        candidates.find((c) => c.name === 'Accept terms Country'),
        undefined,
        'coalesced text must not be offered'
      );

      // And the named controls are still reachable.
      assert.ok(candidates.find((c) => c.role === 'checkbox' && c.name === 'Accept terms'));
      assert.ok(candidates.find((c) => c.role === 'combobox' && c.name === 'Country'));
    } finally {
      await page.close();
    }
  });

  it('drops repeated text, which getByText cannot disambiguate', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    // There is no ancestor trick available here: getByText takes no role to scope by.
    const page = await browser.newPage();
    try {
      await page.setContent('<ul><li><span>Dup</span></li><li><span>Dup</span></li></ul>');
      const candidates = finder.find(await page.locator('body').ariaSnapshot());
      assert.equal(candidates.find((c) => c.name === 'Dup'), undefined);
    } finally {
      await page.close();
    }
  });
});

describe('CandidateFinder — a control value is not text content', () => {
  it('never offers what a user typed into a field', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    // Two failures in one. `- textbox "Patient name": Smith, John` prints the VALUE
    // after the colon, so treating it as text content produced
    // getByText('Smith, John', { exact: true }) — which matches nothing, because an
    // input's value is not in the DOM's text — and carried the value into the prompt as
    // a candidate name, under the rule that keeps names for actionable roles.
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <form>
          <label for="n">Patient name</label><input id="n" value="Smith, John">
          <label for="m">MRN</label><input id="m" value="884213701">
          <label for="c">Notes</label><textarea id="c">Seen 2026-03-11 for review</textarea>
        </form>`);

      const snapshot = await page.locator('body').ariaSnapshot();
      assert.match(snapshot, /textbox "Patient name": Smith, John/, 'the fixture must show a value');

      const candidates = finder.find(snapshot, { action: 'fill' });

      for (const value of ['Smith, John', '884213701', 'Seen 2026-03-11 for review']) {
        assert.equal(
          candidates.find((c) => c.name === value),
          undefined,
          `a control value must not be offered: ${value}`
        );
      }

      // The labels are still reachable, which is what a fill actually needs.
      for (const label of ['Patient name', 'MRN', 'Notes']) {
        const hit = candidates.find((c) => c.name === label);
        assert.ok(hit, `${label} should still be offered`);
        const result = await validator.validateDetailed(hit.selector, page);
        assert.equal(result.valid, true, `${hit.selector}: ${result.reason}`);
      }

      // And the invariant holds across the whole list, which is how this was caught.
      for (const candidate of candidates) {
        const result = await validator.validateDetailed(candidate.selector, page);
        assert.equal(result.valid, true, `${candidate.selector}: ${result.reason}`);
      }
    } finally {
      await page.close();
    }
  });
});

describe('CandidateFinder — headings that share a name', () => {
  it('separates them by level instead of dropping both', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    // Two headings named "Overview" share a role and a name, and no named ancestor
    // separates them — so both were dropped and a page's own section titles were
    // unreachable by id. The level is in the snapshot already, and `SelectorValidator`
    // has always forwarded it.
    const page = await browser.newPage();
    try {
      await page.setContent('<main><h1>Overview</h1><section><h2>Overview</h2></section></main>');

      const candidates = finder.find(await page.locator('body').ariaSnapshot());
      const headings = candidates.filter((c) => c.name === 'Overview');

      assert.equal(headings.length, 2, 'both headings should be reachable');
      for (const candidate of headings) {
        assert.match(candidate.selector, /level: \d+ \}\)$/, candidate.selector);
        const result = await validator.validateDetailed(candidate.selector, page);
        assert.equal(result.valid, true, `${candidate.selector}: ${result.reason}`);
        assert.equal(result.matches, 1);
      }
    } finally {
      await page.close();
    }
  });

  it('still drops headings that share a name AND a level', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    // Nothing separates these, so offering either would be a guess.
    const page = await browser.newPage();
    try {
      await page.setContent('<main><h2>Details</h2><section><h2>Details</h2></section></main>');
      const candidates = finder.find(await page.locator('body').ariaSnapshot());
      assert.equal(candidates.find((c) => c.name === 'Details'), undefined);
    } finally {
      await page.close();
    }
  });
});
