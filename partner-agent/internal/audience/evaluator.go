package audience

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// MinPublishableCohort is v6 §8.2 / v5 §72's floor.
//
// Below it the Agent returns BELOW_THRESHOLD rather than a bucket. That is a
// successful evaluation, not a failure: the Partner ran the rule and the answer
// is that the cohort is too small to describe without saying something about
// the individuals in it.
const MinPublishableCohort = 1000

// ReachBucket is v5 §72's published vocabulary. Oolix receives one of these or
// nothing — never the count behind it.
type ReachBucket string

const (
	BucketUnder10K ReachBucket = "UNDER_10K"
	Bucket10K50K   ReachBucket = "10K_50K"
	Bucket50K100K  ReachBucket = "50K_100K"
	Bucket100K250K ReachBucket = "100K_250K"
	Bucket250K500K ReachBucket = "250K_500K"
	Bucket500K1M   ReachBucket = "500K_1M"
	BucketOver1M   ReachBucket = "OVER_1M"
)

// BucketFor converts an exact local count into a published bucket (§72).
//
// This function is the privacy boundary in miniature: the count goes in, a
// range comes out, and only the range is ever transmitted. It is also why
// repeated estimates are rate-limited centrally (§17) — bucket boundaries are
// coarse, but watching one move across a boundary repeatedly still leaks.
func BucketFor(count int) ReachBucket {
	switch {
	case count < 10_000:
		return BucketUnder10K
	case count < 50_000:
		return Bucket10K50K
	case count < 100_000:
		return Bucket50K100K
	case count < 250_000:
		return Bucket100K250K
	case count < 500_000:
		return Bucket250K500K
	case count < 1_000_000:
		return Bucket500K1M
	default:
		return BucketOver1M
	}
}

// EstimateResult is what the Agent reports back for a reach estimate (§8.2).
//
// Note the absence of a count field. The Agent computes one locally to decide
// the bucket and then discards it — there is nowhere in this struct to put it,
// which is deliberate.
type EstimateResult struct {
	Status         string      `json:"status"`
	ReachBucket    ReachBucket `json:"reach_bucket,omitempty"`
	RuleHash       string      `json:"audience_rule_hash"`
	MappingVersion int         `json:"mapping_version"`
	FreshnessAt    time.Time   `json:"freshness_at"`
	FailureReason  string      `json:"failure_reason,omitempty"`
}

// Evaluator runs compiled audience rules against the Partner's own attribute
// source (§8.2, §11).
type Evaluator struct {
	pool           *pgxpool.Pool
	attributeTable string
	mappings       map[string]Mapping
	mappingVersion int
	timeout        time.Duration
}

// EvaluatorOptions configures local evaluation. Everything here comes from the
// PARTNER's config file (§69.1) — nothing Oolix sends can widen it.
type EvaluatorOptions struct {
	Pool *pgxpool.Pool
	// AttributeTable is the restricted source the Agent may read (§7.1, §45).
	AttributeTable string
	Mappings       map[string]Mapping
	MappingVersion int
	// Timeout bounds a full-table count, which is a much heavier query than a
	// single-user membership lookup and must not be given the §103 ad-decision
	// budget.
	Timeout time.Duration
}

func NewEvaluator(opts EvaluatorOptions) *Evaluator {
	timeout := opts.Timeout
	if timeout == 0 {
		// An estimate is an offline operation a Buyer waits on for seconds, not
		// an ad decision on a page-render path.
		timeout = 30 * time.Second
	}

	table := opts.AttributeTable
	if table == "" {
		table = "oolix_audience_attributes"
	}

	return &Evaluator{
		pool:           opts.Pool,
		attributeTable: table,
		mappings:       opts.Mappings,
		mappingVersion: opts.MappingVersion,
		timeout:        timeout,
	}
}

// Estimate evaluates the rules locally and returns a safe bucket (§8.2).
//
// The steps are §8.2's, in order: validate the rule hash, compile against the
// local mapping, count locally, apply the minimum cohort threshold, return a
// bucket. The count never leaves this function.
func (e *Evaluator) Estimate(ctx context.Context, rules []Rule, expectedHash string) EstimateResult {
	result := EstimateResult{
		RuleHash:       RuleHash(rules),
		MappingVersion: e.mappingVersion,
		FreshnessAt:    time.Now().UTC(),
	}

	// §8.2 step 1: "Validate signed rule snapshot and local mapping version."
	// A hash that does not match means these are not the rules that were
	// approved, so the Partner has agreed to nothing here.
	if expectedHash != "" && result.RuleHash != expectedHash {
		result.Status = "FAILED"
		result.FailureReason = "rule hash mismatch: the rules do not match what was approved"
		return result
	}

	compiled, err := Compile(rules, e.mappings)
	if err != nil {
		// §7 should have prevented this by marking the Partner INCOMPATIBLE.
		// Reaching it means capability metadata went stale, and UNAVAILABLE is
		// the honest answer rather than a partial count.
		result.Status = "UNAVAILABLE"
		result.FailureReason = err.Error()
		return result
	}

	ctx, cancel := context.WithTimeout(ctx, e.timeout)
	defer cancel()

	// Identifier interpolation here is the table name from the Partner's OWN
	// config; every value from Oolix is bound as a parameter.
	sql := fmt.Sprintf("SELECT count(*) FROM %s WHERE %s", e.attributeTable, compiled.Where)

	var count int
	if err := e.pool.QueryRow(ctx, sql, compiled.Args...).Scan(&count); err != nil {
		result.Status = "FAILED"
		result.FailureReason = "local evaluation failed"
		return result
	}

	// §8.2 step 4 and §17's minimum cohort. Below the floor the Partner reports
	// that fact rather than a bucket — "fewer than 1,000" is itself a
	// disclosure, and BELOW_THRESHOLD says only that the rule was run.
	if count < MinPublishableCohort {
		result.Status = "BELOW_THRESHOLD"
		return result
	}

	result.Status = "READY"
	result.ReachBucket = BucketFor(count)
	return result
}

// MaterializeResult reports what a local compilation produced (§11).
type MaterializeResult struct {
	MaterializationVersion int
	MemberCount            int
	Status                 string
}

// Materialize compiles an approved audience into the Partner-local membership
// index (§11).
//
// §11's reason for existing is §12: "Real-time ad decision uses fast membership
// lookup, not full rule evaluation." Evaluating six predicates over a large
// table on every page render would blow the §103 p95 budget, so the work is
// done once here and the runtime becomes a primary-key lookup.
//
// The members written never leave this database. Oolix stores the status,
// version and freshness of this operation and nothing else (§11 privacy
// boundary).
func (e *Evaluator) Materialize(
	ctx context.Context,
	activationID string,
	audienceGroupID string,
	audienceVersion int,
	rules []Rule,
	expectedHash string,
	ttl time.Duration,
) (*MaterializeResult, error) {
	// §10 again, and for the same reason: this is the moment the Agent commits
	// to serving an audience, so it re-checks that these are the approved rules
	// rather than trusting that they were checked earlier.
	if expectedHash != "" && RuleHash(rules) != expectedHash {
		return nil, fmt.Errorf("rule hash mismatch: refusing to materialize an audience that was not approved")
	}

	compiled, err := Compile(rules, e.mappings)
	if err != nil {
		return nil, fmt.Errorf("compile: %w", err)
	}

	ctx, cancel := context.WithTimeout(ctx, e.timeout)
	defer cancel()

	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var version int
	err = tx.QueryRow(ctx,
		`SELECT COALESCE(materialization_version, 0) + 1
           FROM oolix_audience_materialization WHERE activation_id = $1`,
		activationID).Scan(&version)
	if err != nil {
		version = 1
	}

	expiresAt := time.Now().UTC().Add(ttl)

	// Replace rather than merge. A refresh reflects who matches NOW; leaving
	// yesterday's members behind would serve people who have since dropped out
	// of the audience the Partner approved.
	if _, err := tx.Exec(ctx,
		`DELETE FROM oolix_audience_members WHERE activation_id = $1`, activationID); err != nil {
		return nil, fmt.Errorf("clear previous members: %w", err)
	}

	insert := fmt.Sprintf(`
		INSERT INTO oolix_audience_members
			(partner_user_id, activation_id, materialization_version, expires_at)
		SELECT partner_user_id, $%d, $%d, $%d
		  FROM %s
		 WHERE %s
		ON CONFLICT (activation_id, partner_user_id) DO NOTHING`,
		len(compiled.Args)+1, len(compiled.Args)+2, len(compiled.Args)+3,
		e.attributeTable, compiled.Where)

	args := append([]interface{}{}, compiled.Args...)
	args = append(args, activationID, version, expiresAt)

	tag, err := tx.Exec(ctx, insert, args...)
	if err != nil {
		return nil, fmt.Errorf("materialize members: %w", err)
	}
	memberCount := int(tag.RowsAffected())

	if _, err := tx.Exec(ctx, `
		INSERT INTO oolix_audience_materialization
			(activation_id, audience_group_id, audience_version, rule_hash,
			 materialization_version, member_count, status, built_at, expires_at, last_error)
		VALUES ($1, $2, $3, $4, $5, $6, 'READY', NOW(), $7, NULL)
		ON CONFLICT (activation_id) DO UPDATE SET
			audience_group_id = EXCLUDED.audience_group_id,
			audience_version = EXCLUDED.audience_version,
			rule_hash = EXCLUDED.rule_hash,
			materialization_version = EXCLUDED.materialization_version,
			member_count = EXCLUDED.member_count,
			status = 'READY',
			built_at = NOW(),
			expires_at = EXCLUDED.expires_at,
			last_error = NULL`,
		activationID, audienceGroupID, audienceVersion, RuleHash(rules),
		version, memberCount, expiresAt); err != nil {
		return nil, fmt.Errorf("record materialization: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit: %w", err)
	}

	return &MaterializeResult{
		MaterializationVersion: version,
		MemberCount:            memberCount,
		Status:                 "READY",
	}, nil
}

// IsMaterializedMember is §12's runtime lookup.
//
// One indexed read: is this person in this activation's compiled audience, and
// has that compilation not expired. It replaces evaluating the rules per
// request, which is what keeps the §103 budget reachable.
//
// It answers only about the person asked about, and returns only true or false
// — the same shape as the v5 segment membership check it sits beside.
func (e *Evaluator) IsMaterializedMember(
	ctx context.Context,
	partnerUserID, activationID string,
) (bool, int, error) {
	// The materialization version comes back with the membership, because §12's
	// decision response reports which compiled audience served the ad. Reading
	// it from the member row rather than the materialization table means it
	// describes the build THIS person was selected by, not whatever build is
	// current -- those differ during a refresh.
	var version int
	err := e.pool.QueryRow(ctx, `
		SELECT materialization_version FROM oolix_audience_members
		 WHERE partner_user_id = $1 AND activation_id = $2 AND expires_at > NOW()`,
		partnerUserID, activationID).Scan(&version)
	if errors.Is(err, pgx.ErrNoRows) {
		// Not a member. That is an answer, not a failure.
		return false, 0, nil
	}
	if err != nil {
		// Fails closed, exactly as the v5 segment lookup does (§57): an
		// unreachable source must never be read as "probably yes".
		return false, 0, err
	}
	return true, version, nil
}
