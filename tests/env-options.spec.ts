/**
 * A working demonstration of every healer setting in `.env.example`.
 *
 * ```
 * npx playwright test tests/env-options.spec.ts
 * ```
 *
 * **No API key and no network.** One local server plays two roles: it serves the page
 * under test *and* stands in for the Anthropic Messages API. That second role is what
 * makes this more than a demo — the server keeps every request body, so a test can assert
 * on **what actually left the process**. The privacy settings are checked against the real
 * outbound payload rather than against a unit-tested function in isolation.
 *
 * Serving the page over HTTP also matters: `HEALER_ALLOWED_ORIGINS` and
 * `HEALER_BLOCKED_PATHS` match on a URL, and `page.setContent()` gives you `about:blank`,
 * against which neither setting can be demonstrated at all.
 *
 * ## How each test works
 *
 * Settings are read when the engine is built, so each test sets its environment, calls
 * `resetHealingEngine()` to discard the cached engine, then `attachHealing(page)` to build
 * a fresh one. `HEALER_SKIP_DOTENV=1` is set for the whole file so a developer's own `.env`
 * cannot change a result.
 *
 * The baseline is deliberately boring — `HEALER_CACHE=false` and `HEALER_MAX_RETRIES=1` —
 * so a request count means exactly one thing. Tests that exercise the cache or the retry
 * loop set those themselves.
 *
 * ## What is NOT covered here
 *
 * `BROWSER`, `HEADLESS` and `SHOW_BROWSER` are consumed by `playwright.config.ts`, not by
 * the healer, so they cannot be exercised from inside a test that is already running in a
 * browser. `HEALER_PROVIDER=openai|gemini` is covered by `tests/unit/provider-errors.test.js`
 * against a local server in the same way.
 */

import { test, expect, type Page, type TestInfo } from '@playwright/test';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

// Before anything reads configuration: a developer's own .env must not reach these tests.
process.env.HEALER_SKIP_DOTENV = '1';

import {
  attachHealing,
  resetHealingEngine,
  assertNoHeals,
  HEAL_ANNOTATIONS,
} from '../src/index';

// ---------------------------------------------------------------------------
// The page under test
// ---------------------------------------------------------------------------

/**
 * A notes form whose ids have moved on, plus a table of data worth redacting.
 *
 * Three deliberate features:
 * - `#save` and `#save-notes` are both stale; the app now has `#save-notes-v2`. Two names
 *   for one button is deliberate: `#save` yields a single content token, which is enough to
 *   *confirm* a heal but not to *reject* one, while `#save-notes` yields two and can.
 * - A second button named "Cancel" is a plausible wrong answer, for the intent tests.
 * - The table sits **outside** `#form`, so `HEALER_SNAPSHOT_ROOT=#form` can be shown to
 *   exclude it — and it holds an email and a name, so each redaction level has something
 *   distinct to remove.
 */
const PAGE = `<!doctype html>
<html><head><title>Notes</title></head>
<body>
  <div id="form">
    <label for="notes-v2">Notes</label>
    <textarea id="notes-v2"></textarea>
    <button id="save-notes-v2">Save</button>
    <button id="cancel-v2">Cancel</button>
  </div>
  <table>
    <tr><td>Smith, John</td><td>jane.roe@example.com</td></tr>
  </table>
</body></html>`;

// ---------------------------------------------------------------------------
// The stand-in provider
// ---------------------------------------------------------------------------

/** One recorded call to the fake Messages API. */
interface Call {
  /** The `model` field, so `ANTHROPIC_MODEL` can be checked. */
  model: string;
  /** The user prompt verbatim — this is what actually left the process. */
  prompt: string;
}

/** What the fake API should do next. */
interface Script {
  /** Selector to suggest. */
  selector?: string;
  /** Confidence to report. Defaults to 0.95. */
  confidence?: number;
  /** Role the model claims, for the self-consistency check. */
  expectedRole?: string;
  /** Answer with this HTTP status instead of a suggestion. */
  status?: number;
  /** Wait this long before answering, for the timeout test. */
  delayMs?: number;
}

let server: http.Server;
let base: string;
let calls: Call[] = [];
let script: Script = {};

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    // Role 1: the Anthropic Messages API.
    if (req.url?.endsWith('/messages')) {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const body = JSON.parse(raw) as { model: string; messages: Array<{ content: string }> };
        calls.push({ model: body.model, prompt: body.messages[0]?.content ?? '' });

        const answer = (): void => {
          if (script.status) {
            res.writeHead(script.status, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'scripted' } }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    suggestedSelector: script.selector ?? "getByRole('button', { name: 'Save' })",
                    confidence: script.confidence ?? 0.95,
                    reasoning: 'the save button',
                    ...(script.expectedRole ? { expectedRole: script.expectedRole } : {}),
                  }),
                },
              ],
              usage: { input_tokens: 700, output_tokens: 90 },
            })
          );
        };

        if (script.delayMs) setTimeout(answer, script.delayMs);
        else answer();
      });
      return;
    }

    // Role 2: the page under test. Every other path serves the same HTML, so a test can
    // choose a URL that a route policy will accept or refuse.
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// ---------------------------------------------------------------------------
// Per-test environment
// ---------------------------------------------------------------------------

/** Every variable these tests touch, cleared between cases. */
const OWNED = [
  'HEALER_ENABLED', 'HEALER_PROVIDER', 'HEALER_THRESHOLD', 'HEALER_MAX_RETRIES',
  'HEALER_TIMEOUT', 'HEALER_CACHE', 'HEALER_MAX_HEALS', 'HEALER_BREAKER_THRESHOLD',
  'HEALER_RECORDS_MAX', 'HEALER_FAIL_ON_HEAL', 'HEALER_INTENT_CHECK',
  'HEALER_UNVERIFIED_CONFIDENCE', 'HEALER_REDACT', 'HEALER_REDACT_PATTERNS_FILE',
  'HEALER_SNAPSHOT_ROOT', 'HEALER_ALLOWED_ORIGINS', 'HEALER_BLOCKED_PATHS',
  'HEALER_PRIVACY_PREVIEW', 'HEALING_LOGS', 'HEALING_RECORDS_PATH', 'HEALER_RECORDS',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'ANTHROPIC_BASE_URL',
];

let saved: Record<string, string | undefined> = {};
let scratch: string;

test.beforeEach(() => {
  saved = {};
  for (const name of OWNED) {
    saved[name] = process.env[name];
    delete process.env[name];
  }

  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'shp-env-'));

  // The baseline. Cache off and one attempt, so a request count is unambiguous.
  process.env.HEALER_ENABLED = 'true';
  process.env.HEALER_PROVIDER = 'anthropic';
  process.env.HEALER_CACHE = 'false';
  process.env.HEALER_MAX_RETRIES = '1';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-demo-not-a-real-key';
  process.env.ANTHROPIC_MODEL = 'claude-haiku-4-5';
  process.env.ANTHROPIC_BASE_URL = `${base}/v1`;
  process.env.HEALING_RECORDS_PATH = path.join(scratch, 'records.json');

  calls = [];
  script = {};
  resetHealingEngine();
});

test.afterEach(() => {
  for (const name of OWNED) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  resetHealingEngine();
  fs.rmSync(scratch, { recursive: true, force: true });
});

/**
 * Loads the page and attaches healing built from the environment as it stands now.
 *
 * @param page - Playwright page.
 * @param route - Path to load, so a route-policy test can pick a URL.
 * @returns The decorated page.
 */
async function open(page: Page, route = '/forms/notes'): Promise<Page> {
  await page.goto(`${base}${route}`);
  return attachHealing(page);
}

/**
 * Clicks the stale selector, swallowing the failure.
 *
 * The action is expected to fail without healing, so every test drives it the same way and
 * asserts on what the healer did rather than on whether the click threw.
 *
 * @param page - Decorated page.
 * @returns Whether the click ultimately succeeded.
 */
async function clickStale(page: Page): Promise<boolean> {
  try {
    await page.locator('#save').describe('the save button').click({ timeout: 600 });
    return true;
  } catch {
    return false;
  }
}

/** The healing annotations this test produced. */
function annotations(info: TestInfo): Array<{ type: string; description?: string }> {
  const wanted: string[] = Object.values(HEAL_ANNOTATIONS);
  return info.annotations.filter((a) => wanted.includes(a.type));
}

/** The single annotation type this test produced, for a one-line assertion. */
function annotationType(info: TestInfo): string | undefined {
  return annotations(info)[0]?.type;
}

// ---------------------------------------------------------------------------
// The master switch
// ---------------------------------------------------------------------------

test.describe('HEALER_ENABLED', () => {
  test('false runs as plain Playwright and contacts nobody', async ({ page }, info) => {
    process.env.HEALER_ENABLED = 'false';

    expect(await clickStale(await open(page))).toBe(false);
    expect(calls, 'nothing should have been sent').toHaveLength(0);
    expect(annotationType(info)).toBe(HEAL_ANNOTATIONS.unavailable);
  });

  test('true heals the stale selector', async ({ page }, info) => {
    expect(await clickStale(await open(page))).toBe(true);
    expect(calls).toHaveLength(1);
    expect(annotationType(info)).toBe(HEAL_ANNOTATIONS.healed);
  });
});

// ---------------------------------------------------------------------------
// Cost and effort
// ---------------------------------------------------------------------------

test.describe('HEALER_THRESHOLD', () => {
  test('rejects a suggestion below the bar', async ({ page }, info) => {
    process.env.HEALER_THRESHOLD = '0.9';
    script = { confidence: 0.6 };

    expect(await clickStale(await open(page))).toBe(false);
    expect(annotationType(info)).toBe(HEAL_ANNOTATIONS.failed);
    expect(annotations(info)[0]?.description).toContain('0.6');
  });

  test('accepts the same suggestion when the bar is lower', async ({ page }) => {
    process.env.HEALER_THRESHOLD = '0.5';
    script = { confidence: 0.6 };

    expect(await clickStale(await open(page))).toBe(true);
  });
});

test.describe('HEALER_MAX_RETRIES', () => {
  test('bounds the attempts for one failing action', async ({ page }) => {
    process.env.HEALER_MAX_RETRIES = '3';
    // Never resolves to one element, so every attempt is used.
    script = { selector: "getByRole('button')" };

    expect(await clickStale(await open(page))).toBe(false);
    expect(calls, 'one call per attempt').toHaveLength(3);
  });
});

test.describe('HEALER_TIMEOUT', () => {
  test('gives up on a slow provider, and stops asking', async ({ page }, info) => {
    process.env.HEALER_TIMEOUT = '1000';
    process.env.HEALER_MAX_RETRIES = '1';
    script = { delayMs: 4_000 };

    expect(await clickStale(await open(page))).toBe(false);
    expect(annotationType(info)).toBe(HEAL_ANNOTATIONS.failed);
    // One request, not a chain of abandoned retries — the 0.4.1 cancellation fix.
    expect(calls).toHaveLength(1);
  });
});

test.describe('HEALER_CACHE', () => {
  test('true pays for the same selector once', async ({ page }) => {
    process.env.HEALER_CACHE = 'true';
    const decorated = await open(page);

    await clickStale(decorated);
    await clickStale(decorated);

    expect(calls, 'the second heal came from the cache').toHaveLength(1);
  });

  test('false asks again every time', async ({ page }) => {
    process.env.HEALER_CACHE = 'false';
    const decorated = await open(page);

    await clickStale(decorated);
    await clickStale(decorated);

    expect(calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Ceilings
// ---------------------------------------------------------------------------

test.describe('HEALER_MAX_HEALS', () => {
  test('skips a heal past the ceiling instead of failing the healer', async ({ page }, info) => {
    process.env.HEALER_MAX_HEALS = '1';
    const decorated = await open(page);

    await clickStale(decorated);
    await clickStale(decorated);

    expect(calls, 'the ceiling stopped the second call').toHaveLength(1);
    const types = annotations(info).map((a) => a.type);
    expect(types).toContain(HEAL_ANNOTATIONS.skipped);
    expect(annotations(info).find((a) => a.type === HEAL_ANNOTATIONS.skipped)?.description)
      .toContain('HEALER_MAX_HEALS');
  });

  test('0 removes the ceiling', async ({ page }) => {
    process.env.HEALER_MAX_HEALS = '0';
    const decorated = await open(page);

    await clickStale(decorated);
    await clickStale(decorated);

    expect(calls).toHaveLength(2);
  });
});

test.describe('HEALER_BREAKER_THRESHOLD', () => {
  test('stops calling a provider that keeps failing', async ({ page }, info) => {
    process.env.HEALER_BREAKER_THRESHOLD = '2';
    process.env.HEALER_MAX_RETRIES = '4';
    script = { status: 500 };

    const decorated = await open(page);
    await clickStale(decorated);

    // Counted in provider *failures*, not HTTP requests: `httpJson` retries a 500 twice on
    // its own, so one failed attempt is three requests. What matters is that the fourth
    // attempt was never made — the breaker opened after two and abandoned the rest.
    const afterFirst = calls.length;
    expect(afterFirst, 'two attempts, each retried by httpJson').toBe(6);

    await clickStale(decorated);
    expect(calls.length, 'the next heal made no call at all').toBe(afterFirst);
    expect(annotations(info).map((a) => a.type)).toContain(HEAL_ANNOTATIONS.skipped);
  });
});

// ---------------------------------------------------------------------------
// Is it the right element?
// ---------------------------------------------------------------------------

test.describe('HEALER_INTENT_CHECK', () => {
  /** A wrong element that passes every other gate: unique, visible, clickable. */
  const wrongElement: Script = { selector: "getByRole('button', { name: 'Cancel' })" };

  /**
   * Clicks a stale selector carrying **two** content words.
   *
   * `#save` alone yields the single token `save`, and the lexical check deliberately
   * declines to *reject* on one word — a one-word intent is as likely to be an unhelpful
   * identifier as a real signal, so confirming needs one token and rejecting needs two.
   * With only `save` to go on, nothing here can refuse Cancel and the heal falls through to
   * the confidence floor, which 0.95 clears. That asymmetry is by design, and a locator
   * named like a real one is what makes the check bite.
   *
   * @param page - Decorated page.
   * @returns Whether the click succeeded.
   */
  async function clickDescriptive(page: Page): Promise<boolean> {
    try {
      await page.locator('#save-notes').describe('the button that saves the notes').click({ timeout: 600 });
      return true;
    } catch {
      return false;
    }
  }

  test('enforce rejects a plausible wrong element', async ({ page }, info) => {
    process.env.HEALER_INTENT_CHECK = 'enforce';
    script = wrongElement;

    expect(await clickDescriptive(await open(page)), 'Cancel is not the save button').toBe(false);
    expect(annotationType(info)).toBe(HEAL_ANNOTATIONS.failed);
  });

  test('off accepts it — which is the risk the default guards against', async ({ page }) => {
    process.env.HEALER_INTENT_CHECK = 'off';
    script = wrongElement;

    expect(await clickDescriptive(await open(page)), 'the wrong button was clicked').toBe(true);
  });

  test('warn accepts it but records the concern', async ({ page }, info) => {
    process.env.HEALER_INTENT_CHECK = 'warn';
    script = wrongElement;

    expect(await clickDescriptive(await open(page))).toBe(true);
    expect(annotations(info)[0]?.description).toContain('WARNING');
  });
});

test.describe('HEALER_UNVERIFIED_CONFIDENCE', () => {
  /**
   * Clicks a selector nothing can be inferred from — no role, no wording, no describe().
   *
   * @param page - Decorated page.
   * @returns Whether the click succeeded.
   */
  async function clickOpaque(page: Page): Promise<boolean> {
    try {
      await page.locator('#x7f3').click({ timeout: 600 });
      return true;
    } catch {
      return false;
    }
  }

  test('raises the bar when nothing about a heal can be checked', async ({ page }) => {
    process.env.HEALER_UNVERIFIED_CONFIDENCE = '0.9';
    script = { confidence: 0.8 };

    expect(await clickOpaque(await open(page))).toBe(false);
  });

  test('lets the same heal through when the floor is lower', async ({ page }) => {
    process.env.HEALER_UNVERIFIED_CONFIDENCE = '0.7';
    script = { confidence: 0.8 };

    expect(await clickOpaque(await open(page))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Privacy — asserted against what the server actually received
// ---------------------------------------------------------------------------

test.describe('HEALER_REDACT', () => {
  test('off transmits the page as it stands', async ({ page }) => {
    process.env.HEALER_REDACT = 'off';
    await clickStale(await open(page));

    expect(calls[0]?.prompt).toContain('jane.roe@example.com');
    expect(calls[0]?.prompt).toContain('Smith, John');
  });

  test('identifiers strips structured identifiers but cannot catch a name', async ({ page }) => {
    process.env.HEALER_REDACT = 'identifiers';
    await clickStale(await open(page));

    expect(calls[0]?.prompt, 'the email is structured').not.toContain('jane.roe@example.com');
    // Stated plainly rather than glossed: no regex matches a name.
    expect(calls[0]?.prompt, 'a name is not').toContain('Smith, John');
  });

  test('strict collapses the name too, and keeps the button label', async ({ page }) => {
    process.env.HEALER_REDACT = 'strict';
    await clickStale(await open(page));

    expect(calls[0]?.prompt).not.toContain('jane.roe@example.com');
    expect(calls[0]?.prompt, 'a cell is not actionable').not.toContain('Smith, John');
    // Actionable names survive, or nothing could be healed.
    expect(calls[0]?.prompt, 'a button label is the healing signal').toContain('Save');
  });
});

test.describe('HEALER_SNAPSHOT_ROOT', () => {
  test('scopes the capture, so the table never leaves', async ({ page }) => {
    process.env.HEALER_SNAPSHOT_ROOT = '#form';
    process.env.HEALER_REDACT = 'off';

    expect(await clickStale(await open(page))).toBe(true);
    expect(calls[0]?.prompt).toContain('Save');
    expect(calls[0]?.prompt, 'the table is outside #form').not.toContain('Smith, John');
  });

  test('blocks the heal when the root does not resolve, rather than widening', async ({ page }, info) => {
    process.env.HEALER_SNAPSHOT_ROOT = '#no-such-container';

    expect(await clickStale(await open(page))).toBe(false);
    expect(calls, 'nothing was captured, so nothing was sent').toHaveLength(0);
    expect(annotationType(info)).toBe(HEAL_ANNOTATIONS.blocked);
  });
});

test.describe('HEALER_ALLOWED_ORIGINS', () => {
  test('refuses an origin that is not on the list', async ({ page }, info) => {
    process.env.HEALER_ALLOWED_ORIGINS = 'https://cleared.example.com';

    expect(await clickStale(await open(page))).toBe(false);
    expect(calls).toHaveLength(0);
    expect(annotationType(info)).toBe(HEAL_ANNOTATIONS.blocked);
    expect(annotations(info)[0]?.description).toContain('HEALER_ALLOWED_ORIGINS');
  });

  test('allows a listed origin', async ({ page }) => {
    process.env.HEALER_ALLOWED_ORIGINS = `127.0.0.1,${base}`;

    expect(await clickStale(await open(page))).toBe(true);
  });
});

test.describe('HEALER_BLOCKED_PATHS', () => {
  test('refuses a matching path whatever the origin', async ({ page }, info) => {
    process.env.HEALER_BLOCKED_PATHS = '/patients/**';

    expect(await clickStale(await open(page, '/patients/884213701'))).toBe(false);
    expect(calls).toHaveLength(0);
    expect(annotationType(info)).toBe(HEAL_ANNOTATIONS.blocked);
  });

  test('leaves other paths alone', async ({ page }) => {
    process.env.HEALER_BLOCKED_PATHS = '/patients/**';

    expect(await clickStale(await open(page, '/forms/notes'))).toBe(true);
  });

  test('takes precedence over an allowed origin', async ({ page }) => {
    process.env.HEALER_ALLOWED_ORIGINS = base;
    process.env.HEALER_BLOCKED_PATHS = '/patients/**';

    expect(await clickStale(await open(page, '/patients/884213701'))).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

test.describe('HEALER_REDACT_PATTERNS_FILE', () => {
  test('applies rules of your own, on top of the built-ins', async ({ page }) => {
    const file = path.join(scratch, 'patterns.json');
    fs.writeFileSync(file, JSON.stringify(['\\bSmith, John\\b']));
    process.env.HEALER_REDACT_PATTERNS_FILE = file;
    process.env.HEALER_REDACT = 'identifiers';

    await clickStale(await open(page));

    expect(calls[0]?.prompt, 'the custom rule caught what identifiers cannot')
      .not.toContain('Smith, John');
    expect(calls[0]?.prompt, 'the built-ins still applied').not.toContain('jane.roe@example.com');
  });
});

test.describe('HEALER_PRIVACY_PREVIEW', () => {
  test('writes the payload, sends nothing, and needs no credential', async ({ page }, info) => {
    const dir = path.join(scratch, 'preview');
    process.env.HEALER_PRIVACY_PREVIEW = dir;
    delete process.env.ANTHROPIC_API_KEY;

    expect(await clickStale(await open(page)), 'no heal can succeed in preview mode').toBe(false);
    expect(calls, 'no provider was contacted').toHaveLength(0);
    expect(annotationType(info)).toBe(HEAL_ANNOTATIONS.blocked);

    const written = fs.readdirSync(dir);
    expect(written).toHaveLength(1);
    const payload = fs.readFileSync(path.join(dir, written[0]!), 'utf8');
    expect(payload).toContain('NOTHING WAS TRANSMITTED');
    expect(payload, 'the real prompt is reproduced verbatim').toContain('Save');
  });
});

// ---------------------------------------------------------------------------
// The CI gate, records, and logging
// ---------------------------------------------------------------------------

test.describe('HEALER_FAIL_ON_HEAL', () => {
  test('turns a successful heal into a failure carrying the edit', async ({ page }) => {
    process.env.HEALER_FAIL_ON_HEAL = 'true';

    expect(await clickStale(await open(page))).toBe(true);

    // The gate runs in fixture teardown; called directly here so the assertion is visible.
    expect(() => assertNoHeals()).toThrow(/HEALER_FAIL_ON_HEAL/);
  });

  test('is inert when unset', async ({ page }) => {
    expect(await clickStale(await open(page))).toBe(true);
    expect(() => assertNoHeals()).not.toThrow();
  });

  test('gates every page in a test, not just the last one decorated', async ({ page, context }) => {
    // A popup, a second tab, an OAuth window, a print preview. Decorating the second page
    // used to discard every heal from the first, so the gate reported one where two had
    // happened — silently, and only in tests that span pages.
    process.env.HEALER_FAIL_ON_HEAL = 'true';

    await clickStale(await open(page));

    // A *different* stale selector on the second page. The gate reports one edit per
    // distinct rewrite, so healing `#save` twice would legitimately count once and would
    // not tell us whether the first page survived.
    const second = await context.newPage();
    script = { selector: "getByRole('button', { name: 'Cancel' })" };
    const decorated = await open(second);
    try {
      await decorated.locator('#cancel').click({ timeout: 600 });
    } catch {
      // The gate is what is under test, not the click.
    }

    let reported = 0;
    try {
      assertNoHeals();
    } catch (error) {
      reported = Number((String((error as Error).message).match(/and (\d+) selector/) ?? [])[1] ?? -1);
    }

    expect(reported, 'both pages should be gated').toBe(2);
  });

  test('says so when it cannot read the setting, instead of disarming quietly', async ({ page }) => {
    // `HEALER_FAIL_ON_HEAL=${CI}` in a .env file lands here: dotenv does not expand it, so
    // the value is the literal string. The gate used to return in silence, leaving a run
    // ungated with nothing anywhere saying so.
    process.env.HEALER_FAIL_ON_HEAL = '${CI}';

    await clickStale(await open(page));

    const errors: string[] = [];
    const saved = console.error;
    console.error = (line) => errors.push(String(line));
    try {
      expect(() => assertNoHeals(), 'a bad value must not fail the suite').not.toThrow();
    } finally {
      console.error = saved;
    }

    const said = errors.join(' ');
    expect(said, 'the gate must announce that it is off').toMatch(/HEALER_FAIL_ON_HEAL/);
    expect(said).toMatch(/gate is OFF/);
  });
});

test.describe('HEALER_RECORDS_MAX', () => {
  test('bounds the records file', async ({ page }) => {
    process.env.HEALER_RECORDS_MAX = '2';
    process.env.HEALER_MAX_HEALS = '0';
    const decorated = await open(page);

    for (let i = 0; i < 4; i++) await clickStale(decorated);

    const report = JSON.parse(fs.readFileSync(process.env.HEALING_RECORDS_PATH!, 'utf8'));
    expect(report.records.length).toBeLessThanOrEqual(2);
  });

  test('keeps everything at 0', async ({ page }) => {
    process.env.HEALER_RECORDS_MAX = '0';
    const decorated = await open(page);

    for (let i = 0; i < 3; i++) await clickStale(decorated);

    const report = JSON.parse(fs.readFileSync(process.env.HEALING_RECORDS_PATH!, 'utf8'));
    expect(report.records.length).toBe(3);
  });
});

test.describe('HEALER_RECORDS', () => {
  test('false writes no file, and no lock file either', async ({ page }) => {
    process.env.HEALER_RECORDS = 'false';

    expect(await clickStale(await open(page)), 'healing still works').toBe(true);
    expect(fs.existsSync(process.env.HEALING_RECORDS_PATH!), 'no report file').toBe(false);
    expect(fs.existsSync(`${process.env.HEALING_RECORDS_PATH}.lock`), 'no lock file').toBe(false);
  });

  test('the heal is still reported everywhere else', async ({ page }, info) => {
    // The switch trades the unredacted rewrite for the per-heal cost. It does not make a
    // heal invisible: the annotation, the attachment and the CI gate are all unaffected.
    process.env.HEALER_RECORDS = 'false';
    process.env.HEALER_FAIL_ON_HEAL = 'true';

    await clickStale(await open(page));

    expect(annotationType(info)).toBe(HEAL_ANNOTATIONS.healed);
    expect(() => assertNoHeals()).toThrow(/HEALER_FAIL_ON_HEAL/);
  });

  test('is not the same setting as HEALER_RECORDS_MAX=0', async ({ page }) => {
    // 0 means unlimited and always has — the trap this switch exists to avoid.
    process.env.HEALER_RECORDS_MAX = '0';

    await clickStale(await open(page));
    expect(fs.existsSync(process.env.HEALING_RECORDS_PATH!), 'still recording').toBe(true);
  });

  test('records by default', async ({ page }) => {
    await clickStale(await open(page));

    const report = JSON.parse(fs.readFileSync(process.env.HEALING_RECORDS_PATH!, 'utf8'));
    expect(report.records.length).toBeGreaterThan(0);
    // Unredacted, which is the whole reason the file exists.
    expect(report.records[0].suggestedSelector).toContain('Save');
  });
});

test.describe('ANTHROPIC_MODEL', () => {
  test('is the model the request is actually made against', async ({ page }) => {
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-6';

    await clickStale(await open(page));
    expect(calls[0]?.model).toBe('claude-sonnet-4-6');
  });
});

test.describe('HEALING_LOGS', () => {
  test('false silences the narration but never a warning', async ({ page }) => {
    process.env.HEALING_LOGS = 'false';

    const lines: string[] = [];
    const saved = { log: console.log, warn: console.warn };
    console.log = (line) => lines.push(`log ${String(line)}`);
    console.warn = (line) => lines.push(`warn ${String(line)}`);

    try {
      // A rejected suggestion, so there is both narration and a warning to observe.
      script = { selector: "getByRole('button')" };
      await clickStale(await open(page));
    } finally {
      Object.assign(console, saved);
    }

    const healerNarration = lines.filter((l) => l.startsWith('log ') && l.includes('[heal:'));
    const healerWarnings = lines.filter((l) => l.startsWith('warn ') && l.includes('[heal:'));

    expect(healerNarration, 'narration should be silenced').toHaveLength(0);
    expect(healerWarnings.length, 'a rejection is a finding, not narration').toBeGreaterThan(0);
  });
});
