/**
 * Minimal level-filtered console logger shared by the framework.
 *
 * Playwright runs specs across several worker processes, so every line is
 * prefixed with its source to keep interleaved output attributable.
 *
 * @module utils/logger
 */

import { getLogLevel, type LogLevel } from '../config';

/** Log levels ordered least to most verbose. */
const LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

/** A prefixed logger with one method per level. */
export interface Logger {
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
  /** Logs at an explicit level — useful when the level is itself a variable. */
  log(level: LogLevel, message: string): void;
}

/**
 * Reads the configured level, falling back to `info` if `LOG_LEVEL` is invalid.
 *
 * A bad `LOG_LEVEL` must never stop us from reporting the real problem, so the
 * error is swallowed here rather than propagated into a log call.
 */
function currentLevel(): LogLevel {
  try {
    return getLogLevel();
  } catch {
    return 'info';
  }
}

/**
 * Whether the healer's own per-heal narration is wanted.
 *
 * `HEALING_LOGS=false` silences the running commentary — "Attempt 1/2", "Healed X -> Y",
 * "Reused from cache" — without touching `LOG_LEVEL`. The two are different questions: one
 * is *how verbose*, the other is *do I want this subsystem talking at all*. A suite that
 * heals fifty times produces fifty lines nobody reads, and turning `LOG_LEVEL` down to
 * `warn` to stop them would also silence everything else in the run.
 *
 * **Warnings and errors are never suppressed.** A blocked heal, a tripped breaker, a
 * missing `describe()` — those are findings, not narration, and a switch that hid them
 * would be a way to make problems invisible rather than quiet.
 *
 * Read per call and defaulting to `true`, so a malformed value cannot silence the healer.
 */
function healingLogsWanted(): boolean {
  const raw = process.env.HEALING_LOGS;
  if (raw === undefined) return true;

  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

/** Loggers whose informational output `HEALING_LOGS` governs. */
const HEALER_PREFIX = /^heal:/;

/**
 * Creates a logger that prefixes every message and honours `LOG_LEVEL`.
 *
 * The level is read per call rather than captured at creation, so tests can flip
 * `LOG_LEVEL` between cases without rebuilding their loggers.
 *
 * @param prefix - Short source tag, e.g. `heal:engine`.
 * @returns A {@link Logger} for that source.
 */
export function createLogger(prefix: string): Logger {
  const write = (level: LogLevel, message: string): void => {
    if (LEVEL_ORDER[level] > LEVEL_ORDER[currentLevel()]) return;

    // `HEALING_LOGS=false` silences the healer's narration only. Warnings and errors are
    // findings rather than commentary and always get through.
    const narration = level === 'info' || level === 'debug';
    if (narration && HEALER_PREFIX.test(prefix) && !healingLogsWanted()) return;

    const line = `[${prefix}] ${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };

  return {
    error: (message) => write('error', message),
    warn: (message) => write('warn', message),
    info: (message) => write('info', message),
    debug: (message) => write('debug', message),
    log: write,
  };
}
