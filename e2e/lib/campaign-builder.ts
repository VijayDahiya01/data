import { expect, type Page } from '@playwright/test';

/**
 * Drive the campaign builder's three screens: Campaign, Ad, Partners & submit.
 *
 * Shared for the same reason as the audience builder helper: several suites
 * need a submitted campaign, and the builder's shape should be known in one
 * place, so a change to it breaks one helper rather than every test.
 */

/** A tiny valid PNG, so the upload exercises §93.3's magic-byte check for real. */
export const PNG_1PX = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000a49444154789c6360000002000100ffff0300000600' +
    '0557bfabd40000000049454e44ae426082',
  'hex',
);

/**
 * Screens 1 and 2: a qualified-leads campaign with every "More options"
 * default, then its ad. Ends on screen 3; returns the campaign's URL.
 */
export async function startCampaign(page: Page, portal: string, name: string): Promise<string> {
  await page.goto(`${portal}/campaigns/new`);
  await expect(page.getByRole('heading', { name: 'New campaign' })).toBeVisible();
  await page.getByLabel('Campaign name').fill(name);
  await page.getByRole('radio', { name: /qualified leads/i }).check();
  await page.getByRole('button', { name: /continue to the ad/i }).click();

  // §70 binds approval to an ad version, so the ad comes before the Partners.
  await page.waitForURL(/\/campaigns\/[0-9a-f-]+\/creative$/, { timeout: 20_000 });
  const url = page.url().replace(/\/creative$/, '');

  await page.getByLabel('Headline').fill('Protect your trip');
  await page.getByLabel('Text', { exact: true }).fill('Travel insurance in minutes.');
  await page
    .getByLabel('Image', { exact: true })
    .setInputFiles({ name: 'creative.png', mimeType: 'image/png', buffer: PNG_1PX });
  await page.getByRole('button', { name: /save ad and continue/i }).click();
  await page.waitForURL(`${url}/audience`, { timeout: 30_000 });
  return url;
}

/** Screen 3: link the named audience. */
export async function linkAudience(page: Page, url: string, audience: string) {
  await page.goto(`${url}/audience`);
  // The option text can carry more than the name, so match on what is visible.
  const option = page.locator('#audience_group_id option').filter({ hasText: audience }).first();
  await page.getByLabel('Audience').selectOption(await option.getAttribute('value'));
  await page.getByRole('button', { name: /link audience/i }).click();
  await expect(page.getByRole('link', { name: audience })).toBeVisible({ timeout: 20_000 });
}

/**
 * Screen 3: send the campaign to ONE named Partner and submit.
 *
 * Every Partner that can reach the audience starts ticked. A test needs to know
 * whose approver to sign in as afterwards, so it keeps only the one it names.
 */
export async function submitToPartner(page: Page, url: string, partner: string) {
  await expect(page.getByRole('checkbox', { name: partner })).toBeVisible({ timeout: 20_000 });
  const boxes = page.locator('input[name="partner_org_ids"]');
  for (let i = 0; i < (await boxes.count()); i += 1) {
    const box = boxes.nth(i);
    const label = (await box.locator('xpath=..').innerText()).trim();
    if (label === partner) await box.check();
    else await box.uncheck();
  }
  await page.getByLabel(`Budget for ${partner}`).fill('100000');
  await page.getByRole('button', { name: /submit for partner review/i }).click();

  // §40.9 freezes the version and starts each Partner's clock.
  await page.waitForURL(url, { timeout: 30_000 });
}
