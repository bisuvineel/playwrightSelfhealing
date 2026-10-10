/**
 * Nameless controls offered by their test id, against a real browser.
 *
 * An accessibility snapshot never carries test ids, so an icon-only button was invisible
 * to the candidate list and the model could only guess a locator for it. These tests pin
 * down exactly which elements are offered — nameless, interactive, visible, uniquely
 * test-id'd, inside the capture scope — and that the engine heals from a pick while the
 * locator never leaves the machine.
 *
 *   npm run test:live
 */

'use strict';

const assert = require('node:assert/strict');
const { describe, it, before, after } = require('node:test');

const { chromium } = require('@playwright/test');

const { findTestIdCandidates } = require('../../dist/core/TestIdCandidates');
const { HealingEngine } = require('../../dist/core/HealingEngine');
const { SelectorCache } = require('../../dist/core/SelectorCache');
const { HealBudget } = require('../../dist/core/HealBudget');
const { AiProvider } = require('../../dist/core/AiProvider');

/** Silences the engine. */
async function quiet(fn) {
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  console.log = console.warn = console.error = console.info = () => {};
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
  await browser?.close();
});

/**
 * Loads HTML and returns what the collector offers.
 *
 * @param {string} html - Page content.
 * @param {object} [options] - Collector options.
 * @returns {Promise<object[]>} The candidates.
 */
async function offered(html, options = {}) {
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    return await findTestIdCandidates(page, { firstId: 1, ...options });
  } finally {
    await page.close();
  }
}

const ICON = '<svg aria-hidden="true" width="8" height="8"></svg>';

describe('findTestIdCandidates — what is offered', () => {
  it('offers a nameless icon button by its test id, with a CSS locator', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);
    const found = await offered(`<main><button data-testid="close">${ICON}</button></main>`);
    assert.deepEqual(found, [
      { id: 1, role: 'button', name: '', context: [], testId: 'close', selector: '[data-testid="close"]' },
    ]);
  });

  it('numbers after the snapshot candidates, so their ids do not move', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);
    const found = await offered(`<button data-testid="close">${ICON}</button>`, { firstId: 6 });
    assert.equal(found[0].id, 6);
  });

  it('leaves a named element to the snapshot candidates', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);
    // Every way an element can be named: text, aria-label, title, labelledby, a label,
    // an image alt, an SVG title, a placeholder, a submit button's default label.
    const found = await offered(`
      <button data-testid="a">Save</button>
      <button data-testid="b" aria-label="Close">${ICON}</button>
      <button data-testid="c" title="Settings">${ICON}</button>
      <span id="lbl">Help</span><button data-testid="d" aria-labelledby="lbl">${ICON}</button>
      <label for="e">Email</label><input id="e" data-testid="e">
      <button data-testid="f"><img alt="Delete" src="data:,"></button>
      <button data-testid="g"><svg><title>Menu</title></svg></button>
      <input data-testid="h" placeholder="Search">
      <input type="submit" data-testid="i">
    `);
    assert.deepEqual(found, [], `offered: ${found.map((c) => c.testId).join(', ')}`);
  });

  it('offers only interactive elements', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);
    const found = await offered(`
      <div data-testid="wrapper">${ICON}</div>
      <span data-testid="icon">${ICON}</span>
      <a data-testid="no-href">${ICON}</a>
      <input type="hidden" data-testid="hidden-input">
      <div role="button" tabindex="0" data-testid="div-button">${ICON}</div>
      <a href="#/x" data-testid="icon-link">${ICON}</a>
    `);
    assert.deepEqual(
      found.map((c) => [c.role, c.testId]),
      [['button', 'div-button'], ['link', 'icon-link']]
    );
  });

  it('offers only visible elements', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);
    const found = await offered(`
      <button data-testid="none" style="display:none">${ICON}</button>
      <button data-testid="invisible" style="visibility:hidden">${ICON}</button>
      <div aria-hidden="true"><button data-testid="aria-hidden">${ICON}</button></div>
      <button data-testid="shown">${ICON}</button>
    `);
    assert.deepEqual(found.map((c) => c.testId), ['shown']);
  });

  it('never offers a test id shared by several elements', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);
    // A locator that matches three things is no locator.
    const found = await offered(`
      <button data-testid="row-action">${ICON}</button>
      <button data-testid="row-action">${ICON}</button>
      <button data-testid="row-action">${ICON}</button>
    `);
    assert.deepEqual(found, []);
  });

  it('reads the other common test-id attributes, and quotes values safely', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <button data-cy="trash">${ICON}</button>
        <button data-qa='say "hi"'>${ICON}</button>
      `);
      const found = await findTestIdCandidates(page, { firstId: 1 });
      assert.deepEqual(found.map((c) => c.testId), ['trash', 'say "hi"']);
      // Every locator written must resolve to exactly one element on the real page.
      for (const candidate of found) {
        assert.equal(await page.locator(candidate.selector).count(), 1, candidate.selector);
      }
    } finally {
      await page.close();
    }
  });

  it('reads only inside the capture scope, and nothing when the scope is not CSS', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);
    const html = `
      <form id="edit"><button data-testid="inside">${ICON}</button></form>
      <aside><button data-testid="outside">${ICON}</button></aside>
    `;
    const scoped = await offered(html, { scope: '#edit' });
    assert.deepEqual(scoped.map((c) => [c.testId, c.selector]), [['inside', '#edit [data-testid="inside"]']]);

    // A privacy scope that cannot be evaluated must not widen to the whole document.
    assert.deepEqual(await offered(html, { scope: 'text=Edit' }), []);
    assert.deepEqual(await offered(html, { scope: '#missing' }), []);
  });

  it('is capped', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);
    const many = Array.from({ length: 40 }, (_, i) => `<button data-testid="icon-${i}">${ICON}</button>`).join('');
    assert.equal((await offered(many)).length, 20);
    assert.equal((await offered(many, { limit: 3 })).length, 3);
  });

  it('never throws — a page that cannot be read yields nothing', async () => {
    const broken = { evaluate: async () => { throw new Error('Target closed'); } };
    assert.deepEqual(await findTestIdCandidates(broken, { firstId: 1 }), []);
    assert.deepEqual(await findTestIdCandidates({}, { firstId: 1 }), []);
  });
});

describe('the engine heals an icon button from a pick', () => {
  /** A provider that answers with a fixed candidate id and captures what it was sent. */
  class Picker extends AiProvider {
    constructor(pick) {
      super('k', 'm');
      this.pick = pick;
      this.requests = [];
    }
    async heal(request) {
      this.requests.push(request);
      const candidate = request.candidates.find(this.pick);
      return { candidateId: candidate.id, confidence: 0.9, reasoning: 'the icon', tokenUsage: { input: 1, output: 1 }, provider: 'picker' };
    }
    async validateConfig() {
      return true;
    }
  }

  /**
   * An engine with the real gates, a scripted provider, and nothing persisted.
   *
   * @param {AiProvider} ai - The provider.
   * @param {string} redact - Redaction level.
   * @returns {HealingEngine} The engine.
   */
  function engineWith(ai, redact) {
    return new HealingEngine(
      {
        enabled: true,
        maxRetries: 1,
        timeout: 5_000,
        provider: 'picker',
        model: 'm',
        confidenceThreshold: 0.7,
        privacy: { redact },
        intent: { mode: 'enforce', unverifiedConfidence: 0.9 },
        cache: false,
      },
      ai,
      {
        recorder: { recordHeal() {} },
        cache: new SelectorCache(false),
        budget: new HealBudget({ maxHeals: 0, breakerThreshold: 0 }),
      }
    );
  }

  const PAGE = `<div role="dialog" aria-label="Edit record">
      <button data-testid="close">${ICON}</button>
      <p>Edit the record below.</p>
      <button>Save</button>
    </div>`;

  for (const redact of ['identifiers', 'strict']) {
    it(`heals #close-x onto the test-id'd icon under ${redact}, sending no locator`, async (t) => {
      if (!browser) return t.skip(`no browser available: ${unavailable}`);
      const page = await browser.newPage();
      try {
        await page.setContent(PAGE);
        // Under strict the model cannot see the test id, so it picks by position here;
        // the point is that the pick still resolves locally to the real element.
        const ai = new Picker((c) => c.name === '');
        const outcome = await quiet(() =>
          engineWith(ai, redact).attemptHealDetailed(page, '#close-x', 'click', 'close the dialog')
        );

        assert.equal(outcome.healed, '[data-testid="close"]', outcome.error);

        const sent = ai.requests[0].candidates.find((c) => c.name === '');
        assert.equal(sent.selector, undefined, 'the locator never travels');
        if (redact === 'strict') assert.equal(sent.testId, undefined, 'strict withholds the test id');
        else assert.equal(sent.testId, 'close');
      } finally {
        await page.close();
      }
    });
  }

  it('rejects a pick of a nameless Delete icon for a test that saves', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);
    const page = await browser.newPage();
    try {
      await page.setContent(`<main><button data-testid="delete-record">${ICON}</button><h1>Record</h1></main>`);
      const ai = new Picker((c) => c.testId === 'delete-record');
      const outcome = await quiet(() =>
        engineWith(ai, 'identifiers').attemptHealDetailed(page, '#save-btn', 'click', 'save the record')
      );
      assert.equal(outcome.healed, null);
      assert.match(outcome.attempts[0].error ?? outcome.error ?? '', /opposing action \(delete\)/);
    } finally {
      await page.close();
    }
  });
});
