/**
 * Matching with other Partners (docs/DESIGN-PARTNER-DATA.md phase 7).
 *
 * Two Partners who both take part can learn how many customers they share,
 * as a size band, and one can get an audience of its own customers the other
 * also has -- without either, or Oolix, seeing the other's customers. Each
 * Agent seals its customers' match keys to a clean room that runs in a
 * hardware enclave, after checking that enclave's attestation; Oolix carries
 * the sealed data and cannot open it. Customers take part only with their
 * own consent to this purpose, which the Agent reads.
 */
import { requireContext } from '@/lib/nav-entry';
import { apiOptional } from '@/lib/api';
import { Shell } from '@/components/Shell';
import {
  CleanRoomDecision,
  CleanRoomParticipation,
  CleanRoomRequest,
} from '@/components/CleanRoomForms';
import { Card, Empty, Notice, PageHeader, StatusBadge, dateOnly } from '@/components/ui';

interface Status {
  available: boolean;
  enabled: boolean;
  partners: { org_id: string; name: string }[];
}

interface Run {
  id: string;
  kind: 'OVERLAP' | 'JOINT';
  status: string;
  role: 'REQUESTED' | 'ASKED';
  with: { org_id: string; name: string | null };
  band: string | null;
  created_at: string | null;
}

const BANDS: Record<string, string> = {
  UNDER_100: 'under 100 (not shown)',
  '100_TO_1K': '100 to 1,000',
  '1K_TO_10K': '1,000 to 10,000',
  '10K_TO_100K': '10,000 to 1 lakh',
  '100K_TO_1M': '1 lakh to 10 lakh',
  OVER_1M: 'over 10 lakh',
};

export default async function Page() {
  const ctx = await requireContext('/partner/cleanroom');
  const [status, runs] = await Promise.all([
    apiOptional<Status>('/v1/partner/cleanroom'),
    apiOptional<{ items: Run[] }>('/v1/partner/cleanroom/runs'),
  ]);
  const items = runs?.items ?? [];
  const waiting = items.filter((r) => r.role === 'ASKED' && r.status === 'WAITING_APPROVAL');

  return (
    <Shell ctx={ctx}>
      <PageHeader
        title="Matching with other Partners"
        lead="How many customers you share with another Partner, and audiences of them — with nobody seeing the other's customers."
      />

      {status && !status.available ? (
        <Notice tone="warn">This Oolix deployment has no clean room yet.</Notice>
      ) : null}

      <Card title="Taking part">
        <p className="faint">
          Your Agent turns the email and mobile numbers of customers who agreed to this purpose into
          one-way codes on your server, and seals them to a clean room running in a hardware
          enclave, after checking it runs the published code. Oolix carries the sealed data and
          cannot open it; the clean room keeps nothing. Turn the matching on in your Agent&rsquo;s
          setup page too, where you choose the columns and the consent.
        </p>
        <CleanRoomParticipation enabled={status?.enabled ?? false} />
      </Card>

      {waiting.length > 0 ? (
        <Card title={`Asked of you (${waiting.length})`}>
          <table>
            <tbody>
              {waiting.map((r) => (
                <tr key={r.id}>
                  <td>
                    <strong>{r.with.name ?? 'A Partner'}</strong> asks for{' '}
                    {r.kind === 'JOINT'
                      ? 'an audience of their customers that you also have'
                      : 'how many customers you share'}
                  </td>
                  <td>
                    <CleanRoomDecision runId={r.id} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      {status?.enabled ? (
        <Card title="Ask another Partner">
          {status.partners.length === 0 ? (
            <Empty>No other Partner takes part yet.</Empty>
          ) : (
            <CleanRoomRequest partners={status.partners} />
          )}
        </Card>
      ) : null}

      <Card title={`Runs (${items.length})`}>
        {items.length === 0 ? (
          <Empty>No runs yet.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>With</th>
                <th>What</th>
                <th>State</th>
                <th>Shared customers</th>
                <th>Asked</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id}>
                  <td>{r.with.name ?? '—'}</td>
                  <td>{r.kind === 'JOINT' ? 'Joint audience' : 'Overlap'}</td>
                  <td>
                    <StatusBadge status={r.status} />
                  </td>
                  <td>{r.band ? (BANDS[r.band] ?? r.band) : '—'}</td>
                  <td>{dateOnly(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </Shell>
  );
}
