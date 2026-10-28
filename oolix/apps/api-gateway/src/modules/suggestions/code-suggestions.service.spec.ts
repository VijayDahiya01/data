import Anthropic from '@anthropic-ai/sdk';
import type { OolixLogger } from '@oolix/observability';
import type { OolixConfig } from '../../config/configuration.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { CodeSuggestionsService, type SuggestionsClient } from './code-suggestions.service.js';

const CATEGORY = {
  key: 'purchase_category',
  displayName: 'Main purchase category',
  dataType: 'ENUM',
  allowedValuesJson: ['FOOTWEAR', 'FASHION', 'ELECTRONICS'],
};

const prisma = (row: unknown = CATEGORY) =>
  ({ attributeDefinition: { findFirst: async () => row } }) as unknown as PrismaService;

const logger = { warn: () => {}, error: () => {}, info: () => {} } as unknown as OolixLogger;
const config = { SUGGESTIONS_MODEL: 'claude-opus-5-5' } as OolixConfig;

/** A client that records what it was asked and answers as told. */
function fakeClient(reply: object | Error) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        parse: async (params: Record<string, unknown>) => {
          calls.push(params);
          if (reply instanceof Error) throw reply;
          return reply;
        },
      },
    },
  } as unknown as SuggestionsClient;
  return { client, calls };
}

describe('CodeSuggestionsService', () => {
  it("suggests only the attribute's own codes, for the values asked about", async () => {
    const { client, calls } = fakeClient({
      stop_reason: 'end_turn',
      parsed_output: {
        answers: [
          { value: 'Running shoes', code: 'FOOTWEAR' },
          { value: 'Kurtis', code: 'FASHION' },
          { value: 'Toys', code: 'TOYS' }, // not a code: dropped
          { value: 'Something else', code: 'FASHION' }, // not asked: ignored
        ],
      },
    });
    const svc = new CodeSuggestionsService(config, prisma(), logger, client);
    const got = await svc.suggest({
      attribute_key: 'purchase_category',
      values: ['Running shoes', 'Kurtis', 'Kurtis ', 'Toys', 'asha@example.com', 'Gadgets'],
    });
    expect(got).toEqual([
      { value: 'Running shoes', code: 'FOOTWEAR' },
      { value: 'Kurtis', code: 'FASHION' },
      { value: 'Toys', code: null },
      { value: 'asha@example.com', code: null },
      { value: 'Gadgets', code: null },
    ]);

    // One call; an address never left; the request asks for the fallback
    // model on a refusal and for answers in the attribute's codes.
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    const asked = JSON.stringify(call);
    expect(asked).not.toContain('asha@example.com');
    expect(asked).toContain('Running shoes');
    expect(call.model).toBe('claude-opus-5-5');
    expect(call.fallbacks).toBe('default');
    expect(call.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect((call.output_config as { effort: string }).effort).toBe('low');
  });

  it('suggests nothing when the model declines or is cut short', async () => {
    for (const stop_reason of ['refusal', 'max_tokens']) {
      const { client } = fakeClient({ stop_reason, parsed_output: null });
      const svc = new CodeSuggestionsService(config, prisma(), logger, client);
      expect(await svc.suggest({ attribute_key: 'purchase_category', values: ['Kurtis'] })).toEqual(
        [{ value: 'Kurtis', code: null }],
      );
    }
  });

  it('does not call the model when nothing may be sent', async () => {
    const { client, calls } = fakeClient(new Error('should not be called'));
    const svc = new CodeSuggestionsService(config, prisma(), logger, client);
    expect(await svc.suggest({ attribute_key: 'purchase_category', values: ['400001'] })).toEqual([
      { value: '400001', code: null },
    ]);
    expect(calls).toHaveLength(0);
  });

  it('says plainly when it cannot help', async () => {
    const off = new CodeSuggestionsService(config, prisma(), logger);
    expect(off.available).toBe(false);
    await expect(
      off.suggest({ attribute_key: 'purchase_category', values: ['x'] }),
    ).rejects.toMatchObject({
      code: 'SYS_002',
    });

    const { client } = fakeClient({ stop_reason: 'end_turn', parsed_output: { answers: [] } });
    const notEnum = new CodeSuggestionsService(config, prisma(null), logger, client);
    await expect(notEnum.suggest({ attribute_key: 'age', values: ['x'] })).rejects.toMatchObject({
      code: 'VAL_001',
    });

    const failing = fakeClient(
      new Anthropic.InternalServerError(500, { type: 'error' }, 'boom', new Headers()),
    );
    const down = new CodeSuggestionsService(config, prisma(), logger, failing.client);
    await expect(
      down.suggest({ attribute_key: 'purchase_category', values: ['Kurtis'] }),
    ).rejects.toMatchObject({
      code: 'SYS_002',
    });
  });
});
