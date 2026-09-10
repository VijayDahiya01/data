// Package connector reads the Partner's approved local audience source --
// spec v5 §7.1, §7.2, §45.
//
// This is the boundary the whole product rests on. §45's rule for this layer
// is one line: "Read only approved source." The Agent holds a least-privilege
// credential to a restricted view the Partner created; it has no access to,
// and no query against, any other Partner table.
//
// §7.2 is equally firm about shape: membership must be PRE-COMPUTED.
//
//	"Do not query complex booking/order tables for every ad impression."
//
// A connector that joins transactional tables would blow the §103 budget of
// p95 < 30ms and would put load on the Partner's production database on every
// page view -- the fastest way to get the Agent removed.
package connector

import (
	"context"
	"errors"
	"fmt"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Connector is the §7.1 integration interface.
//
// Only PostgresView is implemented for the MVP. The interface exists so a
// warehouse, internal segment API or CDP export slots in without the ad
// decision path changing at all.
type Connector interface {
	// IsMember answers a single question: is this user in this segment right
	// now? It never returns the segment, a member list, or anything else.
	IsMember(ctx context.Context, partnerUserID, segmentKey string) (bool, error)

	// IsAdvertisingEligible applies the Partner's own consent and eligibility
	// rules for a purpose (§45, §81.1). It FAILS CLOSED.
	IsAdvertisingEligible(ctx context.Context, partnerUserID, purposeID string) (bool, error)

	// Health reports connector state for §58 monitoring.
	Health(ctx context.Context) error

	Close()
}

// ErrSourceUnavailable maps to the CONNECTOR-side NO_AD reason
// SEGMENT_SOURCE_ERROR (§77.1).
//
// §57 requires targeted campaigns to FAIL CLOSED when the source is
// unavailable: "do not query unexpected fallback sources." Guessing that an
// unreachable database would have said yes is how a Partner ends up serving
// ads to people who opted out.
var ErrSourceUnavailable = errors.New("segment source unavailable")

// LookupObjectiveP95 is §103's latency OBJECTIVE for a segment lookup.
//
// It is not a deadline. §103 states a p95 target, and treating a p95 as a hard
// per-request timeout fails the slowest 5% of legitimate requests by
// construction -- including the first request against a cold pool, which pays
// connection-establishment cost on top of the query. Exceeding it is logged;
// exceeding the hard timeout below fails closed.
const LookupObjectiveP95 = 30 * time.Millisecond

// PostgresView implements §7.1's "Restricted view/table" mode.
type PostgresView struct {
	pool            *pgxpool.Pool
	membershipQuery string
	consentQuery    string
	queryTimeout    time.Duration
	// slowLookups counts lookups over the §103 objective, for §58 monitoring.
	slowLookups atomic.Int64
}

// PostgresOptions configures the connector.
type PostgresOptions struct {
	DSN string
	// MembershipQuery is Partner-authored, parameterised SQL returning at most
	// one row when the user is a live member. $1 = partner_user_id,
	// $2 = segment_id.
	MembershipQuery string
	// ConsentQuery returns a single boolean eligibility column.
	// $1 = partner_user_id, $2 = purpose_id.
	ConsentQuery string
	MaxOpenConns int
	QueryTimeout time.Duration
}

// NewPostgresView opens a pool against the Partner's restricted view.
func NewPostgresView(ctx context.Context, opts PostgresOptions) (*PostgresView, error) {
	cfg, err := pgxpool.ParseConfig(opts.DSN)
	if err != nil {
		return nil, fmt.Errorf("parse connector dsn: %w", err)
	}
	if opts.MaxOpenConns > 0 {
		cfg.MaxConns = int32(opts.MaxOpenConns)
	}
	// A pooled connection must be ready before a decision needs it; acquiring
	// one is inside the §103 latency budget.
	cfg.MinConns = 2
	cfg.MaxConnIdleTime = 5 * time.Minute
	cfg.HealthCheckPeriod = 30 * time.Second

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("open connector pool: %w", err)
	}

	timeout := opts.QueryTimeout
	if timeout <= 0 {
		// Comfortably inside the §103 decision budget of 100ms while leaving
		// room for connection acquisition, which the context deadline also
		// covers.
		timeout = 50 * time.Millisecond
	}

	view := &PostgresView{
		pool:            pool,
		membershipQuery: opts.MembershipQuery,
		consentQuery:    opts.ConsentQuery,
		queryTimeout:    timeout,
	}

	// Warm the pool before serving.
	//
	// pgxpool creates MinConns lazily, so without this the FIRST ad decision
	// after startup -- or after an idle period reaps connections -- pays TCP
	// and TLS setup inside the decision deadline and fails closed. That is a
	// real production failure mode, not just a slow first request.
	if err := view.warm(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("warm connector pool: %w", err)
	}

	return view, nil
}

// warm establishes the minimum connections up front.
func (p *PostgresView) warm(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return p.pool.Ping(ctx)
}

// SlowLookups reports how many lookups exceeded the §103 p95 objective.
func (p *PostgresView) SlowLookups() int64 { return p.slowLookups.Load() }

// IsMember performs the §7.2 point lookup against pre-computed membership.
func (p *PostgresView) IsMember(ctx context.Context, partnerUserID, segmentKey string) (bool, error) {
	started := time.Now()
	defer func() {
		if time.Since(started) > LookupObjectiveP95 {
			p.slowLookups.Add(1)
		}
	}()

	ctx, cancel := context.WithTimeout(ctx, p.queryTimeout)
	defer cancel()

	rows, err := p.pool.Query(ctx, p.membershipQuery, partnerUserID, segmentKey)
	if err != nil {
		// Deliberately does NOT include the query arguments: partner_user_id
		// must never reach a log line (§78.1).
		return false, fmt.Errorf("%w: %v", ErrSourceUnavailable, err)
	}
	defer rows.Close()

	member := rows.Next()
	if err := rows.Err(); err != nil {
		return false, fmt.Errorf("%w: %v", ErrSourceUnavailable, err)
	}
	return member, nil
}

// IsAdvertisingEligible applies the Partner's consent rules (§45, §81.1).
//
// When no consent query is configured the answer is TRUE, because the Partner
// has told us eligibility is enforced upstream in its own membership
// materialisation. When a query IS configured, a missing row means NOT
// eligible: §81 requires consent to be an explicit, purpose-scoped decision
// rather than a default.
func (p *PostgresView) IsAdvertisingEligible(ctx context.Context, partnerUserID, purposeID string) (bool, error) {
	if p.consentQuery == "" {
		return true, nil
	}

	ctx, cancel := context.WithTimeout(ctx, p.queryTimeout)
	defer cancel()

	var eligible bool
	err := p.pool.QueryRow(ctx, p.consentQuery, partnerUserID, purposeID).Scan(&eligible)
	if err != nil {
		// No row = no recorded consent for this purpose = not eligible.
		if err.Error() == "no rows in result set" {
			return false, nil
		}
		return false, fmt.Errorf("%w: %v", ErrSourceUnavailable, err)
	}
	return eligible, nil
}

func (p *PostgresView) Health(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if err := p.pool.Ping(ctx); err != nil {
		return fmt.Errorf("%w: %v", ErrSourceUnavailable, err)
	}
	return nil
}

func (p *PostgresView) Close() { p.pool.Close() }
