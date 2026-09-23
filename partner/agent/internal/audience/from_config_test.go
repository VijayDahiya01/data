package audience

import (
	"reflect"
	"strings"
	"testing"

	"github.com/oolix/partner-agent/internal/config"
)

// Every field on the config mapping must reach the compiler.
//
// Reflection rather than a hand-written field list: a hand-written list is the
// same thing that was already wrong in main.go, and it would stay silently
// wrong the next time a field is added.
func TestEveryConfiguredFieldReachesTheCompiler(t *testing.T) {
	src := reflect.TypeOf(config.AttributeMapping{})
	dst := reflect.TypeOf(Mapping{})

	for i := 0; i < src.NumField(); i++ {
		name := src.Field(i).Name
		if _, ok := dst.FieldByName(name); !ok {
			t.Errorf("config.AttributeMapping.%s has nowhere to go in audience.Mapping", name)
		}
	}

	// Populate every string field with a distinct value, translate, and check
	// each one arrived.
	in := config.AttributeMapping{
		Expr:   "date_part('year', age(dob))",
		Type:   "NUMBER",
		Column: "dob",
		Derive: "years_since",
	}
	got := MappingsFromConfig(map[string]config.AttributeMapping{"age": in})["age"]

	inV, gotV := reflect.ValueOf(in), reflect.ValueOf(got)
	for i := 0; i < src.NumField(); i++ {
		name := src.Field(i).Name
		want := inV.Field(i).String()
		have := gotV.FieldByName(name).String()
		if want != have {
			t.Errorf("%s was dropped in translation: want %q, got %q", name, want, have)
		}
	}
}

// The end the Partner actually cares about: a configured derived attribute
// compiles to something an index can serve.
func TestAConfiguredDerivedAttributeCompilesToARange(t *testing.T) {
	mappings := MappingsFromConfig(map[string]config.AttributeMapping{
		"age": {
			Expr:   "date_part('year', age(dob))",
			Type:   "NUMBER",
			Column: "dob",
			Derive: "years_since",
		},
	})

	q, err := Compile([]Rule{
		{Attribute: "age", Operator: OpBETWEEN, Value: []interface{}{25.0, 35.0}, Required: true},
	}, mappings)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if strings.Contains(q.Where, "date_part") {
		t.Errorf("config came through as an unindexable expression:\n  %s", q.Where)
	}
	if !strings.Contains(q.Where, "dob") {
		t.Errorf("predicate does not reference the stored column:\n  %s", q.Where)
	}
}
