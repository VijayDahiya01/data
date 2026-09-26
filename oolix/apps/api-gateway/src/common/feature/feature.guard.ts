/**
 * Features that are built but switched off.
 *
 * A switched-off feature answers exactly like a route that does not exist --
 * the same 404 and the same message -- so an off feature cannot be told apart
 * from an absent one, and nothing half-works while it is hidden.
 *
 * Authentication still runs first (the global guards precede this one), so a
 * stranger gets the usual 401 either way.
 */
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  NotFoundException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { CONFIG, type OolixConfig } from '../../config/configuration.js';

const FEATURE_KEY = 'oolix:feature';

/** Each switchable feature and the setting that turns it on. */
const SWITCHES = {
  billing: 'FEATURE_BILLING_ENABLED',
} as const satisfies Record<string, keyof OolixConfig>;

export type Feature = keyof typeof SWITCHES;

/** Mark a controller or route as belonging to a feature that can be off. */
export const RequireFeature = (feature: Feature) => SetMetadata(FEATURE_KEY, feature);

@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(CONFIG) private readonly config: OolixConfig,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const feature = this.reflector.getAllAndOverride<Feature | undefined>(FEATURE_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!feature || this.config[SWITCHES[feature]]) return true;

    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    throw new NotFoundException(`Cannot ${req.method} ${req.url}`);
  }
}
