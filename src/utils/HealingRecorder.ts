/**
 * Records healing attempts to a JSON report file.
 *
 * The report is the framework's audit trail: which selectors are decaying, what the
 * AI proposed, whether it worked, and what it cost. Both successes and failures are
 * recorded — a rejected suggestion is exactly what you need when tuning
 * `HEALER_THRESHOLD`.
 *
 * **Concurrency.** Playwright runs specs across parallel worker processes, and a
 * naive load-then-overwrite cycle loses records: two workers that both start with an
 * empty file will each write only their own attempts, and the last writer wins. Every
 * write here therefore takes a lock file, re-reads what is on disk, merges, and
 * renames a temp file into place — so records accumulate across workers and a crash
 * mid-write cannot leave a half-written report.
 *
 * @module utils/HealingRecorder
 */

import * as fs from 'fs';
import * as path from 'path';

import type { HealRecord } from '../types';
import { createLogger, type Logger } from './logger';

/** Default output file. Already listed in `.gitignore`. */
const DEFAULT_FILE = 'healing-records.json';

/**
 * Whether records are written at all.
 *
 * `HEALER_RECORDS=false` turns the file off: nothing is loaded, nothing is written, and no
 * file or lock file appears. Every heal is still reported through the annotations, the
 * attachment, the CI gate and the run summary — the only thing lost is the **unredacted**
 * copy of the rewrite, which matters when `HEALER_REDACT=strict` collapses the selector
 * everywhere else and this file is where the real string lives.
 *
 * Given a switch was needed, `HEALER_RECORDS_MAX=0` was the obvious candidate to overload —
 * and would have been wrong. `0` already means *unlimited*, it is documented that way, and
 * quietly reinterpreting it as *off* would silently stop recording for anyone who had set
 * it deliberately. Two settings that each mean one thing beats one that means two.
 *
 * @returns Whether to record. Defaults to true, so an unreadable value cannot silently
 * lose the audit trail.
 */
function recordsEnabled(): boolean {
  const raw = process.env.HEALER_RECORDS;
  if (raw === undefined) return true;

  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

/**
 * Reads the retention cap from the environment.
 *
 * Read here rather than through `config.ts` so the recorder keeps working when the rest
 * of the configuration is invalid — the same reasoning as `isHealingEnabled()`.
 *
 * @returns The cap, or {@link DEFAULT_MAX_RECORDS} when unset or unusable.
 */
function readMaxRecords(): number {
  const raw = process.env.HEALER_RECORDS_MAX;
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_RECORDS;

  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;

  // Said out loud. Reading this directly rather than through `config.ts` is deliberate —
  // the recorder has to keep working when the rest of the configuration is invalid — but
  // that is an argument for not *throwing*, not for saying nothing. Every other setting in
  // this package names the variable when it cannot use the value, and `HEALER_RECORDS_MAX=1O000`
  // silently becoming the default is exactly the typo nobody would find.
  createLogger('heal:recorder').warn(
    `HEALER_RECORDS_MAX must be a whole number of 0 or more (got "${raw}"); ` +
      `keeping the default of ${DEFAULT_MAX_RECORDS}.`
  );

  return DEFAULT_MAX_RECORDS;
}

/**
 * Lock acquisition budget.
 *
 * Was 40 × a flat 25ms ≈ 1s. Two changes: more room, and **jitter**. Flat backoff meant
 * four workers that collided once went on colliding in lockstep every 25ms, which is the
 * shape that actually loses records under contention. Randomising each wait breaks the
 * convoy, so the extra attempts are rarely needed.
 *
 * Worst case is now ~3s of waiting, but the mean is far lower — and the cap on retained
 * records below keeps each write short, which is what shortens the window in the first
 * place.
 */
const LOCK_RETRIES = 80;
const LOCK_RETRY_MS = 20;
const LOCK_JITTER_MS = 20;

/**
 * Retries for the atomic rename that publishes the file.
 *
 * On Windows, replacing a file that something else has open for even a moment fails
 * with `EPERM` — a virus scanner or the search indexer reading the file this process
 * just wrote is enough. Observed under a parallel test run:
 *
 * ```
 *   Failed to persist: EPERM: operation not permitted,
 *     rename 'healing-records.json.32644.tmp' -> 'healing-records.json'
 * ```
 *
 * The failure was caught, logged, and the record lost from the file — silently, because
 * the run summary is built from annotations rather than from this file. A lost record in
 * an append-only audit log is the one failure this module cannot shrug off: it is what a
 * reviewer reads to decide which selector fixes to commit.
 *
 * The condition clears in milliseconds, so a few short retries are the whole fix. Kept
 * deliberately small — this runs on the healing path, and a file that genuinely cannot
 * be replaced should be reported rather than waited on.
 */
const RENAME_RETRIES = 5;
const RENAME_RETRY_MS = 20;

/**
 * Retained records, newest kept, when no `HEALER_RECORDS_MAX` is set.
 *
 * The file is read, merged and rewritten on **every** heal, so an unbounded file makes each
 * heal progressively slower. A cap fixes that — but the size of the cap sets a permanent
 * per-heal tax, and the first one chosen was eight times larger than it needed to be:
 *
 * | records | file size | recording cost per heal |
 * |--------:|----------:|------------------------:|
 * |     100 |   0.08 MB |                  5.3 ms |
 * |   1,000 |   0.75 MB |                 14.1 ms |
 * |   5,000 |   3.75 MB |                105.6 ms |
 * |  10,000 |   7.50 MB |                116.7 ms |
 *
 * Ten thousand cost **117ms of synchronous work inside every heal** for history nobody
 * reads. One thousand is still far more than anyone looks at — this repo's whole demo
 * produces about a dozen per run — and costs an eighth of that. Bounding the growth was
 * the fix; bounding it *tightly* is the point.
 *
 * Raise it with `HEALER_RECORDS_MAX` if you genuinely mine this file, and know that you
 * are buying the row above.
 */
const DEFAULT_MAX_RECORDS = 1_000;

/** A lock older than this is treated as abandoned by a crashed worker. */
const STALE_LOCK_MS = 10_000;

/** Whether this worker has already mentioned that the records file is not ignored. */
let warnedAboutSourceControl = false;

/**
 * Says so, once, when the records file is about to land somewhere git can see it.
 *
 * This file is the one place a healed selector is kept **unredacted**, and that is the
 * stated justification for redacting every surface that leaves the machine — the
 * annotations, the attachment, the CI gate's message, the run summary. The justification
 * only holds while the file stays local. It defaults to the *consumer's* project root, and
 * their `.gitignore` has never heard of it: npm strips `.gitignore` from a tarball, so
 * nothing arrives to tell them. One `git add .` and page content is in history for good.
 *
 * **Silent in the two cases where the reader has clearly thought about it:** when the path
 * was chosen — by the caller or by `HEALING_RECORDS_PATH` — and when `.gitignore` already
 * covers it. A warning that fires forever after you have fixed it is a warning
 * people learn to skip, which is how the next real one gets missed.
 *
 * Never throws, and says nothing twice.
 *
 * @param filePath - Resolved path the report is about to be written to.
 */
function warnIfUnignored(filePath: string): void {
  if (warnedAboutSourceControl) return;
  warnedAboutSourceControl = true;

  try {
    const name = path.basename(filePath);
    const ignoreFile = path.join(process.cwd(), '.gitignore');

    if (fs.existsSync(ignoreFile)) {
      const covered = fs
        .readFileSync(ignoreFile, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .some((line) => line !== '' && !line.startsWith('#') && line.replace(/^\/+/, '') === name);

      if (covered) return;
    }

    // No `.gitignore`, or one that does not mention this file.
    createLogger('heal:recorder').warn(
      `${name} is being written to ${process.cwd()} and holds UNREDACTED page content — ` +
        'the selectors and text a heal saw. Add it to .gitignore, or set ' +
        'HEALING_RECORDS_PATH to somewhere outside your repository. Set HEALER_RECORDS=false ' +
        'if you do not need it at all.'
    );
  } catch {
    // A diagnostic must never be the thing that breaks recording.
  }
}

/** Aggregate statistics written at the top of the report. */
export interface HealingStatistics {
  /** Total attempts recorded, successful or not. */
  totalHeals: number;
  /** Attempts where the healed selector was accepted and used. */
  successfulHeals: number;
  /** Attempts that were rejected or errored. */
  failedHeals: number;
  /** Fraction of attempts that succeeded, 0-1. Zero when there are no records. */
  successRate: number;
  /** Input plus output tokens across every attempt. */
  totalTokensUsed: number;
  /** Input and output tokens kept separate, for cost calculations. */
  tokenBreakdown: { input: number; output: number };
  /** Mean reported confidence, 0-1. Zero when there are no records. */
  averageConfidence: number;
}

/** On-disk shape of the report file. */
export interface HealingReport extends HealingStatistics {
  /** When the report was last written, ISO 8601. */
  timestamp: string;
  /** Every recorded attempt, oldest first. */
  records: HealRecord[];
}

/**
 * Accumulates {@link HealRecord}s and persists them as a JSON report.
 */
export class HealingRecorder {
  private records: HealRecord[] = [];
  private filePath: string;
  private log: Logger;

  /** Most recent records to keep on disk. */
  private maxRecords: number;

  /** Whether this recorder touches the disk at all. See {@link recordsEnabled}. */
  private readonly enabled: boolean;

  /** True only when the path came from neither the caller nor the environment. */
  private readonly warnAboutSourceControl: boolean;

  /**
   * @param filePath - Where to write the report. Defaults to `HEALING_RECORDS_PATH` if
   * set, otherwise `healing-records.json` in the current working directory. Existing
   * records are loaded so a run appends to history rather than replacing it.
   * @param maxRecords - Most recent records to keep. Defaults to `HEALER_RECORDS_MAX`,
   * then to {@link DEFAULT_MAX_RECORDS}. `0` keeps everything.
   * @param enabled - Whether to read or write at all. Defaults to `HEALER_RECORDS`.
   * Pass `true` explicitly to read an existing file from a reporting script of your own
   * even when the environment has recording switched off.
   */
  constructor(filePath?: string, maxRecords?: number, enabled?: boolean) {
    // A path from either source is a decision already made; only the fallback is a
    // surprise worth warning about.
    const chosen = filePath ?? process.env.HEALING_RECORDS_PATH;
    this.warnAboutSourceControl = chosen === undefined;
    this.filePath = path.resolve(chosen ?? DEFAULT_FILE);
    this.maxRecords = maxRecords ?? readMaxRecords();
    this.enabled = enabled ?? recordsEnabled();
    this.log = createLogger('heal:recorder');

    // Nothing is read when recording is off. Loading would cost a multi-megabyte parse
    // per worker to populate a history that will never be written back.
    if (this.enabled) this.loadFromFile();
    else this.log.debug('Records are off (HEALER_RECORDS=false); no file will be written.');
  }

  /** Whether this recorder reads and writes, or is inert. */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Drops all but the most recent `max` records, in memory and on disk.
   *
   * Called automatically on every write, and exposed so a caller can trim an existing
   * file to a different size — for example before archiving one.
   *
   * **A one-off trim, not a new setting.** Passing `max` does not change the recorder's
   * retention cap; the next write still applies whatever `HEALER_RECORDS_MAX` or the
   * constructor established. A method that reads as "trim this file" quietly reconfiguring
   * the object is the kind of surprise that only shows up much later, in a write nobody
   * connected to the call — so the cap is passed to the write instead, which is also what
   * makes it survive the merge against what is on disk.
   *
   * @param max - Records to keep for this trim. `0` keeps everything.
   * @returns How many were discarded.
   */
  prune(max: number = this.maxRecords): number {
    if (max <= 0 || this.records.length <= max) return 0;

    const dropped = this.records.length - max;
    this.records = this.records.slice(-max);
    this.persistToFile(max);

    this.log.info(`Pruned ${dropped} old record(s), keeping the most recent ${max}.`);
    return dropped;
  }

  /**
   * Records one attempt and writes the report.
   *
   * Never throws: a healing run must not fail because the audit log is unwritable
   * (read-only checkout, missing directory, locked file).
   *
   * @param record - The attempt to persist.
   */
  recordHeal(record: HealRecord): void {
    this.records.push(record);

    this.log.debug(
      `Recording ${record.success ? 'successful' : 'failed'} heal for ` +
        `"${record.originalSelector}" (${record.file}:${record.line}).`
    );

    this.persistToFile();
  }

  /**
   * Every record held in memory, including any merged in from other workers.
   *
   * A copy is returned so callers cannot mutate the recorder's state by accident.
   *
   * @returns The records, oldest first.
   */
  getRecords(): HealRecord[] {
    return [...this.records];
  }

  /**
   * Computes the report statistics.
   *
   * @param records - Records to summarise. Defaults to what is in memory.
   * @returns Counts, token totals, and mean confidence. All zero for no records.
   */
  getStatistics(records: HealRecord[] = this.records): HealingStatistics {
    const total = records.length;

    // Guard the divisions: an average over zero records is NaN, which serialises
    // to `null` in JSON and breaks anything reading the report.
    if (total === 0) {
      return {
        totalHeals: 0,
        successfulHeals: 0,
        failedHeals: 0,
        successRate: 0,
        totalTokensUsed: 0,
        tokenBreakdown: { input: 0, output: 0 },
        averageConfidence: 0,
      };
    }

    let successfulHeals = 0;
    let input = 0;
    let output = 0;
    let confidenceSum = 0;

    for (const record of records) {
      if (record.success) successfulHeals += 1;
      // Records written by an older version may lack these fields entirely.
      input += record.tokens?.input ?? 0;
      output += record.tokens?.output ?? 0;
      confidenceSum += record.confidence ?? 0;
    }

    return {
      totalHeals: total,
      successfulHeals,
      failedHeals: total - successfulHeals,
      successRate: successfulHeals / total,
      totalTokensUsed: input + output,
      tokenBreakdown: { input, output },
      averageConfidence: confidenceSum / total,
    };
  }

  /**
   * Clears in-memory records and deletes the report file.
   *
   * @returns True when the file was removed or was already absent.
   */
  reset(): boolean {
    this.records = [];

    try {
      if (fs.existsSync(this.filePath)) {
        fs.rmSync(this.filePath);
        this.log.info(`Cleared ${this.filePath}.`);
      }
      return true;
    } catch (error) {
      this.log.error(`Failed to reset: ${this.describe(error)}`);
      return false;
    }
  }

  /** Absolute path the report is written to. */
  getFilePath(): string {
    return this.filePath;
  }

  /**
   * Writes the report: lock, merge with what is on disk, rename into place.
   *
   * The merge is what makes parallel workers safe — each write picks up records
   * added by other processes since this one last read the file, so nothing is
   * silently dropped. Records are de-duplicated because a worker's own entries are
   * present both in memory and (after an earlier write) on disk.
   *
   * @param cap - Records to keep for **this** write. Defaults to the recorder's own
   * retention cap; {@link prune} passes its own so a one-off trim survives the merge
   * without becoming a permanent setting.
   */
  private persistToFile(cap: number = this.maxRecords): void {
    // The single gate for `HEALER_RECORDS=false`. Placed here rather than in `recordHeal`
    // so the in-memory list and `getStatistics()` still work for anything reading them
    // inside the worker — only the disk is left alone. No file, no lock file, no write.
    if (!this.enabled) return;

    if (this.warnAboutSourceControl) warnIfUnignored(this.filePath);

    // The directory first, because the lock file goes *in* it. Locking first meant the
    // very first write to a new directory spent the whole retry budget failing to create
    // a lock in a path that did not exist, then gave up and warned — 3,181ms against 12ms,
    // measured. Which is a poor welcome for `HEALING_RECORDS_PATH=../artifacts/records.json`,
    // the setting this package now recommends.
    try {
      const directory = path.dirname(this.filePath);
      if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
    } catch (error) {
      // Reported by the write below, which is where the real failure belongs.
      this.log.debug(`Could not create the records directory: ${this.describe(error)}`);
    }

    const locked = this.acquireLock();
    const temporary = `${this.filePath}.${process.pid}.tmp`;

    try {
      const onDisk = this.readRecords();
      let merged = this.mergeRecords(onDisk, this.records);

      // Bounded on the way out, so the next write stays as cheap as this one. Trimming
      // the oldest is the right end to lose: the recent rewrites are the ones anyone
      // acts on.
      if (cap > 0 && merged.length > cap) {
        merged = merged.slice(-cap);
      }

      // Adopt the merged view so in-memory statistics reflect the whole run.
      this.records = merged;

      const report: HealingReport = {
        timestamp: new Date().toISOString(),
        ...this.getStatistics(merged),
        records: merged,
      };

      // Write-then-rename: a reader either sees the old report or the new one,
      // never a partially written file.
      fs.writeFileSync(temporary, JSON.stringify(report, null, 2), 'utf8');
      this.publish(temporary);
    } catch (error) {
      this.log.error(`Failed to persist: ${this.describe(error)}`);

      // Do not leave the scratch file behind if the rename never happened.
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        // Nothing more to do — the write already failed.
      }
    } finally {
      if (locked) this.releaseLock();
    }
  }

  /**
   * Loads existing records from disk into memory.
   *
   * Accepts the current report format, a bare array of records, and the JSON Lines
   * format written by an earlier version — an unreadable file starts a fresh run
   * rather than aborting.
   */
  private loadFromFile(): void {
    this.records = this.readRecords();

    if (this.records.length) {
      this.log.debug(`Loaded ${this.records.length} existing record(s) from ${this.filePath}.`);
    }
  }

  /**
   * Reads and parses the records currently on disk.
   *
   * @returns The records found, or an empty array if the file is absent or unreadable.
   */
  private readRecords(): HealRecord[] {
    try {
      if (!fs.existsSync(this.filePath)) return [];

      const content = fs.readFileSync(this.filePath, 'utf-8').trim();
      if (!content) return [];

      // Current format: a report object wrapping the records. A JSON Lines file
      // also starts with '{', so a parse failure here is not an error — it falls
      // through to the line-by-line reader below.
      if (content.startsWith('{')) {
        try {
          const parsed = JSON.parse(content) as Partial<HealingReport>;
          return Array.isArray(parsed.records) ? parsed.records : [];
        } catch {
          // Not one object — try JSON Lines.
        }
      }

      // A bare array of records.
      if (content.startsWith('[')) {
        const parsed = JSON.parse(content) as HealRecord[];
        return Array.isArray(parsed) ? parsed : [];
      }

      // JSON Lines, one record per line.
      const records: HealRecord[] = [];
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          records.push(JSON.parse(trimmed) as HealRecord);
        } catch {
          // Skip a truncated final line from a killed worker.
        }
      }
      return records;
    } catch (error) {
      this.log.warn(`Could not read ${this.filePath}, starting fresh: ${this.describe(error)}`);
      return [];
    }
  }

  /**
   * Combines two record lists, dropping duplicates.
   *
   * @param existing - Records already on disk.
   * @param incoming - Records held in memory.
   * @returns The union, disk order first.
   */
  private mergeRecords(existing: HealRecord[], incoming: HealRecord[]): HealRecord[] {
    const seen = new Set(existing.map((record) => this.identity(record)));
    const merged = [...existing];

    for (const record of incoming) {
      const key = this.identity(record);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(record);
    }

    return merged;
  }

  /**
   * Builds a de-duplication key for a record.
   *
   * The timestamp alone is not unique enough (two workers can record in the same
   * millisecond), so the location and both selectors are included.
   *
   * @param record - Record to key.
   * @returns A stable identity string.
   */
  private identity(record: HealRecord): string {
    return [
      record.timestamp,
      record.file,
      record.line,
      record.originalSelector,
      record.suggestedSelector,
      record.success,
    ].join('|');
  }

  /**
   * Moves the finished temporary file into place, retrying a transient refusal.
   *
   * See {@link RENAME_RETRIES} for what goes wrong and why retrying is the whole fix.
   * Only the last failure is rethrown, to the caller that already knows how to report a
   * persist failure and clean up the scratch file.
   *
   * @param temporary - Path of the file to publish.
   * @throws Whatever the final attempt threw.
   */
  private publish(temporary: string): void {
    for (let attempt = 1; ; attempt++) {
      try {
        fs.renameSync(temporary, this.filePath);
        if (attempt > 1) {
          this.log.debug(`Published the records file on attempt ${attempt}.`);
        }
        return;
      } catch (error) {
        if (attempt >= RENAME_RETRIES) throw error;

        // `EPERM`/`EACCES`/`EBUSY` is something holding the destination open for a
        // moment. Anything else — a missing directory, a read-only checkout — will not
        // improve by waiting, so it is reported immediately.
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw error;

        this.sleepSync(RENAME_RETRY_MS);
      }
    }
  }

  /** Path of the lock file guarding {@link filePath}. */
  private get lockPath(): string {
    return `${this.filePath}.lock`;
  }

  /**
   * Takes the write lock, waiting briefly for another worker to finish.
   *
   * Uses exclusive file creation (`wx`), which is atomic across processes. After the
   * retry budget it gives up and proceeds anyway: losing the lock is better than
   * dropping a record, and the merge step still protects most of the content.
   *
   * @returns True if the lock is held and must be released.
   */
  private acquireLock(): boolean {
    for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
      try {
        fs.closeSync(fs.openSync(this.lockPath, 'wx'));
        return true;
      } catch {
        // Clear a lock left behind by a crashed worker.
        try {
          const age = Date.now() - fs.statSync(this.lockPath).mtimeMs;
          if (age > STALE_LOCK_MS) {
            this.log.warn(`Removing stale lock (${Math.round(age)}ms old).`);
            fs.rmSync(this.lockPath, { force: true });
            continue;
          }
        } catch {
          // The lock vanished between the failed open and the stat — retry.
        }

        // Jittered, so colliding workers do not retry in lockstep.
        this.sleepSync(LOCK_RETRY_MS + Math.floor(Math.random() * LOCK_JITTER_MS));
      }
    }

    this.log.warn('Could not acquire the record lock; writing without it.');
    return false;
  }

  /** Releases the write lock, ignoring an already-removed lock file. */
  private releaseLock(): void {
    try {
      fs.rmSync(this.lockPath, { force: true });
    } catch (error) {
      this.log.debug(`Could not remove the lock file: ${this.describe(error)}`);
    }
  }

  /**
   * Blocks the thread briefly.
   *
   * `recordHeal` is synchronous by design — callers treat recording as
   * fire-and-forget — so the lock wait cannot be a promise. `Atomics.wait` on a
   * throwaway buffer is the only true synchronous sleep in Node.
   *
   * @param ms - Milliseconds to wait.
   */
  private sleepSync(ms: number): void {
    const buffer = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buffer, 0, 0, ms);
  }

  /**
   * Renders an unknown thrown value as a message.
   *
   * @param error - Whatever was thrown.
   * @returns A readable description.
   */
  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
