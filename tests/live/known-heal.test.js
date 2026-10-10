/**
 * A stale selector used more than once, against a real browser.
 *
 * The cache used to save the provider call and nothing else. Every later use of a stale
 * locator still ran its action to the full action timeout before the heal path began, so
 * a page-object locator used thirty times in a run cost thirty timeouts. Measured here
 * with the real wrapper and engine: the first use pays the timeout and one provider call;
 * every later use reuses the heal after a quarter-second probe of the original.
 *
 *   npm run test:live
 */

'use strict';

const assert = require('node:assert/strict');
const { describe, it, before, after } = require('node:test');

const { chromium } = require('@playwright/test');

const { HealingEngine } = require('../../dist/core/HealingEngine');
const { SelectorCache } = require('../../dist/core/SelectorCache');
const { HealBudget } = require('../../dist/core/HealBudget');
const { applyHealing } = require('../../dist/core/TestWrapper');

/** Silences the engine and the wrapper. */
async function quiet(fn) {
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  console.log = console.warn = console.error = console.info = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

/** The action timeout every click runs with, standing in for `use.actionTimeout`. */
const ACTION_TIMEOUT_MS = 2_000;

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
 * An engine whose provider answers at once with the button by its name, with a live cache.
 *
 * @returns {{ engine: object, calls: () => number }}
 */
function engineWithCache() {
  let calls = 0;
  const provider = {
    async heal() {
      calls += 1;
      return {
        suggestedSelector: "getByRole('button', { name: 'Place order' })",
        confidence: 0.95,
        reasoning: 'the button lost its id; its name is unchanged',
        tokenUsage: { input: 100, output: 20 },
        provider: 'script',
      };
    },
    async validateConfig() {
      return true;
    },
  };

  const engine = new HealingEngine(
    {
      enabled: true,
      maxRetries: 1,
      timeout: 10_000,
      provider: 'script',
      model: 'script',
      confidenceThreshold: 0.7,
      privacy: { redact: 'identifiers' },
      intent: { mode: 'enforce', unverifiedConfidence: 0.9 },
    },
    provider,
    { recorder: { recordHeal() {} }, cache: new SelectorCache(true, null), budget: new HealBudget({}) }
  );

  return { engine, calls: () => calls };
}

describe('a stale selector used repeatedly', () => {
  it('pays the action timeout once, not on every use', async (t) => {
    if (unavailable) return t.skip(unavailable);

    const page = await browser.newPage();
    try {
      let clicks = 0;
      await page.exposeFunction('__clicked', () => {
        clicks += 1;
      });
      await page.setContent(
        '<main><button onclick="window.__clicked()">Place order</button><button>Cancel</button></main>'
      );
      page.setDefaultTimeout(ACTION_TIMEOUT_MS);

      const { engine, calls } = engineWithCache();
      const decorated = await quiet(() => applyHealing(page, { annotations: [] }, engine));
      const placeOrder = decorated.locator('#place-order-btn').describe('the button that places the order');

      const timings = [];
      for (let use = 0; use < 3; use++) {
        const started = Date.now();
        await quiet(() => placeOrder.click());
        timings.push(Date.now() - started);
      }

      assert.equal(clicks, 3, 'every use clicked the healed button');
      assert.equal(calls(), 1, 'one provider call for the run, as before');
      assert.ok(
        timings[0] >= ACTION_TIMEOUT_MS,
        `the first use should wait out the ${ACTION_TIMEOUT_MS}ms timeout (took ${timings[0]}ms)`
      );
      for (const [index, took] of timings.slice(1).entries()) {
        assert.ok(
          took < ACTION_TIMEOUT_MS / 2,
          `use ${index + 2} took ${took}ms — it waited on the stale original instead of reusing the heal`
        );
      }
      t.diagnostic(`click timings: ${timings.join('ms, ')}ms`);
    } finally {
      await page.close();
    }
  });

  it('still acts on the original when it comes back', async (t) => {
    // A known heal must not outlive the stale selector: once the original resolves again,
    // it is what gets clicked.
    if (unavailable) return t.skip(unavailable);

    const page = await browser.newPage();
    try {
      const clicked = [];
      await page.exposeFunction('__clicked', (text) => clicked.push(text));
      await page.setContent(
        '<main><button onclick="window.__clicked(this.textContent)">Place order</button></main>'
      );
      page.setDefaultTimeout(ACTION_TIMEOUT_MS);

      const { engine } = engineWithCache();
      const decorated = await quiet(() => applyHealing(page, { annotations: [] }, engine));
      await quiet(() => decorated.locator('#place-order-btn').click());

      await page.setContent(
        '<main><button id="place-order-btn" onclick="window.__clicked(this.textContent)">Submit order</button>' +
          '<button onclick="window.__clicked(this.textContent)">Place order</button></main>'
      );
      await quiet(() => decorated.locator('#place-order-btn').click());

      assert.deepEqual(clicked, ['Place order', 'Submit order']);
    } finally {
      await page.close();
    }
  });
});
