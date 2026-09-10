package audience

import (
	"encoding/json"
	"strings"
	"testing"
)

// §6.3's worked example, as it arrives in a manifest: decoded from JSON, so
// numbers are float64 and lists are []interface{} — exactly what the compiler
// and hasher have to cope with in production.
const shoeRulesJSON = `[
  {"attribute":"age","operator":"BETWEEN","value":[18,35],"required":true,"weight":5},
  {"attribute":"online_shopper","operator":"EQ","value":true,"required":true,"weight":5},
  {"attribute":"purchase_category","operator":"IN","value":["FOOTWEAR"],"required":true,"weight":5},
  {"attribute":"purchase_recency_days","operator":"LTE","value":90,"required":true,"weight":4},
  {"attribute":"payment_method","operator":"IN","value":["UPI","CREDIT_CARD"],"required":false,"weight":2}
]`

func shoeRules(t *testing.T) []Rule {
	t.Helper()
	var rules []Rule
	if err := json.Unmarshal([]byte(shoeRulesJSON), &rules); err != nil {
		t.Fatalf("decode rules: %v", err)
	}
	return rules
}

// §5.2's mapping table. Note that none of these local names is the Oolix
// attribute key, and two are derived rather than stored.
func partnerMappings() map[string]Mapping {
	return map[string]Mapping{
		"age":                   {Expr: "date_part('year', age(dob))", Type: "NUMBER"},
		"gender":                {Expr: "sex_code", Type: "ENUM"},
		"online_shopper":        {Expr: "is_online_buyer", Type: "BOOLEAN"},
		"purchase_category":     {Expr: "product_class", Type: "ENUM"},
		"purchase_recency_days": {Expr: "date_part('day', now() - last_order_at)", Type: "NUMBER"},
		"payment_method":        {Expr: "pay_mode", Type: "ENUM"},
	}
}

// TestRuleHashMatchesTypeScript is the one that matters most.
//
// §10 binds a Partner's approval to this hash, and the Agent recomputes it
// before materializing. If Go and TypeScript ever disagree, either the Agent
// refuses a manifest that is genuinely correct, or — far worse — it accepts one
// that is not.
//
// The expected value was produced by the TypeScript implementation in
// packages/contracts/src/audience.ts over the same rules.
func TestRuleHashMatchesTypeScript(t *testing.T) {
	const wantTypeScriptHash = "50424f8680a98cac3b8e854ab0f8c0d0d1463d15452678977d2034a74e578d73"

	if got := RuleHash(shoeRules(t)); got != wantTypeScriptHash {
		t.Errorf("Go and TypeScript rule hashes disagree.\n got: %s\nwant: %s", got, wantTypeScriptHash)
	}
}

func TestRuleHashIgnoresRuleOrder(t *testing.T) {
	rules := shoeRules(t)
	reversed := make([]Rule, len(rules))
	for i, r := range rules {
		reversed[len(rules)-1-i] = r
	}

	if RuleHash(rules) != RuleHash(reversed) {
		t.Error("rule order changed the hash; a Partner would be asked to re-approve an unchanged audience")
	}
}

func TestRuleHashIgnoresINValueOrder(t *testing.T) {
	// IN [UPI, CREDIT_CARD] and IN [CREDIT_CARD, UPI] select the same people.
	a := []Rule{{Attribute: "payment_method", Operator: OpIN,
		Value: []interface{}{"UPI", "CREDIT_CARD"}, Required: true}}
	b := []Rule{{Attribute: "payment_method", Operator: OpIN,
		Value: []interface{}{"CREDIT_CARD", "UPI"}, Required: true}}

	if RuleHash(a) != RuleHash(b) {
		t.Error("IN value order changed the hash")
	}
}

func TestRuleHashRespectsBetweenOrder(t *testing.T) {
	// [18,35] and [35,18] are not the same rule.
	a := []Rule{{Attribute: "age", Operator: OpBETWEEN, Value: []interface{}{18.0, 35.0}, Required: true}}
	b := []Rule{{Attribute: "age", Operator: OpBETWEEN, Value: []interface{}{35.0, 18.0}, Required: true}}

	if RuleHash(a) == RuleHash(b) {
		t.Error("BETWEEN bounds were reordered; the hash must distinguish them")
	}
}

func TestRuleHashIgnoresWeight(t *testing.T) {
	// Weight changes the match score a Buyer sees, not which people a Partner
	// returns. Invalidating an approval over a reweighting would make Partners
	// re-approve for nothing (§16).
	light := []Rule{{Attribute: "gender", Operator: OpEQ, Value: "MALE", Required: true, Weight: 1}}
	heavy := []Rule{{Attribute: "gender", Operator: OpEQ, Value: "MALE", Required: true, Weight: 5}}

	if RuleHash(light) != RuleHash(heavy) {
		t.Error("weight changed the hash")
	}
}

func TestCompileBindsValuesAsParameters(t *testing.T) {
	compiled, err := Compile(shoeRules(t), partnerMappings())
	if err != nil {
		t.Fatalf("compile: %v", err)
	}

	// §17: values arrive from Oolix and must never be interpolated into SQL.
	for _, literal := range []string{"FOOTWEAR", "UPI", "CREDIT_CARD", "18", "35", "90"} {
		if strings.Contains(compiled.Where, literal) {
			t.Errorf("value %q was interpolated into the predicate instead of bound: %s",
				literal, compiled.Where)
		}
	}

	if !strings.Contains(compiled.Where, "$1") {
		t.Errorf("expected placeholders, got: %s", compiled.Where)
	}
	if len(compiled.Args) == 0 {
		t.Error("no arguments were bound")
	}
}

func TestCompileUsesPartnerLocalColumns(t *testing.T) {
	compiled, err := Compile(shoeRules(t), partnerMappings())
	if err != nil {
		t.Fatalf("compile: %v", err)
	}

	// §5.2: the predicate runs against the PARTNER's schema. Oolix's attribute
	// keys must not appear in it — they are not columns here.
	for _, local := range []string{"pay_mode", "product_class", "is_online_buyer"} {
		if !strings.Contains(compiled.Where, local) {
			t.Errorf("expected local column %q in: %s", local, compiled.Where)
		}
	}
	if strings.Contains(compiled.Where, "payment_method") {
		t.Errorf("Oolix attribute key leaked into the predicate: %s", compiled.Where)
	}
}

func TestCompileRefusesAMissingRequiredRule(t *testing.T) {
	mappings := partnerMappings()
	delete(mappings, "purchase_category")

	_, err := Compile(shoeRules(t), mappings)
	if err == nil {
		t.Fatal("expected an error: serving without a REQUIRED rule would broaden the approved audience")
	}

	var unmappable *ErrUnmappable
	if !asUnmappable(err, &unmappable) || unmappable.Attribute != "purchase_category" {
		t.Errorf("expected ErrUnmappable for purchase_category, got %v", err)
	}
}

func TestCompileDropsAMissingOptionalRule(t *testing.T) {
	// §7 already told the Buyer this Partner cannot evaluate payment_method and
	// lowered the match score. The Partner evaluates the subset it agreed to.
	mappings := partnerMappings()
	delete(mappings, "payment_method")

	compiled, err := Compile(shoeRules(t), mappings)
	if err != nil {
		t.Fatalf("an optional rule should not fail the compile: %v", err)
	}

	for _, attr := range compiled.Attributes {
		if attr == "payment_method" {
			t.Error("payment_method should have been dropped")
		}
	}
	if len(compiled.Attributes) != 4 {
		t.Errorf("expected the 4 required rules, got %v", compiled.Attributes)
	}
}

func TestCompileRefusesAPredicateThatMatchesEveryone(t *testing.T) {
	optionalOnly := []Rule{
		{Attribute: "gender", Operator: OpEQ, Value: "MALE", Required: false, Weight: 1},
	}

	if _, err := Compile(optionalOnly, map[string]Mapping{}); err == nil {
		t.Error("expected a refusal: dropping every rule would select the whole database")
	}
}

func TestCompileRefusesAnUnsafeLocalMapping(t *testing.T) {
	// The Partner is trusted, but a mapping is the one place config text reaches
	// SQL. A statement separator must stop the Agent, not widen the audience.
	mappings := partnerMappings()
	mappings["gender"] = Mapping{Expr: "sex_code; DROP TABLE oolix_audience_members", Type: "ENUM"}

	rules := []Rule{
		{Attribute: "gender", Operator: OpEQ, Value: "MALE", Required: true, Weight: 5},
	}

	if _, err := Compile(rules, mappings); err == nil {
		t.Error("expected a refusal for an unsafe mapping expression")
	}
}

func TestCompileRefusesAnUnsupportedOperator(t *testing.T) {
	rules := []Rule{
		{Attribute: "gender", Operator: Operator("REGEX"), Value: ".*", Required: true, Weight: 5},
	}

	if _, err := Compile(rules, partnerMappings()); err == nil {
		t.Error("expected a refusal: §17 forbids regex rules")
	}
}

func asUnmappable(err error, target **ErrUnmappable) bool {
	if u, ok := err.(*ErrUnmappable); ok {
		*target = u
		return true
	}
	return false
}
