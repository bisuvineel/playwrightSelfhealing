/**
 * Lets the workers of one Playwright run share the selectors they have healed.
 *
 * ## Why
 *
 * {@link SelectorCache} is per worker, so a stale selector in a shared page object is paid
 * for once *per worker* rather than once per run. Measured on the demo suite with four
 * workers against a real model: 13 provider-backed heals for 7 distinct stale selectors —
 * 1.86×, so roughly 46% of the spend bought answers another worker already had. The cost
 * grows with the worker count, which is the one dimension CI turns up.
 *
 * ## Why this does not contradict "deliberately not persisted"
 *
 * The objection to persistence is that it makes rot *free*: a committed selector map lets
 * page objects decay indefinitely while a JSON file papers over them. That objection is
 * about **across runs**. Sharing **within one run** and discarding the result at the end
 * changes nothing a person sees — a reused selector is still validated against the live
 * page, still intent-checked, still recorded as a heal, and still fails the build under
 * `HEALER_FAIL_ON_HEAL`. It only stops the same question being bought twice.
 *
 * So the store is scoped to a run and never outlives it:
 *
 * - **A run is identified by `HEALER_RUN_ID`**, which `HealingReporter` sets to a random
 *   value in the Playwright runner process before any worker starts. Workers are forked
 *   with the runner's environment, so every worker of the run sees the same id and no
 *   other run does. The reporter deletes the run's directory when the run ends.
 * - **Without the reporter**, the parent process id is used: all workers of one
 *   `playwright test` invocation are children of the same runner process. Process ids are
 *   eventually reused, so entries also expire after {@link ENTRY_MAX_AGE_MS} and stale run
 *   directories are pruned — and even a stale entry is only a hint that must re-validate.
 * - **Outside a Playwright worker** there is no store at all, so plain scripts, the unit
 *   suite, and anything else that constructs an engine are unaffected.
 *
 * ## Consistency
 *
 * One small file per original selector, replaced atomically by write-then-rename, so a
 * reader sees a whole entry or none. There is no lock: two workers healing the same
 * selector at the same moment each write a valid answer and the later rename wins. That
 * costs at most one extra provider call, which is the trade the cache makes anyway, and
 * is cheaper than making every heal wait on a lock.
 *
 * Healed selectors can quote page text (`getByText('Smith, John')`), so this is page-derived
 * data on local disk — the same class as `healing-records.json`. It lives under the
 * operating system's temporary directory and is switched off with `HEALER_CACHE=false`.
 *
 * @module core/SharedSelectorStore
 */

import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createLogger, type Logger } from '../utils/logger';
import type { CachedSelector } from './SelectorCache';

/**
 * How long a shared entry may be reused.
 *
 * Longer than any ordinary run, shorter than the gap between runs on a machine that
 * reuses process ids. Only matters when the reporter is not configured: with it, the run
 * directory is removed at the end of the run regardless.
 */
const ENTRY_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** A run directory untouched for this long is from a run that is over. */
const STALE_RUN_MS = 12 * 60 * 60 * 1000;

/** Replacements kept per selector — the same bound {@link SelectorCache} uses. */
const MAX_CANDIDATES = 3;

/**
 * Retries for the rename that publishes an entry.
 *
 * On Windows, replacing a file another worker is reading at that instant fails with
 * `EPERM`. It clears in milliseconds — the same condition `HealingRecorder` retries for.
 */
const RENAME_RETRIES = 5;
const RENAME_RETRY_MS = 15;

/**
 * A claim older than this belongs to a worker that died mid-heal, and may be taken over.
 *
 * Well above a normal heal (a few seconds) and above a slow one that retries, so a live
 * worker's claim is never stolen; only one that can no longer finish is.
 */
const CLAIM_MAX_AGE_MS = 90_000;

/** How often a waiting worker looks for the answer. */
const PEER_POLL_MS = 150;

/** Top-level directory under the OS temporary directory. */
const ROOT = path.join(os.tmpdir(), 'self-healing-playwright');

/** What one entry file holds. */
interface StoredEntry {
  v: 1;
  /** The selector the file is for — checked on read, so a hash collision cannot mislead. */
  originalSelector: string;
  entries: CachedSelector[];
  /** When the entry was last written, for {@link ENTRY_MAX_AGE_MS}. */
  updatedAt: number;
}

/** Pruning runs once per process; it only needs to happen, not to happen often. */
let pruned = false;

/**
 * A run-scoped, cross-worker store of healed selectors.
 */
export class SharedSelectorStore {
  private readonly log: Logger;
  /** Claims this process holds, counted — two actions in one test can heal at once. */
  private readonly held = new Map<string, number>();

  /**
   * @param dir - Directory for this run's entries. Created on first write.
   */
  constructor(readonly dir: string) {
    this.log = createLogger('heal:cache');
  }

  /**
   * The store for the current run, or `null` when this process is not a Playwright
   * worker — outside a test run there is no run for entries to belong to.
   *
   * @returns The store, or `null`.
   */
  static forThisRun(): SharedSelectorStore | null {
    const runId = SharedSelectorStore.runId();
    if (runId === null) return null;

    if (!pruned) {
      pruned = true;
      SharedSelectorStore.pruneStaleRuns();
    }

    return new SharedSelectorStore(path.join(ROOT, `run-${runId}`));
  }

  /**
   * Identifies the current run, or returns `null` outside a Playwright worker.
   *
   * @returns A value safe to use in a directory name.
   */
  static runId(): string | null {
    // Playwright sets this in every worker process, and nowhere else.
    if (process.env.TEST_WORKER_INDEX === undefined) return null;

    const explicit = process.env.HEALER_RUN_ID;
    if (explicit !== undefined && /^[A-Za-z0-9._-]{1,64}$/.test(explicit)) return explicit;

    return `ppid-${process.ppid}`;
  }

  /**
   * A fresh run id, for the reporter to put in the environment before workers start.
   *
   * @returns A random, directory-safe id.
   */
  static newRunId(): string {
    return randomBytes(8).toString('hex');
  }

  /**
   * Deletes a run's directory. Called by the reporter when the run ends.
   *
   * @param runId - The run to remove.
   */
  static removeRun(runId: string): void {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(runId)) return;
    try {
      fs.rmSync(path.join(ROOT, `run-${runId}`), { recursive: true, force: true });
    } catch {
      // Best effort: the entries expire regardless.
    }
  }

  /**
   * Replacements another worker in this run has already found for a selector.
   *
   * @param originalSelector - The selector that failed.
   * @returns Entries, best first, or an empty array.
   */
  read(originalSelector: string): CachedSelector[] {
    let stored: StoredEntry;
    try {
      stored = JSON.parse(fs.readFileSync(this.fileFor(originalSelector), 'utf8')) as StoredEntry;
    } catch {
      return []; // Absent, or caught mid-write on a platform without atomic rename.
    }

    if (
      stored?.v !== 1 ||
      stored.originalSelector !== originalSelector ||
      !Array.isArray(stored.entries) ||
      typeof stored.updatedAt !== 'number' ||
      Date.now() - stored.updatedAt > ENTRY_MAX_AGE_MS
    ) {
      return [];
    }

    return stored.entries
      .filter(
        (entry): entry is CachedSelector =>
          typeof entry?.selector === 'string' &&
          entry.selector !== '' &&
          typeof entry.confidence === 'number'
      )
      .slice(0, MAX_CANDIDATES);
  }

  /**
   * Publishes a replacement that worked, for the other workers of this run.
   *
   * Merged with what is already there, newest first. Never throws: a store that cannot be
   * written costs another worker one provider call, and healing must not fail over a hint.
   *
   * @param originalSelector - The selector that failed.
   * @param entry - The replacement that worked.
   */
  write(originalSelector: string, entry: CachedSelector): void {
    const merged = [
      entry,
      ...this.read(originalSelector).filter((existing) => existing.selector !== entry.selector),
    ].slice(0, MAX_CANDIDATES);

    const body: StoredEntry = {
      v: 1,
      originalSelector,
      entries: merged,
      updatedAt: Date.now(),
    };

    const file = this.fileFor(originalSelector);
    const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;

    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(body), 'utf8');
      this.publish(temporary, file);
    } catch (error) {
      this.log.debug(
        `Could not share the heal for "${originalSelector}" with other workers: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        // Nothing more to do.
      }
    }
  }

  /**
   * Claims the right to heal a selector for this run, so the other workers wait for the
   * answer instead of buying the same one.
   *
   * ## Why a cache alone was not enough
   *
   * Measured on the demo suite with four workers, a shared cache avoided one duplicate
   * heal in six. The duplicates were not sequential — they **finished within 0.1 to 1.8
   * seconds of each other**. Tests start together and walk the same page objects in
   * step, so every worker hits the same stale selector at the same moment, and a heal
   * takes seconds: none of them can see an answer that no one has finished yet. That is
   * the ordinary shape of a real suite, where every test begins by logging in.
   *
   * So the first worker to reach a stale selector claims it, and the rest wait for its
   * answer. The claim is an exclusively created file, which is atomic across processes
   * on every platform this package runs on.
   *
   * @param originalSelector - The selector about to be healed.
   * @returns True when this process may heal it — it holds the claim, or claiming was
   * not possible and it should proceed as if alone. False when another worker is
   * healing it right now.
   */
  claim(originalSelector: string): boolean {
    const count = this.held.get(originalSelector) ?? 0;
    if (count > 0) {
      // Already ours — a second concurrent heal in this worker must not wait on itself.
      this.held.set(originalSelector, count + 1);
      return true;
    }

    const file = this.claimFileFor(originalSelector);

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.closeSync(fs.openSync(file, 'wx'));
        this.held.set(originalSelector, 1);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          // The store is unusable here. Proceed alone rather than wait on nothing.
          return true;
        }

        // Held by another worker. Take it over only if that worker cannot finish.
        try {
          if (Date.now() - fs.statSync(file).mtimeMs > CLAIM_MAX_AGE_MS) {
            fs.rmSync(file, { force: true });
            continue;
          }
        } catch {
          continue; // Released between the failed open and the stat — try again.
        }
        return false;
      }
    }

    return true;
  }

  /**
   * Releases a claim this process holds. Safe to call when it holds none.
   *
   * @param originalSelector - The selector whose heal is over, successful or not.
   */
  release(originalSelector: string): void {
    const count = this.held.get(originalSelector) ?? 0;
    if (count === 0) return;

    if (count > 1) {
      this.held.set(originalSelector, count - 1);
      return;
    }

    this.held.delete(originalSelector);
    try {
      fs.rmSync(this.claimFileFor(originalSelector), { force: true });
    } catch {
      // A leftover claim expires after CLAIM_MAX_AGE_MS.
    }
  }

  /**
   * Waits for another worker's answer to a selector it has claimed.
   *
   * Returns as soon as the answer is published, or as soon as the claim is released
   * without one — the other worker's heal failed, and its page is not this worker's, so
   * this worker should try for itself. The wait is bounded, so a stuck worker costs a
   * delay and never a heal. In the common case the wait is the other worker's call,
   * which this worker would otherwise have spent on an identical call of its own.
   *
   * @param originalSelector - The selector being healed elsewhere.
   * @param timeoutMs - How long to wait at most.
   * @returns True when a new answer was published.
   */
  async awaitPeer(originalSelector: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const claim = this.claimFileFor(originalSelector);

    // Only a *new* answer counts. Entries already here were just tried by the caller and
    // did not work on its page; seeing them again must not end the wait early.
    const known = new Set(this.read(originalSelector).map((entry) => entry.selector));
    const arrived = (): boolean => this.read(originalSelector).some((entry) => !known.has(entry.selector));

    while (Date.now() < deadline) {
      if (arrived()) return true;
      if (!fs.existsSync(claim)) return arrived();
      await new Promise((resolve) => setTimeout(resolve, PEER_POLL_MS));
    }

    this.log.debug(`Stopped waiting for another worker to heal "${originalSelector}".`);
    return false;
  }

  /**
   * The claim file for a selector.
   *
   * @param originalSelector - The selector.
   * @returns Its path.
   */
  private claimFileFor(originalSelector: string): string {
    return this.fileFor(originalSelector).replace(/\.json$/, '.claim');
  }

  /**
   * The file an original selector's entry lives in.
   *
   * @param originalSelector - The selector.
   * @returns Its path.
   */
  private fileFor(originalSelector: string): string {
    const name = createHash('sha256').update(originalSelector).digest('hex').slice(0, 32);
    return path.join(this.dir, `${name}.json`);
  }

  /**
   * Renames the temporary file into place, retrying a transient Windows refusal.
   *
   * @param temporary - The finished temporary file.
   * @param file - Its destination.
   */
  private publish(temporary: string, file: string): void {
    for (let attempt = 1; ; attempt++) {
      try {
        fs.renameSync(temporary, file);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= RENAME_RETRIES || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) {
          throw error;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_RETRY_MS);
      }
    }
  }

  /** Removes run directories from runs that are long over. Best effort, once per process. */
  private static pruneStaleRuns(): void {
    try {
      for (const name of fs.readdirSync(ROOT)) {
        if (!name.startsWith('run-')) continue;
        const dir = path.join(ROOT, name);
        try {
          if (Date.now() - fs.statSync(dir).mtimeMs > STALE_RUN_MS) {
            fs.rmSync(dir, { recursive: true, force: true });
          }
        } catch {
          // Another worker may be pruning the same directory.
        }
      }
    } catch {
      // No root yet.
    }
  }
}
