package standard

import (
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// The Agent's copy of the vocabulary must say exactly what the API's does.
// If they drift, an attribute the Partner publishes is one the API rejects, or
// an allowed code the Agent writes is one no Buyer rule can ever match.
func TestMatchesTheAPITaxonomy(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "oolix", "packages", "db", "prisma", "seed", "attributes.ts")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("taxonomy source not available outside the monorepo: %v", err)
	}
	src := string(raw)

	block := regexp.MustCompile(`(?s)\{\s*key: '([a-z_]+)'(.*?)\n  \}`)
	quoted := regexp.MustCompile(`'([^']*)'`)
	list := func(body, field string) []string {
		m := regexp.MustCompile(field + `: \[([^\]]*)\]`).FindStringSubmatch(body)
		if m == nil {
			return nil
		}
		var out []string
		for _, q := range quoted.FindAllStringSubmatch(m[1], -1) {
			out = append(out, q[1])
		}
		return out
	}

	seen := map[string]bool{}
	for _, m := range block.FindAllStringSubmatch(src, -1) {
		key, body := m[1], m[2]
		seen[key] = true
		a, ok := ByKey(key)
		if !ok {
			t.Errorf("%s: in the API taxonomy but missing from the Agent", key)
			continue
		}
		if dt := regexp.MustCompile(`dataType: '([A-Z]+)'`).FindStringSubmatch(body); dt == nil || dt[1] != a.Type {
			t.Errorf("%s: type %q in the Agent, %v in the API", key, a.Type, dt)
		}
		if ops := list(body, "operators"); !slices.Equal(ops, a.Operators) {
			t.Errorf("%s: operators %v in the Agent, %v in the API", key, a.Operators, ops)
		}
		if allowed := list(body, "allowedValues"); !slices.Equal(allowed, a.Allowed) {
			t.Errorf("%s: allowed values %v in the Agent, %v in the API", key, a.Allowed, allowed)
		}
	}
	for _, a := range Attributes {
		if !seen[a.Key] {
			t.Errorf("%s: in the Agent but not in the API taxonomy", a.Key)
		}
	}
	if len(seen) == 0 {
		t.Fatal("parsed no attributes from the taxonomy source; the parser is out of date")
	}
}

func TestEveryAttributeIsUsable(t *testing.T) {
	columns := map[string]bool{}
	for _, a := range Attributes {
		if a.Column == "" || a.Expr == "" || len(a.Operators) == 0 || len(a.Hints) == 0 {
			t.Errorf("%s: incomplete definition", a.Key)
		}
		if columns[a.Column] {
			t.Errorf("%s: column %s is already used by another attribute", a.Key, a.Column)
		}
		columns[a.Column] = true
		if (a.Kind == KindEnum) != (len(a.Allowed) > 0) {
			t.Errorf("%s: only ENUM attributes have allowed values", a.Key)
		}
		if a.Derive != "" && !strings.Contains(a.Expr, a.Column) {
			t.Errorf("%s: derived expression does not use its column", a.Key)
		}
	}
}
