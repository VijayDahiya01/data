// Package detect suggests which of a Partner's columns holds each standard
// attribute, their customer id and their marketing consent.
//
// It looks at two things: the column's name, and what a sample of its values
// actually contains. Names alone mislead ("status" could be anything); values
// alone mislead too (a 0/1 column cleans perfectly as gender codes). So a
// suggestion needs a name that fits, except for columns whose values could
// hardly be anything else -- a column full of Indian city names is a city.
//
// Everything here runs inside the Partner's network, on their own sample.
// Nothing it looks at leaves the Agent.
package detect

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/oolix/partner-agent/internal/clean"
	"github.com/oolix/partner-agent/internal/standard"
)

// Column is one column or document field of the Partner's customer table.
type Column struct {
	// Name as the source reports it. For MongoDB, a dotted path.
	Name string
	// Type is the source's own type name, lower-case, or "" when unknown.
	Type string
	// PrimaryKey is true when the source says so.
	PrimaryKey bool
}

// ValueCount is a raw value the cleaning did not recognise, and how often.
type ValueCount struct {
	Value string
	Count int
}

// Suggestion is the best match for one standard attribute.
type Suggestion struct {
	Attribute string
	// Column is empty when nothing in the table looks like this attribute.
	Column string
	// Score is how sure the match is, 0 to 1.
	Score float64
	// Readable is the share of non-empty sample values that clean.
	Readable float64
	// Sampled is how many non-empty values the share is out of.
	Sampled int
	// Order is how dates in the column are written.
	Order clean.Order
	// NeedsReview asks the setup page to have the Partner confirm.
	NeedsReview bool
	// Unrecognised lists values of a list attribute that mapped to no code.
	Unrecognised []ValueCount
	// Reason explains the suggestion in plain words.
	Reason string
}

// valueOnly are the attributes whose values are distinctive enough to be
// suggested without a matching name.
var valueOnly = map[string]bool{
	"city": true, "state_region": true, "payment_method": true, "purchase_category": true,
}

// Suggest matches every standard attribute to at most one column, and every
// column to at most one attribute.
func Suggest(columns []Column, samples map[string][]any, now time.Time) []Suggestion {
	type candidate struct {
		attr string
		col  string
		s    Suggestion
	}
	var all []candidate
	for _, a := range standard.Attributes {
		for _, c := range columns {
			s, ok := score(a, c, samples[c.Name], now)
			if ok {
				all = append(all, candidate{a.Key, c.Name, s})
			}
		}
	}
	// Best matches claim their columns first.
	sort.SliceStable(all, func(i, j int) bool { return all[i].s.Score > all[j].s.Score })

	chosen := map[string]Suggestion{}
	taken := map[string]bool{}
	for _, c := range all {
		if _, done := chosen[c.attr]; done || taken[c.col] {
			continue
		}
		chosen[c.attr] = c.s
		taken[c.col] = true
	}

	out := make([]Suggestion, 0, len(standard.Attributes))
	for _, a := range standard.Attributes {
		if s, ok := chosen[a.Key]; ok {
			out = append(out, s)
		} else {
			out = append(out, Suggestion{Attribute: a.Key, Reason: "no column looks like this"})
		}
	}
	return out
}

// Evaluate reports how well a column the Partner picked by hand fits an
// attribute, so the setup page can show the same numbers for it.
func Evaluate(a standard.Attribute, c Column, values []any, now time.Time) Suggestion {
	s := measure(a, c, values, now)
	s.Score = s.Readable
	s.NeedsReview = s.NeedsReview || s.Readable < 0.9 || len(s.Unrecognised) > 0
	s.Reason = joinReason("chosen by you; "+readableText(s), s.Reason)
	return s
}

func score(a standard.Attribute, c Column, values []any, now time.Time) (Suggestion, bool) {
	name := nameScore(c.Name, a.Hints)
	if name == 0 && !valueOnly[a.Key] {
		return Suggestion{}, false
	}
	s := measure(a, c, values, now)
	if s.Sampled == 0 {
		// An empty column holds nothing to copy, whatever it is called.
		if name < 1 {
			return Suggestion{}, false
		}
		s.Score = 0.5
		s.NeedsReview = true
		s.Reason = "the name fits, but the sample was empty"
		return s, true
	}
	switch {
	case name > 0:
		s.Score = 0.6*name + 0.4*s.Readable
	case s.Readable >= 0.8 && s.Sampled >= 20:
		s.Score = 0.5 * s.Readable
	default:
		return Suggestion{}, false
	}
	if s.Readable < 0.5 {
		// Right name, wrong contents: better to leave it for the Partner.
		return Suggestion{}, false
	}
	s.NeedsReview = s.Score < 0.75 || s.Readable < 0.9 || len(s.Unrecognised) > 0 || s.NeedsReview
	why := "values look right"
	if name >= 1 {
		why = "the name matches"
	} else if name > 0 {
		why = "the name is close"
	}
	s.Reason = joinReason(fmt.Sprintf("%s; %s", why, readableText(s)), s.Reason)
	return s, true
}

// joinReason appends a note measure() left about the column's dates.
func joinReason(main, note string) string {
	if note == "" {
		return main
	}
	return main + "; " + note
}

// measure cleans the sample the way the sync will, and counts what survives.
func measure(a standard.Attribute, c Column, values []any, now time.Time) Suggestion {
	s := Suggestion{Attribute: a.Key, Column: c.Name}
	var nonEmpty []any
	for _, v := range values {
		if strings.TrimSpace(clean.Text(v)) != "" {
			nonEmpty = append(nonEmpty, v)
		}
	}
	s.Sampled = len(nonEmpty)
	if s.Sampled == 0 {
		return s
	}

	good := 0
	switch a.Kind {
	case standard.KindDate, standard.KindTimestamp:
		decision := clean.DetectOrder(nonEmpty).Decide()
		s.Order = decision.Order
		if !decision.Confident {
			s.NeedsReview = true
		}
		opts := clean.DateOptions{Order: decision.Order}
		for _, v := range nonEmpty {
			if a.Kind == standard.KindDate {
				if d, ok := clean.ParseDate(v, opts); ok && plausibleBirth(d, now) {
					good++
				}
			} else if t, ok := clean.ParseTimestamp(v, opts); ok && !t.After(now.Add(24*time.Hour)) {
				good++
			}
		}
		if s.Reason == "" && !decision.Confident {
			s.Reason = decision.Note
		}
	case standard.KindEnum:
		m, err := clean.NewEnumMapper(a, nil)
		if err != nil {
			return s
		}
		misses := map[string]int{}
		for _, v := range nonEmpty {
			if _, ok := m.Map(v); ok {
				good++
			} else {
				misses[strings.TrimSpace(clean.Text(v))]++
			}
		}
		s.Unrecognised = topValues(misses, 10)
	case standard.KindBool:
		for _, v := range nonEmpty {
			if _, ok := clean.ParseBool(v); ok {
				good++
			}
		}
	case standard.KindNumber:
		for _, v := range nonEmpty {
			if n, ok := clean.ParseNumber(v); ok && n >= 0 {
				good++
			}
		}
	}
	s.Readable = float64(good) / float64(s.Sampled)
	return s
}

// plausibleBirth accepts a birth date for someone alive and at least 13.
// (Under-18s are dropped later, at sync; they still count as readable here.)
func plausibleBirth(d, now time.Time) bool {
	return d.Year() >= 1900 && !d.After(now.AddDate(-13, 0, 0))
}

// SuggestID picks the column most likely to be the customer id: a name that
// fits and values that are unique in the sample.
func SuggestID(columns []Column, samples map[string][]any) (string, float64) {
	best, bestScore := "", 0.0
	for _, c := range columns {
		name := nameScore(c.Name, standard.IDHints)
		if c.PrimaryKey {
			name = max(name, 0.9)
		}
		if name == 0 {
			continue
		}
		values := samples[c.Name]
		seen := map[string]bool{}
		filled := 0
		for _, v := range values {
			t := strings.TrimSpace(clean.Text(v))
			if t == "" {
				continue
			}
			filled++
			seen[t] = true
		}
		unique := 0.0
		if filled > 0 {
			unique = float64(len(seen)) / float64(filled)
		}
		// A column named just like an id is the id even when the table repeats
		// some customers -- the sync merges those. One that merely ends in
		// "_id" (city_id, store_id) has to prove itself by being unique.
		need := 0.99
		if name >= 0.9 {
			need = 0.8
		}
		if len(values) > 0 && unique < need {
			continue
		}
		if s := 0.7*name + 0.3*unique; s > bestScore {
			best, bestScore = c.Name, s
		}
	}
	return best, bestScore
}

// SuggestConsent picks the column recording marketing consent, and one that
// records it being withdrawn, if the table has them.
func SuggestConsent(columns []Column) (consent, withdrawal string) {
	var bestC, bestW float64
	for _, c := range columns {
		if s := nameScore(c.Name, standard.ConsentHints); s > bestC {
			consent, bestC = c.Name, s
		}
		if s := nameScore(c.Name, standard.WithdrawalHints); s > bestW {
			withdrawal, bestW = c.Name, s
		}
	}
	if consent == withdrawal {
		withdrawal = ""
	}
	return consent, withdrawal
}

var camel = regexp.MustCompile(`([a-z0-9])([A-Z])`)

// Words turns a column name into comparable form: "dateOfBirth",
// "Date Of Birth" and "date_of_birth" all become "date_of_birth". A MongoDB
// path keeps only its last segment: "profile.dob" is "dob".
func Words(name string) string {
	if i := strings.LastIndex(name, "."); i >= 0 {
		name = name[i+1:]
	}
	name = camel.ReplaceAllString(name, "${1}_${2}")
	name = strings.ToLower(name)
	name = regexp.MustCompile(`[^a-z0-9]+`).ReplaceAllString(name, "_")
	return strings.Trim(name, "_")
}

// nameScore is 1 for an exact hint, 0.7 when a hint is one of the name's
// words ("customer_dob"), 0.5 when a longer hint appears inside the name.
func nameScore(name string, hints []string) float64 {
	w := Words(name)
	if w == "" {
		return 0
	}
	parts := strings.Split(w, "_")
	best := 0.0
	for _, h := range hints {
		switch {
		case w == h:
			return 1
		case len(parts) > 1 && (strings.HasSuffix(w, "_"+h) || strings.HasPrefix(w, h+"_") ||
			strings.Contains(w, "_"+h+"_")):
			best = max(best, 0.7)
		case len(h) >= 5 && strings.Contains(w, h):
			best = max(best, 0.5)
		}
	}
	return best
}

func topValues(counts map[string]int, n int) []ValueCount {
	out := make([]ValueCount, 0, len(counts))
	for v, c := range counts {
		out = append(out, ValueCount{v, c})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Value < out[j].Value
	})
	if len(out) > n {
		out = out[:n]
	}
	return out
}

func readableText(s Suggestion) string {
	return fmt.Sprintf("%.0f%% of %d sampled values are usable", s.Readable*100, s.Sampled)
}
