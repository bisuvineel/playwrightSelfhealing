/**
 * Path normalisation shared by everything that shows or sends a source location.
 *
 * A source location reaches three audiences, and the absolute path suits none of them.
 * A **report annotation** gets a line longer than the message attached to it. A **CI log**
 * gets a directory layout nobody reading it has. And an outbound **prompt** gets the
 * account name and the organisation name off the machine that ran the suite —
 * `D:\Users\<account>\OneDrive - <organisation>\…` — which is real disclosure with no
 * benefit, since the model reasons about the page rather than the filesystem.
 *
 * So there is one function, used by all three. It is normalisation rather than redaction:
 * it applies at every `HEALER_REDACT` level, including `off`, because the project-relative
 * form is simply the better value in each case.
 *
 * @module utils/paths
 */

import * as path from 'path';

/**
 * Shortens a file path against the working directory, when it is inside it.
 *
 * A path outside the project keeps its original form rather than growing a run of `..`
 * segments, which would be both longer and harder to read than the absolute path it
 * replaced. Separators are normalised to forward slashes so a location looks the same in a
 * report written on Windows and one written in CI.
 *
 * @param file - Absolute or already-relative path. `'unknown'` and empty pass through,
 * since those are the engine's own fallbacks for a stack it could not read.
 * @returns A project-relative path with forward slashes, or the input unchanged.
 */
export function relativeToProject(file: string): string {
  if (!file || file === 'unknown') return file;

  const relative = path.relative(process.cwd(), file);

  return relative && !relative.startsWith('..') ? relative.replace(/\\/g, '/') : file;
}
