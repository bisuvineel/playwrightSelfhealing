#!/usr/bin/env node
/**
 * Runs the healing corpus against a **real** model, and prints the accuracy.
 *
 * `npm run test:live` measures two things offline: whether the intended element is
 * reachable at all, and whether the engine heals from a given answer. Neither says
 * whether a model *picks* the right element — that needs a real call, and a number
 * produced without one would be invented.
 *
 * This is the opt-in that produces it. It costs money: one provider call per corpus
 * case, plus retries for any that fail.
 *
 *   npm run test:corpus
 *
 * Requires a configured provider — the same `.env` a normal run uses. Existing to set
 * one environment variable is not much of a reason to exist; the reason is that setting
 * one portably from an npm script is not possible without a dependency, and `HEALER_
 * CORPUS_LIVE=1 node --test ...` does not work on Windows, which is where most of this
 * package's users are.
 */

'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const CORPUS = path.join('tests', 'live', 'corpus.test.js');

const result = spawnSync(process.execPath, ['--test', CORPUS], {
  stdio: 'inherit',
  env: { ...process.env, HEALER_CORPUS_LIVE: '1' },
});

if (result.error) {
  console.error(`[corpus] could not start the test runner: ${result.error.message}`);
  process.exit(1);
}

// Propagate the runner's own exit code, including a signal death, so CI sees the truth.
process.exit(result.status === null ? 1 : result.status);
