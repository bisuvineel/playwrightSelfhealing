/**
 * Failures that are not stale selectors — and must not be "healed" onto something else.
 *
 * An action fails for reasons that have nothing to do with the selector. Before these
 * tests, the healer answered every such failure by looking for a *different* element,
 * and a different element that works is the one outcome worse than a red test.
 * Reproduced with a real browser and the real wrapper:
 *
 * ```
 *   slow render   #save rendered during the model call   → clicked "Save as template", PASSED
 *   disabled      #submit was not enabled yet             → clicked "Submit later",     PASSED
 *   overlay       a modal covered #save                   → a provider call, then failed
 * ```
 *
 * The disabled case is the worst: a button that never becomes enabled is a real bug, and
 * healing masked it while performing a different action.
 *
 * The provider is scripted to answer with a plausible *lookalike* — which is what a real
 * model does when asked to replace an element that is, in fact, still there — and to take
 * a moment to answer, as a real one does. That delay is load-bearing for the slow-render
 * case: it is the window a slow page finishes rendering in.
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
const { applyHealing, HEAL_ANNOTATIONS } = require('../../dist/core/TestWrapper');

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
 * An engine whose provider answers, after a delay, with a fixed lookalike.
 *
 * @param {string} answer - The selector the "model" proposes.
 * @param {number} delayMs - How long it takes to answer.
 * @returns {{ engine: object, calls: () => number }}
 */
function scripted(answer, delayMs) {
  let calls = 0;
  const provider = {
    async heal() {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return {
        suggestedSelector: answer,
        confidence: 0.95,
        reasoning: 'a plausible lookalike',
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
      cache: false,
    },
    provider,
    { recorder: { recordHeal() {} }, cache: new SelectorCache(false), budget: new HealBudget({}) }
  );

  return { engine, calls: () => calls };
}

/**
 * Loads a page, decorates it, clicks the selector, and reports what really happened.
 *
 * @param {object} scenario - `html`, `selector`, `answer`, `delayMs`.
 * @returns {Promise<{ clicked: string[], error: string | null, calls: number }>}
 */
async function run({ html, selector, answer, delayMs = 300 }) {
  const page = await browser.newPage();
  try {
    const clicked = [];
    await page.exposeFunction('__clicked', (text) => clicked.push(text));
    await page.setContent(html);
    // Delegated on the document, so a button rendered later is still observed.
    await page.evaluate(() =>
      document.addEventListener(
        'click',
        (event) => {
          const button = event.target.closest('button');
          if (button) window.__clicked(button.textContent);
        },
        true
      )
    );

    const { engine, calls } = scripted(answer, delayMs);
    const decorated = await quiet(() => applyHealing(page, { annotations: [] }, engine));

    let error = null;
    try {
      await quiet(() => decorated.locator(selector).click({ timeout: 1_000 }));
    } catch (thrown) {
      error = thrown.message;
    }

    return { clicked, error, calls: calls() };
  } finally {
    await page.close();
  }
}

describe('a selector that is not stale is not healed', () => {
  it('fails on a disabled control rather than clicking a different one', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    const { clicked, error, calls } = await run({
      html: '<main><button id="submit" disabled>Submit</button><button>Submit later</button></main>',
      selector: '#submit',
      answer: "getByRole('button', { name: 'Submit later' })",
    });

    assert.deepEqual(clicked, [], 'nothing may be clicked in place of a disabled button');
    assert.ok(error, 'the test must fail — a button that never enables is a real bug');
    assert.match(error, /locator\.click: Timeout/, "Playwright's own error, naming the cause");
    assert.equal(calls, 0, 'the provider should not even be asked');
  });

  it('fails on a covered element rather than clicking a lookalike', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    const { clicked, error, calls } = await run({
      html:
        '<main><button id="save">Save</button><button>Save and close</button>' +
        '<div style="position:fixed;inset:0;background:rgba(0,0,0,.3)">Loading…</div></main>',
      selector: '#save',
      answer: "getByRole('button', { name: 'Save and close' })",
    });

    assert.deepEqual(clicked, []);
    assert.ok(error);
    assert.equal(calls, 0);
  });

  it('clicks the real element when it renders while the model is answering', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    // At the moment healing starts, #save does not exist — so it genuinely looks stale,
    // and the model is asked. It renders during the answer. Acting on the heal would
    // click the lookalike; the late recheck sees the original resolve and retries it.
    const { clicked, error, calls } = await run({
      html:
        '<main><button>Save as template</button><div id="slot"></div>' +
        "<script>setTimeout(() => { document.getElementById('slot').innerHTML = " +
        "'<button id=\"save\">Save</button>'; }, 1800);</script></main>",
      selector: '#save',
      answer: "getByRole('button', { name: 'Save as template' })",
      delayMs: 2_000,
    });

    assert.equal(error, null, `expected a pass, got: ${error}`);
    assert.deepEqual(clicked, ['Save'], 'the element the test named, not the lookalike');
    assert.equal(calls, 1);
  });

  it('still heals a selector that really is stale', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    // The control. Without it, the three above would also pass if healing were simply off.
    const { clicked, error, calls } = await run({
      html: '<main><button data-testid="save-v2">Save</button></main>',
      selector: '#save-old',
      answer: "getByTestId('save-v2')",
    });

    assert.equal(error, null);
    assert.deepEqual(clicked, ['Save']);
    assert.equal(calls, 1);
  });

  it('annotates a not-stale outcome as its own thing, not as a failed heal', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    // "heal-failed" would send someone to rewrite a selector that works. The fix for a
    // disabled button or an overlay is state or timing, never the selector.
    assert.equal(HEAL_ANNOTATIONS.notStale, 'heal-not-needed');
    assert.notEqual(HEAL_ANNOTATIONS.notStale, HEAL_ANNOTATIONS.failed);
  });
});
