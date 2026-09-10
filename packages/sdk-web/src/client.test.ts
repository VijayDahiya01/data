import { describe, it, expect, vi, afterEach } from 'vitest';
import { requestDecision, DEFAULT_REQUEST_TIMEOUT_MS } from './client.js';

const ENDPOINT = '/internal/ads/decision';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('§68 SDK defaults', () => {
  it('uses the 150 ms hard timeout from §68/§103', () => {
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(150);
  });
});

describe('§68.1 the SDK never sends a customer identifier', () => {
  it('posts only placement_id and safe context', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ decision: 'NO_AD', reason: 'USER_NOT_IN_SEGMENT' }));
    vi.stubGlobal('fetch', fetchMock);

    await requestDecision({
      decisionEndpoint: ENDPOINT,
      placementId: 'booking_success_offer',
      context: { page_type: 'booking_success', locale: 'en-IN' },
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(ENDPOINT);

    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      placement_id: 'booking_success_offer',
      context: { page_type: 'booking_success', locale: 'en-IN' },
    });
    // The entire privacy claim of the owned-media path rests on this.
    expect(JSON.stringify(body)).not.toMatch(/partner_user_id|user_id|email/i);
  });

  it('sends same-origin credentials so the Partner backend resolves the session itself', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ decision: 'NO_AD', reason: 'NO_ELIGIBLE_CAMPAIGN' }));
    vi.stubGlobal('fetch', fetchMock);

    await requestDecision({ decisionEndpoint: ENDPOINT, placementId: 'p' });

    expect((fetchMock.mock.calls[0]![1] as RequestInit).credentials).toBe('same-origin');
  });
});

describe('§9.2 / §43 ad code fails independently of the host page', () => {
  it('resolves NO_AD instead of rejecting when the backend errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ oops: true }, 500)));

    const r = await requestDecision({ decisionEndpoint: ENDPOINT, placementId: 'p' });

    expect(r.decision.decision).toBe('NO_AD');
    expect(r.error?.code).toBe('HTTP_ERROR');
    expect(r.error?.status).toBe(500);
  });

  it('resolves NO_AD instead of rejecting when the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const r = await requestDecision({ decisionEndpoint: ENDPOINT, placementId: 'p' });

    expect(r.decision.decision).toBe('NO_AD');
    expect(r.error?.code).toBe('NETWORK');
  });

  it('times out and falls back rather than hanging the slot', async () => {
    // A backend that never answers -- the exact case §57 says must degrade to
    // NO_AD while the Partner page carries on.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              const e = new Error('aborted');
              e.name = 'AbortError';
              reject(e);
            });
          }),
      ),
    );

    const started = Date.now();
    const r = await requestDecision({
      decisionEndpoint: ENDPOINT,
      placementId: 'p',
      requestTimeoutMs: 40,
    });

    expect(r.decision.decision).toBe('NO_AD');
    expect(r.error?.code).toBe('TIMEOUT');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('rejects a malformed decision payload rather than rendering garbage', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ decision: 'SHOW' })));

    const r = await requestDecision({ decisionEndpoint: ENDPOINT, placementId: 'p' });

    // decision: SHOW with no creative.destination_url is not usable.
    expect(r.decision.decision).toBe('NO_AD');
    expect(r.error?.code).toBe('BAD_RESPONSE');
  });
});

describe('a valid SHOW decision passes through', () => {
  it('returns the creative unchanged and reports no error', async () => {
    const creative = {
      creative_version_id: 'crv_10',
      format: 'NATIVE_CARD' as const,
      headline: 'Protect your trip',
      body: 'Get travel insurance in minutes.',
      cta: 'GET_QUOTE',
      asset_url: 'https://cdn.example/a.png',
      destination_url: 'https://insurance.example/quote?t=opaque-token',
    };
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ decision: 'SHOW', activation_id: 'act_a_web', creative }),
        ),
    );

    const r = await requestDecision({ decisionEndpoint: ENDPOINT, placementId: 'p' });

    expect(r.error).toBeUndefined();
    expect(r.decision).toMatchObject({ decision: 'SHOW', activation_id: 'act_a_web', creative });
  });
});
