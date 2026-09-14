/**
 * The framework's fixtures — and the only file that knows healing exists.
 *
 * Healing is added by spreading `healingFixtures` into this project's own
 * `base.extend()` call, alongside the page-object fixtures. Specs and page objects are
 * completely unaware of it.
 *
 * This is pattern 1 from the healer's INTEGRATION.md. It applies because this framework
 * does not override the `page` fixture itself; if it did, it would use `withHealing()`
 * or call `attachHealing()` inside its own page fixture instead.
 */

import { test as base, expect } from '@playwright/test';
import { healingFixtures, type HealingFixtures } from './src/index';

import { CartPage } from './pages/CartPage';
import { CheckoutPage } from './pages/CheckoutPage';
import { PaymentFramePage } from './pages/PaymentFramePage';

/** Page objects this framework exposes to its specs. */
type PageObjects = {
  cartPage: CartPage;
  checkoutPage: CheckoutPage;
  paymentFramePage: PaymentFramePage;
};


export const test = base.extend<HealingFixtures & PageObjects>({
  // Healing attaches to `page`. Everything below receives the healed page.
  ...healingFixtures,

  cartPage: async ({ page }, use) => {
    await use(new CartPage(page));
  },

  checkoutPage: async ({ page }, use) => {
    await use(new CheckoutPage(page));
  },

  paymentFramePage: async ({ page }, use) => {
    await use(new PaymentFramePage(page));
  },
});

export { expect };
