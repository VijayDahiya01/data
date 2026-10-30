/**
 * A form says what is missing before it goes on.
 *
 * Asked for while trying the simpler flows: when a required field is left
 * empty, say which one to fill, then go on. The browser checks required fields
 * itself, but tells only in a bubble that is easy to miss, and cannot point at
 * a field inside a closed "More options" at all -- the press did nothing
 * visible.
 */
import { expect, test } from '@playwright/test';
import { signIn } from './lib/auth';

const PORTAL = process.env.PORTAL_URL ?? 'http://localhost:3000';

test.describe('A form says what is missing', () => {
  test('a new campaign names the empty field, even inside More options', async ({ page }) => {
    await signIn(page, 'buyer.admin@example.test');
    await page.goto(`${PORTAL}/campaigns/new`);
    const said = page.locator('.form-missing');

    // Nothing typed: named under the button, outlined, and nothing sent.
    await page.getByRole('button', { name: /continue to the ad/i }).click();
    await expect(said).toHaveText('Fill in Campaign name to continue.');
    await expect(page.getByLabel('Campaign name')).toHaveAttribute('aria-invalid', 'true');
    await expect(page).toHaveURL(/\/campaigns\/new$/);

    // Filling it in clears both.
    await page.getByLabel('Campaign name').fill(`Required fields ${Date.now()}`);
    await expect(said).toHaveCount(0);
    await expect(page.getByLabel('Campaign name')).not.toHaveAttribute('aria-invalid', 'true');

    // Emptied inside "More options", which is then closed again: the section
    // is opened, the field focused and named.
    const more = page.getByText('More options', { exact: true });
    await more.click();
    await page.getByLabel('What is this campaign for?').fill('');
    await more.click();
    await page.getByRole('button', { name: /continue to the ad/i }).click();
    await expect(said).toHaveText('Fill in What is this campaign for? to continue.');
    await expect(page.getByLabel('What is this campaign for?')).toBeFocused();
    await expect(page).toHaveURL(/\/campaigns\/new$/);
  });

  test('an audience with too few conditions says how many more', async ({ page }) => {
    await signIn(page, 'buyer.admin@example.test');
    await page.goto(`${PORTAL}/audiences/new`);

    await page.getByLabel('Audience name').fill(`Too few ${Date.now()}`);
    await page.getByRole('button', { name: /save and find partners/i }).click();

    await expect(page.locator('.form-missing')).toHaveText(
      'Add 4 more conditions to continue: a Partner needs at least four.',
    );
    await expect(page).toHaveURL(/\/audiences\/new$/);
  });
});
