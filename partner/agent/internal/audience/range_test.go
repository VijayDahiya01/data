package audience

import (
	"errors"
	"reflect"
	"testing"
)

// A value known only as a range answers a rule only when every value in the
// range does: an age group 25-45 is not "30 to 40", and a count of 5 over 30
// days is "at least 5" in 90.
func TestRangesCompileToCertainMatches(t *testing.T) {
	age := Mapping{Expr: "date_part('year', age(dob))", Type: "NUMBER", Column: "dob", Derive: "years_since", Upper: "dob_hi"}
	recency := Mapping{Expr: "x", Type: "NUMBER", Column: "last_order_at", Derive: "days_since", Upper: "last_order_at_hi"}
	count := Mapping{Expr: "purchase_frequency", Type: "NUMBER", Upper: "purchase_frequency_hi"}

	for _, tc := range []struct {
		name    string
		rule    Rule
		mapping Mapping
		where   string
		args    []interface{}
	}{
		{"age between: the youngest end must be old enough, the oldest young enough",
			Rule{Attribute: "age", Operator: OpBETWEEN, Value: []interface{}{30.0, 40.0}, Required: true}, age,
			"(dob_hi <= (NOW() - ($1 || ' years')::interval) AND dob > (NOW() - ($2 || ' years')::interval))",
			[]interface{}{"30", "41"}},
		{"recent enough: the earliest the order can have been",
			Rule{Attribute: "r", Operator: OpLTE, Value: 30.0, Required: true}, recency,
			"last_order_at > (NOW() - ($1 || ' days')::interval)", []interface{}{"31"}},
		{"long enough ago: the latest it can have been",
			Rule{Attribute: "r", Operator: OpGTE, Value: 30.0, Required: true}, recency,
			"last_order_at_hi <= (NOW() - ($1 || ' days')::interval)", []interface{}{"30"}},
		{"at least: the smallest the count can be",
			Rule{Attribute: "f", Operator: OpGTE, Value: 3.0, Required: true}, count,
			"(purchase_frequency) >= $1", []interface{}{3.0}},
		{"at most: the largest",
			Rule{Attribute: "f", Operator: OpLTE, Value: 3.0, Required: true}, count,
			"purchase_frequency_hi <= $1", []interface{}{3.0}},
	} {
		q, err := Compile([]Rule{tc.rule}, map[string]Mapping{tc.rule.Attribute: tc.mapping})
		if err != nil {
			t.Errorf("%s: %v", tc.name, err)
			continue
		}
		if q.Where != tc.where || !reflect.DeepEqual(q.Args, tc.args) {
			t.Errorf("%s:\n got  %s %v\n want %s %v", tc.name, q.Where, q.Args, tc.where, tc.args)
		}
	}
}

func TestRangesRefuseWhatTheyCannotAnswerForCertain(t *testing.T) {
	age := Mapping{Expr: "date_part('year', age(dob))", Type: "NUMBER", Column: "dob", Derive: "years_since", Upper: "dob_hi"}
	_, err := Compile([]Rule{{Attribute: "age", Operator: OpIN, Value: []interface{}{"30"}, Required: true}},
		map[string]Mapping{"age": age})
	var unmappable *ErrUnmappable
	if !errors.As(err, &unmappable) {
		t.Errorf("IN on an age range compiled: %v", err)
	}
	bad := age
	bad.Upper = "dob_hi; DROP TABLE x"
	if _, err := Compile([]Rule{{Attribute: "age", Operator: OpBETWEEN, Value: []interface{}{30.0, 40.0}, Required: true}},
		map[string]Mapping{"age": bad}); !errors.As(err, &unmappable) {
		t.Errorf("an unsafe upper column compiled: %v", err)
	}
}
