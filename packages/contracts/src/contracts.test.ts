import { describe, it, expect } from 'vitest';
import {
  CHANNELS,
  isExternalChannel,
  isPartnerOwnedChannel,
  ROLE_PERMISSIONS,
  permissionsForRoles,
  canSubmitOrPublish,
  PARTNER_REQUEST_TRANSITIONS,
  ACTIVATION_TRANSITIONS,
  LEAD_TRANSITIONS,
  canTransition,
  deriveCampaignState,
  bucketForExactReach,
  bucketMatchesFilter,
  summedUpperBound,
  money,
  addMoney,
  multiplyMoney,
  percentageOf,
  majorToMinor,
  durationToSeconds,
  buildError,
  OolixError,
  backoffForAttempt,
  shouldDeadLetter,
} from './index.js';

describe('§89 channel enum', () => {
  it('is exactly the four canonical strings', () => {
    expect(CHANNELS).toEqual(['PARTNER_WEB', 'PARTNER_APP', 'META', 'GOOGLE']);
  });

  it('classifies owned vs external', () => {
    expect(isPartnerOwnedChannel('PARTNER_WEB')).toBe(true);
    expect(isPartnerOwnedChannel('META')).toBe(false);
    expect(isExternalChannel('GOOGLE')).toBe(true);
  });
});

describe('§66 RBAC', () => {
  it('OOLIX_ADMIN cannot approve a partner request', () => {
    // §66: platform operations must never bypass Partner approval.
    expect(ROLE_PERMISSIONS.OOLIX_ADMIN).not.toContain('request:approve');
  });

  it('BUYER_OPERATOR cannot submit a campaign or manage billing', () => {
    expect(ROLE_PERMISSIONS.BUYER_OPERATOR).not.toContain('campaign:submit');
    expect(ROLE_PERMISSIONS.BUYER_OPERATOR).not.toContain('billing:manage');
  });

  it('unions permissions across multiple roles', () => {
    const p = permissionsForRoles(['ANALYST', 'FINANCE']);
    expect(p.has('report:read')).toBe(true);
    expect(p.has('payout:approve')).toBe(true);
    expect(p.has('campaign:submit')).toBe(false);
  });

  it('§66.3 gates submission on business verification', () => {
    expect(canSubmitOrPublish('BUSINESS_VERIFICATION_PENDING')).toBe(false);
    expect(canSubmitOrPublish('BUSINESS_VERIFIED')).toBe(true);
    expect(canSubmitOrPublish('ACTIVE')).toBe(true);
  });
});

describe('§76 / §101 state machines', () => {
  it('REJECTED never reaches APPROVED without a new request version', () => {
    expect(canTransition(PARTNER_REQUEST_TRANSITIONS, 'REJECTED', 'APPROVED')).toBe(false);
  });

  it('EXPIRED is terminal and is not approval', () => {
    expect(PARTNER_REQUEST_TRANSITIONS.EXPIRED).toEqual([]);
    expect(canTransition(PARTNER_REQUEST_TRANSITIONS, 'PARTNER_REVIEW', 'EXPIRED')).toBe(true);
  });

  it('PAUSED activation may resume or end, but not sync directly', () => {
    expect(canTransition(ACTIVATION_TRANSITIONS, 'PAUSED', 'LIVE')).toBe(true);
    expect(canTransition(ACTIVATION_TRANSITIONS, 'PAUSED', 'ENDING')).toBe(true);
    expect(canTransition(ACTIVATION_TRANSITIONS, 'PAUSED', 'SYNCING')).toBe(false);
  });

  it('§71 lead states never move backward', () => {
    expect(canTransition(LEAD_TRANSITIONS, 'QUALIFIED', 'VALID')).toBe(false);
    expect(canTransition(LEAD_TRANSITIONS, 'VALID', 'QUALIFIED')).toBe(true);
    expect(LEAD_TRANSITIONS.CONVERTED).toEqual([]);
  });
});

describe('§42 campaign state is a projection, not a source of truth', () => {
  it('is PARTIALLY_LIVE when one Partner runs and another does not', () => {
    const s = deriveCampaignState(['LIVE', 'PENDING_CHANNEL_CHECK'], {
      submitted: true,
      allRequestsResolved: false,
    });
    expect(s).toBe('PARTIALLY_LIVE');
  });

  it('is LIVE only when every activation is live', () => {
    expect(
      deriveCampaignState(['LIVE', 'LIVE'], { submitted: true, allRequestsResolved: true }),
    ).toBe('LIVE');
  });

  it('is ENDED only when every activation has ended', () => {
    expect(
      deriveCampaignState(['ENDED', 'ENDED'], { submitted: true, allRequestsResolved: true }),
    ).toBe('ENDED');
    expect(
      deriveCampaignState(['ENDED', 'LIVE'], { submitted: true, allRequestsResolved: true }),
    ).toBe('PARTIALLY_LIVE');
  });
});

describe('§72 reach buckets and anti-differencing', () => {
  it('suppresses cohorts below the publishable minimum', () => {
    expect(bucketForExactReach(999)).toBeNull();
    expect(bucketForExactReach(1_000)).toBe('UNDER_10K');
  });

  it('respects a raised partner threshold', () => {
    expect(bucketForExactReach(4_000, 5_000)).toBeNull();
  });

  it('maps the §72 worked example', () => {
    expect(bucketForExactReach(213_418)).toBe('100K_250K');
    expect(bucketForExactReach(64_207)).toBe('50K_100K');
    expect(bucketForExactReach(2_000_000)).toBe('OVER_1M');
  });

  it('filters on bucket overlap, never on an exact count', () => {
    expect(bucketMatchesFilter('100K_250K', { reachMin: 50_000 })).toBe(true);
    expect(bucketMatchesFilter('UNDER_10K', { reachMin: 50_000 })).toBe(false);
  });

  it('labels a cross-partner sum as non-deduplicated', () => {
    const r = summedUpperBound(['100K_250K', '50K_100K']);
    expect(r.deduplicated).toBe(false);
    expect(r.warning).toMatch(/overlap/i);
  });
});

describe('§102 money arithmetic is exact and reproducible', () => {
  it('reproduces the §102 payout worked example', () => {
    // CPQL INR 4,500 x 100 qualified leads.
    const unit = majorToMinor(4_500, 'INR');
    expect(unit.amount_minor).toBe(450_000);

    const mediaAmount = multiplyMoney(unit, 100);
    expect(mediaAmount.amount_minor).toBe(45_000_000); // INR 450,000

    const platformFee = percentageOf(mediaAmount, 1_000); // 10% = 1000 bps
    expect(platformFee.amount_minor).toBe(4_500_000); // INR 45,000

    const invoiceSubtotal = addMoney(mediaAmount, platformFee);
    expect(invoiceSubtotal.amount_minor).toBe(49_500_000); // INR 495,000

    // §102.2 dispute correction: 100 -> 98 qualified leads.
    expect(multiplyMoney(unit, 98).amount_minor).toBe(44_100_000); // INR 441,000
  });

  it('refuses to mix currencies rather than silently converting', () => {
    expect(() => addMoney(money(100, 'INR'), money(100, 'USD'))).toThrow(/currency mismatch/);
  });

  it('handles zero-decimal currencies', () => {
    expect(majorToMinor(1_000, 'JPY').amount_minor).toBe(1_000);
    expect(majorToMinor(1_000, 'INR').amount_minor).toBe(100_000);
  });

  it('rejects fractional minor units', () => {
    expect(() => money(10.5, 'INR')).toThrow(TypeError);
  });
});

describe('§67.2 frequency cap windows', () => {
  it('parses ISO-8601 durations', () => {
    expect(durationToSeconds('P1D')).toBe(86_400);
    expect(durationToSeconds('PT6H')).toBe(21_600);
    expect(durationToSeconds('PT30M')).toBe(1_800);
  });

  it('rejects malformed or zero windows', () => {
    expect(() => durationToSeconds('1 day')).toThrow();
    expect(() => durationToSeconds('P0D')).toThrow();
  });
});

describe('§77.2 / §99 error envelope', () => {
  it('marks channel ineligibility non-retryable', () => {
    const e = buildError('CHAN_001', 'corr_123');
    expect(e.error.retryable).toBe(false);
    expect(e.error.correlation_id).toBe('corr_123');
    expect(e.error.field_errors).toEqual([]);
  });

  it('marks rate limiting retryable and carries retry_after', () => {
    const e = buildError('SYS_001', 'corr_9', { retryAfterSeconds: 45 });
    expect(e.error.retryable).toBe(true);
    expect(e.error.retry_after_seconds).toBe(45);
  });

  it('OolixError exposes the mapped HTTP status', () => {
    expect(new OolixError('PERM_002').httpStatus).toBe(403);
    expect(new OolixError('AGENT_001').retryable).toBe(true);
  });
});

describe('§74 retry policy', () => {
  it('follows the 1s/5s/30s/2m/10m ladder', () => {
    expect([0, 1, 2, 3, 4].map(backoffForAttempt)).toEqual([
      1_000, 5_000, 30_000, 120_000, 600_000,
    ]);
  });

  it('dead-letters at the 5th attempt rather than retrying forever', () => {
    expect(shouldDeadLetter(4)).toBe(false);
    expect(shouldDeadLetter(5)).toBe(true);
  });
});
