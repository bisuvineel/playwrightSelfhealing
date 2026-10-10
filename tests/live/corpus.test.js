/**
 * Runs the healing corpus, so a change to healing reports a number rather than an
 * opinion.
 *
 * Before this existed there was no way to tell whether a prompt edit helped: you
 * changed the wording, ran the demo, and formed a view. The corpus in
 * `tests/corpus/cases.json` is a set of real stale-selector failures — the first
 * transcribed from a healing record — and this file measures two things against it
 * with no model and no credential:
 *
 * 1. **Reachability.** Is the intended element in the candidate list, addressed by a
 *    locator that resolves to exactly one element on the live page? This is the
 *    precondition for every heal. When it fails no model can succeed, however well it
 *    reasons — which is exactly what happened on the record that prompted the work:
 *    the element was there, the model found it, and the only expression offered for it
 *    resolved to nothing.
 *
 * 2. **Engine correctness under replay.** Given an answer, does the engine heal to the
 *    intended element? Run three ways per case: a clean pick, a pick whose id is
 *    nonsense, and a broken first choice with a correct alternative — the last being
 *    the shape that used to cost a second round-trip.
 *
 * What this deliberately does *not* measure is whether a model picks the right id.
 * That needs a real call, and pretending otherwise would manufacture a number.
 * `HEALER_CORPUS_LIVE=1` with a configured provider does measure it; see the last
 * block.
 *
 *   npm run test:live
 *
 * Lives in `tests/live/` rather than `tests/unit/` because it drives a real browser.
 * `node --test` runs files in parallel, and the recorder's concurrency tests budget
 * their lock acquisition in wall-clock time — three Chromium launches alongside them
 * was enough to make those fail intermittently. `npm run test:live` runs this directory
 * with `--test-concurrency=1`, after the unit suite.
 *
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it, before, after } = require('node:test');

const { chromium } = require('@playwright/test');

const { CandidateFinder, } = require('../../dist/core/CandidateFinder');
const { findTestIdCandidates } = require('../../dist/core/TestIdCandidates');
const { HealingEngine, missingLiterals } = require('../../dist/core/HealingEngine');
const { truncateSnapshot } = require('../../dist/utils/DOMSnapshot');
const { SelectorValidator } = require('../../dist/core/SelectorValidator');
const { SelectorCache } = require('../../dist/core/SelectorCache');
const { HealBudget } = require('../../dist/core/HealBudget');

const CORPUS = path.join(__dirname, '..', 'corpus', 'cases.json');
const { cases } = JSON.parse(fs.readFileSync(CORPUS, 'utf8'));

const finder = new CandidateFinder();
const validator = new SelectorValidator();

/** Silences the engine, which is deliberately loud on rejection paths. */
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
 * Builds a real engine whose provider replays a fixed answer.
 *
 * @param {object} answer - The parsed response a provider would have returned.
 * @returns {object} The engine and the provider, whose `calls` counts round-trips.
 */
function engineReplaying(answer) {
  const ai = {
    calls: 0,
    async heal() {
      this.calls += 1;
      return { tokenUsage: { input: 100, output: 20 }, provider: 'replay', ...answer };
    },
  };

  const engine = new HealingEngine(
    {
      enabled: true,
      maxRetries: 2,
      timeout: 5_000,
      provider: 'replay',
      model: 'replay',
      confidenceThreshold: 0.7,
      privacy: { redact: 'identifiers' },
      // Off: this file measures the candidate and choice machinery. Intent checking has
      // its own tests, and leaving it on would make a rejection here ambiguous.
      intent: { mode: 'off', unverifiedConfidence: 0.9 },
      cache: false,
    },
    ai,
    {
      recorder: { recordHeal() {} },
      cache: new SelectorCache(false),
      budget: new HealBudget({ maxHeals: 0, breakerThreshold: 0 }),
    }
  );

  return { engine, ai };
}

/**
 * Loads a case's page and returns what the healer would see.
 *
 * @param {object} testCase - One corpus entry.
 * @returns {Promise<object>} The page, snapshot, candidates and missing literals.
 */
async function load(testCase) {
  const page = await browser.newPage();
  await page.setContent(testCase.html);

  const snapshot = await page.locator('body').ariaSnapshot();
  const named = finder.find(snapshot, {
    action: testCase.action,
    intent: `${testCase.originalSelector} ${testCase.description ?? ''}`,
  });
  // As the engine does: nameless controls by test id, numbered after the snapshot's.
  const candidates = [...named, ...(await findTestIdCandidates(page, { firstId: named.length + 1 }))];

  return {
    page,
    snapshot,
    candidates,
    missing: missingLiterals(testCase.originalSelector, snapshot),
    // The candidate for the element the case says was intended, if it is offered.
    // Role and name alone are not always enough to identify it: a page with two links
    // named "Settings" yields two candidates, each correctly scoped to its own
    // landmark, and only the expected selector says which one the test meant. Cases
    // with a duplicate name therefore declare `expect.selector`.
    intended: testCase.expect.selector
      ? candidates.find((c) => c.selector === testCase.expect.selector)
      : candidates.find((c) => c.role === testCase.expect.role && c.name === testCase.expect.name),
  };
}

describe('corpus — is the intended element reachable at all', () => {
  const score = { reachable: 0, total: 0 };

  for (const testCase of cases) {
    it(testCase.name, async (t) => {
      if (!browser) return t.skip(`no browser available: ${unavailable}`);

      const { page, snapshot, candidates, missing, intended } = await load(testCase);
      try {
        // Every case must actually be broken. Two once were not — `//li/span[...]` on a page
        // with `<li><span>`, and `//tr[td='Gadget']//button` on the table — so they measured
        // the healer rewriting selectors that worked, and "passed". The engine now declines
        // to heal a selector that still resolves, which is how they were caught.
        const original = await validator.validateDetailed(testCase.originalSelector, page);
        assert.equal(
          original.valid,
          false,
          `corpus case "${testCase.name}" is mis-specified: its original selector ` +
            `${testCase.originalSelector} still resolves on its own page, so it is not stale`
        );

        if (testCase.expect.refuse) {
          // Nothing is the right answer, so there is nothing to reach. What is checked
          // is that the page really does offer the model a choice — a refusal case
          // with no candidates would pass for the wrong reason.
          assert.ok(candidates.length > 0, 'a refusal case must offer candidates to refuse');
          return;
        }

        if (testCase.expect.free) {
          // No candidate can name this element, which is the case's whole point: the
          // free-form path has to stay open or such elements become unhealable.
          assert.equal(
            intended,
            undefined,
            'a nameless element must not be offered as a candidate'
          );
          const result = await validator.validateDetailed(testCase.expect.selector, page);
          assert.equal(result.valid, true, `the fallback locator should work: ${result.reason}`);
          score.total += 1;
          score.reachable += 1;
          return;
        }

        score.total += 1;

        assert.ok(
          intended,
          `${testCase.expect.role} "${testCase.expect.name}" was not offered.\n` +
            `offered: ${candidates.map((c) => `${c.role} "${c.name}"`).join(', ') || '(none)'}\n` +
            `snapshot:\n${snapshot}`
        );

        // Offered is not enough — the locator has to work. This is the assertion the
        // record that prompted the corpus would have failed.
        const result = await validator.validateDetailed(intended.selector, page);
        assert.equal(
          result.valid,
          true,
          `${intended.selector} did not resolve uniquely: ${result.reason} (matches=${result.matches})`
        );

        if (testCase.expect.selector) {
          assert.equal(intended.selector, testCase.expect.selector);
        }

        score.reachable += 1;
      } finally {
        await page.close();
      }

      if (testCase.expectMissingText) {
        assert.deepEqual(missing, testCase.expectMissingText);
      }
    });
  }

  after(() => {
    if (score.total > 0) {
      // Printed so a change to candidate generation shows its effect as a number.
      console.log(`\n  corpus reachability: ${score.reachable}/${score.total}`);
    }
  });
});

describe('corpus — the engine heals from an answer', () => {
  for (const testCase of cases.filter((c) => !c.expect.free && !c.expect.refuse)) {
    it(`${testCase.name} — from a clean pick`, async (t) => {
      if (!browser) return t.skip(`no browser available: ${unavailable}`);

      const { page, intended } = await load(testCase);
      try {
        const { engine, ai } = engineReplaying({
          candidateId: intended.id,
          confidence: 0.95,
          reasoning: 'replayed',
        });

        const outcome = await quiet(() =>
          engine.attemptHealDetailed(page, testCase.originalSelector, testCase.action)
        );

        assert.equal(outcome.healed, intended.selector);
        assert.equal(ai.calls, 1, 'a correct pick should cost exactly one call');
      } finally {
        await page.close();
      }
    });
  }

  it('recovers from a broken first choice without a second call', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    // The exact shape of the reported failure: the model reasons its way to the right
    // element and writes an expression that resolves to nothing. Before alternatives,
    // that cost a whole round-trip to correct — and on a two-attempt budget, often the
    // heal itself.
    const testCase = cases[0];
    const { page, intended } = await load(testCase);
    try {
      const { engine, ai } = engineReplaying({
        suggestedSelector: "getByRole('listitem', { name: 'Private Cloud' })",
        confidence: 0.9,
        reasoning: 'the renamed menu item',
        alternatives: [{ candidateId: intended.id, confidence: 0.85, reasoning: 'same item, as a link' }],
      });

      const outcome = await quiet(() =>
        engine.attemptHealDetailed(page, testCase.originalSelector, testCase.action)
      );

      assert.equal(outcome.healed, intended.selector);
      assert.equal(ai.calls, 1, 'the alternative should be tried locally, not bought');
      // Both options are recorded, so the audit log shows the first choice was wrong.
      assert.equal(outcome.attempts.length, 2);
      assert.equal(outcome.attempts[0].success, false);
      assert.equal(outcome.attempts[1].success, true);
    } finally {
      await page.close();
    }
  });

  it('charges one call and one heal however many options it tries', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    const { page, intended } = await load(cases[0]);
    try {
      const { engine, ai } = engineReplaying({
        suggestedSelector: "getByRole('listitem', { name: 'Nope' })",
        confidence: 0.9,
        reasoning: 'wrong',
        alternatives: [
          { suggestedSelector: "getByRole('button', { name: 'Also nope' })", confidence: 0.8, reasoning: 'wrong' },
          { candidateId: intended.id, confidence: 0.8, reasoning: 'right' },
        ],
      });

      const outcome = await quiet(() =>
        engine.attemptHealDetailed(page, cases[0].originalSelector, cases[0].action)
      );

      assert.equal(outcome.healed, intended.selector);
      assert.equal(ai.calls, 1);
      // Tokens are billed per call, so trying three options must not report three bills.
      assert.equal(outcome.tokens.input, 100);
      assert.equal(outcome.tokens.output, 20);
    } finally {
      await page.close();
    }
  });

  it('rejects an id that was never on the list, rather than indexing blindly', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    // Clamping would heal onto whichever element happened to be last, which nobody
    // chose — worse than not healing, because the test would go green on it.
    const { page } = await load(cases[0]);
    try {
      const { engine } = engineReplaying({ candidateId: 999, confidence: 0.99, reasoning: 'out of range' });

      const outcome = await quiet(() =>
        engine.attemptHealDetailed(page, cases[0].originalSelector, cases[0].action)
      );

      assert.equal(outcome.healed, null);
      assert.match(outcome.error, /candidate id/);
    } finally {
      await page.close();
    }
  });
});

describe('corpus — against a real model', () => {
  // Opt-in: costs money and needs a credential, so it is never part of a normal run.
  // This is the only block here that measures whether a model picks the right element;
  // everything above measures whether the framework lets it.
  const live = process.env.HEALER_CORPUS_LIVE === '1';

  it('picks the intended element', async (t) => {
    if (!live) {
      return t.skip('set HEALER_CORPUS_LIVE=1 with a configured provider to measure model accuracy');
    }
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    // Through the same path the fixtures use. This block previously imported a
    // `createProvider` that the package never exported and handed `HealingEngine` the raw
    // environment shape rather than a `HealConfig` — so the one measurement the offline
    // suite cannot make would have crashed on first use. It was always skipped, so nothing
    // noticed. Loaded lazily, because building an engine throws without a credential and
    // that must not break the skip path above.
    const { createHealingEngine } = require('../../dist/index');
    const { SelectorValidator } = require('../../dist/core/SelectorValidator');
    const resolver = new SelectorValidator();

    const rows = [];

    for (const testCase of cases) {
      const page = await browser.newPage();
      try {
        await page.setContent(testCase.html);

        // Fresh per case, cache off: one case's heal must not answer the next.
        const engine = await quiet(() => createHealingEngine({ records: false, cache: false }));
        assert.ok(engine, 'a configured provider is required for HEALER_CORPUS_LIVE=1');

        const started = Date.now();
        const outcome = await quiet(() =>
          engine.attemptHealDetailed(page, testCase.originalSelector, testCase.action, testCase.description)
        );
        const ms = Date.now() - started;

        // Judged by *element*, not by string. `getByRole('link', { name: 'X' })` and the
        // candidate's `{ name: 'X', exact: true }` are the same element; a string compare
        // would score the model wrong for a correct answer.
        const refuse = testCase.expect.refuse === true;
        const expected = refuse
          ? null
          : testCase.expect.selector ??
            `getByRole('${testCase.expect.role}', { name: '${testCase.expect.name}', exact: true })`;

        // An expectation that matches more than one element cannot score anything, and it
        // used to fail *silently* — the table case matched two "Edit" buttons, so a
        // correct answer was reported as WRONG ELEMENT. Refuse to measure instead.
        if (expected !== null) {
          const wanted = await resolver.validateDetailed(expected, page);
          assert.equal(
            wanted.valid,
            true,
            `corpus case "${testCase.name}" is mis-specified: its expectation ${expected} ` +
              `${wanted.reason}. Give it an expect.selector that names exactly one element.`
          );
        }

        // For an ambiguous case the only correct outcome is no heal; any heal is a guess.
        let correct = refuse ? outcome.healed === null : false;
        if (!refuse && outcome.healed) {
          const got = resolver.resolve(outcome.healed, page);
          const want = resolver.resolve(expected, page);
          if (got && want) {
            const [a, b] = [await got.elementHandle({ timeout: 1_000 }).catch(() => null), await want.elementHandle({ timeout: 1_000 }).catch(() => null)];
            correct = a !== null && b !== null && (await a.evaluate((x, y) => x === y, b));
          }
        }

        const last = outcome.attempts[outcome.attempts.length - 1];
        rows.push({
          name: testCase.name,
          healed: outcome.healed,
          correct,
          via: last?.candidateId !== undefined ? `candidate ${last.candidateId}` : outcome.healed ? 'written' : '—',
          records: outcome.attempts.length,
          tokens: outcome.tokens.input + outcome.tokens.output,
          ms,
          reason: outcome.error,
          why: last?.reasoning,
        });
      } finally {
        await page.close();
      }
    }

    const right = rows.filter((r) => r.correct).length;
    const wrong = rows.filter((r) => r.healed && !r.correct).length;
    // A correct refusal is "not healed" and also right, so it is not a miss.
    const none = rows.filter((r) => !r.healed && !r.correct).length;
    const tokens = rows.reduce((sum, r) => sum + r.tokens, 0);

    console.log(
      `\n  corpus model accuracy: ${right}/${rows.length} correct, ${wrong} WRONG ELEMENT, ` +
        `${none} not healed  (ok* = correctly refused an ambiguous case)`
    );
    console.log(`  total tokens: ${tokens}`);
    for (const r of rows) {
      const verdict = r.correct ? (r.healed ? 'ok   ' : 'ok*  ') : r.healed ? 'WRONG' : 'none ';
      console.log(`    ${verdict} ${String(r.ms).padStart(6)}ms  ${String(r.tokens).padStart(6)}tok  ${r.via.padEnd(12)} ${r.name}`);
      if (!r.correct) console.log(`           -> ${r.healed ?? r.reason}`);
      // The reason alone ("confidence 0.1 is below the threshold") says what was
      // rejected, not why the model answered that way — which is what a prompt fix needs.
      if (!r.correct && r.why && !String(r.reason ?? '').includes(r.why)) console.log(`              model: ${r.why}`);
    }

    // A wrong element is the failure this whole package exists to prevent — a heal onto
    // the wrong control goes green while testing the wrong path. It is asserted
    // separately from accuracy, and strictly.
    assert.equal(wrong, 0, 'the model healed onto the WRONG element at least once');
    assert.ok(right > 0, 'the model healed nothing correctly');
  });
});

describe('corpus — the two regressions the audit found', () => {
  it('still applies the unverified-confidence floor to a pick', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    // Substituting the candidate's role and name for the model's claim looked like an
    // upgrade and disabled a safety check: `checkSelfConsistency` records a check
    // whenever an expected role or name is present, and `checkConfidenceFloor` only
    // applies when *no* check had signal. So an opaque selector with no describe() —
    // the class the floor exists for — healed at 0.75 against a floor of 0.9, and
    // healed onto "Abort".
    const page = await browser.newPage();
    try {
      // "Skip for now" rather than the original "Abort": an opposing action is now
      // rejected earlier, by name, which would stop this test reaching the floor it
      // exists to check. The wrong-but-harmless-sounding pick is the floor's job.
      await page.setContent('<main><button>Proceed</button><button>Skip for now</button></main>');
      const candidates = finder.find(await page.locator('body').ariaSnapshot(), { action: 'click' });
      const abort = candidates.find((c) => c.name === 'Skip for now');

      const ai = {
        async heal() {
          return {
            tokenUsage: { input: 10, output: 2 },
            provider: 'replay',
            candidateId: abort.id,
            confidence: 0.75,
            reasoning: 'a guess',
          };
        },
      };

      const engine = new HealingEngine(
        {
          enabled: true,
          maxRetries: 1,
          timeout: 5_000,
          provider: 'replay',
          model: 'replay',
          confidenceThreshold: 0.7,
          privacy: { redact: 'identifiers' },
          intent: { mode: 'enforce', unverifiedConfidence: 0.9 },
          cache: false,
        },
        ai,
        { recorder: { recordHeal() {} }, cache: new SelectorCache(false), budget: new HealBudget({}) }
      );

      const outcome = await quiet(() => engine.attemptHealDetailed(page, '#btn-x7f3', 'click'));

      assert.equal(outcome.healed, null, 'an unverifiable pick below the floor must be refused');
      assert.match(outcome.error, /must be at least 0\.9/);
      assert.deepEqual(
        outcome.attempts[0].intent.checks,
        ['confidence-floor'],
        'a pick makes no role or name claim, so no self-consistency check has evidence'
      );
    } finally {
      await page.close();
    }
  });

  it('roots candidates at the snapshot root, so uniqueness is judged in one universe', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    // Uniqueness is counted in the snapshot. Scoped to a container, an unrooted
    // expression resolves against the whole document — so every candidate drawn from
    // the form matched the sidebar's copy too and was rejected, turning healing off for
    // anyone using `snapshotRoot`.
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <div id="form-area"><button>Save</button><label for="e">Email</label><input id="e"></div>
        <aside><button>Save</button><label for="e2">Email</label><input id="e2"></aside>`);

      const scoped = await page.locator('#form-area').ariaSnapshot();

      const unrooted = finder.find(scoped);
      const rooted = finder.find(scoped, { scope: '#form-area' });

      assert.ok(unrooted.length > 0 && rooted.length === unrooted.length);

      for (const candidate of unrooted) {
        const result = await validator.validateDetailed(candidate.selector, page);
        assert.equal(result.valid, false, `${candidate.selector} should be ambiguous page-wide`);
        assert.equal(result.matches, 2);
      }

      for (const candidate of rooted) {
        assert.match(candidate.selector, /^locator\('#form-area'\)\./);
        const result = await validator.validateDetailed(candidate.selector, page);
        assert.equal(result.valid, true, `${candidate.selector}: ${result.reason}`);
        assert.equal(result.matches, 1);
      }
    } finally {
      await page.close();
    }
  });
});

describe('corpus — resource bounds on a real data grid', () => {
  /**
   * A table of `rows` rows, which is what makes an enterprise page expensive.
   *
   * @param {number} rows - How many rows to render.
   * @returns {string} The HTML.
   */
  const grid = (rows) =>
    '<table>' +
    Array.from({ length: rows }, (_, i) => `<tr><td>Item ${i}</td><td><button>Edit ${i}</button></td></tr>`).join('') +
    '</table>';

  it('bounds the snapshot it sends, and still heals', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    // Unbounded, a 2,000-row grid sent ~55,000 input tokens per attempt — silent cost on
    // every heal, and a context-limit error on a larger grid, which counts against the
    // circuit breaker.
    const page = await browser.newPage();
    try {
      await page.setContent(grid(2000));

      const sent = {};
      /**
       * A provider that records how much snapshot it was handed.
       *
       * @param {string} key - Which run this is.
       * @returns {object} The stub.
       */
      const spy = (key) => ({
        async heal(request) {
          sent[key] = request.ariaSnapshot.length;
          return {
            tokenUsage: { input: 1, output: 1 },
            provider: 'replay',
            candidateId: 1,
            confidence: 0.95,
            reasoning: 'r',
          };
        },
      });

      for (const [key, ceiling] of [['unbounded', 0], ['bounded', 40_000]]) {
        const engine = new HealingEngine(
          {
            enabled: true,
            maxRetries: 1,
            timeout: 30_000,
            provider: 'replay',
            model: 'replay',
            confidenceThreshold: 0.7,
            privacy: { redact: 'identifiers' },
            intent: { mode: 'off', unverifiedConfidence: 0.9 },
            cache: false,
            maxSnapshotChars: ceiling,
          },
          spy(key),
          { recorder: { recordHeal() {} }, cache: new SelectorCache(false), budget: new HealBudget({}) }
        );

        const outcome = await quiet(() => engine.attemptHealDetailed(page, '#edit-btn', 'click'));
        assert.ok(outcome.healed, `${key}: should still heal`);
      }

      assert.ok(sent.unbounded > 200_000, `expected a large snapshot, got ${sent.unbounded}`);
      assert.ok(sent.bounded <= 40_000, `expected a bounded snapshot, got ${sent.bounded}`);
    } finally {
      await page.close();
    }
  });

  it('finds candidates before the cut, not after — which is what makes cutting safe', async (t) => {
    if (!browser) return t.skip(`no browser available: ${unavailable}`);

    // `getAriaSnapshot` refuses to shorten on its own, because a snapshot cut before the
    // target produces a confidently wrong selector. Enumerating first removes that
    // objection: the element stays pickable by id even though the model never sees its
    // line. Reverse the order and the target is simply gone — which this asserts, so the
    // ordering cannot be "tidied" later.
    const page = await browser.newPage();
    try {
      await page.setContent(grid(2000));

      const full = await page.locator('body').ariaSnapshot();
      const cut = truncateSnapshot(full, 40_000);
      const intent = '#edit-btn-1999 Edit 1999 button';

      assert.ok(!cut.includes('Edit 1999'), 'the fixture must put the target past the cut');

      const fromFull = finder.find(full, { action: 'click', intent });
      const fromCut = finder.find(cut, { action: 'click', intent });

      const target = fromFull.find((c) => c.name === 'Edit 1999');
      assert.ok(target, 'enumerating before the cut must still reach the target');

      const result = await validator.validateDetailed(target.selector, page);
      assert.equal(result.valid, true, result.reason);

      assert.equal(
        fromCut.find((c) => c.name === 'Edit 1999'),
        undefined,
        'enumerating after the cut loses it — the ordering is load-bearing'
      );
    } finally {
      await page.close();
    }
  });
});
