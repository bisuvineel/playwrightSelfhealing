/**
 * Tests for the run-scoped, cross-worker selector store.
 *
 * The properties that matter, in order: a heal found by one worker is reused by another
 * in the **same run**; nothing crosses into **another run**; nothing exists **outside a
 * Playwright worker**; and a store that is missing, corrupt or unwritable never breaks a
 * heal. The cross-process case uses real child processes, because "another worker" is
 * another process and a same-process test would prove nothing about the filesystem path.
 *
 * Measured motivation: the demo suite on four workers made 13 provider-backed heals for 7
 * distinct stale selectors, so about 46% of the spend bought answers another worker had.
 *
 *   npm run test:unit
 */

'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, beforeEach, afterEach } = require('node:test');

const { SharedSelectorStore } = require('../../dist/core/SharedSelectorStore');
const { SelectorCache } = require('../../dist/core/SelectorCache');

const DIST = path.resolve(__dirname, '../../dist/core/SharedSelectorStore.js');
const ROOT = path.join(os.tmpdir(), 'self-healing-playwright');

/** Environment this file changes, restored after every test. */
const OWNED = ['TEST_WORKER_INDEX', 'HEALER_RUN_ID'];
let saved;

beforeEach(() => {
  saved = {};
  for (const name of OWNED) saved[name] = process.env[name];
});

afterEach(() => {
  for (const name of OWNED) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

/** A unique run id per test, so tests cannot see each other's entries. */
const freshRun = () => `test-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

describe('SharedSelectorStore — where it exists at all', () => {
  it('does not exist outside a Playwright worker', () => {
    // So plain scripts, the unit suite, and anything else that builds an engine are
    // unaffected: there is no run for entries to belong to.
    delete process.env.TEST_WORKER_INDEX;
    assert.equal(SharedSelectorStore.forThisRun(), null);
  });

  it('is scoped by HEALER_RUN_ID inside a worker', () => {
    process.env.TEST_WORKER_INDEX = '0';
    process.env.HEALER_RUN_ID = 'abc123';
    assert.equal(SharedSelectorStore.forThisRun().dir, path.join(ROOT, 'run-abc123'));
  });

  it('falls back to the parent process when the reporter set no run id', () => {
    // All workers of one `playwright test` are children of the same runner process.
    process.env.TEST_WORKER_INDEX = '0';
    delete process.env.HEALER_RUN_ID;
    assert.equal(SharedSelectorStore.forThisRun().dir, path.join(ROOT, `run-ppid-${process.ppid}`));
  });

  it('ignores a run id that is not safe as a directory name', () => {
    process.env.TEST_WORKER_INDEX = '0';
    process.env.HEALER_RUN_ID = '../../etc';
    assert.equal(SharedSelectorStore.runId(), `ppid-${process.ppid}`);
  });
});

describe('SharedSelectorStore — reading and writing', () => {
  it('round-trips an entry, newest first, capped at three', () => {
    const store = new SharedSelectorStore(path.join(ROOT, `run-${freshRun()}`));
    try {
      for (const selector of ['a', 'b', 'c', 'd']) {
        store.write('#stale', { selector: `getByTestId('${selector}')`, confidence: 0.9 });
      }
      assert.deepEqual(
        store.read('#stale').map((entry) => entry.selector),
        ["getByTestId('d')", "getByTestId('c')", "getByTestId('b')"]
      );
    } finally {
      fs.rmSync(store.dir, { recursive: true, force: true });
    }
  });

  it('returns nothing, rather than throwing, for an absent or corrupt entry', () => {
    const store = new SharedSelectorStore(path.join(ROOT, `run-${freshRun()}`));
    try {
      assert.deepEqual(store.read('#never-written'), []);

      store.write('#x', { selector: "getByTestId('x')", confidence: 0.9 });
      for (const name of fs.readdirSync(store.dir)) {
        fs.writeFileSync(path.join(store.dir, name), '{ not json');
      }
      assert.deepEqual(store.read('#x'), []);
    } finally {
      fs.rmSync(store.dir, { recursive: true, force: true });
    }
  });

  it('never throws when it cannot write', () => {
    // A store on an unwritable path costs another worker one provider call. It must
    // not cost the heal.
    const blocker = path.join(os.tmpdir(), `shp-not-a-dir-${process.pid}`);
    fs.writeFileSync(blocker, 'a file where a directory should be');
    try {
      const store = new SharedSelectorStore(path.join(blocker, 'run-x'));
      assert.doesNotThrow(() => store.write('#x', { selector: "getByTestId('x')", confidence: 0.9 }));
    } finally {
      fs.rmSync(blocker, { force: true });
    }
  });

  it('removes a run, and only a run with a safe name', () => {
    const runId = freshRun();
    const store = new SharedSelectorStore(path.join(ROOT, `run-${runId}`));
    store.write('#x', { selector: "getByTestId('x')", confidence: 0.9 });
    assert.ok(fs.existsSync(store.dir));

    SharedSelectorStore.removeRun(runId);
    assert.equal(fs.existsSync(store.dir), false);

    assert.doesNotThrow(() => SharedSelectorStore.removeRun('../../outside'));
  });
});

describe('SharedSelectorStore — across real worker processes', () => {
  /**
   * Runs a heal "in another worker": a child process that writes an entry.
   *
   * @param {object} env - Environment for the child.
   * @returns {void}
   */
  function otherWorkerRemembers(env) {
    const script = `
      const { SharedSelectorStore } = require(${JSON.stringify(DIST)});
      const store = SharedSelectorStore.forThisRun();
      if (!store) process.exitCode = 3;
      else store.write('#checkout-button', { selector: "getByTestId('checkout')", confidence: 0.95 });
    `;
    const result = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, ...env }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }

  it('lets one worker reuse what another worker healed in the same run', () => {
    const runId = freshRun();
    try {
      otherWorkerRemembers({ TEST_WORKER_INDEX: '1', HEALER_RUN_ID: runId });

      process.env.TEST_WORKER_INDEX = '0';
      process.env.HEALER_RUN_ID = runId;
      const cache = new SelectorCache(true, SharedSelectorStore.forThisRun());

      const candidates = cache.candidates('#checkout-button');
      assert.equal(candidates.length, 1, "this worker should see the other worker's heal");
      assert.equal(candidates[0].selector, "getByTestId('checkout')");

      cache.noteHit('#checkout-button', candidates[0].selector);
      assert.equal(cache.stats().sharedHits, 1, 'counted as reused from another worker');
    } finally {
      SharedSelectorStore.removeRun(runId);
    }
  });

  it('never lets another run see it', () => {
    // The line between this and a committed selector map: sharing within a run changes
    // nothing a person sees, sharing across runs would make rot cheap.
    const first = freshRun();
    const second = freshRun();
    try {
      otherWorkerRemembers({ TEST_WORKER_INDEX: '1', HEALER_RUN_ID: first });

      process.env.TEST_WORKER_INDEX = '0';
      process.env.HEALER_RUN_ID = second;
      const cache = new SelectorCache(true, SharedSelectorStore.forThisRun());

      assert.deepEqual(cache.candidates('#checkout-button'), []);
    } finally {
      SharedSelectorStore.removeRun(first);
      SharedSelectorStore.removeRun(second);
    }
  });

  it('puts what this worker learned ahead of what another worker learned', () => {
    // A selector whose meaning differs by page keeps this worker's answer first.
    const runId = freshRun();
    try {
      otherWorkerRemembers({ TEST_WORKER_INDEX: '1', HEALER_RUN_ID: runId });

      process.env.TEST_WORKER_INDEX = '0';
      process.env.HEALER_RUN_ID = runId;
      const cache = new SelectorCache(true, SharedSelectorStore.forThisRun());
      // Remembered locally *without* touching the store, as if learned before sharing.
      cache.remember('#checkout-button', { selector: "getByRole('button', { name: 'Checkout' })", confidence: 0.9 });

      const selectors = cache.candidates('#checkout-button').map((c) => c.selector);
      assert.equal(selectors[0], "getByRole('button', { name: 'Checkout' })");
    } finally {
      SharedSelectorStore.removeRun(runId);
    }
  });

  it('stays out of the way when the cache is switched off', () => {
    const runId = freshRun();
    try {
      otherWorkerRemembers({ TEST_WORKER_INDEX: '1', HEALER_RUN_ID: runId });
      const cache = new SelectorCache(false, new SharedSelectorStore(path.join(ROOT, `run-${runId}`)));
      assert.deepEqual(cache.candidates('#checkout-button'), []);
    } finally {
      SharedSelectorStore.removeRun(runId);
    }
  });
});

describe('SharedSelectorStore — single-flight across workers', () => {
  // Measured on the demo with four workers: duplicate heals finished within 0.1-1.8 s of
  // each other, so a cache alone saw almost none of them. Claims make the rest wait.

  /**
   * Claims a selector "in another worker" and reports whether it got it.
   *
   * @param {string} dir - The run directory.
   * @param {string} selector - The selector to claim.
   * @returns {boolean} What `claim` returned in the child.
   */
  function otherWorkerClaims(dir, selector) {
    const script = `
      const { SharedSelectorStore } = require(${JSON.stringify(DIST)});
      const store = new SharedSelectorStore(${JSON.stringify(dir)});
      process.stdout.write(String(store.claim(${JSON.stringify(selector)})));
    `;
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout === 'true';
  }

  const claimFile = (store, selector) =>
    path.join(store.dir, fs.readdirSync(store.dir).find((name) => name.endsWith('.claim')) ?? `missing-${selector}`);

  it('gives a selector to exactly one worker at a time', () => {
    const store = new SharedSelectorStore(path.join(ROOT, `run-${freshRun()}`));
    try {
      assert.equal(store.claim('#checkout-button'), true, 'the first worker gets it');
      assert.equal(otherWorkerClaims(store.dir, '#checkout-button'), false, 'another process does not');
      assert.equal(otherWorkerClaims(store.dir, '#email-input'), true, 'claims are per selector');

      store.release('#checkout-button');
      assert.equal(otherWorkerClaims(store.dir, '#checkout-button'), true, 'free again once released');
    } finally {
      fs.rmSync(store.dir, { recursive: true, force: true });
    }
  });

  it('lets a second heal in the same worker through, and releases only after both', () => {
    // One engine serves concurrent actions in a worker; it must never wait on itself.
    const store = new SharedSelectorStore(path.join(ROOT, `run-${freshRun()}`));
    try {
      assert.equal(store.claim('#x'), true);
      assert.equal(store.claim('#x'), true);

      store.release('#x');
      assert.equal(otherWorkerClaims(store.dir, '#x'), false, 'still held by the other heal');
      store.release('#x');
      assert.equal(otherWorkerClaims(store.dir, '#x'), true);
    } finally {
      fs.rmSync(store.dir, { recursive: true, force: true });
    }
  });

  it('takes over a claim left by a worker that died mid-heal', () => {
    const store = new SharedSelectorStore(path.join(ROOT, `run-${freshRun()}`));
    try {
      assert.equal(otherWorkerClaims(store.dir, '#x'), true);
      assert.equal(store.claim('#x'), false, 'a live claim is respected');

      const old = new Date(Date.now() - 10 * 60_000);
      fs.utimesSync(claimFile(store, '#x'), old, old);
      assert.equal(store.claim('#x'), true, 'an abandoned claim is not');
    } finally {
      fs.rmSync(store.dir, { recursive: true, force: true });
    }
  });

  it('proceeds alone, rather than waiting on nothing, when it cannot claim at all', () => {
    const blocker = path.join(os.tmpdir(), `shp-claim-blocker-${process.pid}`);
    fs.writeFileSync(blocker, 'a file where a directory should be');
    try {
      assert.equal(new SharedSelectorStore(path.join(blocker, 'run-x')).claim('#x'), true);
    } finally {
      fs.rmSync(blocker, { force: true });
    }
  });

  it("a waiter returns as soon as the other worker's answer is published", async () => {
    const store = new SharedSelectorStore(path.join(ROOT, `run-${freshRun()}`));
    try {
      assert.equal(otherWorkerClaims(store.dir, '#x'), true);
      setTimeout(() => store.write('#x', { selector: "getByTestId('x')", confidence: 0.9 }), 300);

      const started = Date.now();
      assert.equal(await store.awaitPeer('#x', 10_000), true);
      assert.ok(Date.now() - started < 3_000, 'returned on the answer, not the deadline');
    } finally {
      fs.rmSync(store.dir, { recursive: true, force: true });
    }
  });

  it('a waiter returns without an answer when the other heal ends without one', async () => {
    // The other worker's heal failed on its page; this worker must try on its own.
    const store = new SharedSelectorStore(path.join(ROOT, `run-${freshRun()}`));
    try {
      assert.equal(otherWorkerClaims(store.dir, '#x'), true);
      const file = claimFile(store, '#x');
      setTimeout(() => fs.rmSync(file, { force: true }), 300);

      const started = Date.now();
      assert.equal(await store.awaitPeer('#x', 10_000), false);
      assert.ok(Date.now() - started < 3_000, 'returned on the release, not the deadline');
    } finally {
      fs.rmSync(store.dir, { recursive: true, force: true });
    }
  });

  it('does not end the wait on answers that were already there', async () => {
    // Those were just tried and failed on this page; only a new answer is worth a retry.
    const store = new SharedSelectorStore(path.join(ROOT, `run-${freshRun()}`));
    try {
      store.write('#x', { selector: "getByTestId('other-page')", confidence: 0.9 });
      assert.equal(otherWorkerClaims(store.dir, '#x'), true);
      setTimeout(() => store.write('#x', { selector: "getByTestId('this-page')", confidence: 0.9 }), 300);

      assert.equal(await store.awaitPeer('#x', 10_000), true);
      assert.equal(store.read('#x')[0].selector, "getByTestId('this-page')");
    } finally {
      fs.rmSync(store.dir, { recursive: true, force: true });
    }
  });

  it('never waits past its bound on a stuck worker', async () => {
    const store = new SharedSelectorStore(path.join(ROOT, `run-${freshRun()}`));
    try {
      assert.equal(otherWorkerClaims(store.dir, '#x'), true);
      const started = Date.now();
      assert.equal(await store.awaitPeer('#x', 400), false);
      assert.ok(Date.now() - started < 2_000);
    } finally {
      fs.rmSync(store.dir, { recursive: true, force: true });
    }
  });

  it('is inert through a cache with no shared store', async () => {
    const cache = new SelectorCache(true, null);
    assert.equal(cache.claim('#x'), true);
    assert.doesNotThrow(() => cache.release('#x'));
    assert.equal(await cache.awaitPeer('#x', 10_000), false);
  });
});

describe('the reporter owns the run', () => {
  it('sets a run id before workers start, and removes the run when it ends', () => {
    const { default: HealingReporter } = require('../../dist/reporters/HealingReporter');
    delete process.env.HEALER_RUN_ID;

    const reporter = new HealingReporter();
    const runId = process.env.HEALER_RUN_ID;
    assert.match(runId, /^[a-f0-9]{16}$/, 'a random id, set in the runner process');

    const store = new SharedSelectorStore(path.join(ROOT, `run-${runId}`));
    store.write('#x', { selector: "getByTestId('x')", confidence: 0.9 });
    assert.ok(fs.existsSync(store.dir));

    const saved = { log: console.log };
    console.log = () => {};
    try {
      reporter.onEnd();
    } finally {
      Object.assign(console, saved);
    }
    assert.equal(fs.existsSync(store.dir), false, 'the run leaves nothing behind');
  });

  it('respects a run id someone else set, and does not delete it', () => {
    const { default: HealingReporter } = require('../../dist/reporters/HealingReporter');
    const runId = freshRun();
    process.env.HEALER_RUN_ID = runId;

    const reporter = new HealingReporter();
    assert.equal(process.env.HEALER_RUN_ID, runId);

    const store = new SharedSelectorStore(path.join(ROOT, `run-${runId}`));
    store.write('#x', { selector: "getByTestId('x')", confidence: 0.9 });

    const saved = { log: console.log };
    console.log = () => {};
    try {
      reporter.onEnd();
    } finally {
      Object.assign(console, saved);
    }
    assert.ok(fs.existsSync(store.dir), 'not this reporter\'s to delete');
    SharedSelectorStore.removeRun(runId);
  });
});
