/**
 * Synonyms learned from Partners (docs/DESIGN-PARTNER-DATA.md §5.6).
 *
 * A Partner who chooses to share sends the answers it gave its Agent for
 * values the Agent could not read -- "Kurtis" means FASHION. Nothing reaches
 * another Partner's Agent until it is approved here, which is what keeps one
 * Partner's mistake, or mischief, out of everyone's data.
 *
 * Partners are counted, never named: the review is about the value, and how
 * many independent Partners agree on what it means is the evidence.
 */
import { requireContext } from '@/lib/nav-entry';
import { apiOptional } from '@/lib/api';
import { Shell } from '@/components/Shell';
import { SynonymDecision } from '@/components/SynonymDecision';
import { Card, Empty, Notice, PageHeader, StatusBadge, dateOnly } from '@/components/ui';

interface PendingValue {
  attribute_key: string;
  value_key: string;
  example: string;
  partners: number;
  codes: { code: string; partners: number }[];
}

interface Decision {
  attribute_key: string;
  value_key: string;
  code: string;
  status: 'APPROVED' | 'REJECTED';
  decided_at: string;
}

const attributeLabel = (key: string) => key.replaceAll('_', ' ');

export default async function Page() {
  const ctx = await requireContext('/admin/synonyms');

  const data = await apiOptional<{ pending: PendingValue[]; decided: Decision[] }>(
    '/v1/admin/synonyms',
  );
  const pending = data?.pending ?? [];
  const decided = data?.decided ?? [];

  return (
    <Shell ctx={ctx}>
      <PageHeader
        title="Shared synonyms"
        lead="Values Partners taught their Agents, waiting to be shared with every Agent."
      />

      {data === null ? (
        <Notice tone="warn">
          The shared values could not be loaded. This screen needs
          <code> admin:operate</code>, which only an Oolix administrator holds.
        </Notice>
      ) : null}

      <Card title={`Waiting for review (${pending.length})`}>
        {pending.length === 0 ? (
          <Empty>Nothing is waiting. Partners have not shared anything new.</Empty>
        ) : (
          <>
            <p className="faint">
              Approving sends the value and its code to every Partner&rsquo;s Agent, which reads it
              like a built-in synonym; a Partner&rsquo;s own answers still come first. Values more
              Partners agree on are listed first.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Value</th>
                  <th>Attribute</th>
                  <th>What Partners said</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pending.map((p) => (
                  <tr key={`${p.attribute_key}/${p.value_key}`}>
                    <td>
                      <strong>{p.example}</strong>
                      {p.example !== p.value_key ? (
                        <div className="faint">{p.value_key}</div>
                      ) : null}
                    </td>
                    <td>{attributeLabel(p.attribute_key)}</td>
                    <td>
                      {p.codes.map((c) => (
                        <div key={c.code}>
                          {c.code}{' '}
                          <span className="faint">
                            ({c.partners} Partner{c.partners === 1 ? '' : 's'})
                          </span>
                        </div>
                      ))}
                    </td>
                    <td>
                      <SynonymDecision
                        attributeKey={p.attribute_key}
                        valueKey={p.value_key}
                        codes={p.codes.map((c) => c.code)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Card>

      <Card title={`Decided (${decided.length})`}>
        {decided.length === 0 ? (
          <Empty>No value has been decided yet.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Value</th>
                <th>Attribute</th>
                <th>Code</th>
                <th>Decision</th>
                <th>When</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {decided.map((d) => (
                <tr key={`${d.attribute_key}/${d.value_key}`}>
                  <td>
                    <strong>{d.value_key}</strong>
                  </td>
                  <td>{attributeLabel(d.attribute_key)}</td>
                  <td>{d.code}</td>
                  <td>
                    <StatusBadge status={d.status} />
                  </td>
                  <td>{dateOnly(d.decided_at)}</td>
                  <td>
                    <SynonymDecision
                      attributeKey={d.attribute_key}
                      valueKey={d.value_key}
                      codes={[d.code]}
                      status={d.status}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </Shell>
  );
}
