/**
 * Playwright reporter that summarises healing across a whole run.
 *
 * Per-test detail already reaches the HTML report as annotations and attachments (see
 * `TestWrapper`), but those are scattered across tests and, under parallel workers, no
 * single process sees them all. A reporter runs once in the main process and receives
 * every result, which makes it the only place a run-level summary can be correct.
 *
 * It reads two channels: **annotation types**, which are stable constants and carry the
 * counts, and the **`healing-*.json` attachments**, which are JSON and carry anything that
 * gets arithmetic done to it. Nothing here parses prose — an earlier version regexed token
 * counts out of the annotation text, so rewording a sentence elsewhere silently zeroed the
 * totals.
 *
 * Add it alongside the other reporters in `playwright.config.ts`:
 * ```ts
 * reporter: [['list'], ['html'], ['./src/reporters/HealingReporter.ts']]
 * ```
 *
 * @module reporters/HealingReporter
 */

import * as fs from 'fs';

import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';

import { getConfig } from '../config';
import { PrivacyGuard } from '../core/PrivacyGuard';
import { HEAL_ANNOTATIONS } from '../core/TestWrapper';
import { SharedSelectorStore } from '../core/SharedSelectorStore';

/** One healed selector, as reported by a test. */
interface HealEntry {
  test: string;
  detail: string;
}

/**
 * The machine-readable half of a heal, read from the `healing-*.json` attachment.
 *
 * Only the fields this reporter counts are named. Everything else in the attachment is
 * for a human or a custom script.
 */
interface HealingData {
  originalSelector?: string;
  healedSelector?: string | null;
  outcome?: string;
  cached?: boolean;
  described?: boolean | null;
  tokens?: { input?: number; output?: number; cached?: number };
}

/** Options accepted from the reporter tuple in `playwright.config.ts`. */
export interface HealingReporterOptions {
  /** Print the summary even when nothing healed. Default false. */
  always?: boolean;
}


/**
 * The annotations belonging to **this** result.
 *
 * `TestResult.annotations` is the per-result channel and is exactly what is wanted here.
 * `TestCase.annotations` is documented by Playwright as "`testResult.annotations` of the
 * **last** test run" — so under retries it is only ever right by an ordering assumption
 * about when `onTestEnd` fires relative to the next attempt starting. That assumption held
 * when it was measured, but it is the runner's business, not this reporter's, and the
 * attachments beside it were already being read per result.
 *
 * The fallback covers the older end of the supported peer range, where `TestResult` has no
 * `annotations` — reading nothing there would silently zero every count.
 *
 * @param test - The test case.
 * @param result - The result just finished.
 * @returns Annotations to count.
 */
function annotationsOf(test: TestCase, result: TestResult): TestCase['annotations'] {
  const perResult = (result as { annotations?: TestCase['annotations'] }).annotations;
  return perResult ?? test.annotations;
}

/**
 * Prints a healing summary when a run finishes.
 */
export default class HealingReporter implements Reporter {
  private healed: HealEntry[] = [];
  private failed: HealEntry[] = [];
  private blocked = new Map<string, number>();
  private skipped = new Map<string, number>();
  private unavailable = new Map<string, number>();
  private tokens = { input: 0, output: 0, cached: 0 };
  /** `#old → new` pairs, deduplicated across the run. */
  private rewrites = new Map<string, string>();
  /** Heals that reused a cached selector, so cost nothing. */
  private reused = 0;
  /** Heals where the locator carried a `describe()`. */
  private described = 0;
  /** Heals where it did not — the ones likeliest to have picked the wrong element. */
  private undescribed = 0;
  /** Results that were a retry, so the reader can explain a surprising total. */
  private retried = 0;
  /** Healing attachments parsed, so a missing one can be reported rather than hidden. */
  private attachmentsSeen = 0;

  /** This run's id, owned by this reporter only if it was the one to create it. */
  private readonly ownedRunId: string | null;

  /**
   * @param options - Output options.
   */
  constructor(private options: HealingReporterOptions = {}) {
    // Give the run an identity before any worker starts. This constructor runs in the
    // Playwright runner process, and workers are forked with the runner's environment —
    // confirmed in Playwright's own process host (`env: { ...process.env }`) — so every
    // worker of this run sees the same id and no other run does. That is what makes the
    // cross-worker selector cache exactly run-scoped. A value already set (by CI, say)
    // is respected, and then this reporter does not delete what it did not create.
    if (process.env.HEALER_RUN_ID === undefined) {
      this.ownedRunId = SharedSelectorStore.newRunId();
      process.env.HEALER_RUN_ID = this.ownedRunId;
    } else {
      this.ownedRunId = null;
    }
  }

  /**
   * Reporter API: collect what this test produced.
   *
   * Two channels, on purpose. **Annotation types** are stable constants, so they carry
   * the counts and the human-readable lines. **Attachments** are JSON, so they carry
   * everything that gets arithmetic done to it — tokens, rewrites, cache reuses.
   *
   * The numbers used to be regexed out of the annotation prose, which meant rewording a
   * sentence in `publishOutcome` silently zeroed the token totals with no error anywhere.
   */
  onTestEnd(test: TestCase, result: TestResult): void {
    for (const annotation of annotationsOf(test, result)) {
      const detail = annotation.description ?? '';

      if (annotation.type === HEAL_ANNOTATIONS.healed) {
        this.healed.push({ test: test.title, detail });
      } else if (annotation.type === HEAL_ANNOTATIONS.failed) {
        this.failed.push({ test: test.title, detail });
      } else if (annotation.type === HEAL_ANNOTATIONS.blocked) {
        this.blocked.set(detail, (this.blocked.get(detail) ?? 0) + 1);
      } else if (annotation.type === HEAL_ANNOTATIONS.skipped) {
        this.skipped.set(detail, (this.skipped.get(detail) ?? 0) + 1);
      } else if (annotation.type === HEAL_ANNOTATIONS.unavailable) {
        this.unavailable.set(detail, (this.unavailable.get(detail) ?? 0) + 1);
      }
    }

    for (const data of this.readHealingData(result)) {
      this.tokens.input += data.tokens?.input ?? 0;
      this.tokens.output += data.tokens?.output ?? 0;
      this.tokens.cached += data.tokens?.cached ?? 0;
      this.attachmentsSeen += 1;

      if (data.cached) this.reused += 1;

      // `describe()` is the strongest signal the model gets and it is optional, so the
      // split is worth seeing: it tells you where to spend effort improving the inputs.
      if (data.described === true) this.described += 1;
      else if (data.described === false) this.undescribed += 1;

      // Deduplicated across the run: the same page object drives many tests, but the
      // edit is still one edit.
      if (data.outcome === 'healed' && data.originalSelector && data.healedSelector) {
        this.rewrites.set(data.originalSelector, data.healedSelector);
      }
    }

    // A retried attempt re-runs the test, so it heals again and spends again — counting
    // both results is correct rather than double-counting. Tracked only so a surprising
    // total can explain itself.
    if (result.retry > 0) this.retried += 1;
  }

  /**
   * Reads the structured half of each heal from this result's attachments.
   *
   * `publishOutcome` attaches one `healing-<action>-<selector>.json` per healed action,
   * with a body. Playwright hands a reporter the body as a Buffer; `path` is read as a
   * fallback in case a future version or a blob reporter spills it to disk instead.
   *
   * Never throws: a malformed attachment must cost a number, not the whole summary.
   *
   * @param result - The result just finished.
   * @returns Parsed healing payloads, in attachment order.
   */
  private readHealingData(result: TestResult): HealingData[] {
    const found: HealingData[] = [];

    for (const attachment of result.attachments) {
      if (!attachment.name.startsWith('healing-')) continue;
      if (attachment.contentType !== 'application/json') continue;

      try {
        const raw = attachment.body
          ? attachment.body.toString('utf8')
          : attachment.path
            ? fs.readFileSync(attachment.path, 'utf8')
            : null;

        if (raw) found.push(JSON.parse(raw) as HealingData);
      } catch {
        // Ignored deliberately — see the note above.
      }
    }

    return found;
  }

  /**
   * Describes what this run transmitted, and under what policy.
   *
   * Printed whenever a heal actually happened. Healing sends page content to a third
   * party, and the run summary is the one place every operator looks — so "what left
   * this machine, to whom, and what was stripped first" belongs here rather than
   * buried in a configuration file nobody re-reads. Costs one line.
   *
   * @returns The disclosure line, or `null` if the configuration is unreadable.
   */
  private describeDisclosure(): string | null {
    try {
      const config = getConfig();
      const provider = config.healing.provider;
      const guard = new PrivacyGuard(config.privacy);

      // Read from configuration, like everything else this reporter counts.
      const gate = config.healing.failOnHeal
        ? '\n  HEALER_FAIL_ON_HEAL is set: every test below that healed was failed ' +
          'deliberately.\n  The failure message on each carries the edits to make.'
        : '';

      return (
        `  sent to: ${provider} · ${guard.describe()} · intent=${config.intent.mode}${gate}`
      );
    } catch {
      // A config too broken to read is already being reported elsewhere, and a
      // reporter must never be the thing that fails a run.
      return null;
    }
  }

  /** Reporter API: print the summary. */
  onEnd(): void {
    // The run is over, so what its workers shared goes with it. Never carried into the
    // next run — that would make rot cheap, which this package exists to prevent.
    if (this.ownedRunId !== null) SharedSelectorStore.removeRun(this.ownedRunId);

    const nothingHappened =
      this.healed.length === 0 &&
      this.failed.length === 0 &&
      this.blocked.size === 0 &&
      this.skipped.size === 0 &&
      this.unavailable.size === 0;

    if (nothingHappened && !this.options.always) return;

    const lines: string[] = ['', '  Self-healing summary', '  ' + '─'.repeat(60)];

    // Only when something was actually transmitted — announcing the redaction policy
    // on a run that sent nothing would be noise, and slightly misleading.
    if (this.healed.length > 0 || this.failed.length > 0) {
      const disclosure = this.describeDisclosure();
      if (disclosure) lines.push(disclosure, '');
    }

    if (this.blocked.size > 0) {
      lines.push('  Not sent (privacy policy):');
      for (const [reason, count] of this.blocked) {
        lines.push(`    • ${reason} (${count} time${count === 1 ? '' : 's'})`);
      }
      lines.push('');
    }

    if (this.skipped.size > 0) {
      // Separated from the privacy block above: nothing was wrong with the page, this is
      // a cost or availability decision, and the response to it is different.
      lines.push('  Skipped (spend ceiling or circuit breaker):');
      for (const [reason, count] of this.skipped) {
        lines.push(`    • ${reason} (${count} time${count === 1 ? '' : 's'})`);
      }
      lines.push('');
    }

    if (this.unavailable.size > 0) {
      lines.push('  Healing did not run:');
      for (const [reason, count] of this.unavailable) {
        lines.push(`    • ${reason} (${count} test${count === 1 ? '' : 's'})`);
      }
      lines.push('');
    }

    // Counted by occurrence, not by distinct reason — otherwise this number would
    // disagree with `healed` and `failed`, which count events.
    let blockedCount = 0;
    for (const count of this.blocked.values()) blockedCount += count;

    let skippedCount = 0;
    for (const count of this.skipped.values()) skippedCount += count;

    // `reused` is only meaningful next to the rest, so it is shown inline rather than
    // as its own line: 13 heals costing 7 calls is the story worth telling.
    const reuse = this.reused > 0 ? `    reused: ${this.reused}` : '';

    lines.push(
      `  healed: ${this.healed.length}    failed: ${this.failed.length}    ` +
        `blocked: ${blockedCount}` +
        `${skippedCount > 0 ? `    skipped: ${skippedCount}` : ''}${reuse}    ` +
        `tokens: ${this.tokens.input} in / ${this.tokens.output} out` +
        // Shown only when it happened: a cache that silently never engages looks exactly
        // like a working one in every other number.
        `${this.tokens.cached > 0 ? ` (${this.tokens.cached} of the input served from cache)` : ''}`
    );

    if (this.retried > 0) {
      // Otherwise a reader wonders why there are more heals than tests. A retried
      // attempt really does heal again and really does spend again.
      lines.push(
        `  (includes ${this.retried} retried attempt${this.retried === 1 ? '' : 's'}, ` +
          'which heal and spend again)'
      );
    }

    if (this.healed.length > 0 && this.attachmentsSeen === 0) {
      // Says so rather than quietly reporting zero tokens — the failure mode this
      // reporter used to have when an annotation was reworded.
      lines.push(
        '  (token totals unavailable: no healing attachments reached the reporter)'
      );
    }

    if (this.undescribed > 0) {
      lines.push(
        `  ${this.undescribed} of ${this.described + this.undescribed} heal(s) had no ` +
          'describe(). Those are the likeliest to have picked the wrong element —',
        '  adding a description to the locators that matter is the cheapest accuracy win.'
      );
    }

    if (this.healed.length > 0) {
      lines.push('', '  Healed:');
      for (const entry of this.healed) lines.push(`    ✔ ${entry.test}`, `        ${entry.detail}`);

      // The point of a healing run: the selector edits worth committing. Taken from the
      // attachments, so no amount of rewording the annotation can lose them.
      if (this.rewrites.size > 0) {
        lines.push('', '  Suggested source updates:');
        for (const [from, to] of this.rewrites) lines.push(`    ${from}  →  ${to}`);
      }
    }

    if (this.failed.length > 0) {
      lines.push('', '  Not healed:');
      for (const entry of this.failed) lines.push(`    ✘ ${entry.test}`, `        ${entry.detail}`);
    }

    lines.push('', '  Full per-attempt detail: healing-records.json, or the');
    lines.push('  healing-*.json attachments on each test in the HTML report.', '');

    console.log(lines.join('\n'));
  }

  /** Keeps the terminal output ordered ahead of Playwright's own summary. */
  printsToStdio(): boolean {
    return true;
  }

}
