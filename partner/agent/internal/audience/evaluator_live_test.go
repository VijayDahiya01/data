package audience

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// These run against the Partner-side fixture database from
// partner/dev-db/init. They are skipped when it is not reachable, so the
// unit suite stays runnable without infrastructure — but when it IS reachable
// they are the only proof that the compiled SQL is actually valid Postgres and
// selects the people it should.
func livePool(t *testing.T) *pgxpool.Pool {
	t.Helper()

	dsn := os.Getenv("PARTNER_DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://partner:partner@localhost:5433/partner_audience"
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Skipf("Partner fixture database unavailable: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Skipf("Partner fixture database unavailable: %v", err)
	}

	var exists bool
	_ = pool.QueryRow(ctx, `SELECT to_regclass('oolix_audience_attributes') IS NOT NULL`).Scan(&exists)
	if !exists {
		pool.Close()
		t.Skip("v6 attribute fixtures not installed")
	}

	t.Cleanup(pool.Close)
	return pool
}

func liveEvaluator(t *testing.T) *Evaluator {
	return NewEvaluator(EvaluatorOptions{
		Pool:           livePool(t),
		AttributeTable: "oolix_audience_attributes",
		Mappings:       partnerMappings(),
		MappingVersion: 8,
	})
}

func TestEstimateRunsAgainstTheRealAttributeSource(t *testing.T) {
	e := liveEvaluator(t)
	rules := shoeRules(t)

	result := e.Estimate(context.Background(), rules, RuleHash(rules))

	if result.Status != "READY" && result.Status != "BELOW_THRESHOLD" {
		t.Fatalf("expected a completed evaluation, got %s: %s", result.Status, result.FailureReason)
	}

	// §8.2: whatever the answer, it is a bucket or a threshold status. The
	// struct has nowhere to put a count, which is the point.
	if result.Status == "READY" && result.ReachBucket == "" {
		t.Error("READY without a bucket")
	}

	encoded, _ := json.Marshal(result)
	for _, leak := range []string{"count", "exact", "members"} {
		if containsFold(string(encoded), leak) {
			t.Errorf("the estimate payload mentions %q: %s", leak, encoded)
		}
	}
}

func TestEstimateRefusesRulesThatDoNotMatchTheApprovedHash(t *testing.T) {
	e := liveEvaluator(t)
	rules := shoeRules(t)

	// §10: the Partner approved a hash. Rules that do not produce it are not
	// the rules they agreed to, whatever else is true about them.
	result := e.Estimate(context.Background(), rules, "0000000000000000000000000000000000000000000000000000000000000000")

	if result.Status != "FAILED" {
		t.Errorf("expected FAILED on a hash mismatch, got %s", result.Status)
	}
	if result.ReachBucket != "" {
		t.Error("a rejected evaluation must not report a bucket")
	}
}

func TestMaterializeThenLookUpMembership(t *testing.T) {
	e := liveEvaluator(t)
	rules := shoeRules(t)
	ctx := context.Background()

	const activationID = "00000000-0000-4000-8000-000000000097"

	res, err := e.Materialize(ctx, activationID, "aud_test", 1, rules, RuleHash(rules), time.Hour)
	if err != nil {
		t.Fatalf("materialize: %v", err)
	}
	if res.MemberCount == 0 {
		t.Fatal("materialized an empty audience; the fixtures should match")
	}

	// §12: the runtime is a membership lookup, not a rule evaluation.
	// U123 matches every rule in the §6.3 audience.
	member, version, err := e.IsMaterializedMember(ctx, "U123", activationID)
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if !member {
		t.Error("U123 matches the rules and should be materialized")
	}
	// §12's decision response reports which compiled build matched, so the
	// lookup has to return it alongside membership.
	if version != res.MaterializationVersion {
		t.Errorf("lookup reported build v%d, materialize wrote v%d",
			version, res.MaterializationVersion)
	}

	// U456 buys groceries and has not bought in 200 days: fails two REQUIRED
	// rules.
	nonMember, _, err := e.IsMaterializedMember(ctx, "U456", activationID)
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if nonMember {
		t.Error("U456 fails required rules and must not be materialized")
	}

	// U789 is the right shopper but outside the 18-35 age rule.
	tooOld, _, err := e.IsMaterializedMember(ctx, "U789", activationID)
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if tooOld {
		t.Error("U789 is outside the age range and must not be materialized")
	}
}

func TestMaterializeRefusesAnUnapprovedRuleSet(t *testing.T) {
	e := liveEvaluator(t)
	rules := shoeRules(t)

	_, err := e.Materialize(context.Background(), "00000000-0000-4000-8000-000000000099",
		"aud_test", 1, rules, "deadbeef", time.Hour)

	if err == nil {
		t.Error("expected a refusal: materializing rules that do not match the approved hash would serve an audience nobody agreed to")
	}
}

func TestMaterializeReplacesRatherThanMerges(t *testing.T) {
	e := liveEvaluator(t)
	ctx := context.Background()
	const activationID = "00000000-0000-4000-8000-000000000098"

	broad := []Rule{
		{Attribute: "online_shopper", Operator: OpEQ, Value: true, Required: true, Weight: 5},
		{Attribute: "purchase_category", Operator: OpIN,
			Value: []interface{}{"FOOTWEAR", "FASHION"}, Required: true, Weight: 5},
		{Attribute: "age", Operator: OpBETWEEN, Value: []interface{}{18.0, 60.0}, Required: true, Weight: 5},
		{Attribute: "purchase_recency_days", Operator: OpLTE, Value: 365.0, Required: true, Weight: 4},
	}
	first, err := e.Materialize(ctx, activationID, "aud_test", 1, broad, RuleHash(broad), time.Hour)
	if err != nil {
		t.Fatalf("first materialize: %v", err)
	}

	narrow := []Rule{
		{Attribute: "online_shopper", Operator: OpEQ, Value: true, Required: true, Weight: 5},
		{Attribute: "purchase_category", Operator: OpIN,
			Value: []interface{}{"FOOTWEAR"}, Required: true, Weight: 5},
		{Attribute: "age", Operator: OpBETWEEN, Value: []interface{}{18.0, 25.0}, Required: true, Weight: 5},
		{Attribute: "purchase_recency_days", Operator: OpLTE, Value: 7.0, Required: true, Weight: 4},
	}
	second, err := e.Materialize(ctx, activationID, "aud_test", 2, narrow, RuleHash(narrow), time.Hour)
	if err != nil {
		t.Fatalf("second materialize: %v", err)
	}

	// A refresh reflects who matches NOW. Leaving yesterday's members behind
	// would keep serving people who have dropped out of the approved audience.
	if second.MemberCount >= first.MemberCount {
		t.Errorf("narrowing the rules should shrink the audience: %d -> %d",
			first.MemberCount, second.MemberCount)
	}
	if second.MaterializationVersion <= first.MaterializationVersion {
		t.Error("each rebuild should advance the materialization version (§11)")
	}
}

func TestBelowThresholdRatherThanATinyBucket(t *testing.T) {
	e := liveEvaluator(t)

	// A rule set narrow enough to select almost nobody. §17's minimum cohort
	// means the answer is BELOW_THRESHOLD, not "UNDER_10K" — the latter would
	// still say something about a handful of identifiable people.
	tiny := []Rule{
		{Attribute: "online_shopper", Operator: OpEQ, Value: true, Required: true, Weight: 5},
		{Attribute: "purchase_category", Operator: OpIN,
			Value: []interface{}{"FOOTWEAR"}, Required: true, Weight: 5},
		{Attribute: "age", Operator: OpBETWEEN, Value: []interface{}{28.0, 28.0}, Required: true, Weight: 5},
		{Attribute: "purchase_recency_days", Operator: OpLTE, Value: 1.0, Required: true, Weight: 4},
	}

	result := e.Estimate(context.Background(), tiny, RuleHash(tiny))

	if result.Status != "BELOW_THRESHOLD" {
		t.Errorf("expected BELOW_THRESHOLD for a tiny cohort, got %s (%s)",
			result.Status, result.ReachBucket)
	}
	if result.ReachBucket != "" {
		t.Error("BELOW_THRESHOLD must not carry a bucket")
	}
}

func containsFold(haystack, needle string) bool {
	return len(needle) > 0 && len(haystack) >= len(needle) &&
		indexFold(haystack, needle) >= 0
}

func indexFold(s, substr string) int {
	lower := func(b byte) byte {
		if b >= 'A' && b <= 'Z' {
			return b + 32
		}
		return b
	}
	for i := 0; i+len(substr) <= len(s); i++ {
		match := true
		for j := 0; j < len(substr); j++ {
			if lower(s[i+j]) != lower(substr[j]) {
				match = false
				break
			}
		}
		if match {
			return i
		}
	}
	return -1
}
