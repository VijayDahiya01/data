/**
 * Mock Data Partner -- spec v5 §91.
 *
 * §91 requires this to exist so frontend, backend and Agent work can proceed
 * before a real Data Partner is available. It stands in for the Partner's own
 * product, and its job is to demonstrate the boundary the whole architecture
 * rests on:
 *
 *   browser -> Partner backend -> Partner Agent (local)
 *
 * The browser never sends a customer identifier, and nothing here ever talks
 * to Oolix Cloud. The Partner backend resolves the logged-in user from its own
 * session (§68.1 step 2) and calls the Agent over a private endpoint.
 *
 * §91 fixtures: U123 is a member of RECENT_TRAVELLER_60D and PREMIUM_USER;
 * U456 is a member of neither.
 */
import Fastify, { type FastifyInstance } from 'fastify';

export interface MockPartnerOptions {
  /** The LOCAL Partner Agent. Never an Oolix address (§12.1). */
  agentUrl?: string;
  /** §68 / §103: the hard decision timeout before fallback. */
  decisionTimeoutMs?: number;
}

/**
 * Build the Partner backend.
 *
 * Separated from the process entrypoint so tests can drive the §91 fixtures
 * and the §43 fail-safe path without binding a port or requiring a live Agent.
 */
export function buildApp(options: MockPartnerOptions = {}): FastifyInstance {
  const AGENT_URL = options.agentUrl ?? process.env.PARTNER_AGENT_URL ?? 'http://localhost:8082';
  const DECISION_TIMEOUT_MS =
    options.decisionTimeoutMs ?? Number(process.env.MOCK_PARTNER_TIMEOUT_MS ?? 150);

  const app = Fastify({ logger: false });

  interface AdDecision {
    decision: 'SHOW' | 'NO_AD';
    reason?: string;
    activation_id?: string;
    creative?: Record<string, unknown>;
    cache_ttl_ms?: number;
  }

  /**
   * Resolve the logged-in customer.
   *
   * A real Partner reads this from its own session or auth token. The mock uses
   * ?user= purely so a developer can switch between the §91 fixtures. This value
   * NEVER leaves the Partner boundary -- it goes to the local Agent and nowhere
   * else (§12 step 3, §43).
   */
  function resolvePartnerUserId(query: Record<string, unknown>): string | null {
    const u = query.user;
    return typeof u === 'string' && u.length > 0 ? u : null;
  }

  /**
   * §91.1 / §68.1: the Partner backend's ad-decision endpoint.
   *
   * Everything about this handler is designed to fail safe. §43 is explicit that
   * "ad placement failure cannot block checkout/booking/login", so a missing,
   * slow or broken Agent must produce house content, never a 500.
   */
  app.post('/api/ad-decision', async (request, reply) => {
    const body = (request.body ?? {}) as {
      placement_id?: string;
      context?: Record<string, unknown>;
    };
    const partnerUserId = resolvePartnerUserId(request.query as Record<string, unknown>);

    if (!body.placement_id) {
      return reply.status(400).send({ error: 'placement_id is required' });
    }

    // An anonymous visitor cannot be segment-targeted at all (§76.2: "MVP
    // segment-based targeting requires a Partner-authenticated or
    // Partner-resolvable first-party identity").
    if (!partnerUserId) {
      return reply.send({ decision: 'NO_AD', reason: 'CONSENT_NOT_ELIGIBLE' } satisfies AdDecision);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DECISION_TIMEOUT_MS);

    try {
      const res = await fetch(`${AGENT_URL}/private/v1/ad-decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Sent to the LOCAL Agent only. This is the one hop where a customer
          // identifier appears, and it never crosses the Partner boundary.
          partner_user_id: partnerUserId,
          placement_id: body.placement_id,
          context: body.context ?? {},
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        return reply.send({
          decision: 'NO_AD',
          reason: 'NO_ELIGIBLE_CAMPAIGN',
        } satisfies AdDecision);
      }

      const decision = (await res.json()) as AdDecision;

      // Strip anything that is not needed for rendering before it reaches the
      // browser (§68.1 step 4: "return sanitized ad payload").
      if (decision.decision === 'SHOW') {
        return reply.send({
          decision: 'SHOW',
          activation_id: decision.activation_id,
          creative: decision.creative,
          cache_ttl_ms: decision.cache_ttl_ms,
        } satisfies AdDecision);
      }
      return reply.send({ decision: 'NO_AD', reason: decision.reason ?? 'NO_ELIGIBLE_CAMPAIGN' });
    } catch {
      // Agent offline or over the latency budget. §57: the slot degrades, the
      // Partner's page does not.
      return reply.send({ decision: 'NO_AD', reason: 'NO_ELIGIBLE_CAMPAIGN' } satisfies AdDecision);
    } finally {
      clearTimeout(timer);
    }
  });

  /** Impression and click telemetry, kept Partner-side. */
  app.post('/api/ad-event', async (_request, reply) => reply.status(204).send());

  /**
   * §91: the Buyer landing page, used to exercise attribution.
   *
   * It receives ONLY the opaque click token (§90). The page cannot tell which
   * Partner, segment or creative produced the click -- that mapping exists only
   * server-side in Oolix, keyed by SHA-256(token).
   */
  app.get('/buyer-landing', async (request, reply) => {
    const token = (request.query as Record<string, unknown>).click_token;
    return reply.type('text/html').send(`<!doctype html>
  <html><head><meta charset="utf-8"><title>ABC Insurance - Get a quote</title>
  <style>body{font-family:system-ui,sans-serif;max-width:640px;margin:4rem auto;padding:0 1rem;line-height:1.6}
  code{background:#f4f4f5;padding:.15rem .4rem;border-radius:4px;word-break:break-all}</style></head>
  <body>
    <h1>Buyer landing page</h1>
    <p>This stands in for the Buyer's own site. It received an opaque attribution token
       and nothing else &mdash; no Partner identity, no segment, no customer data.</p>
    <p><strong>click_token:</strong> <code>${token ? String(token).replace(/[<>&"]/g, '') : '(none)'}</code></p>
    <p>The Buyer stores this token alongside the lead, then posts lead status to
       <code>POST /v1/leads/events</code>. Oolix resolves it to an activation by hash.</p>
  </body></html>`);
  });

  /** The Partner's own product page, carrying an Oolix ad slot. */
  app.get('/', async (request, reply) => {
    const user = resolvePartnerUserId(request.query as Record<string, unknown>) ?? '';
    return reply.type('text/html').send(`<!doctype html>
  <html><head><meta charset="utf-8"><title>Travel A - Booking confirmed</title>
  <style>
    body{font-family:system-ui,sans-serif;max-width:720px;margin:3rem auto;padding:0 1rem;line-height:1.6;color:#18181b}
    .confirm{background:#ecfdf5;border:1px solid #a7f3d0;border-radius:10px;padding:1rem 1.25rem}
    .slot{margin-top:2rem;border:1px dashed #d4d4d8;border-radius:10px;padding:1rem;min-height:96px}
    .ad{display:block;border:1px solid #e4e4e7;border-radius:10px;padding:1rem;text-decoration:none;color:inherit}
    .ad h3{margin:0 0 .35rem}
    .house{color:#71717a;font-style:italic}
    .who{margin-top:2rem;font-size:.9rem;color:#52525b}
    .who a{margin-right:.75rem}
    .note{margin-top:1.5rem;font-size:.85rem;color:#71717a;border-top:1px solid #e4e4e7;padding-top:1rem}
  </style></head>
  <body>
    <h1>Travel A</h1>
    <div class="confirm"><strong>Booking confirmed.</strong> Your trip to Goa is booked.</div>

    <div class="slot" id="slot"><span class="house">Loading&hellip;</span></div>

    <div class="who">
      Mock customer: <strong>${user || '(anonymous)'}</strong><br>
      <a href="/?user=U123">U123 (in both segments)</a>
      <a href="/?user=U456">U456 (in no segment)</a>
      <a href="/?user=U321">U321 (consent withdrawn)</a>
      <a href="/">anonymous</a>
    </div>

    <p class="note">
      The browser sends only a placement id. This page's backend resolves the
      customer from its own session and asks the local Partner Agent. No customer
      identifier reaches Oolix (spec &sect;12, &sect;68).
    </p>

  <script>
  (async () => {
    const slot = document.getElementById('slot');
    const house = '<span class="house">Partner house offer &mdash; no Oolix ad served.</span>';
    const user = new URLSearchParams(location.search).get('user');
    try {
      const res = await fetch('/api/ad-decision' + (user ? '?user=' + encodeURIComponent(user) : ''), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ placement_id: 'booking_success_offer', context: { page_type: 'booking_success' } })
      });
      const d = await res.json();
      if (d.decision === 'SHOW' && d.creative) {
        const c = d.creative;
        // An IMAGE creative has no headline or body -- the image is the whole
        // ad. Rendering only the text fields showed an empty card for a
        // perfectly good ad, which looks exactly like no ad at all.
        const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (ch) =>
          ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
        const parts = [];
        if (c.asset_url) {
          parts.push('<img src="' + esc(c.asset_url) + '" alt="' + esc(c.headline || 'Advertisement') +
            '" style="width:100%;border-radius:8px;display:block">');
        }
        if (c.headline) parts.push('<h3>' + esc(c.headline) + '</h3>');
        if (c.body) parts.push('<p>' + esc(c.body) + '</p>');
        parts.push('<strong>' + esc(c.cta || 'Learn more') + '</strong>');
        slot.innerHTML =
          '<a class="ad" href="' + esc(c.destination_url) + '" rel="noopener noreferrer sponsored">' +
          parts.join('') + '</a>' +
          '<small style="color:#71717a">' + esc(c.format || '') + ' &middot; activation ' +
          esc(String(d.activation_id || '').slice(0, 8)) + '</small>';
      } else {
        slot.innerHTML = house + '<br><small>reason: ' + (d.reason || 'NO_AD') + '</small>';
      }
    } catch (e) {
      // §43: an ad failure must never affect the booking flow.
      slot.innerHTML = house;
    }
  })();
  </script>
  </body></html>`);
  });

  app.get('/healthz', async () => ({ status: 'ok', agent_url: AGENT_URL }));

  return app;
}
