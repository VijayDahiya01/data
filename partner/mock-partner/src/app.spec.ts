/**
 * Mock Data Partner behaviour (§91, §43, §68.1).
 *
 * These are not tests of a toy. §91 makes this the reference for how a real
 * Partner backend must behave, so the properties pinned here are the ones a
 * Partner integrating for real has to reproduce: the customer identifier never
 * leaves the Partner, and an ad failure never breaks the page.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';

const AGENT = 'http://agent.test';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Replace fetch so the Agent's behaviour can be driven precisely. */
function stubAgent(handler: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const calls: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return handler(url, init);
  });
  return calls;
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('POST /api/ad-decision (§68.1)', () => {
  it('sends the customer identifier to the LOCAL Agent and nowhere else (§12.1)', async () => {
    const calls = stubAgent(() =>
      jsonResponse({ decision: 'SHOW', activation_id: 'act-1', creative: { headline: 'hi' } }),
    );

    const app = buildApp({ agentUrl: AGENT });
    const res = await app.inject({
      method: 'POST',
      url: '/api/ad-decision?user=U123',
      payload: { placement_id: 'booking_success_offer' },
    });

    expect(res.statusCode).toBe(200);
    // Exactly one outbound call, and it goes to the Agent. An Oolix address
    // here would mean the customer identifier had left the Partner (§1, §54).
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${AGENT}/private/v1/ad-decision`);
    expect(calls[0]!.body).toMatchObject({
      partner_user_id: 'U123',
      placement_id: 'booking_success_offer',
    });
    await app.close();
  });

  it('never returns the customer identifier to the browser (§68.1 step 4)', async () => {
    stubAgent(() =>
      jsonResponse({
        decision: 'SHOW',
        activation_id: 'act-1',
        creative: { headline: 'hi' },
        // A sloppy Agent echoing the identifier back must not reach the page.
        partner_user_id: 'U123',
        segment_id: 'RECENT_TRAVELLER_60D',
      }),
    );

    const app = buildApp({ agentUrl: AGENT });
    const res = await app.inject({
      method: 'POST',
      url: '/api/ad-decision?user=U123',
      payload: { placement_id: 'booking_success_offer' },
    });

    expect(res.body).not.toContain('U123');
    expect(res.body).not.toContain('RECENT_TRAVELLER_60D');
    expect(res.json()).toEqual({
      decision: 'SHOW',
      activation_id: 'act-1',
      creative: { headline: 'hi' },
    });
    await app.close();
  });

  it('refuses to target an anonymous visitor (§76.2)', async () => {
    const calls = stubAgent(() => jsonResponse({ decision: 'SHOW' }));

    const app = buildApp({ agentUrl: AGENT });
    const res = await app.inject({
      method: 'POST',
      url: '/api/ad-decision',
      payload: { placement_id: 'booking_success_offer' },
    });

    // §76.2 requires a Partner-resolvable first-party identity, so the Agent
    // is not even consulted.
    expect(res.json()).toEqual({ decision: 'NO_AD', reason: 'CONSENT_NOT_ELIGIBLE' });
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it('degrades to NO_AD when the Agent is offline (§43)', async () => {
    stubAgent(() => {
      throw new Error('ECONNREFUSED');
    });

    const app = buildApp({ agentUrl: AGENT });
    const res = await app.inject({
      method: 'POST',
      url: '/api/ad-decision?user=U123',
      payload: { placement_id: 'booking_success_offer' },
    });

    // §43: "ad placement failure cannot block checkout/booking/login." A 5xx
    // here would take down the Partner's own page.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ decision: 'NO_AD', reason: 'NO_ELIGIBLE_CAMPAIGN' });
    await app.close();
  });

  it('degrades to NO_AD when the Agent exceeds the latency budget (§103)', async () => {
    stubAgent(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );

    const app = buildApp({ agentUrl: AGENT, decisionTimeoutMs: 20 });
    const started = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: '/api/ad-decision?user=U123',
      payload: { placement_id: 'booking_success_offer' },
    });

    expect(res.json()).toEqual({ decision: 'NO_AD', reason: 'NO_ELIGIBLE_CAMPAIGN' });
    // The page must not wait on a hung Agent.
    expect(Date.now() - started).toBeLessThan(2000);
    await app.close();
  });

  it('degrades to NO_AD when the Agent returns an error status', async () => {
    stubAgent(() => new Response('boom', { status: 500 }));

    const app = buildApp({ agentUrl: AGENT });
    const res = await app.inject({
      method: 'POST',
      url: '/api/ad-decision?user=U123',
      payload: { placement_id: 'booking_success_offer' },
    });

    expect(res.json()).toEqual({ decision: 'NO_AD', reason: 'NO_ELIGIBLE_CAMPAIGN' });
    await app.close();
  });

  it('passes the Agent’s own NO_AD reason through (§77.1)', async () => {
    stubAgent(() => jsonResponse({ decision: 'NO_AD', reason: 'FREQUENCY_CAP_REACHED' }));

    const app = buildApp({ agentUrl: AGENT });
    const res = await app.inject({
      method: 'POST',
      url: '/api/ad-decision?user=U456',
      payload: { placement_id: 'booking_success_offer' },
    });

    // §77.1 reasons describe a decision, not a person, so they are safe to
    // surface and valuable for the §98.2 distribution.
    expect(res.json()).toEqual({ decision: 'NO_AD', reason: 'FREQUENCY_CAP_REACHED' });
    await app.close();
  });

  it('requires a placement', async () => {
    const app = buildApp({ agentUrl: AGENT });
    const res = await app.inject({
      method: 'POST',
      url: '/api/ad-decision?user=U123',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('GET /buyer-landing (§90)', () => {
  it('receives only the opaque token, and escapes it', async () => {
    const app = buildApp({ agentUrl: AGENT });
    const res = await app.inject({
      method: 'GET',
      url: '/buyer-landing?click_token=<script>alert(1)</script>',
    });

    expect(res.statusCode).toBe(200);
    // The token arrives from a URL, so rendering it unescaped would be stored
    // XSS on the Buyer's own page.
    expect(res.body).not.toContain('<script>alert(1)</script>');
    await app.close();
  });
});
