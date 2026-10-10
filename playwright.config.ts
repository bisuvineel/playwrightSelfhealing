/**
 * Playwright config for the demo suite.
 *
 * Two healer-related lines, both marked below: the reporter, and a test timeout wide
 * enough for healing to finish. Everything else is an ordinary Playwright config.
 */

import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:4173';

/**
 * `BROWSER`, `HEADLESS` and `SHOW_BROWSER` are read here, not through `getConfig()`.
 *
 * `getConfig()` throws when healing is enabled without a credential, and a Playwright
 * config that cannot be *loaded* without an API key would break `HEALER_ENABLED=false`
 * runs — the one thing that has to work with no setup at all. These three are simple
 * enough to parse directly.
 *
 * They were documented in `.env.example` and parsed into `Config.playwright` from the
 * start, and consumed by nothing: this file hardcoded `headless: false` and `chromium`.
 */
const truthy = (value: string | undefined): boolean =>
  ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());

const falsy = (value: string | undefined): boolean =>
  ['0', 'false', 'no', 'off'].includes((value ?? '').trim().toLowerCase());

const SHOW_BROWSER = truthy(process.env.SHOW_BROWSER);
// A request to watch the browser wins over any headless setting — same precedence
// `config.ts` applies.
const HEADLESS = SHOW_BROWSER ? false : !falsy(process.env.HEADLESS);

const BROWSERS = {
  chromium: devices['Desktop Chrome'],
  firefox: devices['Desktop Firefox'],
  webkit: devices['Desktop Safari'],
} as const;

const BROWSER = (process.env.BROWSER ?? 'chromium').trim().toLowerCase();
const PROJECT = BROWSER in BROWSERS ? (BROWSER as keyof typeof BROWSERS) : 'chromium';

if (PROJECT !== BROWSER) {
  console.warn(`[config] BROWSER="${BROWSER}" is not one of chromium, firefox, webkit — using chromium.`);
}

export default defineConfig({
  testDir: './tests',

  // Only the browser suite. `tests/unit/` holds Node-runner tests (`*.test.js`) which
  // Playwright's default testMatch would otherwise try to run as specs; they are run
  // by `npm run test:unit` and need no browser.
  testMatch: '**/*.spec.ts',

  // Healing runs AFTER an action fails and spends the same test budget:
  //   actionTimeout + (HEALER_MAX_RETRIES × HEALER_TIMEOUT) + the retried action.
  // Five stale selectors in one test means five heals, so this is deliberately roomy.
  timeout: 120_000,

  expect: { timeout: 5_000 },

  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Spread in rather than set to `undefined`: omitting the key lets Playwright pick its
  // own default, which is what "undefined" was trying to say. The same idiom the rest of
  // this repo uses for optional fields, and now enforced by `exactOptionalPropertyTypes`.
  ...(process.env.CI ? { workers: 1 } : {}),

  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    // Healer summary: healed/failed counts, token spend, and the selector rewrites
    // worth committing back into the page objects.
    ['./src/reporters/HealingReporter.ts'],
  ],

  use: {
    baseURL: BASE_URL,
    trace: 'on',
    screenshot: 'only-on-failure',
    // Honours HEADLESS / SHOW_BROWSER — see the note at the top of this file.
    headless: HEADLESS,
    // Short, so a stale selector fails fast and healing starts sooner.
    actionTimeout: 5_000,
    navigationTimeout: 10_000,
    ignoreHTTPSErrors: true,
  },

  // Honours BROWSER. One project, so a run targets the browser you asked for rather
  // than every browser — the demo is a demonstration, not a compatibility matrix.
  projects: [{ name: PROJECT, use: { ...BROWSERS[PROJECT] } }],

  webServer: {
    command: 'node app/server.js',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
