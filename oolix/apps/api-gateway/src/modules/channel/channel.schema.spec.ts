/**
 * §17: "Never collect Partner usernames/passwords... Oolix stores account IDs,
 * authorization state, resource IDs and non-sensitive configuration."
 *
 * The schema is where that rule is enforced, so this is where it is tested. A
 * credential accepted here would land in the database, in every backup, and in
 * anything that ever dumps a row -- somewhere it can never be fully recalled
 * from.
 */
import { UpsertConnectionSchema } from './channel.schema.js';

function connection(overrides: Record<string, unknown> = {}) {
  return {
    account_ids: { business_id: 'bus-1', ad_account_id: 'act-1' },
    scopes: ['ads_management'],
    capability_flags: { customer_list_audiences: true },
    ...overrides,
  };
}

describe('UpsertConnectionSchema', () => {
  it('accepts a well-formed connection', () => {
    expect(UpsertConnectionSchema.safeParse(connection()).success).toBe(true);
  });

  it.each([
    'access_token',
    'accessToken',
    'refresh_token',
    'client_secret',
    'clientSecret',
    'api_key',
    'apiKey',
    'password',
    'private_key',
    'authorization',
    'fb_access_token',
    'user_credential',
  ])('refuses an account identifier named %s', (key) => {
    const parsed = UpsertConnectionSchema.safeParse(
      connection({ account_ids: { ad_account_id: 'act-1', [key]: 'a-secret-value' } }),
    );
    expect(parsed.success).toBe(false);
  });

  it('refuses a credential hidden among capability flags', () => {
    // A different field, the same consequence.
    const parsed = UpsertConnectionSchema.safeParse(
      connection({ capability_flags: { customer_match: true, refresh_token_valid: true } }),
    );
    expect(parsed.success).toBe(false);
  });

  it('rejects unknown top-level fields rather than stripping them', () => {
    // Silently dropping a field an integrator believed was saved is how a
    // connection ends up half configured with nobody aware of it.
    const parsed = UpsertConnectionSchema.safeParse(connection({ system_user_token: 'EAAG...' }));
    expect(parsed.success).toBe(false);
  });

  it('bounds identifier length so an OAuth response cannot be pasted in', () => {
    // A value long enough to be a JWT is far more likely to be one than to be
    // an account number.
    const parsed = UpsertConnectionSchema.safeParse(
      connection({ account_ids: { ad_account_id: 'x'.repeat(300) } }),
    );
    expect(parsed.success).toBe(false);
  });

  it('accepts ordinary identifiers that merely look unusual', () => {
    // The rejection must not be so eager that a legitimate account id is
    // refused. "token" is the trigger, not "to".
    const parsed = UpsertConnectionSchema.safeParse(
      connection({
        account_ids: { ad_account_id: 'act-1', tokyo_account_id: '42', page_id: 'p-1' },
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it('defaults scopes and capabilities to empty rather than permissive', () => {
    const parsed = UpsertConnectionSchema.safeParse({
      account_ids: { ad_account_id: 'act-1' },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // An absent capability is treated as unconfirmed by the eligibility
      // gate, which is the safe direction.
      expect(parsed.data.capability_flags).toEqual({});
      expect(parsed.data.scopes).toEqual([]);
    }
  });
});
