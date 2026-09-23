-- =============================================================================
-- Partner-local audience attributes and materialization -- v6 §5.2, §11.
--
-- THIS FILE LIVES INSIDE THE DATA PARTNER. Oolix has no credential to it and
-- no knowledge of what is in it beyond the capability metadata the Partner
-- chooses to publish.
--
-- Two things here matter more than they look:
--
--   1. The LOCAL COLUMN NAMES ARE DELIBERATELY NOT the Oolix attribute keys.
--      v6 §5.2's mapping table is the whole point: Oolix asks about
--      `payment_method`; this Partner stores `pay_mode`. The Agent holds the
--      mapping in its own config, and §17 states that Oolix stores "Partner
--      capability metadata, not Partner customer records or Partner local
--      field names".
--
--   2. §5.2's recommended integration: "Do not dynamically join a large
--      transactional production schema for every estimate or ad request."
--      This is a PRE-COMPUTED attribute table the Partner refreshes on its own
--      schedule -- not a view over live orders.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The restricted attribute source the Agent may read (§7.1, §45).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oolix_audience_attributes (
  partner_user_id   VARCHAR(120) PRIMARY KEY,

  -- Demographic. Note `sex_code`, not `gender`.
  dob               DATE,
  sex_code          VARCHAR(16),

  -- Geography.
  country_code      VARCHAR(2),
  region_code       VARCHAR(8),
  city_code         VARCHAR(40),

  -- Commerce. `product_class`, not `purchase_category`.
  is_online_buyer   BOOLEAN      NOT NULL DEFAULT FALSE,
  product_class     VARCHAR(40),
  last_order_at     TIMESTAMPTZ,
  order_count_90d   INTEGER      NOT NULL DEFAULT 0,

  -- Payment. `pay_mode`, not `payment_method`.
  pay_mode          VARCHAR(24),

  -- Travel.
  has_recent_trip   BOOLEAN      NOT NULL DEFAULT FALSE,
  trip_scope        VARCHAR(16),
  last_booking_at   TIMESTAMPTZ,

  -- Engagement.
  last_seen_at      TIMESTAMPTZ,
  uses_app          BOOLEAN      NOT NULL DEFAULT FALSE,
  tier_code         VARCHAR(16),

  refreshed_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE oolix_audience_attributes IS
  'v6 §5.2: pre-computed attribute source the Oolix Agent may read. Column names are local and are never published to Oolix.';

-- Age and recency are DERIVED at query time from dob / last_order_at, exactly
-- as §5.2's mapping table describes. The Agent's compiled predicate uses these
-- expressions; the raw dates never leave this database either way.
CREATE INDEX IF NOT EXISTS idx_audience_attrs_commerce
  ON oolix_audience_attributes (is_online_buyer, product_class, last_order_at);
CREATE INDEX IF NOT EXISTS idx_audience_attrs_pay
  ON oolix_audience_attributes (pay_mode);

-- The two columns behind v6 5.2's derived attributes: `age` from dob, and
-- `purchase_recency_days` from last_order_at.
--
-- These earn their keep only because the Agent compiles those attributes into
-- ranges over the raw column. Expressed the obvious way -- a function wrapped
-- around the column -- no index can be used at all, and the query reads every
-- row. Measured 12x on 20k rows; the ratio holds as the table grows, because
-- the slow form's cost is the table itself.
CREATE INDEX IF NOT EXISTS idx_audience_attrs_dob
  ON oolix_audience_attributes (dob);
CREATE INDEX IF NOT EXISTS idx_audience_attrs_last_order
  ON oolix_audience_attributes (last_order_at);

-- -----------------------------------------------------------------------------
-- §11: the local materialized audience.
--
-- This table is the reason Oolix can stay out of it. An approved audience rule
-- is compiled here ONCE, the matching members are written down, and the runtime
-- ad decision becomes a primary-key lookup rather than a rule evaluation
-- (§12) -- which is what keeps the §103 p95 budget reachable.
--
-- Oolix stores status, version and freshness for this. Never a row of it.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oolix_audience_members (
  partner_user_id         VARCHAR(120) NOT NULL,
  activation_id           UUID         NOT NULL,
  materialization_version INTEGER      NOT NULL,
  expires_at              TIMESTAMPTZ  NOT NULL,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  PRIMARY KEY (activation_id, partner_user_id)
);

COMMENT ON TABLE oolix_audience_members IS
  'v6 §11: locally compiled audience membership. Never leaves this database.';

-- The runtime lookup (§12): one activation, one user, is it live.
CREATE INDEX IF NOT EXISTS idx_audience_members_lookup
  ON oolix_audience_members (partner_user_id, activation_id, expires_at);

-- -----------------------------------------------------------------------------
-- §11: what the Agent has compiled, and at which version.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oolix_audience_materialization (
  activation_id           UUID PRIMARY KEY,
  audience_group_id       VARCHAR(64)  NOT NULL,
  audience_version        INTEGER      NOT NULL,
  -- §10: recomputed by the Agent before it serves. A mismatch means the rules
  -- changed since the Partner approved them.
  rule_hash               CHAR(64)     NOT NULL,
  materialization_version INTEGER      NOT NULL DEFAULT 1,
  member_count            INTEGER      NOT NULL DEFAULT 0,
  status                  VARCHAR(24)  NOT NULL DEFAULT 'NOT_STARTED',
  last_error              TEXT,
  built_at                TIMESTAMPTZ,
  expires_at              TIMESTAMPTZ
);

COMMENT ON COLUMN oolix_audience_materialization.member_count IS
  'Local only. Oolix receives a reach BUCKET, never this number (v6 §8.2, §17).';

-- -----------------------------------------------------------------------------
-- §95-style fixtures, aligned with the existing U123 / U456 identities.
-- -----------------------------------------------------------------------------
INSERT INTO oolix_audience_attributes (
  partner_user_id, dob, sex_code, country_code, region_code, city_code,
  is_online_buyer, product_class, last_order_at, order_count_90d, pay_mode,
  has_recent_trip, trip_scope, last_booking_at, last_seen_at, uses_app, tier_code
) VALUES
  -- U123: matches the §6.3 "Urban Shoe Shoppers" audience on every rule.
  ('U123', '1996-04-12', 'MALE', 'IN', 'DL', 'DELHI',
   TRUE, 'FOOTWEAR', NOW() - INTERVAL '12 days', 4, 'UPI',
   TRUE, 'DOMESTIC', NOW() - INTERVAL '20 days', NOW() - INTERVAL '2 days', TRUE, 'GOLD'),

  -- U456: right age, but buys groceries and has not bought recently. Fails
  -- purchase_category AND purchase_recency_days.
  ('U456', '1994-08-30', 'FEMALE', 'IN', 'KA', 'BENGALURU',
   TRUE, 'GROCERY', NOW() - INTERVAL '200 days', 1, 'COD',
   FALSE, NULL, NULL, NOW() - INTERVAL '5 days', FALSE, 'SILVER'),

  -- U321: matches the rules, but consent is withdrawn in oolix_user_consent.
  -- §11 and §12 both re-check consent locally, so this person is materialized
  -- and still never served.
  ('U321', '1999-01-05', 'FEMALE', 'IN', 'DL', 'GURUGRAM',
   TRUE, 'FOOTWEAR', NOW() - INTERVAL '30 days', 3, 'CREDIT_CARD',
   FALSE, NULL, NULL, NOW() - INTERVAL '1 day', TRUE, 'SILVER'),

  -- U789: too old for the 18-35 rule, matches everything else.
  ('U789', '1975-06-18', 'MALE', 'IN', 'MH', 'MUMBAI',
   TRUE, 'FOOTWEAR', NOW() - INTERVAL '5 days', 8, 'UPI',
   TRUE, 'INTERNATIONAL', NOW() - INTERVAL '10 days', NOW(), TRUE, 'PLATINUM')
ON CONFLICT (partner_user_id) DO NOTHING;

-- A cohort large enough to clear §72's minimum publishable size, so a reach
-- estimate returns a real bucket rather than BELOW_THRESHOLD.
INSERT INTO oolix_audience_attributes (
  partner_user_id, dob, sex_code, country_code, region_code, city_code,
  is_online_buyer, product_class, last_order_at, order_count_90d, pay_mode,
  last_seen_at, uses_app, tier_code
)
SELECT
  'SYN' || g,
  (DATE '1990-01-01' + (g % 4000) * INTERVAL '1 day')::date,
  CASE WHEN g % 2 = 0 THEN 'MALE' ELSE 'FEMALE' END,
  'IN',
  'DL',
  'DELHI',
  TRUE,
  CASE WHEN g % 3 = 0 THEN 'FOOTWEAR' ELSE 'FASHION' END,
  NOW() - ((g % 120) * INTERVAL '1 day'),
  (g % 9) + 1,
  CASE WHEN g % 2 = 0 THEN 'UPI' ELSE 'CREDIT_CARD' END,
  NOW() - ((g % 30) * INTERVAL '1 day'),
  g % 2 = 0,
  'SILVER'
FROM generate_series(1, 20000) AS g
ON CONFLICT (partner_user_id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- §45: least privilege. The Agent may READ attributes and READ/WRITE only its
-- own materialization -- it has no access to anything else in this database.
-- -----------------------------------------------------------------------------
GRANT SELECT ON oolix_audience_attributes TO oolix_agent_ro;
GRANT SELECT, INSERT, UPDATE, DELETE ON oolix_audience_members TO oolix_agent_ro;
GRANT SELECT, INSERT, UPDATE ON oolix_audience_materialization TO oolix_agent_ro;
