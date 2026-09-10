/**
 * Audiences — v6 §18.1.
 *
 * This route replaces "Audience discovery" as the Buyer's primary entry point,
 * and the inversion it represents is the whole of v6: you describe who you want
 * to reach first, and Oolix then works out which Data Partners can actually
 * evaluate that description. You no longer start by browsing other people's
 * segments and hoping one is close enough.
 *
 * §18.1 asks this list for name, status, rule summary, compatible Partner count
 * and linked campaigns — each of which answers a different question about
 * whether an audience is ready to carry a campaign.
 */
import Link from 'next/link';
import { requireContext } from '@/lib/nav-entry';
import { apiOptional } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { Card, Empty, PageHeader, relative } from '@/components/ui';

interface AudienceListItem {
  id: string;
  name: string;
  description: string | null;
  status: string;
  /** The Buyer-facing word: Draft, Ready, In Use or Archived. */
  display_status: string;
  current_version: number;
  rule_count: number;
  rule_hash: string | null;
  compatible_partners: number;
  linked_campaigns: number;
  updated_at: string;
}

export default async function AudiencesPage() {
  const ctx = await requireContext('/audiences');
  const data = await apiOptional<{ items: AudienceListItem[] }>('/v1/audiences');
  const items = data?.items ?? [];

  return (
    <Shell ctx={ctx}>
      <PageHeader
        title="Audiences"
        lead="Describe who you want to reach. Oolix finds the Data Partners who can evaluate it."
        actions={
          <Link className="btn-primary" href="/audiences/new">
            New audience
          </Link>
        }
      />

      {items.length === 0 ? (
        <Card>
          <Empty>
            No audiences yet. Describe who you want to reach and we&apos;ll find the Data Partners
            who can reach them.
          </Empty>
          <p>
            <Link className="btn-primary" href="/audiences/new">
              Build your first audience
            </Link>
          </p>
        </Card>
      ) : (
        <Card>
          <table className="table">
            <thead>
              <tr>
                <th>Audience</th>
                <th>Status</th>
                <th>Rules</th>
                <th>Compatible Partners</th>
                <th>Campaigns</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id}>
                  <td>
                    <Link href={`/audiences/${a.id}`}>{a.name}</Link>
                    {a.description ? <div className="faint small">{a.description}</div> : null}
                  </td>
                  <td>
                    {/* The version number is kept by the backend and is what a
                        Partner's approval binds to; it is not something a Buyer
                        chooses or can act on, so it is not shown. */}
                    <span
                      className={
                        a.display_status === 'In Use' || a.display_status === 'Ready'
                          ? 'badge badge-ok'
                          : a.display_status === 'Draft'
                            ? 'badge badge-warn'
                            : 'badge'
                      }
                    >
                      {a.display_status}
                    </span>
                  </td>
                  <td>{a.rule_count}</td>
                  <td>
                    {a.compatible_partners > 0 ? (
                      <Link href={`/audiences/${a.id}/matches`}>{a.compatible_partners}</Link>
                    ) : (
                      <Link className="faint" href={`/audiences/${a.id}/matches`}>
                        check matches
                      </Link>
                    )}
                  </td>
                  <td>{a.linked_campaigns}</td>
                  <td className="faint">{relative(a.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </Shell>
  );
}
