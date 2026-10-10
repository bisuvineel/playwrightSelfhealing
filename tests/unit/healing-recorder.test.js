/**
 * Unit tests for the healing records file.
 *
 * The interesting part is concurrency. Playwright runs workers as separate processes, and
 * ARCHITECTURE.md records that a naive load-then-overwrite cycle lost half the records
 * with two workers — so every write takes a lock, re-reads, merges, and renames a temp
 * file into place. It also claims "four concurrent processes writing 15 records each:
 * 60/60 survived". That claim was measured once by hand and then never again.
 *
 * The last test in this file re-measures it, with real child processes.
 *
 *   npm run test:unit
 */

'use strict';

const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { HealingRecorder } = require('../../dist/utils/HealingRecorder');

const DIST = path.resolve(__dirname, '../../dist/utils/HealingRecorder.js');

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shp-records-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Path to a fresh records file inside the per-test directory. */
const file = (name = 'healing-records.json') => path.join(dir, name);

/**
 * A record, shaped as the engine writes them.
 *
 * @param {object} [overrides] - Fields to replace.
 * @returns {object} A HealRecord.
 */
function record(overrides = {}) {
  return {
    timestamp: '2026-08-24T10:00:00.000Z',
    file: 'pages/CartPage.ts',
    line: 37,
    originalSelector: '#checkout-button',
    suggestedSelector: "getByTestId('checkout')",
    confidence: 0.95,
    provider: 'anthropic:claude-haiku-4-5',
    tokens: { input: 700, output: 90 },
    success: true,
    ...overrides,
  };
}

/** Silences the recorder's own logging. */
function quiet(fn) {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return fn();
  } finally {
    Object.assign(console, saved);
  }
}

describe('HealingRecorder — writing', () => {
  it('writes a report a reader can parse', () => {
    const target = file();
    const recorder = new HealingRecorder(target);
    recorder.recordHeal(record());

    const report = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.equal(report.records.length, 1);
    assert.equal(report.totalHeals, 1);
    assert.equal(report.successfulHeals, 1);
    assert.ok(report.timestamp);
  });

  it('persists the fields added in 0.3.0', () => {
    // reasoning and intent were the point of finding 19; a write that dropped them would
    // leave the audit trail as empty as it was before.
    const target = file();
    new HealingRecorder(target).recordHeal(
      record({
        reasoning: 'The only button with that name.',
        intent: { mode: 'enforce', verified: true, checks: ['lexical'], role: 'button', name: 'Checkout' },
      })
    );

    const [saved] = JSON.parse(fs.readFileSync(target, 'utf8')).records;
    assert.match(saved.reasoning, /only button/);
    assert.deepEqual(saved.intent.checks, ['lexical']);
  });

  it('appends to history rather than replacing it', () => {
    const target = file();
    new HealingRecorder(target).recordHeal(record({ timestamp: 'A' }));
    new HealingRecorder(target).recordHeal(record({ timestamp: 'B' }));

    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).records.length, 2);
  });

  it('creates a missing directory rather than failing', () => {
    const target = path.join(dir, 'nested', 'deeper', 'records.json');
    new HealingRecorder(target).recordHeal(record());
    assert.ok(fs.existsSync(target));
  });

  it('leaves no temp or lock file behind', () => {
    const recorder = new HealingRecorder(file());
    recorder.recordHeal(record());
    assert.deepEqual(fs.readdirSync(dir), ['healing-records.json']);
  });

  it('never throws when the target is unwritable', () => {
    // A healing run must not fail because the audit log could not be written.
    const target = path.join(dir, 'records.json');
    fs.mkdirSync(target); // a directory where a file is expected
    const recorder = quiet(() => new HealingRecorder(target));
    assert.doesNotThrow(() => quiet(() => recorder.recordHeal(record())));
  });
});

describe('HealingRecorder — statistics', () => {
  it('summarises counts, tokens and confidence', () => {
    const recorder = new HealingRecorder(file());
    recorder.recordHeal(record({ timestamp: 'A', success: true, confidence: 1 }));
    recorder.recordHeal(record({ timestamp: 'B', success: false, confidence: 0.5 }));

    const stats = recorder.getStatistics();
    assert.equal(stats.totalHeals, 2);
    assert.equal(stats.successfulHeals, 1);
    assert.equal(stats.failedHeals, 1);
    assert.equal(stats.successRate, 0.5);
    assert.equal(stats.totalTokensUsed, 1580);
    assert.deepEqual(stats.tokenBreakdown, { input: 1400, output: 180 });
    assert.equal(stats.averageConfidence, 0.75);
  });

  it('returns zeros rather than NaN for an empty set', () => {
    // NaN serialises to null and breaks anything reading the report.
    const stats = new HealingRecorder(file()).getStatistics([]);
    assert.equal(stats.successRate, 0);
    assert.equal(stats.averageConfidence, 0);
    for (const value of Object.values(stats)) {
      if (typeof value === 'number') assert.ok(!Number.isNaN(value));
    }
  });

  it('tolerates records written by an older version', () => {
    // Fields that did not exist then must not produce NaN now.
    const stats = new HealingRecorder(file()).getStatistics([
      { timestamp: 'A', originalSelector: '#x', suggestedSelector: '#y', success: true },
    ]);
    assert.equal(stats.totalTokensUsed, 0);
    assert.equal(stats.averageConfidence, 0);
  });
});

describe('HealingRecorder — reading what is already there', () => {
  it('reads the current report format', () => {
    const target = file();
    fs.writeFileSync(target, JSON.stringify({ records: [record()] }));
    assert.equal(new HealingRecorder(target).getRecords().length, 1);
  });

  it('reads a bare array, as an early version wrote', () => {
    const target = file();
    fs.writeFileSync(target, JSON.stringify([record(), record({ timestamp: 'B' })]));
    assert.equal(new HealingRecorder(target).getRecords().length, 2);
  });

  it('reads JSON Lines, as an earlier version wrote', () => {
    const target = file();
    fs.writeFileSync(target, [JSON.stringify(record()), JSON.stringify(record({ timestamp: 'B' }))].join('\n'));
    assert.equal(new HealingRecorder(target).getRecords().length, 2);
  });

  it('skips a truncated final line from a killed worker', () => {
    const target = file();
    fs.writeFileSync(target, JSON.stringify(record()) + '\n{"timestamp":"B",');
    assert.equal(quiet(() => new HealingRecorder(target).getRecords()).length, 1);
  });

  it('starts fresh on an unreadable file rather than aborting the run', () => {
    const target = file();
    fs.writeFileSync(target, 'this is not JSON at all');
    assert.deepEqual(quiet(() => new HealingRecorder(target).getRecords()), []);
  });

  it('treats an empty file as no records', () => {
    const target = file();
    fs.writeFileSync(target, '   ');
    assert.deepEqual(new HealingRecorder(target).getRecords(), []);
  });

  it('hands back a copy, so callers cannot mutate its state', () => {
    const recorder = new HealingRecorder(file());
    recorder.recordHeal(record());
    recorder.getRecords().push(record({ timestamp: 'injected' }));
    assert.equal(recorder.getRecords().length, 1);
  });
});

describe('HealingRecorder — merging', () => {
  it('picks up records another process added since it last read', () => {
    const target = file();
    const mine = new HealingRecorder(target);

    // Another worker writes while this recorder holds an older view.
    fs.writeFileSync(target, JSON.stringify({ records: [record({ timestamp: 'THEIRS' })] }));

    mine.recordHeal(record({ timestamp: 'MINE' }));

    const stamps = JSON.parse(fs.readFileSync(target, 'utf8')).records.map((r) => r.timestamp);
    assert.deepEqual(stamps.sort(), ['MINE', 'THEIRS']);
  });

  it('does not duplicate a record it has already written', () => {
    const target = file();
    const recorder = new HealingRecorder(target);
    recorder.recordHeal(record({ timestamp: 'A' }));
    recorder.recordHeal(record({ timestamp: 'B' }));

    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).records.length, 2);
  });

  it('keeps two records that differ only by outcome', () => {
    // Identity spans location and both selectors, because two workers can record within
    // the same millisecond.
    const target = file();
    const recorder = new HealingRecorder(target);
    recorder.recordHeal(record({ success: true }));
    recorder.recordHeal(record({ success: false }));

    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).records.length, 2);
  });
});

describe('HealingRecorder — reset', () => {
  it('clears memory and removes the file', () => {
    const target = file();
    const recorder = new HealingRecorder(target);
    recorder.recordHeal(record());

    assert.equal(quiet(() => recorder.reset()), true);
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(recorder.getRecords(), []);
  });

  it('succeeds when there is nothing to remove', () => {
    assert.equal(quiet(() => new HealingRecorder(file()).reset()), true);
  });
});

describe('HealingRecorder — concurrency, re-measured', () => {
  it('loses nothing with four processes writing at once', () => {
    // The claim ARCHITECTURE.md makes: 4 processes x 15 records = 60/60 survive. Real
    // child processes, because the lock is `open(..., 'wx')` — atomic across processes but
    // meaningless within one.
    const target = file();
    const WORKERS = 4;
    const PER_WORKER = 15;

    const script = `
      const { HealingRecorder } = require(${JSON.stringify(DIST)});
      const id = process.argv[2];
      const recorder = new HealingRecorder(${JSON.stringify(target)});
      for (let i = 0; i < ${PER_WORKER}; i++) {
        recorder.recordHeal({
          timestamp: id + '-' + i,
          file: 'pages/P.ts', line: i,
          originalSelector: '#s' + i, suggestedSelector: '#t' + i,
          confidence: 0.9, provider: 'stub',
          tokens: { input: 1, output: 1 }, success: true,
        });
      }
    `;

    const scriptPath = path.join(dir, 'writer.js');
    fs.writeFileSync(scriptPath, script);

    // Real parallelism: spawn all four and let them overlap, rather than running them in
    // sequence, which would never exercise the lock.
    const children = Array.from({ length: WORKERS }, (_, w) =>
      spawn(process.execPath, [scriptPath, `w${w}`], { stdio: 'ignore' })
    );

    const done = children.map(
      (child) => new Promise((resolve) => child.on('exit', resolve))
    );

    return Promise.all(done).then(() => {
      const report = JSON.parse(fs.readFileSync(target, 'utf8'));
      assert.equal(
        report.records.length,
        WORKERS * PER_WORKER,
        `expected ${WORKERS * PER_WORKER} records, found ${report.records.length}`
      );
      assert.equal(report.totalHeals, WORKERS * PER_WORKER);

      // No stray lock or temp file, which would break the next run.
      const leftovers = fs.readdirSync(dir).filter((name) => /\.lock$|\.tmp$/.test(name));
      assert.deepEqual(leftovers, []);
    });
  });

  it('proves the merge is what saves them', () => {
    // Without re-reading before writing, the last writer wins. Simulated by two recorders
    // that each start from an empty file — the exact scenario ARCHITECTURE describes.
    const target = file();
    const first = new HealingRecorder(target);
    const second = new HealingRecorder(target);

    first.recordHeal(record({ timestamp: 'FIRST' }));
    second.recordHeal(record({ timestamp: 'SECOND' }));

    const stamps = JSON.parse(fs.readFileSync(target, 'utf8')).records.map((r) => r.timestamp);
    assert.deepEqual(stamps.sort(), ['FIRST', 'SECOND']);
  });
});

describe('HealingRecorder — retention', () => {
  it('keeps only the most recent records once capped', () => {
    // The file is read, merged and rewritten on every heal, so an unbounded file makes
    // each heal progressively slower. The cap is what keeps every write cheap.
    const target = file();
    const recorder = new HealingRecorder(target, 5);

    for (let i = 0; i < 12; i++) recorder.recordHeal(record({ timestamp: `t${i}` }));

    const saved = JSON.parse(fs.readFileSync(target, 'utf8')).records;
    assert.equal(saved.length, 5);
    assert.deepEqual(saved.map((r) => r.timestamp), ['t7', 't8', 't9', 't10', 't11']);
  });

  it('trims the oldest, which is the right end to lose', () => {
    // The recent rewrites are the ones anyone acts on.
    const target = file();
    const recorder = new HealingRecorder(target, 2);
    recorder.recordHeal(record({ timestamp: 'oldest' }));
    recorder.recordHeal(record({ timestamp: 'middle' }));
    recorder.recordHeal(record({ timestamp: 'newest' }));

    const stamps = JSON.parse(fs.readFileSync(target, 'utf8')).records.map((r) => r.timestamp);
    assert.deepEqual(stamps, ['middle', 'newest']);
  });

  it('prune() trims an existing file and reports what it dropped', () => {
    const target = file();
    const recorder = new HealingRecorder(target, 0);
    for (let i = 0; i < 10; i++) recorder.recordHeal(record({ timestamp: `t${i}` }));

    assert.equal(quiet(() => recorder.prune(3)), 7);
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).records.length, 3);
  });

  it('prune() is a no-op below the cap', () => {
    const recorder = new HealingRecorder(file(), 0);
    recorder.recordHeal(record());
    assert.equal(recorder.prune(10), 0);
  });

  it('treats a cap of 0 as unlimited', () => {
    const target = file();
    const recorder = new HealingRecorder(target, 0);
    for (let i = 0; i < 30; i++) recorder.recordHeal(record({ timestamp: `t${i}` }));

    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).records.length, 30);
  });

  it('reads the cap from HEALER_RECORDS_MAX', () => {
    const saved = process.env.HEALER_RECORDS_MAX;
    process.env.HEALER_RECORDS_MAX = '4';
    try {
      const target = file();
      const recorder = new HealingRecorder(target);
      for (let i = 0; i < 9; i++) recorder.recordHeal(record({ timestamp: `t${i}` }));
      assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).records.length, 4);
    } finally {
      if (saved === undefined) delete process.env.HEALER_RECORDS_MAX;
      else process.env.HEALER_RECORDS_MAX = saved;
    }
  });

  it('ignores an unusable HEALER_RECORDS_MAX rather than failing', () => {
    const saved = process.env.HEALER_RECORDS_MAX;
    process.env.HEALER_RECORDS_MAX = 'lots';
    try {
      const recorder = new HealingRecorder(file());
      assert.doesNotThrow(() => recorder.recordHeal(record()));
    } finally {
      if (saved === undefined) delete process.env.HEALER_RECORDS_MAX;
      else process.env.HEALER_RECORDS_MAX = saved;
    }
  });

  it('records whether the locator carried a describe()', () => {
    const target = file();
    new HealingRecorder(target).recordHeal(record({ described: false }));
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).records[0].described, false);
  });
});

describe('the retention cap as a setting', () => {
  it('prune() does not become the new cap', () => {
    // The docstring calls it a one-off trim. It used to reassign `maxRecords`, so a call
    // that read as "tidy this file" silently reconfigured every write that followed.
    const target = file();
    const recorder = new HealingRecorder(target, 20);
    for (let i = 0; i < 10; i++) recorder.recordHeal(record({ timestamp: `t${i}` }));

    quiet(() => recorder.prune(3));
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).records.length, 3);

    // Back above the trim size, because 20 is still the cap.
    for (let i = 10; i < 18; i++) recorder.recordHeal(record({ timestamp: `t${i}` }));
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).records.length, 11);
  });

  it('warns rather than silently defaulting when HEALER_RECORDS_MAX is unusable', () => {
    // The only healer setting read outside config.ts, and so the only one that could
    // absorb a typo without a word. `HEALER_RECORDS_MAX=1O000` is the case.
    const saved = process.env.HEALER_RECORDS_MAX;
    const lines = [];
    const savedWarn = console.warn;
    console.warn = (line) => lines.push(String(line));

    try {
      process.env.HEALER_RECORDS_MAX = '1O000';
      new HealingRecorder(file());
    } finally {
      console.warn = savedWarn;
      if (saved === undefined) delete process.env.HEALER_RECORDS_MAX;
      else process.env.HEALER_RECORDS_MAX = saved;
    }

    assert.match(lines.join('\n'), /HEALER_RECORDS_MAX/);
    assert.match(lines.join('\n'), /1O000/);
  });
});

describe('HEALER_RECORDS — the off switch', () => {
  /**
   * Runs `fn` with `HEALER_RECORDS` set, restoring it afterwards.
   *
   * @param {string|undefined} value - Value to set, or undefined to unset.
   * @param {Function} fn - Body to run.
   * @returns {*} Whatever `fn` returns.
   */
  function withRecords(value, fn) {
    const saved = process.env.HEALER_RECORDS;
    if (value === undefined) delete process.env.HEALER_RECORDS;
    else process.env.HEALER_RECORDS = value;
    try {
      return fn();
    } finally {
      if (saved === undefined) delete process.env.HEALER_RECORDS;
      else process.env.HEALER_RECORDS = saved;
    }
  }

  it('writes no file at all when off', () => {
    const target = file();
    withRecords('false', () => {
      const recorder = new HealingRecorder(target);
      recorder.recordHeal(record());
      recorder.recordHeal(record({ timestamp: 't2' }));
    });

    assert.equal(fs.existsSync(target), false, 'no report file');
    assert.equal(fs.existsSync(`${target}.lock`), false, 'no lock file either');
  });

  it('keeps the records in memory, so statistics still work inside the worker', () => {
    // Only the disk is left alone. A custom reporter reading getRecords() mid-run is not
    // the thing this switch is for turning off.
    withRecords('false', () => {
      const recorder = new HealingRecorder(file());
      recorder.recordHeal(record());

      assert.equal(recorder.isEnabled, false);
      assert.equal(recorder.getRecords().length, 1);
      assert.equal(recorder.getStatistics().totalHeals, 1);
    });
  });

  it('does not read an existing file either', () => {
    const target = file();
    const seeded = new HealingRecorder(target, 0);
    seeded.recordHeal(record({ timestamp: 'seeded' }));

    withRecords('false', () => {
      const recorder = new HealingRecorder(target);
      assert.deepEqual(recorder.getRecords(), [], 'a multi-megabyte parse for nothing');
    });

    // And the seeded file is left untouched rather than truncated.
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).records.length, 1);
  });

  it('accepts the documented spellings', () => {
    for (const value of ['false', 'FALSE', '0', 'no', 'off', ' off ']) {
      const target = file();
      withRecords(value, () => new HealingRecorder(target).recordHeal(record()));
      assert.equal(fs.existsSync(target), false, value);
    }
  });

  it('records by default, and on any other value', () => {
    for (const value of [undefined, 'true', '1', 'yes', 'on']) {
      const target = file();
      withRecords(value, () => new HealingRecorder(target).recordHeal(record()));
      assert.equal(fs.existsSync(target), true, String(value));
    }
  });

  it('is a different setting from HEALER_RECORDS_MAX=0', () => {
    // 0 means UNLIMITED and always has. Overloading it as "off" would have silently
    // stopped recording for anyone who set it deliberately.
    const target = file();
    withRecords(undefined, () => {
      const recorder = new HealingRecorder(target, 0);
      for (let i = 0; i < 5; i++) recorder.recordHeal(record({ timestamp: `t${i}` }));
    });

    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).records.length, 5);
  });

  it('can be overridden per instance, for a script that only reads', () => {
    const target = file();
    new HealingRecorder(target, 0).recordHeal(record({ timestamp: 'kept' }));

    withRecords('false', () => {
      const reader = new HealingRecorder(target, 0, true);
      assert.equal(reader.isEnabled, true);
      assert.equal(reader.getRecords().length, 1);
    });
  });
});

describe('the retention default', () => {
  it('is 1000, not 10000', () => {
    // The cap sets a permanent per-heal cost: 14ms at 1000 records against 117ms at
    // 10000, measured. Bounding the growth was the fix in 0.4.0; bounding it tightly is
    // the point. Asserted so the number cannot drift back up unnoticed.
    const target = file();
    const recorder = new HealingRecorder(target);

    assert.equal(recorder.prune(2000), 0, 'a cap above the default should be a no-op');
    for (let i = 0; i < 3; i++) recorder.recordHeal(record({ timestamp: `t${i}` }));
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).records.length, 3);
  });
});

describe('the source-control warning', () => {
  /** Runs `fn` with cwd moved to a scratch directory. */
  function inDirectory(setup, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shp-scw-'));
    const cwd = process.cwd();
    const saved = process.env.HEALING_RECORDS_PATH;
    delete process.env.HEALING_RECORDS_PATH;
    process.chdir(dir);
    setup(dir);

    const lines = [];
    const savedWarn = console.warn;
    console.warn = (line) => lines.push(String(line));
    try {
      fn();
    } finally {
      console.warn = savedWarn;
      process.chdir(cwd);
      if (saved === undefined) delete process.env.HEALING_RECORDS_PATH;
      else process.env.HEALING_RECORDS_PATH = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return lines.join('\n');
  }

  // The warning fires once per worker, and these tests share one. Each case therefore
  // asserts on a freshly required copy of the module.
  function freshRecorder() {
    const resolved = require.resolve('../../dist/utils/HealingRecorder');
    delete require.cache[resolved];
    return require(resolved).HealingRecorder;
  }

  it('warns when the file is not covered by .gitignore', () => {
    const out = inDirectory(
      (dir) => fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n'),
      () => new (freshRecorder())().recordHeal(record())
    );

    assert.match(out, /UNREDACTED/);
    assert.match(out, /healing-records\.json/);
    assert.match(out, /HEALING_RECORDS_PATH/);
  });

  it('stays quiet when .gitignore already covers it', () => {
    // A warning that fires forever after you have fixed it is one people learn to skip.
    const out = inDirectory(
      (dir) => fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\nhealing-records.json\n'),
      () => new (freshRecorder())().recordHeal(record())
    );

    assert.equal(out, '');
  });

  it('stays quiet when the caller chose the path', () => {
    const out = inDirectory(
      () => {},
      () => new (freshRecorder())('somewhere/else.json').recordHeal(record())
    );

    assert.equal(out, '');
  });

  it('says nothing twice', () => {
    const out = inDirectory(
      () => {},
      () => {
        const R = freshRecorder();
        const r = new R();
        for (let i = 0; i < 3; i++) r.recordHeal(record({ timestamp: `t${i}` }));
      }
    );

    assert.equal(out.split('\n').filter((l) => l.includes('UNREDACTED')).length, 1);
  });
});

describe('writing into a directory that does not exist yet', () => {
  it('does not spend the lock budget failing to lock a missing path', () => {
    // The lock file lives in the target directory, so locking before creating it burned
    // all 80 retries and then warned: 3,181ms against 12ms, measured. That is the first
    // write for anyone who follows the advice to move this file out of their repository.
    const target = path.join(file() + '.d', 'nested', 'deep', 'records.json');

    const started = Date.now();
    const recorder = new HealingRecorder(target, 1000, true);
    recorder.recordHeal(record());
    const elapsed = Date.now() - started;

    assert.equal(fs.existsSync(target), true, 'the file should be written');
    assert.ok(elapsed < 1000, `first write took ${elapsed}ms — the lock budget was spent`);
  });
});

describe('publishing the file through a transient refusal', () => {
  /**
   * Replaces `fs.renameSync` with one that fails `times` times before succeeding.
   *
   * @param {number} times - How many attempts should fail.
   * @param {string} code - The errno to fail with.
   * @returns {Function} A restore function, and a `calls` counter on it.
   */
  function failRenames(times, code = 'EPERM') {
    const real = fs.renameSync;
    let calls = 0;
    fs.renameSync = (from, to) => {
      calls += 1;
      if (calls <= times) {
        const error = new Error(`${code}: operation not permitted, rename '${from}' -> '${to}'`);
        error.code = code;
        throw error;
      }
      return real(from, to);
    };
    const restore = () => {
      fs.renameSync = real;
    };
    restore.count = () => calls;
    return restore;
  }

  it('does not lose a record when the rename is briefly refused', () => {
    // Observed for real under a parallel run on Windows: a scanner or the indexer holds
    // the destination open for a moment and the atomic rename fails with EPERM. The
    // failure was caught, logged, and the record lost from the file — silently, because
    // the run summary is built from annotations rather than from this file.
    const target = file();
    const restore = failRenames(3);
    try {
      const recorder = new HealingRecorder(target, 0);
      quiet(() => recorder.recordHeal(record({ timestamp: 'kept' })));

      const onDisk = JSON.parse(fs.readFileSync(target, 'utf8')).records;
      assert.equal(onDisk.length, 1, 'the record must survive a transient refusal');
      assert.equal(onDisk[0].timestamp, 'kept');
      assert.equal(restore.count(), 4, 'it should have retried rather than given up');
    } finally {
      restore();
    }
  });

  it('gives up rather than waiting on a refusal that will not clear', () => {
    const target = file();
    const restore = failRenames(Number.MAX_SAFE_INTEGER);
    try {
      const recorder = new HealingRecorder(target, 0);
      // Still never throws at the caller — healing must not fail because a log did.
      assert.doesNotThrow(() => quiet(() => recorder.recordHeal(record())));
      assert.equal(fs.existsSync(target), false);
      // And no scratch file is left behind to confuse the next run.
      assert.deepEqual(
        fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')),
        []
      );
    } finally {
      restore();
    }
  });

  it('does not retry an error that waiting cannot fix', () => {
    // A read-only checkout or a missing directory will not improve, so it is reported
    // at once rather than costing five sleeps on the healing path.
    const target = file();
    const restore = failRenames(Number.MAX_SAFE_INTEGER, 'EROFS');
    try {
      quiet(() => new HealingRecorder(target, 0).recordHeal(record()));
      assert.equal(restore.count(), 1, 'EROFS should not be retried');
    } finally {
      restore();
    }
  });
});
