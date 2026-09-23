/**
 * Switch the active organization (§34).
 *
 * A plain form that posts to a route handler, so it works before hydration and
 * without client JavaScript. Switching changes which organization subsequent
 * calls act within; it grants nothing — the API re-derives roles and
 * permissions from the database for whichever organization is named (§4.2), so
 * naming one you do not belong to simply fails there.
 *
 * The roles held in the ACTIVE organization are shown, because with several
 * memberships "who am I right now" is the question this control answers.
 */
import type { MeContext } from '@/lib/context';

export function OrgSwitcher({ ctx }: { ctx: MeContext }) {
  const active = ctx.active_organization;
  const multiple = ctx.organizations.length > 1;

  return (
    <div className="org-switch">
      <div className="org-switch-label">{multiple ? 'Acting as' : 'Organization'}</div>
      <div className="org-switch-name">{active?.name ?? 'No organization'}</div>

      {active ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', marginBottom: '0.3rem' }}>
          {active.roles.map((role) => (
            <span className="badge badge-info" key={role}>
              {role.replaceAll('_', ' ').toLowerCase()}
            </span>
          ))}
        </div>
      ) : null}

      {multiple ? (
        <form action="/api/auth/org" method="post">
          <label htmlFor="org_id" className="org-switch-label">
            Switch to
          </label>
          <select id="org_id" name="org_id" defaultValue={active?.id}>
            {ctx.organizations.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </select>
          <button type="submit">Switch organization</button>
        </form>
      ) : null}
    </div>
  );
}
