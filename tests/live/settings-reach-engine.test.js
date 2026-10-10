/**
 * Proves each behavioural setting reaches the engine on the REAL integration path.
 *
 * The regression this exists for: `HEALER_MAX_SNAPSHOT_CHARS` and `HEALER_CANDIDATES`
 * were parsed, validated, printed in the startup log — and never passed to the engine.
 * Both fields are optional on `HealConfig` so that hand-built configs keep their old
 * behaviour, which means the compiler could not insist on them at the two places that
 * build one from the environment. Every test that "proved" them constructed a
 * `HealingEngine` by hand, so every test passed while the fixtures ignored both.
 *
 * Measured before the fix, through the path below: a 1,000-character ceiling sent a
 * 31,872-character snapshot, and `HEALER_CANDIDATES=false` still sent the list.
 *
 * So these go through `createHealingEngine()` — what the fixtures use — and observe the
 * outbound payload with preview mode, which writes exactly what would be sent and
 * contacts no provider. Real path, real browser, zero cost, no key required.
 *
 * The pattern generalises: when a setting is added, add a case here that observes its
 * *effect*, not its parsed value. A parsed value proves config.ts; only an effect proves
 * the wiring.
 *
 *   npm run test:live
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');

const { chromium } = require('@playwright/test');

/** Silences the engine and the config banner. */
async function quiet(fn) {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

/** Settings this file sets, restored after every test. */
const OWNED = [
  'HEALER_PRIVACY_PREVIEW',
  'HEALER_MAX_SNAPSHOT_CHARS',
  'HEALER_CANDIDATES',
  'HEALER_RECORDS',
  'HEALER_SKIP_DOTENV',
  'HEALER_PROVIDER',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
];

let browser;
let unavailable;
let saved;
let preview;

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

beforeEach(() => {
  saved = {};
  for (const name of OWNED) saved[name] = process.env[name];

  preview = fs.mkdtempSync(path.join(os.tmpdir(), 'shp-reach-'));
  // A developer's own .env must not decide these assertions, and preview mode needs no
  // real credential — only a provider it will never call.
  process.env.HEALER_SKIP_DOTENV = '1';
  process.env.HEALER_PROVIDER = 'anthropic';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-preview-only';
  process.env.ANTHROPIC_MODEL = 'claude-haiku-4-5';
  process.env.HEALER_PRIVACY_PREVIEW = preview;
  process.env.HEALER_RECORDS = 'false';
});

afterEach(() => {
  for (const name of OWNED) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  fs.rmSync(preview, { recursive: true, force: true });
});

/**
 * Heals once through the real integration path and returns what would have been sent.
 *
 * @param {string} html - Page content.
 * @returns {Promise<{ snapshotChars: number, candidateList: boolean, body: string }>}
 */
async function outboundFor(html) {
  // Required fresh: `createHealingEngine` reads the environment at call time, and the
  // settings under test are changed between cases.
  const { createHealingEngine } = require('../../dist/index');

  const page = await browser.newPage();
  try {
    await page.setContent(html);
    const engine = await quiet(() => createHealingEngine());
    assert.ok(engine, 'createHealingEngine should build an engine in preview mode');

    await quiet(() => engine.attemptHealDetailed(page, '#edit-btn', 'click'));

    const files = fs.readdirSync(preview);
    assert.ok(files.length > 0, 'preview mode should have written the payload');
    const body = fs.readFileSync(path.join(preview, files[0]), 'utf8');

    const fenced = SNAPSHOT_BLOCK.exec(body);

    return {
      snapshotChars: fenced ? fenced[2].length : -1,
      candidateList: body.includes('Candidate elements on this page'),
      body,
    };
  } finally {
    await page.close();
  }
}

/**
 * The fenced snapshot block in a payload, found by its fence rather than by the heading
 * above it. Matching the heading coupled these tests to prompt wording: renaming it from
 * "Current page structure" made every snapshot measurement read -1, and three tests
 * reported a wiring failure that was really a changed sentence.
 */
const SNAPSHOT_BLOCK = /\n(```|--- SNAPSHOT ---)\n([\s\S]*?)\n\1(?:\n|$)/;

/** A table large enough that any ceiling below ~30,000 characters must cut it. */
const GRID =
  '<table>' +
  Array.from({ length: 300 }, (_, i) => `<tr><td>Item ${i}</td><td><button>Edit ${i}</button></td></tr>`).join('') +
  '</table>';

describe('HEALER_MAX_SNAPSHOT_CHARS reaches the engine', () => {
  it('cuts the snapshot to the configured ceiling', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    process.env.HEALER_MAX_SNAPSHOT_CHARS = '1000';
    const { snapshotChars } = await outboundFor(GRID);

    assert.ok(snapshotChars > 0, 'the snapshot block should be found in the payload');
    assert.ok(
      snapshotChars <= 1000,
      `a 1,000-character ceiling sent ${snapshotChars} characters — the setting did not reach the engine`
    );
  });

  it('sends the whole snapshot when set to 0', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    process.env.HEALER_MAX_SNAPSHOT_CHARS = '0';
    const { snapshotChars } = await outboundFor(GRID);
    assert.ok(snapshotChars > 20_000, `0 means unlimited, but only ${snapshotChars} characters were sent`);
  });

  it('applies the documented default when unset', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    delete process.env.HEALER_MAX_SNAPSHOT_CHARS;
    // Large enough to exceed the 40,000 default.
    const huge =
      '<table>' +
      Array.from({ length: 800 }, (_, i) => `<tr><td>Item ${i}</td><td><button>Edit ${i}</button></td></tr>`).join('') +
      '</table>';

    const { snapshotChars } = await outboundFor(huge);
    // Bounded on both sides. An upper bound alone passed while the harness could not find
    // the snapshot at all — -1 is below every ceiling — so it measured nothing.
    assert.ok(snapshotChars > 30_000, `expected a cut near the ceiling, measured ${snapshotChars}`);
    assert.ok(snapshotChars <= 40_000, `the default ceiling was not applied: ${snapshotChars}`);
  });
});

describe('HEALER_CANDIDATES reaches the engine', () => {
  it('sends the candidate list by default', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    delete process.env.HEALER_CANDIDATES;
    const { candidateList } = await outboundFor('<button>Place order</button>');
    assert.equal(candidateList, true);
  });

  it('omits it when switched off — the kill switch actually kills', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    process.env.HEALER_CANDIDATES = 'false';
    const { candidateList, body } = await outboundFor('<button>Place order</button>');

    assert.equal(candidateList, false, 'HEALER_CANDIDATES=false still sent the list');
    assert.ok(body.includes('"suggestedSelector"'), 'the free-form contract should be asked for instead');
  });
});

describe('createHealingEngine options override the environment', () => {
  it('honours candidates and maxSnapshotChars passed in code', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    // Environment says one thing; code says another; code wins, as for every option.
    process.env.HEALER_CANDIDATES = 'true';
    process.env.HEALER_MAX_SNAPSHOT_CHARS = '0';

    const { createHealingEngine } = require('../../dist/index');
    const page = await browser.newPage();
    try {
      await page.setContent(GRID);
      const engine = await quiet(() => createHealingEngine({ candidates: false, maxSnapshotChars: 1500 }));
      await quiet(() => engine.attemptHealDetailed(page, '#edit-btn', 'click'));

      const body = fs.readFileSync(path.join(preview, fs.readdirSync(preview)[0]), 'utf8');
      const fenced = SNAPSHOT_BLOCK.exec(body);

      assert.ok(!body.includes('Candidate elements on this page'), 'the candidates option was ignored');
      assert.ok(fenced && fenced[2].length <= 1500, 'the maxSnapshotChars option was ignored');
    } finally {
      await page.close();
    }
  });
});
