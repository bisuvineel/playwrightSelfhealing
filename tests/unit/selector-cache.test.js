/**
 * Unit tests for the selector cache.
 *
 * The cache's value is entirely in its bookkeeping — what it keeps, what it evicts, and
 * what it promotes — because correctness is handled elsewhere: every candidate it hands
 * back is re-validated and re-intent-checked against the live DOM before use. So these
 * tests are about the policy, not about whether a selector works.
 *
 *   npm run test:unit
 */

'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { SelectorCache } = require('../../dist/core/SelectorCache');

/** Shorthand for a remembered replacement. */
const entry = (selector, confidence = 0.9) => ({ selector, confidence });

describe('SelectorCache — remembering', () => {
  it('hands back what it was told to remember', () => {
    const cache = new SelectorCache(true);
    cache.remember('#checkout-button', entry("getByTestId('checkout')"));

    assert.deepEqual(cache.candidates('#checkout-button'), [
      { selector: "getByTestId('checkout')", confidence: 0.9 },
    ]);
  });

  it('knows nothing about a selector it has not seen', () => {
    const cache = new SelectorCache(true);
    assert.deepEqual(cache.candidates('#never-seen'), []);
  });

  it('keeps several replacements for one selector', () => {
    // The same selector can legitimately mean different elements on different pages.
    // Keeping both means neither page evicts the other's answer — a single-entry cache
    // would thrash between them, and every thrash is a full provider call.
    const cache = new SelectorCache(true);
    cache.remember('#submit', entry("getByRole('button', { name: 'Save' })"));
    cache.remember('#submit', entry("getByRole('button', { name: 'Send' })"));

    assert.equal(cache.candidates('#submit').length, 2);
  });

  it('promotes the most recent success to the front', () => {
    // So the answer that keeps working on the page under test is probed first, and a
    // stale alternative costs at most one quick DOM probe.
    const cache = new SelectorCache(true);
    cache.remember('#submit', entry('a'));
    cache.remember('#submit', entry('b'));
    cache.remember('#submit', entry('a'));

    assert.deepEqual(
      cache.candidates('#submit').map((c) => c.selector),
      ['a', 'b']
    );
  });

  it('does not duplicate a replacement it already knows', () => {
    const cache = new SelectorCache(true);
    cache.remember('#submit', entry('a'));
    cache.remember('#submit', entry('a'));

    assert.equal(cache.candidates('#submit').length, 1);
  });

  it('caps the list, so a miss stays cheap', () => {
    // Every candidate is probed against the DOM before the provider is contacted, so an
    // uncapped list would turn a cache miss into a slow one.
    const cache = new SelectorCache(true);
    for (const name of ['a', 'b', 'c', 'd', 'e']) cache.remember('#submit', entry(name));

    const kept = cache.candidates('#submit').map((c) => c.selector);
    assert.equal(kept.length, 3);
    // The three most recent survive; the oldest fall off.
    assert.deepEqual(kept, ['e', 'd', 'c']);
  });

  it('replays the confidence of the heal it came from', () => {
    // Not re-derived — a reuse has no fresh model opinion — but kept so the records
    // file's statistics stay meaningful. The record is marked provider `cache`, so it
    // cannot be mistaken for one.
    const cache = new SelectorCache(true);
    cache.remember('#x', entry('y', 0.83));

    assert.equal(cache.candidates('#x')[0].confidence, 0.83);
  });
});

describe('SelectorCache — disabled', () => {
  it('remembers nothing and offers nothing', () => {
    // HEALER_CACHE=false must make the engine behave exactly as it did before the cache
    // existed, so every heal goes to the provider.
    const cache = new SelectorCache(false);
    cache.remember('#checkout-button', entry("getByTestId('checkout')"));

    assert.equal(cache.isEnabled, false);
    assert.deepEqual(cache.candidates('#checkout-button'), []);
    assert.match(cache.describe(), /disabled/);
  });
});

describe('SelectorCache — accounting', () => {
  it('counts reuses, calls and probes', () => {
    const cache = new SelectorCache(true);
    cache.remember('#a', entry('x'));
    cache.noteProbe();
    cache.noteHit('#a', 'x');
    cache.noteMiss('#b');

    assert.deepEqual(cache.stats(), { hits: 1, sharedHits: 0, misses: 1, probes: 1, tracked: 1, evicted: 0 });
  });

  it('reports the share of heals that avoided a provider call', () => {
    // The demo's real ratio: five distinct selectors healed eleven times, so six of the
    // eleven should come from the cache.
    const cache = new SelectorCache(true);
    for (let i = 0; i < 5; i++) cache.noteMiss(`#s${i}`);
    for (let i = 0; i < 6; i++) cache.noteHit('#s0', 'x');

    // Called misses, not provider calls: a miss reaches the provider only if the spend
    // ceiling allows it, the breaker is closed and the privacy gate passed.
    assert.match(cache.describe(), /6 reuse\(s\), 5 miss\(es\)/);
    assert.match(cache.describe(), /55% of heals avoided a call/);
  });

  it('does not divide by zero before anything has healed', () => {
    const cache = new SelectorCache(true);
    assert.match(cache.describe(), /0 selector\(s\) cached/);
    assert.ok(!cache.describe().includes('%'));
  });

  it('is bounded, and drops the least recently used selector', () => {
    // Bounded for the same reason healing-records.json is: a per-worker structure that
    // only ever grows is a slow leak in a process that can run for hours.
    const cache = new SelectorCache(true);
    for (let i = 0; i < 600; i++) cache.remember(`#s${i}`, entry(`x${i}`));

    const { tracked, evicted } = cache.stats();
    assert.equal(tracked, 500);
    assert.equal(evicted, 100);

    // The oldest went; the newest stayed.
    assert.deepEqual(cache.candidates('#s0'), []);
    assert.equal(cache.candidates('#s599')[0].selector, 'x599');
  });

  it('counts a read as a use, so a busy selector survives eviction', () => {
    const cache = new SelectorCache(true);
    cache.remember('#keep', entry('kept'));
    for (let i = 0; i < 400; i++) cache.remember(`#s${i}`, entry(`x${i}`));

    // Touched here, which moves it to the back of the eviction queue.
    assert.equal(cache.candidates('#keep')[0].selector, 'kept');

    for (let i = 400; i < 600; i++) cache.remember(`#s${i}`, entry(`x${i}`));

    assert.equal(cache.candidates('#keep')[0]?.selector, 'kept', 'a used selector should survive');
  });

  it('says how many it evicted rather than letting the cap look like room', () => {
    const cache = new SelectorCache(true);
    for (let i = 0; i < 520; i++) cache.remember(`#s${i}`, entry(`x${i}`));

    assert.match(cache.describe(), /20 evicted/);
  });

  it('forgets everything on clear', () => {
    const cache = new SelectorCache(true);
    cache.remember('#a', entry('x'));
    cache.noteHit('#a', 'x');
    cache.clear();

    assert.deepEqual(cache.stats(), { hits: 0, sharedHits: 0, misses: 0, probes: 0, tracked: 0, evicted: 0 });
    assert.deepEqual(cache.candidates('#a'), []);
  });
});
