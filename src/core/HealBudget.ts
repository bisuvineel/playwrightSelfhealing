/**
 * Puts a ceiling on what one worker will spend, and stops calling a provider that is down.
 *
 * Two failures this guards against, both of which turn a healer from a convenience into a
 * liability:
 *
 * **Runaway cost.** A suite with 400 rotted selectors makes 400 provider calls with no
 * ceiling. The money is real but modest; the wall clock is the problem, because every one
 * of those calls sits in the middle of a test.
 *
 * **An outage.** If the provider is unreachable, every failing action still waits
 * `HEALER_TIMEOUT` × `HEALER_MAX_RETRIES` before giving up — so with the defaults a
 * five-minute suite becomes an hour, and every single test fails anyway. Detecting that
 * once and then not asking again is worth far more than any retry policy.
 *
 * ## Scope: per worker, deliberately
 *
 * Playwright runs workers as separate processes with no shared memory, so a true
 * per-*run* budget would need the same lock-file dance as the records file — coordinating
 * a counter on every heal, for a number that only has to be approximately right. The
 * budget is therefore per worker, and the effective ceiling is
 * `HEALER_MAX_HEALS × workers`. That is documented rather than hidden, because a cap that
 * silently means four times what it says is worse than no cap.
 *
 * ## Cached reuses are free
 *
 * The budget counts heals that **reach the provider**. A reuse from `SelectorCache` costs
 * nothing and makes no call, so it is never refused — which means an exhausted budget
 * degrades into "keep using what you already learned" rather than "stop healing".
 *
 * @module core/HealBudget
 */

import { createLogger, type Logger } from '../utils/logger';

/** Settings for one worker's budget and breaker. */
export interface HealBudgetPolicy {
  /**
   * Heals that may reach the provider, per worker. `0` means no ceiling.
   *
   * Cached reuses do not count against it.
   */
  maxHeals: number;
  /**
   * Consecutive provider failures before this worker stops calling out. `0` disables the
   * breaker.
   *
   * Counted in **attempts**, not heals, so an outage is detected in roughly
   * `threshold ÷ HEALER_MAX_RETRIES` failing actions rather than waiting for whole heals
   * to exhaust their retries first.
   */
  breakerThreshold: number;
}

/** Why a heal was refused before anything was spent. */
export interface BudgetRefusal {
  /** Machine-readable cause. */
  kind: 'budget' | 'breaker';
  /** Human-readable explanation, surfaced as the `heal-skipped` annotation. */
  reason: string;
}

/** Counters for the run summary. */
export interface HealBudgetStats {
  /** Heals that reached the provider. */
  spent: number;
  /** Heals refused because the ceiling was reached. */
  refusedByBudget: number;
  /** Heals refused because the breaker was open. */
  refusedByBreaker: number;
  /** Whether the breaker is currently open. */
  breakerOpen: boolean;
}

/**
 * One worker's spend ceiling and provider circuit breaker.
 */
export class HealBudget {
  private readonly policy: HealBudgetPolicy;
  private readonly log: Logger;

  private spent = 0;
  private refusedByBudget = 0;
  private refusedByBreaker = 0;
  private consecutiveFailures = 0;
  private breakerOpen = false;

  /**
   * @param policy - Ceiling and breaker threshold. Defaults leave both off, so an engine
   * built without a policy behaves as it did before this existed.
   */
  constructor(policy: HealBudgetPolicy = { maxHeals: 0, breakerThreshold: 0 }) {
    this.policy = policy;
    this.log = createLogger('heal:budget');
  }

  /**
   * Decides whether a heal may reach the provider.
   *
   * The breaker is checked first: when the provider is down, saying so is more useful
   * than reporting a budget that was never the problem.
   *
   * @returns `null` when the heal may proceed, or why it may not.
   */
  check(): BudgetRefusal | null {
    if (this.breakerOpen) {
      this.refusedByBreaker += 1;
      return {
        kind: 'breaker',
        reason:
          `the provider failed ${this.policy.breakerThreshold} times in a row, so this worker ` +
          'stopped calling it — healing is off for the rest of this worker rather than ' +
          'timing out on every remaining action',
      };
    }

    if (this.policy.maxHeals > 0 && this.spent >= this.policy.maxHeals) {
      this.refusedByBudget += 1;
      return {
        kind: 'budget',
        reason:
          `this worker has used its ceiling of ${this.policy.maxHeals} provider-backed ` +
          'heal(s) (HEALER_MAX_HEALS) — cached selectors still apply, but nothing new will ' +
          'be requested',
      };
    }

    return null;
  }

  /**
   * Records that a heal is about to reach the provider.
   *
   * Counted on the way out rather than on success, because a heal that fails has still
   * cost wall-clock time and possibly tokens.
   *
   * **Once per heal, not once per attempt.** The engine may make up to `HEALER_MAX_RETRIES`
   * provider calls while healing one selector, and charging each of them would make a
   * ceiling of 100 mean 50 — a setting that is named, configured, documented and reported
   * in heals has to be counted in heals. The breaker below is the deliberate opposite: it
   * counts attempts, which is what lets it catch an outage in half a failing action.
   */
  spend(): void {
    this.spent += 1;

    if (this.policy.maxHeals > 0 && this.spent === this.policy.maxHeals) {
      this.log.warn(
        `Reached the ceiling of ${this.policy.maxHeals} provider-backed heal(s) for this ` +
          'worker. Further heals will be skipped and annotated; cached selectors still apply.'
      );
    }
  }

  /**
   * Records one failed provider attempt, and opens the breaker if enough have failed
   * back to back.
   *
   * "Provider failure" means the call itself did not work — network, credential, timeout.
   * A low-confidence answer or a rejected suggestion is **not** a failure here: the
   * provider is working fine and the breaker must not trip on a model simply being unsure.
   */
  recordProviderFailure(): void {
    if (this.policy.breakerThreshold <= 0 || this.breakerOpen) return;

    this.consecutiveFailures += 1;

    if (this.consecutiveFailures >= this.policy.breakerThreshold) {
      this.breakerOpen = true;
      this.log.error(
        `The provider failed ${this.consecutiveFailures} times in a row. Healing is now off ` +
          'for this worker, so the rest of the suite fails fast instead of waiting on every ' +
          'action. Set HEALER_BREAKER_THRESHOLD=0 to disable this.'
      );
    }
  }

  /** Records a provider call that worked, clearing the consecutive-failure count. */
  recordProviderSuccess(): void {
    this.consecutiveFailures = 0;
  }

  /** Whether the breaker has tripped. */
  get isBreakerOpen(): boolean {
    return this.breakerOpen;
  }

  /** Counters for the run summary. */
  stats(): HealBudgetStats {
    return {
      spent: this.spent,
      refusedByBudget: this.refusedByBudget,
      refusedByBreaker: this.refusedByBreaker,
      breakerOpen: this.breakerOpen,
    };
  }

  /**
   * One-line description of the policy, for the startup log.
   *
   * @returns Something like `ceiling 100 heal(s)/worker, breaker after 5 failure(s)`.
   */
  describe(): string {
    const parts = [
      this.policy.maxHeals > 0
        ? `ceiling ${this.policy.maxHeals} provider-backed heal(s) per worker`
        : 'no ceiling',
      this.policy.breakerThreshold > 0
        ? `breaker after ${this.policy.breakerThreshold} consecutive failure(s)`
        : 'no breaker',
    ];
    return parts.join(', ');
  }

  /** Resets everything. Used by tests. */
  reset(): void {
    this.spent = 0;
    this.refusedByBudget = 0;
    this.refusedByBreaker = 0;
    this.consecutiveFailures = 0;
    this.breakerOpen = false;
  }
}
