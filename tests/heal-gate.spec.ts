/**
 * Integration coverage for the CI gate — the one path a Node test cannot reach.
 *
 * `assertNoHeals(true)` fails a test that only passed because a selector healed. It is
 * the control that stops healing from masking a regression, so it is worth a test that
 * actually exercises it. But heals are collected by `publishOutcome`, which returns
 * early when there is no `testInfo` — deliberately, because that is what makes
 * `attachHealing` safe to call from a global setup file. So the armed gate can only be
 * observed from inside a real Playwright test, which is this file.
 *
 * ```
 * npx playwright test tests/heal-gate.spec.ts --project=chromium
 * ```
 *
 * **No API key and no network.** The provider is a stub installed with
 * `setHealingEngine`, so the heal is real — decoration, validation, intent check,
 * retry — while the model is not.
 */

import {
  test,
  expect,
  setHealingEngine,
  resetHealingEngine,
  assertNoHeals,
  HealingEngine,
  SelectorCache,
  type HealConfig,
  type HealingRequest,
  type HealingResponse,
} from '../src/index';

/** A page whose button id has moved on, but whose test id has not. */
const PAGE = `<!doctype html>
<html>
  <body>
    <button data-testid="checkout">Proceed to checkout</button>
  </body>
</html>`;

/**
 * An engine that heals `#checkout-button` to the test id, without a network call.
 *
 * @returns A configured {@link HealingEngine}.
 */
function stubEngine(): HealingEngine {
  const config: HealConfig = {
    enabled: true,
    maxRetries: 1,
    timeout: 5_000,
    provider: 'stub',
    model: 'stub',
    confidenceThreshold: 0.7,
    privacy: { redact: 'identifiers' },
    intent: { mode: 'enforce', unverifiedConfidence: 0.9 },
    cache: false,
  };

  // Keyed by the stale selector, because the intent check is real: answering
  // `getByTestId('checkout')` for `#other-button` is rejected for sharing no vocabulary
  // with it, which is the check doing its job rather than the stub being unlucky.
  const answers: Record<string, string> = {
    '#checkout-button': "getByTestId('checkout')",
    '#checkout-link': "getByTestId('checkout-2')",
  };

  const provider = {
    async heal(request: HealingRequest): Promise<HealingResponse> {
      return {
        suggestedSelector: answers[request.originalSelector] ?? "getByTestId('checkout')",
        expectedRole: 'button',
        expectedName: 'Proceed to checkout',
        confidence: 0.95,
        reasoning: `scripted answer for ${request.originalSelector}`,
        tokenUsage: { input: 100, output: 20 },
        provider: 'stub',
      };
    },
    async validateConfig(): Promise<boolean> {
      return true;
    },
  };

  return new HealingEngine(config, provider as never, {
    recorder: { recordHeal() {} } as never,
    cache: new SelectorCache(false),
  });
}

test.describe('the fail-on-heal gate', () => {
  test.beforeEach(() => {
    setHealingEngine(stubEngine(), 'heal-gate.spec.ts');
  });

  test.afterEach(() => {
    resetHealingEngine();
    // Drain, so a heal from one test cannot arm the next one's assertion.
    assertNoHeals(false);
  });

  test('stays quiet when nothing healed', async ({ page }) => {
    await page.setContent(PAGE);
    await page.getByTestId('checkout').click();

    expect(() => assertNoHeals(true)).not.toThrow();
  });

  test('fails the test when armed and a selector healed', async ({ page }) => {
    await page.setContent(PAGE);

    // Stale: heals to getByTestId('checkout') and the click succeeds, so without the
    // gate this test passes while no longer matching the application.
    await page.locator('#checkout-button').click();

    let thrown: Error | null = null;
    try {
      assertNoHeals(true);
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown, 'an armed gate must fail a test that only passed by healing').not.toBeNull();
    // The message has to name the selector to fix and what to replace it with, or a CI
    // failure sends someone hunting.
    expect(thrown?.message).toContain('#checkout-button');
    expect(thrown?.message).toContain("getByTestId('checkout')");
  });

  test('heals anyway when disarmed, which is the local default', async ({ page }) => {
    await page.setContent(PAGE);
    await page.locator('#checkout-button').click();

    expect(() => assertNoHeals(false)).not.toThrow();
  });

  test('reports every distinct stale selector, not just the first', async ({ page }) => {
    // The gate runs in teardown precisely so one run lists everything worth fixing,
    // rather than stopping at the first. Distinct selectors, because the message
    // deduplicates: one stale selector in a shared page object is one edit, however
    // many tests touch it.
    await page.setContent(`<!doctype html>
      <html><body>
        <button data-testid="checkout">Proceed to checkout</button>
        <button data-testid="checkout-2">Proceed to checkout</button>
      </body></html>`);

    await page.locator('#checkout-button').click();
    await page.locator('#checkout-link').click();

    let thrown: Error | null = null;
    try {
      assertNoHeals(true);
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).not.toBeNull();
    expect(thrown?.message).toContain('#checkout-button');
    expect(thrown?.message).toContain('#checkout-link');
  });
});
