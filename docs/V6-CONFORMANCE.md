# v6 change spec — section-by-section conformance

`Oolix_Audience_Builder_Data_Partner_Matching_Change_Spec_v6.docx`, audited
2026-08-24 against the code, not against memory.

Each row names where the behaviour lives and what proves it. "Proof" means a
check that fails if the behaviour is removed — not that a file exists.

## §1–§3 Product change and canonical objects

| Object (§3) | Where | Proof |
| --- | --- | --- |
| AudienceGroup | `audience_groups` | `verify-v6` §3 |
| AudienceRule | `audience_group_versions.rules_json` | `verify-v6` §3 |
| AttributeDefinition | `attribute_definitions` | `verify-v6` §1 |
| PartnerCapability | `partner_capabilities` | `verify-v6` §2 |
| PartnerAttributeMapping | **Partner only** — `partner/agent/config.*.yaml` | `internal/config` test |
| PartnerMatchSnapshot | `partner_match_snapshots` | `verify-v6` §4 |
| ReachEstimate | `reach_estimates` | `verify-v6` §8 |
| AudienceMaterialization | **Partner only** — `oolix_audience_materialization` | `verify-v6-serving` §5 |
| CampaignAudienceLink | `campaign_audience_links` | `verify-v6` §10 |
| PartnerRequest | `partner_requests` + v6 columns | `verify-v6-serving` §3 |
| Activation | `activations` + materialization columns | `verify-v6-serving` §5 |

§3's "one Audience Group per campaign in the first MVP" is enforced by
`linkAudience`, and the join table shape means supporting several later is not a
destructive migration.

## §4 Taxonomy

16 attributes (Appendix A) seeded as platform data, versioned by `(key,
version)`, every one `policy_class = GENERAL` — §4's sensitive classes are
absent rather than present-and-disabled.

"A campaign request binds to the exact taxonomy/rule version approved by the
Partner": `audience_group_versions.taxonomy_version` records what the rules were
validated against, and a `PartnerRequest` binds to `(audience_group_id,
audience_version)`, so the taxonomy version is fixed transitively.

## §5 Capability publication and mapping

`PUT /v1/partner/capabilities` publishes metadata; each call mints a new
version. §5.2's mapping is Partner-local and **has no column anywhere in the
Oolix schema** — the fixture Partner deliberately stores `pay_mode`,
`sex_code`, `product_class`, so a leak would be visible.

## §6 Audience Builder

Attribute / operator / value / required / weight, composed from the taxonomy.
No free-text expression field exists.

§6.2 lists a **Match mode** row ("exact required / flexible optional"). That is
the per-rule REQUIRED/OPTIONAL flag, not a separate control: §6.3's canonical
rule JSON has no `match_mode` key and §7's algorithm reads only `required`.
Adding a second, redundant control would let the two disagree.

## §7 Matching

`matchPartner()` in `shared/contracts/src/audience.ts` implements §7's
pseudocode literally, including:

- per-attribute `status` — §17's Partner attribute block;
- **geography** — §7 step 3 asks for "attribute + operator + geography/policy",
  and a Partner able to evaluate `country` but not holding that country is
  INCOMPATIBLE. Narrow by design: `country` only (`geographies` is a country
  list; `state_region`/`city` are sub-national), and a Partner declaring no
  geographies is not gated, because missing metadata is not a claim to cover
  nowhere.

## §8 Reach estimation

`POST .../reach-estimates` returns **202** — §8.1's code, and the honest one:
nothing is computed when it returns. The Agent evaluates locally, applies the
minimum cohort, and reports a bucket. `EstimateResult` has no field that could
carry a count.

## §9–§10 Campaign linkage and Partner review

Link freezes version + rule hash. §10's review table is rendered in full,
including field coverage computed from the Partner's *own* capabilities and the
safe reach their *own* Agent produced.

§10's "REQUEST_CHANGE can request audience-rule changes" is a named option in
the Partner's change form, alongside creative, placement, channel, commercial
terms, dates/frequency and purpose.

## §11–§13 Local materialization, runtime, external

Compiled locally by rule hash; the runtime is one indexed lookup (§12), and the
decision reports `audience_materialization_version` per §12's response shape.
Meta/Google remain feature-flagged off — §13's plumbing routes them through the
same locally materialized set, and §20's "External" row is that they cannot run
before approval, eligibility and materialization.

## §14–§16 Contracts, schema, states

All 11 routes exist with the specified verbs, all 8 tables with the specified
fields, and every state set in §16 including `ReachEstimate.EXPIRED`, which a
worker actually sets rather than merely declaring.

## §17 Privacy

Rules and capability metadata centrally; counts, field names and members local.
Minimum cohort before a bucket. Repeat estimates cached and rate-limited. No
arbitrary SQL/JS/regex — the compiler binds every Oolix-supplied value as a
parameter and validates column expressions against a Partner-owned allow-list.

## §18–§19 UI and migration

`/discover` demoted to "Partner segments"; `/audiences` is the primary Buyer
route. `targeting_source = AUDIENCE_GROUP | PREBUILT_SEGMENT`, both paths
working, each with browser coverage.

## §20 Acceptance criteria

All eleven rows pass live: `pnpm verify` runs the seven v5 phases plus
`verify-v6` and `verify-v6-serving`.

## Known deviations

| | Why |
| --- | --- |
| TypeScript 5.9.3, not 7 | 7 is not released |
| Docker Engine in WSL2 | Docker Desktop's installer stalls on this host |
| Meta/Google off | §84 requires proven account eligibility first |
