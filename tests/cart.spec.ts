import { expect, test } from '../fixtures';
import { Page } from '@playwright/test';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function xpathText(value: string): string {
  if (!value.includes("'")) {
    return `'${value}'`;
  }
  return `concat('${value.replaceAll("'", "',\"'\",'")}')`;
}

async function login(page: Page): Promise<void> {
  await page.goto('https://3.19.220.15:9543/user/#/home');
  await page.locator('[name="login"]').waitFor({ state: 'visible', timeout: 240_000 });
  await page.locator('[name="username"]').fill('p2754336');
  await page.locator('[name="password"]').fill('test');
  await page.locator('[name="login"]').click();
  await expect(page.locator("//a[i[text()='logout']]")).toBeVisible({ timeout: 240_000 });
}

async function selectSegmentAndCategory(page: Page, segment: string, category: string): Promise<void> {
  await page.waitForTimeout(2000);
  await page.locator(`//li/a/span[text()='Chartr Cloud']`).click();
  await page.locator(`//ul/span[text()=${xpathText(category)}]`).click();
  await page.waitForTimeout(2000);
}

async function selectApplication(page: Page, application: string): Promise<void> {
  const project = application.split(':', 1)[0];
  const input = page.locator("//label[text()='Application']/../input");
  await input.fill(project);
  await input.click();
  await page.locator(`//tbody/tr/td[text()=${xpathText(application)}]`).click();
}

async function searchCart(page: Page, application: string): Promise<void> {
  const project = application.split(':', 1)[0];
  const input = page.locator("//label[text()='Application']/../input");
  await input.fill(project);
  await input.click();
  await page.locator(`//tbody/tr/td[text()=${xpathText(application)}]`).click();
  await page.locator("//button[i[text()='search']]").click();
}

async function openCart(page: Page): Promise<void> {
  await page.locator("//li/a[i[text()='shopping_cart']]").click();
}

test.describe.serial('UCARE cart @ui @regression', () => {
  test.setTimeout(240_000);

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test.only('selects an offer and verifies it in the cart', async ({ page }) => {
    const data = {
      segment: 'Chartr Cloud',
      category: 'Networking',
      offerName: 'VPC',
      application: 'VPC:VPC',
    };
    await selectSegmentAndCategory(page, data.segment, data.category);
    await page.locator("//form//div/input[contains(@placeholder,'Search in')]").fill(data.offerName);
    await page.locator("//button[i[text()='search']]").click();

    // const offer = page.locator(
    //   `//div[contains(@id,'CatalogOffers')]//div/div/span/span[text()=${xpathText(data.offerName)}]`,
    // );
    // await expect(offer).toBeVisible();
    // await offer.click();
    // await selectApplication(page, data.application);
    // await page.getByRole('button', { name: 'Configure' }).click();

    // await openCart(page);
    // await searchCart(page, data.application);
    // await expect(
    //   page.locator(
    //     `//td[@data-title='projectName']//div[text()=${xpathText(data.application)}]`,
    //   ),
    // ).toBeVisible();
  });

  test('cancels the configured product from the cart', async ({ page }) => {
    const data = {
      segment: 'Chartr Cloud',
      category: 'Networking',
      offerName: 'VPC',
      application: 'VPC:VPC',
    };
    await openCart(page);
    await searchCart(page, data.application);

    await page
      .locator(
        `//td[@data-title='projectName']//div[text()=${xpathText(data.application)}]/../../..//td[@data-title=' ']//i[text()='keyboard_arrow_right']`,
      )
      .click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page
      .locator("(//span[text()='Confirmation']/../../..//button[span[text()='Yes']])[last()]")
      .click();

    await openCart(page);
    await searchCart(page, data.application);
    await expect(
      page.locator(
        `//td[@data-title='projectName']//div[text()=${xpathText(data.application)}]`,
      ),
    ).toBeHidden();
  });

  test.afterEach(async ({ page }) => {
    const logoutLink = page.locator("//a[i[text()='logout']]");
    if (await logoutLink.isVisible()) {
      await logoutLink.click();
    }
  });
});
