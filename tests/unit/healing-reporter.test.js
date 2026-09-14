/**
 * Unit tests for the run summary.
 *
 * The reporter is the only place a whole run is visible — under parallel workers no single
 * test process sees every heal.
 *
 * It reads two channels, and the split is the point of these tests. **Annotation types**
 * are stable constants and carry the counts. **`healing-*.json` attachments** are JSON and
 * carry anything that gets arithmetic done to it. An earlier version regexed token counts
 * out of the annotation prose, so rewording a sentence elsewhere silently zeroed the
 * totals — `survives a reworded annotation` is the test that used to pin that weakness and
 * now proves it is gone.
 *
 *   npm run test:unit
 */

'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const Reporter = require('../../dist/reporters/HealingReporter');
const { HEAL_ANNOTATIONS } = require('../../dist/core/TestWrapper');

/** The module exports the class as a default, for the reporter tuple. */
const HealingReporter = Reporter.default ?? Reporter;

/**
 * Runs a reporter over a set of tests and captures what it printed.
 *
 * @param {Array<{annotations?: Array, attachments?: Array, retry?: number}>} tests
 * @param {object} [options] - Reporter options.
 * @returns {string} Everything written to stdout.
 */
function summarise(tests, options = {}) {
  const reporter = new HealingReporter(options);

  tests.forEach((spec, index) => {
    reporter.onTestEnd(
      { title: `test ${index + 1}`, annotations: spec.annotations ?? [] },
      { attachments: spec.attachments ?? [], retry: spec.retry ?? 0 }
    );
  });

  let out = '';
  const saved = console.log;
  console.log = (line) => {
    out += `${line}\n`;
  };
  try {
    reporter.onEnd();
  } finally {
    console.log = saved;
  }
  return out;
}

/** A `healed` annotation in the shape `publishOutcome` produces. */
const healedNote = (from, to) => ({
  type: HEAL_ANNOTATIONS.healed,
  description: `click(): "${from}" → "${to}" [button "X", checks: lexical] (confidence 0.95, 1 attempt(s), 700 in / 90 out tokens) at pages/P.ts:1`,
});

const failedNote = (selector) => ({
  type: HEAL_ANNOTATIONS.failed,
  description: `click(): "${selector}" could not be healed — matched no elements at pages/P.ts:1`,
});

const blockedNote = (reason) => ({
  type: HEAL_ANNOTATIONS.blocked,
  description: `click(): "#x" was not sent — ${reason} at pages/P.ts:1`,
});

const unavailableNote = (reason) => ({ type: HEAL_ANNOTATIONS.unavailable, description: reason });

/** The machine-readable half, as a real attachment arrives: a Buffer body. */
function attachment(data) {
  return {
    name: `healing-${data.action ?? 'click'}-x.json`,
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify(data), 'utf8'),
  };
}

/** A healed attachment payload. */
const healedData = (from, to, extra = {}) => ({
  action: 'click',
  originalSelector: from,
  healedSelector: to,
  outcome: 'healed',
  cached: false,
  tokens: { input: 700, output: 90 },
  ...extra,
});

/** A test that healed once: annotation for the count, attachment for the numbers. */
const heal = (from, to, extra = {}) => ({
  annotations: [healedNote(from, to)],
  attachments: [attachment(healedData(from, to, extra))],
});

describe('HealingReporter — counting', () => {
  it('counts healed, failed and blocked', () => {
    const out = summarise([
      heal('#a', "getByTestId('a')"),
      { annotations: [failedNote('#b')] },
      { annotations: [blockedNote('origin "http://x" is not in HEALER_ALLOWED_ORIGINS')] },
    ]);

    assert.match(out, /healed: 1/);
    assert.match(out, /failed: 1/);
    assert.match(out, /blocked: 1/);
  });

  it('counts blocked by occurrence, not by distinct reason', () => {
    // Otherwise the number disagrees with `healed` and `failed`, which count events.
    const spec = { annotations: [blockedNote('same reason')] };
    assert.match(summarise([spec, spec, spec]), /blocked: 3/);
  });

  it('groups repeated unavailable reasons with a count', () => {
    const spec = { annotations: [unavailableNote('healing is disabled (HEALER_ENABLED=false)')] };
    const out = summarise([spec, spec]);

    assert.match(out, /Healing did not run/);
    assert.match(out, /\(2 tests\)/);
  });

  it('says "1 test" rather than "1 tests"', () => {
    assert.match(summarise([{ annotations: [unavailableNote('no key')] }]), /\(1 test\)/);
  });
});

describe('HealingReporter — numbers come from the attachment', () => {
  it('sums tokens across tests', () => {
    const out = summarise([
      heal('#a', '#x'),
      { annotations: [healedNote('#b', '#y')], attachments: [attachment(healedData('#b', '#y', { tokens: { input: 300, output: 10 } }))] },
    ]);

    assert.match(out, /tokens: 1000 in \/ 100 out/);
  });

  it('survives a reworded annotation', () => {
    // The test that used to pin the old weakness. The annotation here says nothing about
    // tokens at all, and the totals are still right — because they never came from it.
    const out = summarise([
      {
        annotations: [{ type: HEAL_ANNOTATIONS.healed, description: 'something else entirely' }],
        attachments: [attachment(healedData('#a', "getByTestId('a')"))],
      },
    ]);

    assert.match(out, /tokens: 700 in \/ 90 out/);
    assert.match(out, /healed: 1/);
    assert.match(out, /#a/, 'the rewrite is also structural now');
  });

  it('reads an attachment spilled to disk instead of held in memory', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');

    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shp-att-')), 'a.json');
    fs.writeFileSync(file, JSON.stringify(healedData('#a', '#x')));

    const out = summarise([
      {
        annotations: [healedNote('#a', '#x')],
        attachments: [{ name: 'healing-click-x.json', contentType: 'application/json', path: file }],
      },
    ]);

    assert.match(out, /tokens: 700 in \/ 90 out/);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('says so when a heal arrived with no attachment', () => {
    // Reporting a silent zero is what the old implementation did. Now it admits it.
    const out = summarise([{ annotations: [healedNote('#a', '#x')] }]);

    assert.match(out, /healed: 1/);
    assert.match(out, /token totals unavailable/);
  });

  it('ignores a malformed attachment rather than losing the summary', () => {
    const out = summarise([
      {
        annotations: [healedNote('#a', '#x')],
        attachments: [{ name: 'healing-click-x.json', contentType: 'application/json', body: Buffer.from('{ not json', 'utf8') }],
      },
    ]);

    assert.match(out, /healed: 1/);
  });

  it('ignores attachments that are not healing payloads', () => {
    const out = summarise([
      {
        annotations: [healedNote('#a', '#x')],
        attachments: [
          { name: 'trace', contentType: 'application/zip', path: '/tmp/trace.zip' },
          { name: 'screenshot', contentType: 'image/png', body: Buffer.from('png') },
          attachment(healedData('#a', '#x')),
        ],
      },
    ]);

    assert.match(out, /tokens: 700 in \/ 90 out/);
  });
});

describe('HealingReporter — the rewrites are the point of a run', () => {
  it('lists old → new pairs from the attachment', () => {
    const out = summarise([heal('#checkout-button', "getByTestId('checkout')")]);

    assert.match(out, /Suggested source updates/);
    assert.match(out, /#checkout-button/);
    assert.match(out, /getByTestId\('checkout'\)/);
  });

  it('deduplicates a rewrite seen in several tests', () => {
    // The same page object drives many tests; the edit is still one edit.
    const spec = heal('#checkout-button', "getByTestId('checkout')");
    const out = summarise([spec, spec, spec]);

    const section = out.split('Suggested source updates')[1];
    assert.equal(section.split('#checkout-button').length - 1, 1);
  });

  it('keeps distinct rewrites for distinct selectors', () => {
    const out = summarise([
      {
        annotations: [healedNote('#a', "getByTestId('a')"), healedNote('#b', "getByTestId('b')")],
        attachments: [attachment(healedData('#a', "getByTestId('a')")), attachment(healedData('#b', "getByTestId('b')"))],
      },
    ]);

    assert.match(out, /#a/);
    assert.match(out, /#b/);
  });

  it('offers no rewrites section when nothing healed', () => {
    assert.ok(!summarise([{ annotations: [failedNote('#b')] }]).includes('Suggested source updates'));
  });

  it('does not list a rewrite for a heal that did not succeed', () => {
    const out = summarise([
      {
        annotations: [failedNote('#b')],
        attachments: [attachment({ ...healedData('#b', null), outcome: 'not healed' })],
      },
    ]);

    assert.ok(!out.includes('Suggested source updates'));
  });
});

describe('HealingReporter — cache reuses are now countable', () => {
  it('reports how many heals cost nothing', () => {
    // The thing the prose-parsing version could not do.
    const out = summarise([
      heal('#a', '#x'),
      heal('#a', '#x', { cached: true, tokens: { input: 0, output: 0 } }),
      heal('#a', '#x', { cached: true, tokens: { input: 0, output: 0 } }),
    ]);

    assert.match(out, /reused: 2/);
    assert.match(out, /tokens: 700 in \/ 90 out/);
  });

  it('says nothing about reuse when there was none', () => {
    assert.ok(!summarise([heal('#a', '#x')]).includes('reused:'));
  });
});

describe('HealingReporter — retries', () => {
  it('explains a total inflated by a retried attempt', () => {
    // Not double-counting: a retried attempt re-runs the test, so it heals again and
    // spends again. The note exists so a reader is not left puzzled.
    const out = summarise([heal('#a', '#x'), { ...heal('#a', '#x'), retry: 1 }]);

    assert.match(out, /healed: 2/);
    assert.match(out, /tokens: 1400 in \/ 180 out/);
    assert.match(out, /includes 1 retried attempt/);
  });

  it('stays quiet when nothing was retried', () => {
    assert.ok(!summarise([heal('#a', '#x')]).includes('retried'));
  });
});

describe('HealingReporter — when to say anything at all', () => {
  it('stays silent on a run where nothing happened', () => {
    assert.equal(summarise([{}]), '');
  });

  it('speaks up on a quiet run when asked', () => {
    assert.match(summarise([{}], { always: true }), /Self-healing summary/);
  });

  it('reports blocked heals even though nothing was transmitted', () => {
    const out = summarise([{ annotations: [blockedNote('preview mode')] }]);
    assert.match(out, /Not sent \(privacy policy\)/);
    assert.match(out, /preview mode/);
  });

  it("claims stdio so its output is ordered ahead of Playwright's own", () => {
    assert.equal(new HealingReporter().printsToStdio(), true);
  });
});
