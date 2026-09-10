-- =============================================================================
-- What a Data Partner provides for the Oolix Agent.
--
-- These tables live in the PARTNER's database, and Oolix has no credential to
-- any of them. The Agent — running inside the Partner's own infrastructure —
-- is the only thing that reads them. Nothing here is ever transmitted; what
-- leaves is a reach band, a hashed token and counts.
--
-- Three of these the Partner fills. Two the Agent writes for itself.
--
-- Column names below are deliberately NOT the names Oolix uses. `sex_code` for
-- gender, `product_class` for purchase category, `pay_mode` for payment method:
-- the translation between a Partner's schema and the Oolix vocabulary belongs
-- in the Partner's Agent configuration, not in a shared naming convention. A
-- Partner whose columns are named differently again changes the mapping, not
-- this file.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Segment membership — who is in an audience the Partner already maintains.
--
-- Only needed for the prebuilt-segment path. A Partner using audience rules
-- (the primary path) can leave this empty.
--
-- `expires_at` is not optional. Membership that never expires is membership
-- nobody re-verified, and the Agent refuses to serve on a stale row.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oolix_segment_membership (
    partner_user_id TEXT        NOT NULL,
    segment_id      TEXT        NOT NULL,
    effective_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (partner_user_id, segment_id)
);

CREATE INDEX IF NOT EXISTS idx_membership_segment_live
    ON oolix_segment_membership (segment_id, expires_at);


-- -----------------------------------------------------------------------------
-- 2. Consent — per person, per declared advertising purpose.
--
-- This is the table that decides whether anybody sees an ad at all, and it is
-- checked at decision time rather than at audience build time: consent
-- withdrawn an hour ago stops the next impression, not the next rebuild.
--
-- `purpose_id` matches the purpose a Buyer declared on the campaign. There is
-- no general "advertising" flag by design — consent is given for a stated
-- purpose or it is not given.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oolix_user_consent (
    partner_user_id  TEXT        NOT NULL,
    purpose_id       TEXT        NOT NULL,
    eligible         BOOLEAN     NOT NULL,
    policy_version   TEXT        NOT NULL,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    withdrawn_at     TIMESTAMPTZ,
    PRIMARY KEY (partner_user_id, purpose_id)
);


-- -----------------------------------------------------------------------------
-- 3. Attributes — the pre-computed view the Agent evaluates rules against.
--
-- A RESTRICTED, PRE-BUILT table. Not a view over the live transactional schema,
-- and not a join across it: an ad decision has roughly 100ms, and a build has
-- to finish inside a timeout measured in seconds. Refresh it on whatever
-- schedule suits the data — nightly is usually enough — and record when.
--
-- Every column is optional. An attribute a Partner does not hold is one they
-- cannot be asked about: the matching step marks them incompatible for a rule
-- that requires it, which is the honest answer rather than a partial match.
--
-- The columns below are what the reference mapping expects. Rename freely and
-- change the mapping to suit.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oolix_audience_attributes (
  partner_user_id   VARCHAR(120) PRIMARY KEY,

  -- Demographic. Store the date of birth, not a computed age: an age column is
  -- wrong the morning after it is written, and the Agent derives it anyway.
  dob               DATE,
  sex_code          VARCHAR(16),

  -- Geography.
  country_code      VARCHAR(2),
  region_code       VARCHAR(8),
  city_code         VARCHAR(40),

  -- Commerce.
  is_online_buyer   BOOLEAN      NOT NULL DEFAULT FALSE,
  product_class     VARCHAR(40),
  last_order_at     TIMESTAMPTZ,
  order_count_90d   INTEGER      NOT NULL DEFAULT 0,

  -- Payment.
  pay_mode          VARCHAR(24),

  -- Travel.
  has_recent_trip   BOOLEAN      NOT NULL DEFAULT FALSE,
  trip_scope        VARCHAR(16),
  last_booking_at   TIMESTAMPTZ,

  -- Engagement.
  last_seen_at      TIMESTAMPTZ,
  uses_app          BOOLEAN      NOT NULL DEFAULT FALSE,
  tier_code         VARCHAR(16),

  -- When this row was last rebuilt. Reported with every reach estimate so an
  -- answer can be tied to the data that produced it.
  refreshed_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Index the columns the rules actually filter on.
--
-- The two date indexes matter more than they look. `age` and
-- `purchase_recency_days` are derived values, and the obvious way to express
-- them — wrapping the column in a function — cannot use an index at all, so
-- every audience carrying an age rule reads the whole table. Declaring
-- `column:` and `derive:` in the Agent's mapping makes it compile to a range
-- over the raw column instead. Measured 12x faster on 20,000 rows, and the gap
-- widens with the table, because the slow form's cost IS the table.
CREATE INDEX IF NOT EXISTS idx_audience_attrs_commerce
  ON oolix_audience_attributes (is_online_buyer, product_class, last_order_at);
CREATE INDEX IF NOT EXISTS idx_audience_attrs_pay
  ON oolix_audience_attributes (pay_mode);
CREATE INDEX IF NOT EXISTS idx_audience_attrs_dob
  ON oolix_audience_attributes (dob);
CREATE INDEX IF NOT EXISTS idx_audience_attrs_last_order
  ON oolix_audience_attributes (last_order_at);


-- -----------------------------------------------------------------------------
-- 4 and 5. The Agent's own working tables.
--
-- Created here so the read-only connector user never needs permission to create
-- anything. The Agent writes these; a Partner reads them if they want to see
-- what was built. Neither is ever sent anywhere.
-- -----------------------------------------------------------------------------

-- Who matched an approved rule set, built locally.
CREATE TABLE IF NOT EXISTS oolix_audience_members (
  partner_user_id         VARCHAR(120) NOT NULL,
  activation_id           UUID         NOT NULL,
  materialization_version INTEGER      NOT NULL,
  expires_at              TIMESTAMPTZ  NOT NULL,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  PRIMARY KEY (activation_id, partner_user_id)
);

CREATE INDEX IF NOT EXISTS idx_audience_members_lookup
  ON oolix_audience_members (partner_user_id, activation_id, expires_at);

-- One row per activation: what was built, from which rules, and when.
--
-- `rule_hash` is recomputed by the Agent before it serves. A mismatch means the
-- rules changed after the Partner approved them, and the Agent refuses rather
-- than serving something nobody agreed to.
CREATE TABLE IF NOT EXISTS oolix_audience_materialization (
  activation_id           UUID PRIMARY KEY,
  audience_group_id       VARCHAR(64)  NOT NULL,
  audience_version        INTEGER      NOT NULL,
  rule_hash               CHAR(64)     NOT NULL,
  materialization_version INTEGER      NOT NULL DEFAULT 1,
  member_count            INTEGER      NOT NULL DEFAULT 0,
  status                  VARCHAR(24)  NOT NULL DEFAULT 'NOT_STARTED',
  last_error              TEXT,
  built_at                TIMESTAMPTZ,
  expires_at              TIMESTAMPTZ
);


-- -----------------------------------------------------------------------------
-- The connector user.
--
-- The Agent reads attributes, membership and consent, and writes only its own
-- two tables. Granting more than this does not make anything work better.
-- -----------------------------------------------------------------------------
-- CREATE USER oolix_agent_ro WITH PASSWORD '<from your secret manager>';
--
-- GRANT SELECT ON oolix_audience_attributes,
--                 oolix_segment_membership,
--                 oolix_user_consent
--   TO oolix_agent_ro;
--
-- GRANT SELECT, INSERT, UPDATE, DELETE ON oolix_audience_members,
--                                          oolix_audience_materialization
--   TO oolix_agent_ro;
