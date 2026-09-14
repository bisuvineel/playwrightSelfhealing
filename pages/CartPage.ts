/**
 * Page object for the cart page.
 *
 * The selectors here are the ones the app used **before** its redesign. They no longer
 * match anything — which is the point of this sample. Nothing in this class knows about
 * healing; it is written exactly as it would have been a year ago.
 */

import type { Locator, Page } from '@playwright/test';

export class CartPage {
  private readonly checkoutButton: Locator;
  private readonly total: Locator;

  constructor(private readonly page: Page) {
    // STALE: the app renamed this to #go-to-checkout-v3.
    this.checkoutButton = page
      .locator('#checkout-button')
      .describe('the button that goes from the cart to checkout');

    // Still valid — test ids survived the redesign.
    this.total = page.getByTestId('cart-total');
  }

  /** Opens the cart page. */
  async open(): Promise<void> {
    await this.page.goto('/');
  }

  /** Reads the cart total as displayed. */
  async getTotal(): Promise<string> {
    return (await this.total.textContent()) ?? '';
  }

  /** Proceeds to the checkout page. */
  async proceedToCheckout(): Promise<void> {
    await this.checkoutButton.click();
  }
}
