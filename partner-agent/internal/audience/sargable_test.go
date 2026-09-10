package audience

import (
	"strings"
	"testing"
)

// The indexable form has to select exactly the same people as the function
// form. A faster query that quietly changes an audience is worse than a slow
// one, because a Partner approved the rules — not the plan.
//
// These assert the SHAPE and the boundaries. `sargable_live_test.go` runs both
// forms against the real dataset and compares the rows they return, which is
// the assertion that actually matters; this one localises a break to the
// compiler rather than the data.

func derivedMappings() map[string]Mapping {
	return map[string]Mapping{
		"age": {
			Expr:   "date_part('year', age(dob))",
			Type:   "NUMBER",
			Column: "dob",
			Derive: "years_since",
		},
		"purchase_recency_days": {
			Expr:   "date_part('day', now() - last_order_at)",
			Type:   "NUMBER",
			Column: "last_order_at",
			Derive: "days_since",
		},
	}
}

func TestBetweenCompilesToAColumnRange(t *testing.T) {
	q, err := Compile([]Rule{
		{Attribute: "age", Operator: OpBETWEEN, Value: []interface{}{25.0, 35.0}, Required: true},
	}, derivedMappings())
	if err != nil {
		t.Fatalf("compile: %v", err)
	}

	if strings.Contains(q.Where, "date_part") {
		t.Errorf("still wrapping the column in a function, so no index can serve it:\n  %s", q.Where)
	}
	if !strings.Contains(q.Where, "dob") {
		t.Errorf("predicate does not reference the stored column:\n  %s", q.Where)
	}

	// Ages 25..35 inclusive means born no later than 25 years ago and strictly
	// after 36 years ago. The upper bound is 36, not 35: someone aged exactly
	// 35 was born between 35 and 36 years back.
	if len(q.Args) != 2 {
		t.Fatalf("expected two bound arguments, got %d: %v", len(q.Args), q.Args)
	}
	if q.Args[0] != "25" || q.Args[1] != "36" {
		t.Errorf("boundaries wrong: got lo=%v hi=%v, want 25 and 36", q.Args[0], q.Args[1])
	}
}

func TestRecencyCompilesToAColumnRange(t *testing.T) {
	q, err := Compile([]Rule{
		{Attribute: "purchase_recency_days", Operator: OpLTE, Value: 90.0, Required: true},
	}, derivedMappings())
	if err != nil {
		t.Fatalf("compile: %v", err)
	}

	if strings.Contains(q.Where, "date_part") {
		t.Errorf("still wrapping the column in a function:\n  %s", q.Where)
	}
	if !strings.Contains(q.Where, "last_order_at >") {
		t.Errorf("expected a lower bound on the stored column:\n  %s", q.Where)
	}
	// "within 90 days" includes day 90 itself, so the boundary is 91 days back.
	if len(q.Args) != 1 || q.Args[0] != "91" {
		t.Errorf("boundary wrong: got %v, want 91", q.Args)
	}
}

func TestAMappingWithoutAColumnStillUsesTheExpression(t *testing.T) {
	// Every attribute that is not derived must compile exactly as before.
	plain := map[string]Mapping{
		"purchase_category": {Expr: "product_class", Type: "ENUM"},
	}
	q, err := Compile([]Rule{
		{Attribute: "purchase_category", Operator: OpIN,
			Value: []interface{}{"FOOTWEAR"}, Required: true},
	}, plain)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if !strings.Contains(q.Where, "product_class") {
		t.Errorf("plain mapping did not compile through its expression:\n  %s", q.Where)
	}
}

func TestAnUncoveredOperatorFallsBackRatherThanGuessing(t *testing.T) {
	// EQ on a derived attribute has no exact range form. Falling back to the
	// expression is slow and correct; inventing a range would be fast and wrong.
	q, err := Compile([]Rule{
		{Attribute: "age", Operator: OpEQ, Value: 30.0, Required: true},
	}, derivedMappings())
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if !strings.Contains(q.Where, "date_part") {
		t.Errorf("expected a fallback to the expression form, got:\n  %s", q.Where)
	}
}

func TestAColumnThatIsNotAnIdentifierIsRefused(t *testing.T) {
	// The column name reaches the statement text, so it is held to a much
	// narrower shape than an expression is.
	_, err := Compile([]Rule{
		{Attribute: "age", Operator: OpBETWEEN, Value: []interface{}{25.0, 35.0}, Required: true},
	}, map[string]Mapping{
		"age": {
			Expr:   "date_part('year', age(dob))",
			Type:   "NUMBER",
			Column: "dob) OR (1=1",
			Derive: "years_since",
		},
	})
	if err == nil {
		t.Fatal("a malformed column name was accepted")
	}
}
