/**
 * A guided tour of everything healing puts in the Playwright report.
 *
 * ```
 * npx playwright test tests/report-example.spec.ts --project=chromium
 * npx playwright show-report
 * ```
 *
 * **No API key and no network are needed.** The provider is scripted, so each test
 * produces one specific report state on demand:
 *
 * | Test                             | Annotation      | What the report shows                      |
 * |----------------------------------|-----------------|--------------------------------------------|
 * | heals on the first attempt       | `healed`        | old → new, confidence, tokens, intent checks|
 * | heals after a rejected guess     | `healed`        | 2 attempts; the rejected one and why        |
 * | reuses a selector from the cache | `healed`        | `via cache`, 0 tokens                       |
 * | wrong element, right shape       | `heal-failed`   | rejected on intent, not on validation       |
 * | confidence below threshold       | `heal-failed`   | the suggestion and the threshold it missed  |
 * | provider call fails              | `heal-failed`   | the provider error, verbatim                |
 * | route excluded by policy         | `heal-blocked`  | why nothing was transmitted                 |
 *
 * Each test also carries a `healing-*.json` attachment with the full per-attempt detail,
 * each heal appears as a boxed step in the trace, and the run ends with the reporter
 * summary — including the selector rewrites worth committing.
 *
 * The provider is scripted rather than real, so this file demonstrates the **reporting**,
 * not the model's judgement. It is the failure paths that the demo suite cannot show: the
 * demo only ever heals successfully.
 *
 * `heal-unavailable` is the one state not scripted here, because it is what the whole
 * suite does with no credential — see `HEALER_ENABLED=false npm test`.
 */

import {
  test,
  expect,
  setHealingEngine,
  resetHealingEngine,
  HealingEngine,
  HealingRecorder,
  PrivacyGuard,
  SelectorCache,
  type HealConfig,
  type HealingRequest,
  type HealingResponse,
} from '../src/index';

import * as os from 'os';
import * as path from 'path';

/**
 * A checkout form whose ids have moved on since the tests below were written.
 *
 * Two identically named "Cancel" buttons are deliberate: any suggestion naming Cancel is
 * ambiguous, so the validator rejects it and the report shows a second attempt.
 */
const PAGE = `<!doctype html>
<html>
  <head><title>Checkout</title></head>
  <body>
    <h1>Checkout</h1>
    <form>
      <label for="promo-code-v4">Promo code</label>
      <input id="promo-code-v4" name="promo" data-testid="promo" type="text" />

      <label for="newsletter-v4">Email me offers</label>
      <input type="checkbox" id="newsletter-v4" data-testid="newsletter" />

      <button id="place-order-v4" data-testid="place-order" type="button">Place order</button>
      <button id="cancel-a" type="button">Cancel</button>
      <button id="cancel-b" type="button">Cancel</button>
    </form>
  </body>
</html>`;

/** A suggestion, shaped as a provider returns one. */
function suggest(
  selector: string,
  confidence: number,
  reasoning: string,
  extra: { expectedRole?: string; expectedName?: string } = {}
): HealingResponse {
  return {
    suggestedSelector: selector,
    confidence,
    reasoning,
    ...extra,
    tokenUsage: { input: 1_180, output: 42 },
    provider: 'scripted:demo',
  };
}

/** Matches both Cancel buttons, so the validator must refuse it. */
const AMBIGUOUS = "getByRole('button', { name: 'Cancel' })";

/**
 * Per-selector scripts. The engine is shared, so the *selector* decides what happens —
 * which keeps this file free of per-test global state.
 */
const SCRIPT: Record<string, Array<() => HealingResponse>> = {
  // Clean first-time heal.
  '#submit-order': [
    () => suggest("getByTestId('place-order')", 0.96, 'The only button that submits the form.', {
      expectedRole: 'button',
      expectedName: 'Place order',
    }),
  ],

  // First answer matches two elements and is rejected; the second works. The attachment
  // shows both attempts and the reason the first was refused.
  '#promo': [
    () => suggest(AMBIGUOUS, 0.91, 'Guessing from the button row.'),
    () => suggest("getByTestId('promo')", 0.89, 'Input labelled "Promo code".', {
      expectedRole: 'textbox',
      expectedName: 'Promo code',
    }),
  ],

  // Its own selector, so the count below measures this test rather than inheriting a
  // cache entry from the one above — the cache is per worker and deliberately outlives a
  // single test.
  '#promo-legacy': [
    () => suggest("getByTestId('promo')", 0.92, 'Input labelled "Promo code".', {
      expectedRole: 'textbox',
      expectedName: 'Promo code',
    }),
  ],

  // Unique, visible, and the wrong element — rejected on intent rather than validation.
  // This is the false-green case: without the intent check the test would pass.
  '#place-order-btn': [
    () => suggest("getByRole('button', { name: 'Cancel' }).first()", 0.94, 'A button I am sure exists.', {
      expectedRole: 'button',
      expectedName: 'Cancel',
    }),
  ],

  // Answers, but not confidently enough to be trusted.
  '#newsletter-opt-in': [
    () => suggest("getByTestId('newsletter')", 0.4, 'Weak evidence; unsure.'),
  ],

  // The provider itself fails. The wording deliberately avoids naming a real fault like
  // "invalid API key": this string reaches the run summary, where it would otherwise read
  // as a genuine credential problem and send someone hunting for a key that is fine.
  '#mystery-widget': [
    () => {
      throw new Error('SCRIPTED DEMO FAILURE — not a real credential problem');
    },
  ],
};

/** How many times each selector has been asked about, so scripts advance in order. */
const asked = new Map<string, number>();

/** A provider that answers from {@link SCRIPT} and never touches the network. */
const scripted = {
  async heal(request: HealingRequest): Promise<HealingResponse> {
    const steps = SCRIPT[request.originalSelector];
    if (!steps) throw new Error(`No script for "${request.originalSelector}"`);

    const index = asked.get(request.originalSelector) ?? 0;
    asked.set(request.originalSelector, index + 1);

    return steps[Math.min(index, steps.length - 1)]!();
  },
  async validateConfig(): Promise<boolean> {
    return true;
  },
} as never;

const CONFIG: HealConfig = {
  enabled: true,
  maxRetries: 2,
  timeout: 5_000,
  provider: 'scripted',
  model: 'scripted-demo',
  confidenceThreshold: 0.7,
  privacy: { redact: 'identifiers', blockedPaths: ['/checkout.html'] },
  intent: { mode: 'enforce', unverifiedConfidence: 0.9 },
  cache: true,
};

// Installed in beforeAll rather than at module scope, and undone afterwards. The engine is
// per-worker module state, and a worker can run several spec files — leaving a scripted
// provider installed would hijack the real demo suite if it ran here next.
test.beforeAll(() => {
  setHealingEngine(
    new HealingEngine(CONFIG, scripted, {
      guard: new PrivacyGuard(CONFIG.privacy!),
      cache: new SelectorCache(true),
      // Keep the tour out of the project's real records file.
      recorder: new HealingRecorder(path.join(os.tmpdir(), 'shp-report-example.json')),
    })
  );
});

test.afterAll(() => {
  resetHealingEngine();
});

test.beforeEach(async ({ page }) => {
  asked.clear();
  await page.setContent(PAGE);
});

test.describe('what the report shows', () => {
  test('heals on the first attempt', async ({ page }) => {
    await page.locator('#submit-order').describe('the button that submits the order').click();

    // Proof the healed selector acted on the intended element.
    await expect(page.locator('#place-order-v4')).toBeVisible();
  });

  test('heals after a rejected guess', async ({ page }) => {
    // The first suggestion matches both Cancel buttons; the attachment shows why it was
    // refused and what the second attempt proposed.
    await page.locator('#promo').describe('the promo code field').fill('SUMMER25');

    await expect(page.locator('#promo-code-v4')).toHaveValue('SUMMER25');
  });

  test('reuses a selector from the cache', async ({ page }) => {
    // Two actions on the same stale selector: the first heals, the second is annotated
    // `via cache` with zero tokens and makes no provider call.
    await page.locator('#promo-legacy').describe('the promo code field').fill('FIRST');
    await page.locator('#promo-legacy').describe('the promo code field').fill('SECOND');

    await expect(page.locator('#promo-code-v4')).toHaveValue('SECOND');

    // The point of the cache: two failed actions, one provider call.
    expect(asked.get('#promo-legacy')).toBe(1);
  });

  test('refuses a wrong element that would otherwise have passed', async ({ page }) => {
    // Unique, visible, clickable — and Cancel, not Place order. Validation accepts it;
    // the intent check does not, so the original error is re-thrown.
    await expect(
      page.locator('#place-order-btn').describe('the button that submits the order').click({ timeout: 2_000 })
    ).rejects.toThrow(/place-order-btn/);
  });

  test('refuses a suggestion below the confidence threshold', async ({ page }) => {
    await expect(
      page.locator('#newsletter-opt-in').describe('the newsletter checkbox').check({ timeout: 2_000 })
    ).rejects.toThrow(/newsletter-opt-in/);
  });

  test('reports a provider failure without inventing a cause', async ({ page }) => {
    await expect(
      page.locator('#mystery-widget').describe('a widget that no longer exists').click({ timeout: 2_000 })
    ).rejects.toThrow(/mystery-widget/);
  });

  test('transmits nothing on a route the policy excludes', async ({ page }) => {
    // `/checkout.html` is in blockedPaths, so the page is never even read. Reported as
    // `heal-blocked` rather than `heal-failed`: a policy decision, not a model failure.
    await page.goto('/checkout.html');

    await expect(
      page.locator('#submit-order').describe('the button that submits the order').click({ timeout: 2_000 })
    ).rejects.toThrow(/submit-order/);

    // Nothing was asked of the provider.
    expect(asked.get('#submit-order')).toBeUndefined();
  });
});
