/**
 * The customer-facing half of §43, in a real browser.
 *
 * §43: "ad placement failure cannot block checkout/booking/login." Every other
 * layer of this system can be proven with HTTP assertions; this one cannot,
 * because the property is about what a person sees on a page whose ad slot did
 * not work. The Agent this suite runs against is deliberately not listening,
 * so the failure path IS the default path.
 *
 * §12 / §68: the browser sends a placement id and nothing else. That is
 * asserted here against real network traffic rather than against the source,
 * because a future change to the SDK would not touch this file.
 */
import { expect, test } from '@playwright/test';

test.describe('Partner product page with an Oolix ad slot (§43, §68)', () => {
  test('the booking confirmation renders even though the Agent is down', async ({ page }) => {
    await page.goto('/?user=U123');

    // The Partner's own content is the thing that must never be at risk.
    await expect(page.getByText('Booking confirmed.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Travel A' })).toBeVisible();
  });

  test('the slot degrades to house content rather than staying empty or broken', async ({
    page,
  }) => {
    await page.goto('/?user=U123');

    const slot = page.locator('#slot');
    // "Loading..." must not be the final state: a spinner that never resolves
    // is a broken page as far as a customer is concerned.
    await expect(slot).toContainText('Partner house offer', { timeout: 10_000 });
    await expect(slot).not.toContainText('Loading');
  });

  test('the page never sends a customer identifier to Oolix (§12, §54)', async ({
    page,
    baseURL,
  }) => {
    // Compared against the configured origin rather than `page.url()`: at the
    // moment of the first request the page is still about:blank, which would
    // make the navigation itself look external.
    const partnerHost = new URL(baseURL!).host;

    const external: string[] = [];
    page.on('request', (req) => {
      if (new URL(req.url()).host !== partnerHost) external.push(req.url());
    });

    await page.goto('/?user=U123');
    await expect(page.locator('#slot')).toContainText('Partner house offer', { timeout: 10_000 });

    expect(external).toEqual([]);
  });

  test('the browser sends only a placement id (§68.1 step 1)', async ({ page }) => {
    const bodies: unknown[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/api/ad-decision')) bodies.push(JSON.parse(req.postData() ?? 'null'));
    });

    await page.goto('/?user=U123');
    await expect(page.locator('#slot')).toContainText('Partner house offer', { timeout: 10_000 });

    expect(bodies).toHaveLength(1);
    const body = bodies[0] as Record<string, unknown>;
    expect(body.placement_id).toBe('booking_success_offer');
    // The customer identifier is resolved server-side from the Partner's own
    // session (§68.1 step 2). Its presence here would mean the browser had
    // become the source of identity.
    expect(body).not.toHaveProperty('partner_user_id');
    expect(JSON.stringify(body)).not.toContain('U123');
  });

  test('an anonymous visitor is not targeted at all (§76.2)', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByText('(anonymous)')).toBeVisible();
    await expect(page.locator('#slot')).toContainText('Partner house offer', { timeout: 10_000 });
  });

  test('the Buyer landing page receives only an opaque token (§90)', async ({ page }) => {
    await page.goto('/buyer-landing?click_token=abc123opaque');

    await expect(page.getByRole('heading', { name: 'Buyer landing page' })).toBeVisible();
    await expect(page.getByText('abc123opaque')).toBeVisible();

    // The token is opaque by construction (§90); the page cannot name the
    // Partner, segment or creative behind it.
    const content = await page.content();
    expect(content).not.toContain('RECENT_TRAVELLER_60D');
    expect(content).not.toContain('partner_user_id');
  });

  test('a token from the URL is escaped before it is rendered', async ({ page }) => {
    let dialogOpened = false;
    page.on('dialog', async (d) => {
      dialogOpened = true;
      await d.dismiss();
    });

    await page.goto('/buyer-landing?click_token=%3Cscript%3Ealert(1)%3C/script%3E');
    await expect(page.getByRole('heading', { name: 'Buyer landing page' })).toBeVisible();

    // The token arrives from a URL under an attacker's control, so rendering
    // it unescaped would be XSS on the Buyer's own site.
    expect(dialogOpened).toBe(false);
  });
});
