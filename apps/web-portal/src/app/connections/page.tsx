/**
 * CRM and channel connections (§71, §84, §90).
 *
 * The CRM key is what closes the loop: a Buyer's own system reports which leads
 * turned out to be real, and that — not a click count — is what a Partner is
 * paid on (§50). It reports against an opaque token, so the Buyer's CRM never
 * receives a Partner's customer identifier (§90).
 */
import { requireContext, can } from '@/lib/nav-entry';
import { apiOptional } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { Card, Empty, Notice, PageHeader, StatusBadge } from '@/components/ui';
import { CrmKeyForm } from '@/components/OpsForms';
import { BrandForm } from '@/components/BrandForm';

interface Brand {
  id: string;
  name: string;
  category: string;
  website: string;
  landing_domain: string;
}

export default async function ConnectionsPage() {
  const ctx = await requireContext('/connections');
  const brands = await apiOptional<{ items: Brand[] }>('/v1/brands');
  const items = brands?.items ?? [];

  const mayConnect = can(ctx, 'crm:connect');

  return (
    <Shell ctx={ctx}>
      <PageHeader
        title="Connections"
        lead="Brands you advertise under, and the CRM feed that confirms which leads were real."
      />

      <Card title="CRM lead feedback">
        {mayConnect ? (
          <CrmKeyForm hasKey={false} />
        ) : (
          <Notice tone="warn">Issuing a CRM key needs the Buyer admin role.</Notice>
        )}

        <div
          style={{ marginTop: '1rem', paddingTop: '0.9rem', borderTop: '1px solid var(--border)' }}
        >
          <h3>How your CRM reports back</h3>
          <p className="muted">
            Post lead state changes to <code>/v1/leads/events</code> with this key as a bearer
            token. States move forward only — received, valid, qualified, converted, or rejected —
            and each event is idempotent on your own <code>crm_event_id</code>, so a retry storm
            cannot inflate a payout.
          </p>
          <p className="faint" style={{ marginBottom: 0 }}>
            The attribution key is the opaque <code>click_token</code> your landing page received.
            It maps to an activation only inside Oolix, by SHA-256 — it says nothing about the
            person, the Partner or the segment.
          </p>
        </div>
      </Card>

      <Card title={`Brands (${items.length})`}>
        {items.length === 0 ? (
          <Empty>No brands yet. A campaign runs under one, so add it here or in the builder.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Brand</th>
                  <th>Category</th>
                  <th>Website</th>
                  <th>Landing domain</th>
                </tr>
              </thead>
              <tbody>
                {items.map((b) => (
                  <tr key={b.id}>
                    <td>{b.name}</td>
                    <td className="muted">{b.category}</td>
                    <td className="muted">{b.website}</td>
                    <td>
                      <code>{b.landing_domain}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <details className="card">
        <summary>Add a brand</summary>
        <div style={{ marginTop: '1rem' }}>
          <p className="muted">
            The landing domain you set becomes the allow-list: campaign links are permitted on that
            domain and nowhere else.
          </p>
          <BrandForm />
        </div>
      </details>

      <Card title="External channels">
        <p className="muted" style={{ marginTop: 0 }}>
          Meta and Google are <StatusBadge status="NOT_OFFERED" /> and stay that way until account
          eligibility is proven for a specific Partner and Buyer pair.
        </p>
        <p className="faint" style={{ marginBottom: 0 }}>
          This is not an unfinished screen — it is a deliberate stop. Even after a Data Partner
          approves a campaign, nothing is sent to an outside platform: the approval by itself never
          turns on an upload. Both stay switched off until that is separately proven.
        </p>
      </Card>
    </Shell>
  );
}
