/**
 * Synonyms learned from Partners (docs/DESIGN-PARTNER-DATA.md §5.6).
 *
 * A Partner who chooses to share sends the answers it gave on its Agent's
 * setup page -- "Kurtis" means FASHION -- and nothing else: values and codes,
 * never customers, counts or rows. An Oolix admin reviews what Partners
 * shared, most agreed first, and approves or rejects each value. Approved
 * pairs go to every Agent, which uses them like its built-in synonyms; a
 * Partner's own answers still come first.
 *
 * Review is what keeps one Partner's mistake, or mischief, out of everyone's
 * data: nothing a Partner shares reaches another Agent until a person at
 * Oolix has looked at it.
 */
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { OolixError } from '@oolix/contracts';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { normalizeValue, shareable } from './values.js';

export const ShareAnswersSchema = z.object({
  answers: z
    .array(
      z.object({
        attribute_key: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
        value: z.string().min(1).max(200),
        code: z.string().min(1).max(64),
      }),
    )
    .max(1000),
});
export type ShareAnswersInput = z.infer<typeof ShareAnswersSchema>;

export const DecideSynonymSchema = z.object({
  attribute_key: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  value_key: z.string().min(1).max(200),
  code: z.string().min(1).max(64),
  status: z.enum(['APPROVED', 'REJECTED']),
});
export type DecideSynonymInput = z.infer<typeof DecideSynonymSchema>;

@Injectable()
export class SynonymsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Each list-of-values attribute's codes. */
  private async codes(): Promise<Map<string, string[]>> {
    const rows = await this.prisma.attributeDefinition.findMany({
      where: { active: true, dataType: 'ENUM' },
      orderBy: { version: 'asc' },
    });
    return new Map(rows.map((a) => [a.key, (a.allowedValuesJson as string[] | null) ?? []]));
  }

  /**
   * The Partner's shared answers, replacing what it shared before. An empty
   * list withdraws them all, which is what turning sharing off sends.
   */
  async share(partnerOrgId: string, agentId: string, input: ShareAnswersInput) {
    const codes = await this.codes();
    const rows = new Map<
      string,
      { attributeKey: string; valueKey: string; value: string; code: string }
    >();
    let skipped = 0;
    for (const a of input.answers) {
      const valueKey = normalizeValue(a.value);
      if (!codes.get(a.attribute_key)?.includes(a.code) || !shareable(a.value) || !valueKey) {
        skipped++;
        continue;
      }
      rows.set(`${a.attribute_key}\u0000${valueKey}`, {
        attributeKey: a.attribute_key,
        valueKey,
        value: a.value.trim(),
        code: a.code,
      });
    }
    await this.prisma.$transaction([
      this.prisma.synonymContribution.deleteMany({ where: { partnerOrgId } }),
      this.prisma.synonymContribution.createMany({
        data: [...rows.values()].map((r) => ({ ...r, partnerOrgId })),
      }),
    ]);
    await this.audit.record({
      action: 'SYNONYMS_SHARED',
      entityType: 'agent',
      entityId: agentId,
      orgId: partnerOrgId,
      actorType: 'AGENT',
      metadata: { shared: rows.size, skipped },
    });
    return { shared: rows.size, skipped };
  }

  /**
   * The approved synonyms, for every Agent. version changes whenever any
   * decision does, so an Agent can skip a list it already holds.
   */
  async approved() {
    const [rows, latest] = await Promise.all([
      this.prisma.sharedSynonym.findMany({
        where: { status: 'APPROVED' },
        orderBy: [{ attributeKey: 'asc' }, { valueKey: 'asc' }],
      }),
      this.prisma.sharedSynonym.aggregate({ _max: { decidedAt: true }, _count: { _all: true } }),
    ]);
    const at = latest._max.decidedAt?.getTime() ?? 0;
    return {
      version: `${latest._count._all}.${at}`,
      synonyms: rows.map((r) => ({
        attribute_key: r.attributeKey,
        value_key: r.valueKey,
        code: r.code,
      })),
    };
  }

  /**
   * What Partners shared and nobody has decided, most Partners first, with
   * every code they gave it; then the decisions already made. Partners are
   * counted, never named.
   */
  async review() {
    const [groups, examples, decided] = await Promise.all([
      this.prisma.synonymContribution.groupBy({
        by: ['attributeKey', 'valueKey', 'code'],
        _count: { _all: true },
      }),
      this.prisma.synonymContribution.findMany({
        distinct: ['attributeKey', 'valueKey'],
        select: { attributeKey: true, valueKey: true, value: true },
      }),
      this.prisma.sharedSynonym.findMany({ orderBy: { decidedAt: 'desc' }, take: 500 }),
    ]);
    const key = (a: string, v: string) => `${a}\u0000${v}`;
    const done = new Set(decided.map((d) => key(d.attributeKey, d.valueKey)));
    const example = new Map(examples.map((e) => [key(e.attributeKey, e.valueKey), e.value]));
    const pending = new Map<
      string,
      {
        attribute_key: string;
        value_key: string;
        example: string;
        partners: number;
        codes: { code: string; partners: number }[];
      }
    >();
    for (const g of groups) {
      const k = key(g.attributeKey, g.valueKey);
      if (done.has(k)) continue;
      let p = pending.get(k);
      if (!p) {
        p = {
          attribute_key: g.attributeKey,
          value_key: g.valueKey,
          example: example.get(k) ?? g.valueKey,
          partners: 0,
          codes: [],
        };
        pending.set(k, p);
      }
      p.partners += g._count._all;
      p.codes.push({ code: g.code, partners: g._count._all });
    }
    const items = [...pending.values()];
    for (const p of items)
      p.codes.sort((a, b) => b.partners - a.partners || a.code.localeCompare(b.code));
    items.sort((a, b) => b.partners - a.partners || a.value_key.localeCompare(b.value_key));
    return {
      pending: items.slice(0, 200),
      decided: decided.map((d) => ({
        attribute_key: d.attributeKey,
        value_key: d.valueKey,
        code: d.code,
        status: d.status,
        decided_at: d.decidedAt.toISOString(),
      })),
    };
  }

  /** An admin's decision on one value; a later decision replaces it. */
  async decide(userId: string, input: DecideSynonymInput) {
    const codes = await this.codes();
    if (!codes.get(input.attribute_key)?.includes(input.code)) {
      throw new OolixError('VAL_001', "That code is not one of the attribute's codes.", {
        fieldErrors: [{ field: 'code', message: 'not a code of this attribute' }],
      });
    }
    const valueKey = normalizeValue(input.value_key);
    if (!valueKey) {
      throw new OolixError('VAL_001', 'A value is required.', {
        fieldErrors: [{ field: 'value_key', message: 'required' }],
      });
    }
    const row = await this.prisma.sharedSynonym.upsert({
      where: { attributeKey_valueKey: { attributeKey: input.attribute_key, valueKey } },
      create: {
        attributeKey: input.attribute_key,
        valueKey,
        code: input.code,
        status: input.status,
        decidedBy: userId,
      },
      update: { code: input.code, status: input.status, decidedBy: userId, decidedAt: new Date() },
    });
    await this.audit.record({
      action: input.status === 'APPROVED' ? 'SHARED_SYNONYM_APPROVED' : 'SHARED_SYNONYM_REJECTED',
      entityType: 'shared_synonym',
      entityId: row.id,
      metadata: { attribute_key: row.attributeKey, value_key: row.valueKey, code: row.code },
    });
    return {
      attribute_key: row.attributeKey,
      value_key: row.valueKey,
      code: row.code,
      status: row.status,
      decided_at: row.decidedAt.toISOString(),
    };
  }
}
