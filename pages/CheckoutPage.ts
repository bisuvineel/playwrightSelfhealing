/**
 * Page object for the checkout page.
 *
 * Three of these four selectors are stale after the app's redesign. Each one carries a
 * `describe()` call — plain Playwright uses it for trace labelling, and the healer uses
 * it as the strongest hint about which element was meant.
 */

import type { Locator, Page } from '@playwright/test';

export class CheckoutPage {
  private readonly emailField: Locator;
  private readonly promoField: Locator;
  private readonly termsCheckbox: Locator;
  private readonly placeOrderButton: Locator;
  private readonly confirmation: Locator;

  // Not stored: every locator is built here, so nothing later needs the page.
  constructor(page: Page) {
    // STALE: renamed to #customer-email-v3.
    this.emailField = page
      .locator('#email-input')
      .describe('the field where the customer types their email address');

    // STALE: renamed to #promotion-code-v3.
    this.promoField = page.locator('#promo-field').describe('the promotion code field');

    // STALE: renamed to #terms-v3.
    this.termsCheckbox = page
      .locator('#accept-terms')
      .describe('the checkbox for accepting the terms and conditions');

    // STALE: renamed to #submit-order-v3.
    this.placeOrderButton = page
      .locator('//button[text()="Place order"]')
      .describe('the button that submits the order');

    // Still valid.
    this.confirmation = page.getByText('Order placed');
  }

  /** Fills in the customer's email address. */
  async enterEmail(email: string): Promise<void> {
    await this.emailField.fill(email);
  }

  /** Applies a promotion code. */
  async applyPromoCode(code: string): Promise<void> {
    await this.promoField.fill(code);
  }

  /** Accepts the terms and conditions. */
  async acceptTerms(): Promise<void> {
    await this.termsCheckbox.check();
  }

  /** Submits the order. */
  async placeOrder(): Promise<void> {
    await this.placeOrderButton.click();
  }

  /** The confirmation message, for assertions. */
  get confirmationMessage(): Locator {
    return this.confirmation;
  }

  /** Completes the whole checkout journey. */
  async checkout(email: string, promoCode: string): Promise<void> {
    await this.enterEmail(email);
    await this.applyPromoCode(promoCode);
    await this.acceptTerms();
    await this.placeOrder();
  }
}
