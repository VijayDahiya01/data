import { expect, type Page } from '@playwright/test';

/**
 * Compose the §6.3 worked audience through the Audience Builder.
 *
 * Shared because two suites need the same audience, and because the builder's
 * controls are typed per attribute — a yes/no select, value chips, a range —
 * so driving it is more than filling four text boxes. Keeping that knowledge in
 * one place means a UI change breaks one helper rather than every test.
 */
export async function buildShoeAudience(page: Page, portal: string, name: string) {
  await page.goto(`${portal}/audiences/new`);
  await page.getByLabel('Audience name').fill(name);

  // Each condition is added from the picker, so an attribute cannot be chosen
  // twice and no empty rows exist to skip past.
  const add = async (label: string) => {
    await page.getByRole('button', { name: '+ Add condition' }).last().click();
    await page
      .getByRole('button', { name: new RegExp(`^${label}`) })
      .first()
      .click();
  };

  await add('Online shopper'); // BOOLEAN → defaults to Yes
  await add('Purchase category');
  await page.getByRole('button', { name: 'Footwear', exact: true }).click();

  // Numeric conditions start EMPTY on purpose — the builder will not invent a
  // range on the Buyer's behalf — so the test has to type the numbers a Buyer
  // would type. An unfilled condition counts as unfinished and is left out of
  // the submitted rules, which is what the count below actually proves.
  await add('Age');
  await page.getByLabel('Age from', { exact: true }).fill('18');
  await page.getByLabel('Age to', { exact: true }).fill('35');

  await add('Purchased within');
  await page.getByLabel('Purchased within value', { exact: true }).fill('90');

  // Four required conditions is the floor, and all four default to Required.
  await expect(page.getByText('4 required')).toBeVisible({ timeout: 10_000 });

  // "Save draft" rather than the primary CTA: the primary one goes straight to
  // Partner matches, which is right for a Buyer but skips the audience page
  // these tests need in order to publish the version.
  await page.getByRole('button', { name: /save draft/i }).click();
  await page.waitForURL(/\/audiences\/[0-9a-f-]+$/, { timeout: 20_000 });
}
