import { describe, it, expect, beforeEach } from 'vitest';
import {
  redact,
  redactUrl,
  tokenHashPrefix,
  redactionHits,
  resetRedactionHits,
  REDACTED_PLACEHOLDER,
  ALERT_RULES,
  PERFORMANCE_BUDGETS_MS,
} from './index.js';

beforeEach(() => resetRedactionHits());

describe('§78.1 nothing on the forbidden list reaches a log', () => {
  it('redacts a partner customer identifier at any depth', () => {
    const out = redact({
      activation_id: 'act_1',
      request: { body: { partner_user_id: 'U123', placement_id: 'p1' } },
    });
    expect(JSON.stringify(out)).not.toContain('U123');
    expect(out.request.body.partner_user_id).toBe(REDACTED_PLACEHOLDER);
    // §3 makes this architecturally impossible, so a hit is alertable.
    expect(redactionHits()).toBe(1);
  });

  it('redacts a raw click token but keeps safe fields', () => {
    const out = redact({ click_token: 'abc123', activation_id: 'act_1' });
    expect(out.click_token).toBe(REDACTED_PLACEHOLDER);
    expect(out.activation_id).toBe('act_1');
  });

  it('redacts credentials and matching payloads', () => {
    const out = redact({
      client_secret: 's',
      access_token: 't',
      DATABASE_URL: 'postgres://u:p@h/db',
      matching_payload: ['hash1', 'hash2'],
    });
    expect(Object.values(out)).toEqual(Array(4).fill(REDACTED_PLACEHOLDER));
  });

  it('is case-insensitive on field names', () => {
    const out = redact({ Email: 'a@b.c', PartnerUserId: 'U1' });
    expect(out.Email).toBe(REDACTED_PLACEHOLDER);
    expect(out.PartnerUserId).toBe(REDACTED_PLACEHOLDER);
  });

  it('survives circular references instead of hanging the logger', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(() => redact(a)).not.toThrow();
    expect((redact(a) as { self: unknown }).self).toBe('[CIRCULAR]');
  });

  it('does not expand binary buffers', () => {
    const out = redact({ hash: Buffer.from('deadbeef', 'hex') });
    expect(String(out.hash)).toMatch(/^\[BINARY \d+B\]$/);
  });

  it('preserves errors in a readable shape', () => {
    const out = redact({ err: new Error('boom') }) as { err: { message: string } };
    expect(out.err.message).toBe('boom');
  });
});

describe('§53 / §82 PII never appears in a logged URL', () => {
  it('redacts sensitive query parameters', () => {
    const out = redactUrl('https://x.test/v1/leads?click_token=secret&campaign=cmp_100');
    expect(out).not.toContain('secret');
    expect(out).toContain('campaign=cmp_100');
  });

  it('never throws on adversarial input', () => {
    // The property that matters is that a log call cannot crash a request.
    // Most malformed strings still parse against the placeholder base and come
    // back as a harmless path; the point is that none of them throw.
    for (const bad of ['%%%', '', '://', 'http://[', ' ', 'a'.repeat(10_000)]) {
      expect(() => redactUrl(bad)).not.toThrow();
    }
  });

  it('drops the origin so a host is never logged from a full URL', () => {
    expect(redactUrl('https://partner.example/checkout?x=1')).toBe('/checkout?x=1');
  });
});

describe('§71 token hash prefix', () => {
  it('emits only a short prefix, never the whole hash', () => {
    const hash = Buffer.alloc(32, 0xab);
    const p = tokenHashPrefix(hash);
    expect(p).toBe('abababab');
    expect(p.length).toBe(8);
  });
});

describe('§78.2 / §103 thresholds are encoded, not just documented', () => {
  it('alerts on a heartbeat older than 5 minutes', () => {
    const r = ALERT_RULES.find((x) => x.description.includes('heartbeat'));
    expect(r?.threshold).toBe(300);
    expect(r?.severity).toBe('critical');
  });

  it('alerts on any production DLQ message', () => {
    const r = ALERT_RULES.find((x) => x.description.includes('DLQ'));
    expect(r?.threshold).toBe(0);
    expect(r?.comparison).toBe('gt');
  });

  it('matches the §103 latency budgets', () => {
    expect(PERFORMANCE_BUDGETS_MS.adDecisionP95).toBe(100);
    expect(PERFORMANCE_BUDGETS_MS.segmentLookupP95).toBe(30);
    expect(PERFORMANCE_BUDGETS_MS.sdkHardTimeout).toBe(150);
  });
});
