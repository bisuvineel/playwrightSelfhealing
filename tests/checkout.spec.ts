/**
 * An ordinary POM test suite.
 *
 * Nothing in this file mentions healing. It imports `test` from the framework's
 * fixtures, drives page objects, and asserts on outcomes — exactly as it did before the
 * app was redesigned and its ids changed.
 *
 * Every action below goes through a selector that no longer exists. Without healing this
 * suite fails on its first click; with healing it passes.
 */

import { test, expect } from '../fixtures';

test.describe('checkout journey', () => {
  test('a customer can place an order', async ({ cartPage, checkoutPage }) => {
    await cartPage.open();

    // Still-valid selector: no healing needed here.
    expect(await cartPage.getTotal()).toBe('£161.00');

    // #checkout-button is stale → healed to getByTestId('checkout').
    await cartPage.proceedToCheckout();

    // #email-input, #promo-field, #accept-terms, #place-order-btn are all stale.
    await checkoutPage.checkout('buyer@example.com', 'SUMMER25');

    await expect(checkoutPage.confirmationMessage).toBeVisible();
  });

  test('the order form keeps what the customer typed', async ({ cartPage, checkoutPage, page }) => {
    await cartPage.open();
    await cartPage.proceedToCheckout();

    await checkoutPage.enterEmail('someone@example.com');
    await checkoutPage.applyPromoCode('WINTER10');

    // Asserting against the app's real ids proves the healed selectors acted on the
    // intended elements rather than on something that merely matched.
    await expect(page.locator('#customer-email-v3')).toHaveValue('someone@example.com');
    await expect(page.locator('#promotion-code-v3')).toHaveValue('WINTER10');
  });

  test('a customer can pay in the embedded payment frame', async ({ paymentFramePage }) => {
    await paymentFramePage.open();

    // Every selector here lives inside an iframe. A page-level snapshot shows the frame
    // as a bare leaf, so healing these needs the frame's own snapshot — see
    // pages/PaymentFramePage.ts.
    await paymentFramePage.enterCard('4111111111111111', '123');

    // Asserting against the app's real id proves the healed selector acted on the field
    // inside the frame, not on something in the parent document that merely matched.
    await expect(paymentFramePage.cardNumberField).toHaveValue('4111111111111111');
  });

  test('the form refuses to submit without the terms accepted', async ({
    cartPage,
    checkoutPage,
    page,
  }) => {
    await cartPage.open();
    await cartPage.proceedToCheckout();

    await checkoutPage.enterEmail('buyer@example.com');

    // The app alerts instead of submitting; swallow it and check nothing was confirmed.
    page.on('dialog', (dialog) => void dialog.dismiss());
    await checkoutPage.placeOrder();

    await expect(checkoutPage.confirmationMessage).toBeHidden();
  });
});
