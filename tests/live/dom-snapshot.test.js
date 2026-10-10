/**
 * Tests for page capture — the evidence every heal is built on.
 *
 * Coverage put this module at 63% of lines and 44% of branches, and the uncovered part
 * was the whole DOM-scan fallback. That path matters more than its share of the file
 * suggests: it is what runs when `ariaSnapshot()` is unavailable or throws mid-
 * navigation, it reads `element.value`, and it is the strategy a scoped capture must
 * *not* silently widen when the preferred one fails.
 *
 * Lives in `tests/live/` because a DOM scan is `page.evaluate` — there is no honest way
 * to test it against a stub.
 *
 *   npm run test:live
 */

'use strict';

const assert = require('node:assert/strict');
const { describe, it, before, after } = require('node:test');

const { chromium } = require('@playwright/test');

const {
  getAriaSnapshot,
  getDomSnapshot,
  truncateSnapshot,
} = require('../../dist/utils/DOMSnapshot');

/** Silences the module, which is deliberately loud on the fallback paths. */
async function quiet(fn) {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

let browser;
let unavailable;

before(async () => {
  try {
    browser = await chromium.launch();
  } catch (error) {
    const message = error.message ?? String(error);
    if (!/Executable doesn't exist|playwright install|browserType\.launch/i.test(message)) throw error;
    unavailable = message.split('\n')[0];
  }
});

after(async () => {
  if (browser) await browser.close();
});

/**
 * Opens a page with the given content.
 *
 * @param {string} html - Body HTML.
 * @returns {Promise<object>} The page.
 */
async function pageWith(html) {
  const page = await browser.newPage();
  await page.setContent(html);
  return page;
}

describe('getDomSnapshot — the fallback strategy', () => {
  it('describes the attributes a selector is built from, plus the element text', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    const page = await pageWith(`
      <button id="go" data-testid="submit" name="action" type="submit">Place order</button>
      <input id="email" name="email" type="email" placeholder="you@example.com">
      <a href="/cart" aria-label="Your cart">Cart</a>`);
    try {
      const snapshot = await quiet(() => getDomSnapshot(page));

      assert.match(snapshot, /<button[^>]*id="go"/);
      assert.match(snapshot, /data-testid="submit"/);
      assert.match(snapshot, /Place order/);
      assert.match(snapshot, /placeholder="you@example.com"/);
      assert.match(snapshot, /aria-label="Your cart"/);
    } finally {
      await page.close();
    }
  });

  it('reads only an element\'s own text, so a wrapper does not repeat its children', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    // Otherwise a top-level div carries the whole page's text and every line is noise.
    const page = await pageWith(
      '<div role="group">Outer<button>Inner button</button><span>Inner span</span></div>'
    );
    try {
      const lines = (await quiet(() => getDomSnapshot(page))).split('\n');
      const wrapper = lines.find((line) => line.includes('role="group"'));

      assert.ok(wrapper, 'the wrapper should be described');
      assert.match(wrapper, /Outer/);
      assert.ok(!wrapper.includes('Inner button'), `wrapper repeated a child: ${wrapper}`);
    } finally {
      await page.close();
    }
  });

  it('honours a root, and never widens past one that does not resolve', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    // The load-bearing case. This strategy reads `element.value`, so "the whole page"
    // means every value the user has typed — a scoped capture that widened on failure
    // would disclose exactly what scoping was chosen to withhold.
    const page = await pageWith(`
      <form id="inner"><input id="a" value="kept"></form>
      <aside><input id="b" value="OUTSIDE THE ROOT"></aside>`);
    try {
      const scoped = await quiet(() => getDomSnapshot(page, { root: '#inner' }));
      assert.match(scoped, /id="a"/);
      assert.ok(!scoped.includes('OUTSIDE THE ROOT'), 'the scan escaped its root');

      const missing = await quiet(() => getDomSnapshot(page, { root: '#nope' }));
      assert.equal(missing, '', 'an unresolved root must yield nothing, not the document');
    } finally {
      await page.close();
    }
  });

  it('honours the element limit', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    const page = await pageWith(Array.from({ length: 40 }, (_, i) => `<button>B${i}</button>`).join(''));
    try {
      const lines = (await quiet(() => getDomSnapshot(page, { limit: 5 }))).split('\n').filter(Boolean);
      assert.equal(lines.length, 5);
    } finally {
      await page.close();
    }
  });

  it('returns a string rather than throwing when the page cannot be read', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    const page = await pageWith('<button>Gone</button>');
    await page.close();

    // Capture is best-effort by contract: the caller has already had an action fail and
    // must be able to report *that* error, not one from the healer.
    const snapshot = await quiet(() => getDomSnapshot(page));
    assert.equal(typeof snapshot, 'string');
  });
});

describe('getAriaSnapshot — strategy selection', () => {
  it('prefers the accessibility tree', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    const page = await pageWith('<button>Place order</button>');
    try {
      const snapshot = await quiet(() => getAriaSnapshot(page));
      assert.match(snapshot, /- button "Place order"/);
      assert.ok(!snapshot.includes('<button'), 'the DOM-scan format should not appear');
    } finally {
      await page.close();
    }
  });

  it('refuses to substitute the parent page for a frame it could not read', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    // The DOM scan runs in the main frame, so falling back to it here would describe the
    // *parent* while the question was about the frame — a confidently wrong answer, and
    // on a payment or identity frame the wrong document transmitted.
    const page = await pageWith('<h1>Parent page content</h1>');
    try {
      const snapshot = await quiet(() => getAriaSnapshot(page, { frames: ['#missing'], timeoutMs: 500 }));

      assert.equal(snapshot, '', 'an unreadable frame must yield nothing');
      assert.ok(!snapshot.includes('Parent page content'));
    } finally {
      await page.close();
    }
  });

  it('reads inside a frame when it can', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    const page = await pageWith(
      '<iframe id="pay" srcdoc="&lt;button&gt;Pay now&lt;/button&gt;"></iframe>'
    );
    try {
      await page.waitForTimeout(200);
      const snapshot = await quiet(() => getAriaSnapshot(page, { frames: ['#pay'] }));

      assert.match(snapshot, /- button "Pay now"/);
      assert.ok(!snapshot.includes('iframe'), 'the frame itself is not the answer');
    } finally {
      await page.close();
    }
  });

  it('scopes to a root, and blocks rather than widening when it is absent', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    const page = await pageWith(
      '<div id="inner"><button>Inside</button></div><aside><button>Outside</button></aside>'
    );
    try {
      const scoped = await quiet(() => getAriaSnapshot(page, { root: '#inner' }));
      assert.match(scoped, /Inside/);
      assert.ok(!scoped.includes('Outside'));

      const missing = await quiet(() =>
        getAriaSnapshot(page, { root: '#nope', timeoutMs: 500 })
      );
      assert.ok(!missing.includes('Outside'), 'an absent root must not widen the capture');
    } finally {
      await page.close();
    }
  });
});

describe('truncateSnapshot', () => {
  it('leaves a snapshot under the ceiling alone', () => {
    const snapshot = '- button "Go"';
    assert.equal(truncateSnapshot(snapshot, 1_000), snapshot);
  });

  it('marks the cut, so a reader knows the evidence is partial', () => {
    const cut = truncateSnapshot('- button "Go"\n'.repeat(500), 200);
    assert.ok(cut.length <= 200);
    assert.match(cut, /truncated/);
  });

  it('prefers a line boundary, so it does not end mid-element', () => {
    // A half-written `- button "Pl` is worse than one line fewer: it reads as an element
    // whose name is something it is not.
    const cut = truncateSnapshot('- button "Place order"\n'.repeat(50), 120);
    const body = cut.replace(/\n\.\.\. \(truncated\)$/, '');
    for (const line of body.split('\n').filter(Boolean)) {
      assert.match(line, /^- button "Place order"$/, `partial line: ${JSON.stringify(line)}`);
    }
  });

  it('still returns something when the ceiling is smaller than the marker', () => {
    assert.equal(typeof truncateSnapshot('- button "Go"'.repeat(20), 4), 'string');
  });
});
