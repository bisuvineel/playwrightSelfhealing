/**
 * Page object for the payment step, whose card fields live inside an iframe.
 *
 * This is the case healing could not reach before 0.4.0: a page-level accessibility
 * snapshot shows an `<iframe>` as a bare leaf, so the model was never shown the fields
 * inside it. Locators built through `page.frameLocator()` now heal like any other, and
 * the suggested rewrite comes back fully qualified — `frameLocator('#payment-frame')
 * .getByLabel('Card number')` — ready to paste back in here.
 */

import type { FrameLocator, Locator, Page } from '@playwright/test';

export class PaymentFramePage {
  private readonly page: Page;
  private readonly frame: FrameLocator;
  private readonly cardNumber: Locator;
  private readonly securityCode: Locator;
  private readonly payButton: Locator;

  constructor(page: Page) {
    this.page = page;

    // The frame selector itself is still valid — only the fields inside it were renamed.
    this.frame = page.frameLocator('#payment-frame');

    // STALE: renamed to #card-number-v3.
    this.cardNumber = this.frame
      .locator('#card-number')
      .describe('the card number field in the payment frame');

    // STALE: renamed to #card-cvc-v3.
    this.securityCode = this.frame
      .locator('#card-cvc')
      .describe('the card security code field in the payment frame');

    // STALE: renamed to #pay-now-v3.
    this.payButton = this.frame.locator('#pay-button').describe('the button that pays');
  }

  /** Opens the payment step. */
  async open(): Promise<void> {
    await this.page.goto('/frames.html');
  }

  /** Fills in the card details. */
  async enterCard(number: string, code: string): Promise<void> {
    await this.cardNumber.fill(number);
    await this.securityCode.fill(code);
  }

  /** Submits the payment. */
  async pay(): Promise<void> {
    await this.payButton.click();
  }

  /** The card number field, for assertions against the app's real ids. */
  get cardNumberField(): Locator {
    return this.frame.locator('#card-number-v3');
  }
}
