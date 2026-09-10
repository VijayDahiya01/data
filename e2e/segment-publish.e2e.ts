/**
 * Publishing a segment, through the browser (§38.1, §72).
 *
 * The property under test is as much about what does NOT happen as what does:
 * a Partner types a member count, and it becomes a published RANGE that no
 * Buyer-facing surface can turn back into a number.
 */
import { expect, test, type Page } from '@playwright/test';

const PORTAL = process.env.PORTAL_URL ?? 'http://localhost:3000';

const KEY = `E2E_SEGMENT_${Date.now()}`;
const NAME = `E2E segment ${Date.now()}`;
// Falls in §72's 100K-250K bucket. The published range must be all a Buyer
// ever sees of it.
const EXACT_MEMBERS = 137_412;

async function signIn(page: Page, email: string) {
  await page.goto(`${PORTAL}/login`);
  await page.getByRole('link', { name: /continue to sign in/i }).click();
  await page.waitForURL(/\/realms\/oolix\//, { timeout: 20_000 });
  await page.locator('#username').fill(email);
  await page.locator('#password').fill('password');
  await page.locator('#kc-login, input[type="submit"], button[type="submit"]').first().click();
  await page.waitForURL((url) => url.origin === new URL(PORTAL).origin, { timeout: 20_000 });
}

test.describe.configure({ mode: 'serial' });

test.describe('Publish a segment', () => {
  test('a Partner publishes metadata about an audience they already hold', async ({ page }) => {
    await signIn(page, 'partner.admin@example.test');
    await page.goto(`${PORTAL}/partner/segments`);

    // The page says plainly where the audience actually lives.
    await expect(page.locator('body')).toContainText(/audience itself is not built here/i);

    await page.getByText(/publish a new segment/i).click();

    await page.getByLabel(/your segment key/i).fill(KEY);
    await page
      .getByLabel(/current member count/i)
      .first()
      .fill(String(EXACT_MEMBERS));
    await page.getByLabel(/display name/i).fill(NAME);
    await page.getByLabel(/^category$/i).fill('travel_intent');
    await page.getByLabel(/description/i).fill('Created by the segment publishing test.');

    // §66.2: a segment is discoverable through its listing. Publishing without
    // one leaves it visible to nobody, which is why the form requires it.
    await page.getByLabel(/unit price/i).fill('4500');

    await page.getByRole('button', { name: /save as draft/i }).click();

    const card = page.locator('.card', { hasText: NAME });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText(/draft/i);
  });

  test('the exact count becomes a range, and the count itself is gone (§72)', async ({ page }) => {
    await signIn(page, 'partner.admin@example.test');
    await page.goto(`${PORTAL}/partner/segments`);

    const card = page.locator('.card', { hasText: NAME });
    await expect(card).toBeVisible({ timeout: 20_000 });

    // The published figure is a bucket.
    await expect(card).toContainText(/100K – 250K/);

    // And the number the Partner typed is not on the page anywhere -- not in
    // the rendered text and not in the HTML behind it.
    const html = await page.content();
    expect(html).not.toContain(String(EXACT_MEMBERS));
    expect(html).not.toContain('137,412');
  });

  test('publishing needs a reported refresh first (§38.1)', async ({ page }) => {
    await signIn(page, 'partner.admin@example.test');
    await page.goto(`${PORTAL}/partner/segments`);

    const card = page.locator('.card', { hasText: NAME });
    await card.getByLabel(/current member count/i).fill(String(EXACT_MEMBERS));
    await card.getByRole('button', { name: /report refresh/i }).click();

    // The refresh has to have LANDED before publishing: §38.1 blocks publish
    // until a segment has reported one. Waiting on the publish button to appear
    // is the observable proof, since the card renders it only for a segment
    // that could be published.
    const publishButton = page
      .locator('.card', { hasText: NAME })
      .getByRole('button', { name: /publish to catalogue/i });
    await expect(publishButton).toBeVisible({ timeout: 30_000 });
    await publishButton.click();

    // NOT `toContainText(/published/i)` — the card carries a "Published reach"
    // column header, so that regex matched whether or not the publish worked
    // and the assertion could never fail. The button is replaced by the
    // discoverability note once the segment is genuinely PUBLISHED, so its
    // disappearance is the real signal.
    await expect(publishButton).toBeHidden({ timeout: 30_000 });
    await expect(page.locator('.card', { hasText: NAME })).toContainText(
      /discoverable by buyers/i,
      { timeout: 30_000 },
    );
  });

  test('a Buyer discovers it as a range, never as a count (§39, §72)', async ({ page }) => {
    await signIn(page, 'buyer.admin@example.test');
    await page.goto(`${PORTAL}/discover?query=${encodeURIComponent('E2E segment')}`);

    const card = page.locator('.card', { hasText: NAME });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText(/100K – 250K/);

    const html = await page.content();
    expect(html).not.toContain(String(EXACT_MEMBERS));
    // §38.1: the Partner's own key is theirs. A Buyer has no use for it and
    // never receives it.
    expect(html).not.toContain(KEY);
  });
});
