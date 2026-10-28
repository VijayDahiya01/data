/**
 * Codes at scale (docs/DESIGN-PARTNER-DATA.md §5.6): suggested meanings for
 * values an Agent could not read, and synonyms learned from Partners.
 *
 * The Agent routes use the scopes a managed Agent already holds, so Agents
 * registered before this existed need nothing new: asking and sharing are
 * part of publishing what the local copy can answer (capabilities:write),
 * and the approved list is configuration (config:read).
 */
import { Body, Controller, Get, Inject, Post, Put } from '@nestjs/common';
import type { AgentPrincipal, UserPrincipal } from '@oolix/auth-rbac';
import { RequireAgentScope, RequirePermissions } from '../../common/auth/auth.guard.js';
import { Principal } from '../../common/auth/principal.decorator.js';
import { RateLimit } from '../../common/ratelimit/rate-limit.guard.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import { AuditService } from '../../common/audit/audit.service.js';
import {
  CodeSuggestionsService,
  SuggestCodesSchema,
  type SuggestCodesInput,
} from './code-suggestions.service.js';
import {
  DecideSynonymSchema,
  ShareAnswersSchema,
  SynonymsService,
  type DecideSynonymInput,
  type ShareAnswersInput,
} from './synonyms.service.js';

@Controller('agent/v1')
export class AgentSuggestionsController {
  constructor(
    @Inject(CodeSuggestionsService) private readonly suggestions: CodeSuggestionsService,
    @Inject(SynonymsService) private readonly synonyms: SynonymsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * Suggested codes for up to 50 values, asked for by the Partner on the
   * setup page. The values are used for the answer and not kept; the audit
   * trail records how many there were, not what they were.
   */
  @Post('suggestions/codes')
  @RequireAgentScope('capabilities:write')
  @RateLimit('codeSuggestions')
  async codes(
    @Principal() p: AgentPrincipal,
    @Body(new ZodValidationPipe(SuggestCodesSchema)) body: SuggestCodesInput,
  ) {
    const suggestions = await this.suggestions.suggest(body);
    await this.audit.record({
      action: 'CODE_SUGGESTIONS_REQUESTED',
      entityType: 'agent',
      entityId: p.agentId,
      orgId: p.partnerOrgId,
      actorType: 'AGENT',
      metadata: {
        attribute_key: body.attribute_key,
        values: suggestions.length,
        suggested: suggestions.filter((s) => s.code !== null).length,
      },
    });
    return { suggestions };
  }

  /** The Partner's shared answers, replacing what it shared before. */
  @Put('synonyms/contributions')
  @RequireAgentScope('capabilities:write')
  async share(
    @Principal() p: AgentPrincipal,
    @Body(new ZodValidationPipe(ShareAnswersSchema)) body: ShareAnswersInput,
  ) {
    return this.synonyms.share(p.partnerOrgId, p.agentId, body);
  }

  /** Synonyms Oolix approved, for every Agent. */
  @Get('synonyms')
  @RequireAgentScope('config:read')
  async approved() {
    return this.synonyms.approved();
  }
}

/** Reviewing what Partners shared. admin:operate is OOLIX_ADMIN's alone. */
@Controller('v1/admin/synonyms')
export class AdminSynonymsController {
  constructor(@Inject(SynonymsService) private readonly synonyms: SynonymsService) {}

  @Get()
  @RequirePermissions('admin:operate')
  async review() {
    return this.synonyms.review();
  }

  @Post('decisions')
  @RequirePermissions('admin:operate')
  async decide(
    @Principal() p: UserPrincipal,
    @Body(new ZodValidationPipe(DecideSynonymSchema)) body: DecideSynonymInput,
  ) {
    return this.synonyms.decide(p.userId, body);
  }
}
