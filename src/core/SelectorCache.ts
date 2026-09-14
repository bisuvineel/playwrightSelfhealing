/**
 * Remembers selectors that healed, so the same rot is not paid for twice.
 *
 * A stale selector usually lives in a page object shared by many tests. This repo's own
 * demo heals five distinct selectors **eleven times** in one run, because three tests
 * each drive the same page objects. On a real suite that ratio is far worse: one rotted
 * locator in a widely-used page object costs a provider call per test that touches it,
 * and the wall-clock cost — a snapshot plus a network round trip per heal — hurts more
 * than the money.
 *
 * ## Why a cache here is safe
 *
 * A cached selector is **not trusted**. It is re-validated against the live DOM and
 * re-checked for intent exactly as a fresh suggestion would be, so a hit that is wrong
 * for the current page is rejected and the normal heal proceeds. That is what makes the
 * cache key allowed to be crude: it does not need to be right, only cheap and usually
 * right. A wrong hit costs one local DOM probe instead of a network call.
 *
 * `SelectorValidator.validateMultiple` was written for this shape before this cache
 * existed — "falling back through a list of hand-written candidates before paying for an
 * AI call".
 *
 * ## Why the key is the selector alone
 *
 * Not `(selector, action)`, and not `(selector, url)`. The same selector on two different
 * pages can legitimately need two different replacements, so instead of splitting the key
 * this keeps **several candidates per selector** and lets validation pick. That way both
 * pages' answers live in the cache and neither evicts the other — a single-entry cache
 * keyed too loosely would thrash between them, and each thrash is a full provider call.
 *
 * Including the action would halve the hit rate for no gain: a field healed for `fill` is
 * the same element when it is later `clear`ed. Where an action genuinely implies a
 * different element, the intent check's action-compatibility gate rejects the hit and the
 * heal proceeds normally.
 *
 * ## Deliberately not persisted
 *
 * This is in-memory and per-worker. Two tempting extensions are left out on purpose:
 *
 * - **A committed `selector-map.json`** would turn a recurring cost into a one-off, and
 *   also into a maintenance trap: the page objects rot indefinitely while a JSON file
 *   papers over them. That fights the rest of this package, whose reporter and
 *   `HEALER_FAIL_ON_HEAL` gate both exist to push the fix into the source. Making rot
 *   free removes the incentive to fix it.
 * - **Cross-worker sharing** would need a lock file and a run-scoped lifecycle to avoid
 *   becoming the stale map above, and would save only the first heal per worker rather
 *   than per test — a small gain for real complexity.
 *
 * A cache hit still counts as a heal everywhere it matters: the annotation, the records
 * file, the reporter's rewrite list, and the CI gate. The cache makes the rot cheaper to
 * live with, never invisible.
 *
 * @module core/SelectorCache
 */

import { createLogger, type Logger } from '../utils/logger';

/**
 * How many replacements to remember per original selector.
 *
 * Bounds the cost of a miss: every candidate is probed against the DOM before the
 * provider is contacted, so a long list would turn a cache miss into a slow one. Three
 * covers the realistic case — the same selector meaning different things on a handful of
 * pages — while capping a full miss at three quick probes.
 */
const MAX_CANDIDATES = 3;

/**
 * Distinct original selectors remembered, before the least recently useful is dropped.
 *
 * Bounded for the same reason `healing-records.json` is: a per-worker structure that only
 * ever grows is a slow leak in a process that can run for hours. The realistic ceiling is
 * the number of rotted selectors in a suite, so this will not be reached by an ordinary
 * one — it is a backstop against a pathological suite, not a tuning knob.
 *
 * An eviction costs exactly one provider call, which is the trade this cache makes anyway.
 */
const MAX_TRACKED = 500;

/** A remembered replacement. */
export interface CachedSelector {
  /** The replacement that worked. */
  selector: string;
  /**
   * Confidence of the heal that produced it, replayed rather than re-derived.
   *
   * Kept so the records file and its statistics stay meaningful. The record is marked
   * with provider `cache`, so it is never mistaken for a fresh model opinion.
   */
  confidence: number;
}

/** Counters for the run summary and for tuning. */
export interface SelectorCacheStats {
  /** Cached candidates that validated and were reused. */
  hits: number;
  /** Heals that had no usable cached candidate and went to the provider. */
  misses: number;
  /** Candidates probed against the DOM, including ones that did not work out. */
  probes: number;
  /** Distinct original selectors remembered. */
  tracked: number;
  /**
   * Selectors dropped because the cache was full.
   *
   * Reported rather than left silent: a bounded cache that never says it evicted looks
   * exactly like one that had room for everything.
   */
  evicted: number;
}

/**
 * Per-worker memory of selectors that healed.
 */
export class SelectorCache {
  private readonly entries = new Map<string, CachedSelector[]>();
  private readonly log: Logger;
  private hits = 0;
  private misses = 0;
  private probes = 0;
  private evicted = 0;

  /**
   * @param enabled - When false, every method is inert and `candidates()` returns
   * nothing, so the engine behaves exactly as it did before this cache existed.
   */
  constructor(private readonly enabled: boolean = true) {
    this.log = createLogger('heal:cache');
  }

  /** Whether the cache is switched on. */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Replacements worth trying for a selector, best first.
   *
   * @param originalSelector - The selector that just failed.
   * @returns Candidates to probe, or an empty array when there is nothing remembered.
   */
  candidates(originalSelector: string): CachedSelector[] {
    if (!this.enabled) return [];

    const found = this.entries.get(originalSelector);
    if (found === undefined) return [];

    // Re-inserting moves the key to the end of the Map's iteration order, which is what
    // makes the eviction in `remember` least-recently-*used* rather than oldest-first.
    this.entries.delete(originalSelector);
    this.entries.set(originalSelector, found);

    return found;
  }

  /**
   * Remembers a replacement that worked, or promotes one that worked again.
   *
   * Most recent success moves to the front, so a selector whose meaning has settled on
   * one page is probed first next time. The list is capped, which quietly evicts
   * replacements that stopped being useful.
   *
   * @param originalSelector - The selector that failed.
   * @param entry - The replacement that worked, and the confidence behind it.
   */
  remember(originalSelector: string, entry: CachedSelector): void {
    if (!this.enabled) return;

    const existing = this.entries.get(originalSelector) ?? [];
    const withoutDuplicate = existing.filter((candidate) => candidate.selector !== entry.selector);

    // Delete first so a re-remembered key moves to the end of the iteration order.
    this.entries.delete(originalSelector);
    this.entries.set(originalSelector, [entry, ...withoutDuplicate].slice(0, MAX_CANDIDATES));

    // Maps iterate in insertion order, so the first key is the least recently used.
    while (this.entries.size > MAX_TRACKED) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;

      this.entries.delete(oldest.value);
      this.evicted += 1;
    }
  }

  /**
   * Records that a cached candidate was reused successfully.
   *
   * @param originalSelector - The selector that failed.
   * @param selector - The cached replacement that worked.
   */
  noteHit(originalSelector: string, selector: string): void {
    this.hits += 1;
    this.log.info(
      `Reused "${selector}" for "${originalSelector}" from this worker's cache — ` +
        'no provider call.'
    );
  }

  /**
   * Records that nothing cached was usable, so a provider call follows.
   *
   * @param originalSelector - The selector that failed.
   */
  noteMiss(originalSelector: string): void {
    this.misses += 1;
    this.log.debug(`Nothing cached for "${originalSelector}".`);
  }

  /** Records one DOM probe of a cached candidate, successful or not. */
  noteProbe(): void {
    this.probes += 1;
  }

  /** Counters for the run summary. */
  stats(): SelectorCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      probes: this.probes,
      tracked: this.entries.size,
      evicted: this.evicted,
    };
  }

  /**
   * One-line summary, for logging when a worker finishes.
   *
   * @returns Something like `5 selector(s) cached, 6 reuse(s), 5 provider call(s)`.
   */
  describe(): string {
    if (!this.enabled) return 'disabled';

    const { hits, misses, tracked, evicted } = this.stats();
    const total = hits + misses;
    const saved = total > 0 ? Math.round((hits / total) * 100) : 0;

    return (
      `${tracked} selector(s) cached, ${hits} reuse(s), ${misses} miss(es)` +
      `${evicted > 0 ? `, ${evicted} evicted` : ''}` +
      `${total > 0 ? ` — ${saved}% of heals avoided a call` : ''}`
    );
  }

  /** Forgets everything. Used by tests. */
  clear(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
    this.probes = 0;
    this.evicted = 0;
  }
}
