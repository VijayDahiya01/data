// Package audience compiles Oolix audience rules into a query against the
// Partner's own attribute source -- v6 §5.2, §8.2, §10, §11.
//
// This package is where the two halves of v6 meet. Oolix sends standardized
// rules ("purchase_recency_days LTE 90"); the Partner holds a mapping to its
// own schema ("last_order_at"); and the compiled predicate runs HERE, inside
// the Partner, against a restricted view. Oolix learns a bucket or a status and
// nothing else.
//
// Three rules govern everything below:
//
//   - Column names come from the PARTNER's config and are validated against an
//     allow-list. Values come from OOLIX and are always bound as parameters.
//     §17 forbids arbitrary SQL; that has to hold even though the rules arrive
//     over the network from a system the Partner does not control.
//   - The rule hash is recomputed from the rules before anything is served.
//     §10 binds the Partner's approval to that hash, so a mismatch means the
//     audience changed after they agreed to it.
//   - Anything unmappable fails CLOSED. §57's principle applies here as much as
//     to the ad decision: guessing is how people who opted out get served.
package audience

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// Operator is v6 §4's MVP operator set.
type Operator string

const (
	OpEQ      Operator = "EQ"
	OpIN      Operator = "IN"
	OpLTE     Operator = "LTE"
	OpGTE     Operator = "GTE"
	OpBETWEEN Operator = "BETWEEN"
)

// Rule is one condition from an Oolix Audience Group version (§6.3).
type Rule struct {
	Attribute string      `json:"attribute"`
	Operator  Operator    `json:"operator"`
	Value     interface{} `json:"value"`
	Required  bool        `json:"required"`
	Weight    int         `json:"weight"`
}

// Mapping is the Partner-local translation for one Oolix attribute (§5.2).
//
// `Expr` rather than a plain column so a Partner can map a derived attribute:
// §5.2's own examples are age "derived from dob" and purchase_recency_days
// "derived from last_order_at". Neither exists as a stored column here.
type Mapping struct {
	// Expr is a SQL expression over the Partner's attribute source. It comes
	// from the PARTNER's config file, never from Oolix.
	Expr string `yaml:"expr"`
	// Type drives how a value is bound: NUMBER, ENUM, BOOLEAN or ID.
	Type string `yaml:"type"`

	// Column and Derive together describe an attribute computed FROM a stored
	// timestamp, so the predicate can be expressed as a range over that column
	// instead of a function over every row.
	//
	// `date_part('year', age(dob)) BETWEEN 25 AND 35` and
	// `dob BETWEEN <36 years ago> AND <25 years ago>` select the same people.
	// Only the second can use an index on `dob`, and the difference is the
	// whole table versus a seek.
	//
	// Optional. Without them the mapping compiles through Expr exactly as
	// before, which is what every non-derived attribute does.
	Column string `yaml:"column"`
	// Derive is how the value is computed from Column:
	//   years_since  whole years elapsed, as `age` is
	//   days_since   whole days elapsed, as `purchase_recency_days` is
	Derive string `yaml:"derive"`
}

// sargable reports whether this mapping can be compiled as a range over a
// stored column rather than a function over one.
func (m Mapping) sargable() bool {
	return m.Column != "" && (m.Derive == "years_since" || m.Derive == "days_since")
}

// safeExpr limits what a Partner's own config may put in a predicate.
//
// The Partner is trusted -- it is their database -- but a typo that silently
// produced a broken predicate would be worse than a startup error, and a
// mapping is the one place where config text reaches SQL. Identifiers,
// function calls, arithmetic and interval literals are enough for §5.2's
// derived examples; statement separators and comments are not.
var safeExpr = regexp.MustCompile(`^[A-Za-z0-9_.,'"\s()\-+*/:]+$`)

// A column name is narrower than an expression: an identifier, optionally
// qualified. Nothing that could carry a function call, an operator or a comment.
var safeColumn = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$`)

// CompiledQuery is a parameterised predicate ready to run.
type CompiledQuery struct {
	// Where is the predicate with $1..$n placeholders, joined by AND.
	Where string
	// Args are the bound values, in placeholder order.
	Args []interface{}
	// Attributes lists the Oolix attributes this predicate covers, for logging.
	Attributes []string
}

// ErrUnmappable means the Partner cannot evaluate a rule it was sent.
//
// It should be unreachable in practice -- §7 makes a Partner INCOMPATIBLE for a
// missing REQUIRED rule, so Oolix will not send one it cannot evaluate. Being
// reachable anyway is the point: capability metadata can go stale between
// publication and use, and the Agent must refuse rather than approximate.
type ErrUnmappable struct {
	Attribute string
	Reason    string
}

func (e *ErrUnmappable) Error() string {
	return fmt.Sprintf("cannot evaluate %q locally: %s", e.Attribute, e.Reason)
}

// Compile turns audience rules into a parameterised predicate.
//
// OPTIONAL rules the Partner cannot evaluate are DROPPED rather than failing
// the compile: §7 already told the Buyer this Partner does not support them and
// lowered the match score accordingly, so the Partner evaluates the subset it
// agreed to. A missing REQUIRED rule is an error -- serving a broader audience
// than was approved is exactly what §10's binding exists to prevent.
func Compile(rules []Rule, mappings map[string]Mapping) (*CompiledQuery, error) {
	if len(rules) == 0 {
		return nil, fmt.Errorf("no rules to compile")
	}

	var (
		clauses    []string
		args       []interface{}
		attributes []string
	)

	for _, rule := range rules {
		mapping, ok := mappings[rule.Attribute]
		if !ok {
			if rule.Required {
				return nil, &ErrUnmappable{Attribute: rule.Attribute, Reason: "no local mapping"}
			}
			continue
		}

		if !safeExpr.MatchString(mapping.Expr) {
			// A malformed mapping is a Partner configuration error, and it must
			// stop the Agent rather than silently widen the audience.
			return nil, &ErrUnmappable{
				Attribute: rule.Attribute,
				Reason:    "local mapping expression contains unsupported characters",
			}
		}

		if mapping.sargable() && !safeColumn.MatchString(mapping.Column) {
			return nil, &ErrUnmappable{
				Attribute: rule.Attribute,
				Reason:    "local mapping column is not a plain identifier",
			}
		}

		clause, clauseArgs, err := compileRule(rule, mapping, len(args))
		if err != nil {
			if rule.Required {
				return nil, err
			}
			continue
		}

		clauses = append(clauses, clause)
		args = append(args, clauseArgs...)
		attributes = append(attributes, rule.Attribute)
	}

	if len(clauses) == 0 {
		// Every rule dropped means the predicate would select everybody. That
		// is never what an audience meant.
		return nil, fmt.Errorf("no evaluable rules: refusing to compile a predicate that matches everyone")
	}

	return &CompiledQuery{
		Where:      strings.Join(clauses, " AND "),
		Args:       args,
		Attributes: attributes,
	}, nil
}

func compileRule(rule Rule, mapping Mapping, argOffset int) (string, []interface{}, error) {
	expr := "(" + mapping.Expr + ")"
	next := func(i int) string { return fmt.Sprintf("$%d", argOffset+i+1) }

	// Prefer the indexable form where the mapping describes one. It selects the
	// same rows; it just lets the database seek rather than scan.
	if mapping.sargable() {
		if clause, args, ok := compileDerivedRange(rule, mapping, next); ok {
			return clause, args, nil
		}
		// An operator the range form does not cover falls through to Expr,
		// which is correct but slower — never wrong.
	}

	switch rule.Operator {
	case OpEQ:
		return fmt.Sprintf("%s = %s", expr, next(0)), []interface{}{rule.Value}, nil

	case OpLTE:
		return fmt.Sprintf("%s <= %s", expr, next(0)), []interface{}{rule.Value}, nil

	case OpGTE:
		return fmt.Sprintf("%s >= %s", expr, next(0)), []interface{}{rule.Value}, nil

	case OpIN:
		values, ok := rule.Value.([]interface{})
		if !ok || len(values) == 0 {
			return "", nil, &ErrUnmappable{Attribute: rule.Attribute, Reason: "IN needs a non-empty list"}
		}
		// ANY($n) rather than an expanded IN list: one placeholder regardless of
		// how many values arrive, so a long list cannot balloon the statement.
		return fmt.Sprintf("%s = ANY(%s)", expr, next(0)), []interface{}{toStringSlice(values)}, nil

	case OpBETWEEN:
		bounds, ok := rule.Value.([]interface{})
		if !ok || len(bounds) != 2 {
			return "", nil, &ErrUnmappable{Attribute: rule.Attribute, Reason: "BETWEEN needs [min, max]"}
		}
		return fmt.Sprintf("%s BETWEEN %s AND %s", expr, next(0), next(1)),
			[]interface{}{bounds[0], bounds[1]}, nil

	default:
		return "", nil, &ErrUnmappable{
			Attribute: rule.Attribute,
			Reason:    fmt.Sprintf("unsupported operator %q", rule.Operator),
		}
	}
}

// compileDerivedRange turns a predicate on a derived value into a range over the
// stored column it derives from.
//
// The boundaries are the whole point, so they are spelled out rather than
// approximated. For `years_since` (age):
//
//	age >= lo   means born no later than lo years ago      -> col <= now - lo
//	age <= hi   means born after hi+1 years ago            -> col >  now - (hi+1)
//
// The `hi+1` is not an off-by-one: someone aged exactly hi has a birthday
// between hi and hi+1 years back, and a strict `>` excludes the person who has
// just turned hi+1. `days_since` follows the same shape with days.
//
// Returns ok=false for anything it cannot express exactly, so the caller can
// fall back rather than guess.
func compileDerivedRange(
	rule Rule,
	mapping Mapping,
	next func(int) string,
) (string, []interface{}, bool) {
	unit := "years"
	if mapping.Derive == "days_since" {
		unit = "days"
	}

	// `NOW() - ($n || ' years')::interval` keeps the bound a parameter: the
	// number never reaches the statement text.
	ago := func(placeholder string) string {
		return fmt.Sprintf("(NOW() - (%s || ' %s')::interval)", placeholder, unit)
	}

	num := func(v interface{}) (float64, bool) {
		switch n := v.(type) {
		case float64:
			return n, true
		case int:
			return float64(n), true
		case int64:
			return float64(n), true
		}
		return 0, false
	}

	switch rule.Operator {
	case OpLTE:
		// "within the last N" — the common shape for recency.
		n, ok := num(rule.Value)
		if !ok {
			return "", nil, false
		}
		return fmt.Sprintf("%s > %s", mapping.Column, ago(next(0))),
			[]interface{}{fmt.Sprint(n + 1)}, true

	case OpGTE:
		n, ok := num(rule.Value)
		if !ok {
			return "", nil, false
		}
		return fmt.Sprintf("%s <= %s", mapping.Column, ago(next(0))),
			[]interface{}{fmt.Sprint(n)}, true

	case OpBETWEEN:
		bounds, ok := rule.Value.([]interface{})
		if !ok || len(bounds) != 2 {
			return "", nil, false
		}
		lo, okLo := num(bounds[0])
		hi, okHi := num(bounds[1])
		if !okLo || !okHi {
			return "", nil, false
		}
		return fmt.Sprintf("(%s <= %s AND %s > %s)",
				mapping.Column, ago(next(0)),
				mapping.Column, ago(next(1))),
			[]interface{}{fmt.Sprint(lo), fmt.Sprint(hi + 1)}, true
	}

	return "", nil, false
}

func toStringSlice(values []interface{}) []string {
	out := make([]string, 0, len(values))
	for _, v := range values {
		out = append(out, fmt.Sprint(v))
	}
	return out
}

// RuleHash recomputes v6 §10's hash from the rules the Agent was sent.
//
// This MUST agree with the TypeScript implementation in
// packages/contracts/src/audience.ts, byte for byte. The Agent checks it before
// materializing: an approval binds to a hash, so if the rules that arrived do
// not produce the hash in the manifest, they are not the rules the Partner
// agreed to serve.
//
// Weight is excluded, IN lists are sorted, BETWEEN order is preserved, and the
// canonical rules are sorted -- all for the same reason as the TypeScript side:
// two rule sets a human would call identical must not force a re-approval.
func RuleHash(rules []Rule) string {
	canonical := make([]string, 0, len(rules))

	for _, rule := range rules {
		value := rule.Value

		if list, ok := rule.Value.([]interface{}); ok && rule.Operator != OpBETWEEN {
			sorted := toStringSlice(list)
			sort.Strings(sorted)
			// Re-widen to []interface{} so the JSON encoding matches
			// JSON.stringify of an array of strings on the TypeScript side.
			widened := make([]interface{}, len(sorted))
			for i, s := range sorted {
				widened[i] = s
			}
			value = widened
		}

		// SetEscapeHTML(false) matters more than it looks. Go's json.Marshal
		// escapes <, > and & by default; JSON.stringify does not. A value
		// containing any of them would hash differently in the two languages,
		// and the Agent would refuse a manifest that was in fact correct.
		var buf bytes.Buffer
		enc := json.NewEncoder(&buf)
		enc.SetEscapeHTML(false)
		if err := enc.Encode([]interface{}{
			rule.Attribute,
			string(rule.Operator),
			value,
			rule.Required,
		}); err != nil {
			// Unreachable for the shapes the schema permits. An empty hash
			// mismatches, which is the safe direction to fail.
			return ""
		}
		// Encode appends a newline that Marshal does not.
		canonical = append(canonical, strings.TrimRight(buf.String(), "\n"))
	}

	sort.Strings(canonical)

	sum := sha256.Sum256([]byte("[" + strings.Join(canonical, ",") + "]"))
	return hex.EncodeToString(sum[:])
}
