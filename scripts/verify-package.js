/**
 * Packs the tarball, installs it into throwaway projects, and smoke-tests it.
 *
 * This is the check that "anyone can install the zip and use it" is true rather than
 * assumed. It exercises what a consumer actually does — resolve the package by name,
 * import from it, and call into it — in both module systems:
 *
 *   1. CommonJS project  (`require('self-healing-playwright')`)
 *   2. ESM project       (`import … from 'self-healing-playwright'`, "type": "module")
 *
 * The ESM case is the one worth having: our build is CommonJS, so Node has to infer our
 * named exports by static analysis. This proves whether that works instead of guessing.
 *
 * Usage: npm run verify:package
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/**
 * Path to npm's JavaScript entry point.
 *
 * Running `node npm-cli.js …` avoids spawning `npm.cmd`, which recent Node refuses to
 * execute directly on Windows (EINVAL) and which would otherwise need `shell: true` —
 * and a shell re-parses arguments, breaking paths with spaces such as
 * "OneDrive - Norstella". `npm_execpath` is set for us because this runs as an npm
 * script; the fallback covers direct invocation.
 */
const NPM_CLI = process.env.npm_execpath ?? null;

/** Runs npm with the given arguments, echoing failures with their output. */
function npm(args, cwd) {
  if (!NPM_CLI) {
    throw new Error('Could not locate npm — run this through `npm run verify:package`.');
  }
  return run(process.execPath, [NPM_CLI, ...args], cwd);
}

/** Runs a command, echoing failures with their output. */
function run(command, args, cwd) {
  try {
    return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    console.error(`\n  command failed: ${command} ${args.join(' ')}`);
    console.error(error.stdout ?? '');
    console.error(error.stderr ?? '');
    throw error;
  }
}

/** Builds the tarball and returns its absolute path. */
function pack() {
  console.log('• building and packing…');
  const output = npm(['pack', '--silent'], ROOT).trim().split(/\r?\n/);
  const name = output[output.length - 1];
  const tarball = path.join(ROOT, name);

  if (!fs.existsSync(tarball)) throw new Error(`npm pack reported ${name} but the file is missing`);

  const sizeKb = Math.round(fs.statSync(tarball).size / 1024);
  console.log(`  ${name} (${sizeKb} KB)`);
  return tarball;
}

/**
 * Creates a consumer project, installs the tarball, and runs a script in it.
 *
 * @param label - Name for logging.
 * @param esm - Whether the project is `"type": "module"`.
 * @param tarball - Tarball to install.
 * @param source - Contents of the smoke-test script.
 */
function verifyConsumer(label, esm, tarball, source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `shp-${esm ? 'esm' : 'cjs'}-`));
  console.log(`\n• ${label}: ${dir}`);

  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'consumer', version: '1.0.0', private: true, ...(esm ? { type: 'module' } : {}) }, null, 2)
  );

  // Playwright is a peer dependency, so a real consumer installs it themselves.
  console.log('  installing @playwright/test and the tarball…');
  npm(['install', '--no-audit', '--no-fund', '@playwright/test@^1.62.1', tarball], dir);

  const installed = path.join(dir, 'node_modules', 'self-healing-playwright', 'package.json');
  if (!fs.existsSync(installed)) throw new Error('package did not install');

  const script = path.join(dir, esm ? 'smoke.mjs' : 'smoke.cjs');
  fs.writeFileSync(script, source);

  console.log('  running the smoke test…');
  const output = run(process.execPath, [script], dir);
  console.log(
    output
      .trim()
      .split(/\r?\n/)
      .map((line) => `    ${line}`)
      .join('\n')
  );

  // Leave nothing behind; a failed run keeps the directory for inspection.
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Smoke test written as CommonJS. */
const CJS_SMOKE = `
const pkg = require('self-healing-playwright');
const Reporter = require('self-healing-playwright/reporter');

const required = [
  'test', 'expect', 'healingFixtures', 'withHealing', 'attachHealing',
  'createHealingFixtures', 'createHealingEngine', 'HealingEngine', 'SelectorValidator',
  'AnthropicProvider', 'OpenAIProvider', 'GeminiProvider', 'HealingRecorder',
  'PromptBuilder', 'getConfig', 'HEAL_ANNOTATIONS',
  'PrivacyGuard', 'PrivacyBlockedError', 'IntentVerifier', 'SelectorCache', 'assertNoHeals',
];
const missing = required.filter((name) => typeof pkg[name] === 'undefined');
if (missing.length) throw new Error('missing exports: ' + missing.join(', '));
console.log('exports resolved: ' + required.length + '/' + required.length);

if (typeof (Reporter.default ?? Reporter) !== 'function') throw new Error('reporter subpath broken');
console.log('reporter subpath: ok');

// Exercise real behaviour, not just resolution.
const prompt = pkg.PromptBuilder.buildSystemPrompt();
if (!prompt.includes('Playwright')) throw new Error('prompt builder broken');
console.log('promptBuilder: ' + prompt.length + ' chars');

const validator = new pkg.SelectorValidator();
if (!validator.isValidSyntax("getByRole('button', { name: 'Submit' })")) throw new Error('validator broken');
if (validator.isValidSyntax('div[')) throw new Error('validator accepted malformed css');
console.log('selectorValidator: ok');

// The two gates must be live in the shipped artefact, with their strict defaults
// intact — a build that exported them but defaulted to permissive would pass a
// resolution check and quietly transmit page content.
const guard = new pkg.PrivacyGuard();
if (guard.level !== 'identifiers') throw new Error('privacy default is not identifiers');
const outbound = guard.sanitizeRequest({
  originalSelector: '#x',
  originalAction: 'click',
  ariaSnapshot: '- textbox "Email address": someone@hospital.example.com',
  pageUrl: 'https://app.test/patients/884213701?token=abc123',
  testFile: 'f.spec.ts',
  testLine: 1,
});
if (outbound.ariaSnapshot.includes('someone@hospital.example.com')) throw new Error('redaction not applied');
if (outbound.pageUrl.includes('token=abc123')) throw new Error('url query not dropped');
if (!outbound.ariaSnapshot.includes('Email address')) throw new Error('redaction destroyed the healing signal');
console.log('privacyGuard: ok (default ' + guard.level + ', signal preserved)');

const verifier = new pkg.IntentVerifier();
if (verifier.mode !== 'enforce') throw new Error('intent default is not enforce');
console.log('intentVerifier: ok (default ' + verifier.mode + ')');

// The cache changes cost, not outcomes — but a build where it silently remembered
// nothing would look identical and quietly cost 2x.
const cache = new pkg.SelectorCache(true);
cache.remember('#stale', { selector: "getByTestId('fresh')", confidence: 0.9 });
if (cache.candidates('#stale')[0].selector !== "getByTestId('fresh')") {
  throw new Error('selector cache remembers nothing');
}
if (new pkg.SelectorCache(false).candidates('#stale').length !== 0) {
  throw new Error('disabled cache still returns candidates');
}
console.log('selectorCache: ok');

// The CI gate must be inert by default, or every consumer's healed test starts failing.
pkg.assertNoHeals();
console.log('assertNoHeals: ok (inert by default)');

// The package must not read .env just by being imported.
if (process.env.HEALER_PROVIDER) throw new Error('importing the package leaked env vars');
console.log('no import side effects: ok');
`;

/** Smoke test written as ESM. */
const ESM_SMOKE = `
import pkg, { PromptBuilder, SelectorValidator, healingFixtures, withHealing, test, expect } from 'self-healing-playwright';
import Reporter from 'self-healing-playwright/reporter';

// Named imports from a CommonJS build rely on Node's static analysis — this is the
// case that decides whether a dual ESM build is needed.
const named = { PromptBuilder, SelectorValidator, healingFixtures, withHealing, test, expect };
const missing = Object.entries(named).filter(([, value]) => value === undefined).map(([name]) => name);
if (missing.length) throw new Error('named imports failed: ' + missing.join(', '));
console.log('named ESM imports: ' + Object.keys(named).length + '/' + Object.keys(named).length);

if (typeof pkg.createHealingEngine !== 'function') throw new Error('default interop broken');
console.log('default interop: ok');

if (typeof (Reporter.default ?? Reporter) !== 'function') throw new Error('reporter subpath broken');
console.log('reporter subpath: ok');

if (!PromptBuilder.buildSystemPrompt().includes('Playwright')) throw new Error('prompt builder broken');
console.log('promptBuilder: ok');

if (!new SelectorValidator().isValidSyntax('#ok')) throw new Error('validator broken');
console.log('selectorValidator: ok');
`;

function main() {
  const tarball = pack();

  try {
    verifyConsumer('CommonJS consumer', false, tarball, CJS_SMOKE);
    verifyConsumer('ESM consumer', true, tarball, ESM_SMOKE);
    console.log('\n✔ package verified in both CommonJS and ESM consumers');
    console.log(`  shareable artefact: ${path.basename(tarball)}`);
  } finally {
    // Keep the tarball: it is the deliverable.
  }
}

main();
