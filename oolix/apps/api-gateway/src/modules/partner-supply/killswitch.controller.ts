/**
 * Kill switch and activation lifecycle endpoints -- spec v5 §24, §52.3, §56.
 */
import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { OolixError } from '@oolix/contracts';
import type { UserPrincipal } from '@oolix/auth-rbac';
import { RequirePermissions } from '../../common/auth/auth.guard.js';
import { Principal } from '../../common/auth/principal.decorator.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import { KillSwitchService, KillSwitchSchema, type KillSwitchInput } from './killswitch.service.js';

@Controller('v1/partner/kill-switches')
export class KillSwitchController {
  constructor(@Inject(KillSwitchService) private readonly killSwitches: KillSwitchService) {}

  /**
   * §24: unilateral and immediate. No Buyer agreement, no Oolix approval.
   */
  @Post()
  @RequirePermissions('killswitch:operate')
  async activate(
    @Principal() p: UserPrincipal,
    @Body(new ZodValidationPipe(KillSwitchSchema)) body: KillSwitchInput,
  ) {
    return this.killSwitches.activate(p, body);
  }

  @Get()
  @RequirePermissions('killswitch:operate')
  async list(@Principal() p: UserPrincipal) {
    return this.killSwitches.list(p);
  }

  @Post(':id/release')
  @RequirePermissions('killswitch:operate')
  async release(@Principal() p: UserPrincipal, @Param('id') id: string) {
    return this.killSwitches.release(p, id);
  }
}

/** §52.3 activation lifecycle. Reachable by the Partner AND the Buyer. */
@Controller('v1/activations')
export class ActivationController {
  constructor(@Inject(KillSwitchService) private readonly lifecycle: KillSwitchService) {}

  @Post(':id/pause')
  @RequirePermissions('report:read')
  async pause(
    @Principal() p: UserPrincipal,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    return this.lifecycle.pause(p, id, body?.reason ?? 'Paused by operator.');
  }

  @Post(':id/resume')
  @RequirePermissions('report:read')
  async resume(@Principal() p: UserPrincipal, @Param('id') id: string) {
    return this.lifecycle.resume(p, id);
  }

  @Post(':id/end')
  @RequirePermissions('report:read')
  async end(
    @Principal() p: UserPrincipal,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    if (!body?.reason) {
      // §83: ending an activation ends a commercial arrangement, so the
      // reason is part of the dispute trail rather than a nicety.
      throw new OolixError('VAL_001', 'A reason is required to end an activation.', {
        fieldErrors: [{ field: 'reason', message: 'required' }],
      });
    }
    return this.lifecycle.end(p, id, body.reason);
  }
}
