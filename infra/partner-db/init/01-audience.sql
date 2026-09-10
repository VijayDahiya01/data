-- =========================================================================
-- MOCK DATA PARTNER audience source (spec §7.1 "Restricted view/table",
-- §7.2 "Pre-compute segment membership", §91 Mock Partner fixtures).
--
-- This database lives INSIDE the simulated Data Partner boundary.
-- Oolix Cloud has no credential to it and never queries it (§3, §6).
-- The Partner Agent reads it read-only through the connector layer (§45).
--
-- Note the shape: membership is PRE-COMPUTED. There is deliberately no
-- bookings/orders table here, because §7.2 forbids joining transactional
-- tables on the ad-serving path.
-- =========================================================================

CREATE TABLE oolix_segment_membership (
    partner_user_id TEXT        NOT NULL,
    segment_id      TEXT        NOT NULL,
    effective_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (partner_user_id, segment_id)
);

-- The membership lookup runs on every ad decision and must hit p95 < 30 ms
-- (§103). The PK covers the point lookup; this composite index serves the
-- segment-wide live-count scan used for reach bucketing.
--
-- Deliberately NOT a partial index with a `WHERE expires_at > NOW()`
-- predicate: NOW() is STABLE, not IMMUTABLE, so Postgres rejects it in an
-- index predicate. Including expires_at as a trailing key column gives the
-- same index-only scan for range filtering without that restriction.
CREATE INDEX idx_membership_segment_live
    ON oolix_segment_membership (segment_id, expires_at);

-- Advertising eligibility / consent, owned and operated by the Partner (§45,
-- §81.1). The Agent fails CLOSED when a row is missing or withdrawn.
CREATE TABLE oolix_user_consent (
    partner_user_id  TEXT        NOT NULL,
    purpose_id       TEXT        NOT NULL,
    eligible         BOOLEAN     NOT NULL,
    policy_version   TEXT        NOT NULL,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    withdrawn_at     TIMESTAMPTZ,
    PRIMARY KEY (partner_user_id, purpose_id)
);

-- Segment freshness, published to Oolix as metadata only (§38.1).
CREATE TABLE oolix_segment_freshness (
    segment_id         TEXT        PRIMARY KEY,
    last_refreshed_at  TIMESTAMPTZ NOT NULL,
    refresh_frequency  TEXT        NOT NULL,
    member_count       BIGINT      NOT NULL
);

-- ---------------------------------------------------------------------
-- §91 canonical fixtures: U123 is eligible, U456 is not.
-- ---------------------------------------------------------------------
INSERT INTO oolix_segment_membership (partner_user_id, segment_id, expires_at) VALUES
    ('U123', 'RECENT_TRAVELLER_60D', NOW() + INTERVAL '60 days'),
    ('U123', 'PREMIUM_USER',         NOW() + INTERVAL '90 days'),
    ('U789', 'RECENT_TRAVELLER_60D', NOW() + INTERVAL '30 days'),
    -- Expired on purpose: proves the connector filters on expires_at rather
    -- than merely finding a row.
    ('U999', 'RECENT_TRAVELLER_60D', NOW() - INTERVAL '1 day');
-- U456 intentionally absent from every segment.

INSERT INTO oolix_user_consent (partner_user_id, purpose_id, eligible, policy_version) VALUES
    ('U123', 'travel_insurance_offer', TRUE,  'P-21'),
    ('U789', 'travel_insurance_offer', TRUE,  'P-21'),
    ('U456', 'travel_insurance_offer', TRUE,  'P-21'),
    ('U999', 'travel_insurance_offer', TRUE,  'P-21');

-- U321 is a member but has withdrawn consent: exercises the CONSENT_NOT_ELIGIBLE
-- NO_AD path (§77.1) and the §81.1 withdrawal flow.
INSERT INTO oolix_segment_membership (partner_user_id, segment_id, expires_at) VALUES
    ('U321', 'RECENT_TRAVELLER_60D', NOW() + INTERVAL '60 days');
INSERT INTO oolix_user_consent (partner_user_id, purpose_id, eligible, policy_version, withdrawn_at) VALUES
    ('U321', 'travel_insurance_offer', FALSE, 'P-21', NOW());

INSERT INTO oolix_segment_freshness (segment_id, last_refreshed_at, refresh_frequency, member_count) VALUES
    ('RECENT_TRAVELLER_60D', NOW(), 'daily',  213418),
    ('PREMIUM_USER',         NOW(), 'hourly',  64207);

-- ---------------------------------------------------------------------
-- Least-privilege role for the Partner Agent connector (§45 "Read only
-- approved source", §82). The Agent gets SELECT on these tables and nothing
-- else -- it cannot reach any other Partner schema.
-- ---------------------------------------------------------------------
CREATE ROLE oolix_agent_ro WITH LOGIN PASSWORD 'agent-local-only';
GRANT CONNECT ON DATABASE partner_audience TO oolix_agent_ro;
GRANT USAGE ON SCHEMA public TO oolix_agent_ro;
GRANT SELECT ON oolix_segment_membership, oolix_user_consent, oolix_segment_freshness TO oolix_agent_ro;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO oolix_agent_ro;
