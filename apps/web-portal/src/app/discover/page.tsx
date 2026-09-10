/**
 * Audience discovery (§39, §72).
 *
 * §39 is emphatic about what this screen is not: "Do not allow a Buyer to send
 * arbitrary SQL-like rules against a Partner database." Every control here
 * filters PUBLISHED METADATA. Nothing a Buyer types reaches a Partner's
 * systems, which is why the filters are a fixed set rather than a query
 * builder.
 */
import Link from 'next/link';
import { requireContext } from '@/lib/nav-entry';
import { apiOptional } from '@/lib/api';
import { Shell } from '@/components/Shell';
import {
  Card,
  Empty,
  Money,
  Notice,
  PageHeader,
  Reach,
  StatusBadge,
  relative,
} from '@/components/ui';

interface CatalogueItem {
  segment_id: string;
  display_name: string;
  description: string;
  category: string;
  geographies: string[];
  reach_bucket: string | null;
  freshness_at: string | null;
  refresh_frequency: string;
  consent_eligibility: string;
  partner: { id: string; display_name: string; industry?: string; trust_status?: string };
  channels: { type: string; status: string }[];
  pricing?: { model?: string; indicative_unit_price_minor?: number; currency?: string } | null;
  network?: { id: string; name: string } | null;
}

export default async function DiscoverPage({
  searchParams,
}: {
  searchParams: Promise<{ query?: string; category?: string; geo?: string }>;
}) {
  const sp = await searchParams;
  const ctx = await requireContext('/discover');

  const params = new URLSearchParams({ limit: '25' });
  if (sp.query) params.set('query', sp.query);
  if (sp.category) params.set('category', sp.category);
  if (sp.geo) params.set('geo', sp.geo);

  const data = await apiOptional<{ items: CatalogueItem[]; notice?: string }>(
    `/v1/catalogue/segments?${params.toString()}`,
  );
  const items = data?.items ?? [];

  return (
    <Shell ctx={ctx}>
      <PageHeader
        title="Audience discovery"
        lead="Published audience metadata from Data Partners. Membership lists stay inside each Partner."
        actions={
          <Link className="btn btn-primary" href="/campaigns/new">
            Start a campaign
          </Link>
        }
      />

      <Card>
        <form method="get">
          <div className="field-row">
            <div className="field">
              <label htmlFor="query">Search</label>
              <input
                id="query"
                name="query"
                defaultValue={sp.query ?? ''}
                placeholder="travel, premium…"
              />
            </div>
            <div className="field">
              <label htmlFor="category">Category</label>
              <input
                id="category"
                name="category"
                defaultValue={sp.category ?? ''}
                placeholder="travel_intent"
              />
            </div>
            <div className="field">
              <label htmlFor="geo">Geography</label>
              <input id="geo" name="geo" defaultValue={sp.geo ?? ''} placeholder="IN" />
            </div>
          </div>
          <button type="submit">Search</button>
        </form>
      </Card>

      <Notice tone="plain">
        {data?.notice ??
          'Reach is a range, and ranges from different Partners must not be added together — the same person can appear in more than one.'}
      </Notice>

      {items.length === 0 ? (
        <Card>
          <Empty>No published audiences match. Try a broader search.</Empty>
        </Card>
      ) : (
        items.map((s) => (
          <Card key={s.segment_id} title={s.display_name}>
            <p className="muted" style={{ marginTop: 0 }}>
              {s.description}
            </p>

            <div className="table-wrap">
              <table>
                <tbody>
                  <tr>
                    <th>Partner</th>
                    <td>
                      {s.partner.display_name}{' '}
                      {s.partner.trust_status ? (
                        <StatusBadge status={s.partner.trust_status} />
                      ) : null}
                      {s.network ? <span className="faint"> · {s.network.name}</span> : null}
                    </td>
                  </tr>
                  <tr>
                    <th>Reach</th>
                    <td>
                      <Reach bucket={s.reach_bucket} />
                      <span className="faint"> · never an exact count</span>
                    </td>
                  </tr>
                  <tr>
                    <th>Freshness</th>
                    <td className="muted">
                      {s.freshness_at ? `refreshed ${relative(s.freshness_at)}` : 'never refreshed'}
                      <span className="faint"> · {s.refresh_frequency}</span>
                    </td>
                  </tr>
                  <tr>
                    <th>Consent</th>
                    <td>
                      <StatusBadge status={s.consent_eligibility} />
                      <div className="field-hint">
                        Re-checked inside the Partner at decision time, and it fails closed.
                      </div>
                    </td>
                  </tr>
                  <tr>
                    <th>Channels</th>
                    <td>
                      {s.channels.map((c) => (
                        <span key={c.type} style={{ marginRight: '0.5rem' }}>
                          {c.type.replaceAll('_', ' ').toLowerCase()}{' '}
                          <StatusBadge status={c.status} />
                        </span>
                      ))}
                    </td>
                  </tr>
                  {s.pricing?.model ? (
                    <tr>
                      <th>Indicative price</th>
                      <td>
                        {s.pricing.model} ·{' '}
                        <Money
                          minor={s.pricing.indicative_unit_price_minor}
                          currency={s.pricing.currency}
                        />
                        <div className="field-hint">
                          Final terms are agreed when the Partner approves.
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </Card>
        ))
      )}
    </Shell>
  );
}
