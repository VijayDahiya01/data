/**
 * A switched-off feature must be indistinguishable from a route that does not
 * exist, and a switched-on one must pass straight through.
 */
import { NotFoundException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { OolixConfig } from '../../config/configuration.js';
import { FeatureGuard, RequireFeature } from './feature.guard.js';

@RequireFeature('billing')
class BillingLike {
  route(): void {}
}

class Ungated {
  route(): void {}
}

function contextFor(cls: new () => { route(): void }): ExecutionContext {
  return {
    getHandler: () => cls.prototype.route,
    getClass: () => cls,
    switchToHttp: () => ({
      getRequest: () => ({ method: 'GET', url: '/v1/billing/payouts' }),
    }),
  } as unknown as ExecutionContext;
}

const guard = (billing: boolean) =>
  new FeatureGuard(new Reflector(), { FEATURE_BILLING_ENABLED: billing } as OolixConfig);

describe('FeatureGuard', () => {
  it('answers a switched-off feature exactly like a missing route', () => {
    const attempt = () => guard(false).canActivate(contextFor(BillingLike));
    expect(attempt).toThrow(NotFoundException);
    expect(attempt).toThrow('Cannot GET /v1/billing/payouts');
  });

  it('lets a switched-on feature through', () => {
    expect(guard(true).canActivate(contextFor(BillingLike))).toBe(true);
  });

  it('ignores routes that belong to no switchable feature', () => {
    expect(guard(false).canActivate(contextFor(Ungated))).toBe(true);
  });
});
