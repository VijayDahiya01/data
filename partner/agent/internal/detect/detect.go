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
	// Form is how the column holds the attribute: an age group rather than a
	// date of birth, say. FormNative for the attribute's own form.
	Form standard.Form
	// Days is a window read from the column's name -- 30 for
	// "orders_last_30_days" -- or 0 when the name gives none.
	Days int
	// NeedsReview asks the setup page to have the Partner confirm.
	NeedsReview bool
	// Unrecognised lists values of a list attribute that mapped to no code.
	Unrecognised []ValueCount
	// Outside counts values that are places Oolix does not list; they are
	// not in Sampled.
	Outside int
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
	// A pincode column gives both the city and the state, so it may serve
	// both, and either one no better column did.
	if pin := pincodeColumn(columns, samples); pin != "" {
		for _, key := range []string{"city", "state_region"} {
			if _, done := chosen[key]; done {
				continue
			}
			a, _ := standard.ByKey(key)
			s := measure(a, standard.FormNative, Column{Name: pin}, samples[pin], now)
			if s.Sampled == 0 {
				continue
			}
			s.Score = 0.5 + 0.4*s.Readable
			s.NeedsReview = s.Readable < 0.9 || len(s.Unrecognised) > 0
			s.Reason = "pincodes, read through India Post's directory; " + readableText(s)
			chosen[key] = s
		}
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
	s := bestForm(a, c, values, now)
	s.Days = WindowFromName(c.Name)
	s.Score = s.Readable
	s.NeedsReview = s.NeedsReview || s.Readable < 0.9 || len(s.Unrecognised) > 0
	s.Reason = joinReason("chosen by you; "+readableText(s), s.Reason)
	return s
}

// Forms lists the forms a column may hold an attribute in, the native one
// first.
func Forms(a standard.Attribute) []standard.Form {
	out := []standard.Form{standard.FormNative}
	for _, f := range []standard.Form{standard.FormBirthYear, standard.FormAge, standard.FormAgeBand,
		standard.FormDaysSince, standard.FormWithinDays} {
		if _, ok := a.Forms[f]; ok {
			out = append(out, f)
		}
	}
	return out
}

func hintsFor(a standard.Attribute, f standard.Form) []string {
	if f == standard.FormNative {
		return a.Hints
	}
	return a.Forms[f]
}

// bestForm measures a column under each form the attribute accepts and keeps
// the one its values read best in. The name decides a tie: a column called
// age_group holding "25" is an age group with one-year bands, not an age.
func bestForm(a standard.Attribute, c Column, values []any, now time.Time) Suggestion {
	var best Suggestion
	bestName := -1.0
	for i, f := range Forms(a) {
		s := measure(a, f, c, values, now)
		name := nameScore(c.Name, hintsFor(a, f))
		if i == 0 || s.Readable > best.Readable || (s.Readable == best.Readable && name > bestName) {
			best, bestName = s, name
		}
	}
	return best
}

var windowName = regexp.MustCompile(`(?:^|_)(?:last_?|l|past_?)?(\d{1,3})_?(?:d|day|days)(?:_|$)`)

// WindowFromName reads the days a column's name says it covers:
// orders_30d, orders_last_30_days, purchased_l7d. 0 when it says none.
func WindowFromName(name string) int {
	m := windowName.FindStringSubmatch(Words(name))
	if m == nil {
		return 0
	}
	n := 0
	fmt.Sscan(m[1], &n)
	return n
}

func score(a standard.Attribute, c Column, values []any, now time.Time) (Suggestion, bool) {
	name := 0.0
	for _, f := range Forms(a) {
		name = max(name, nameScore(c.Name, hintsFor(a, f)))
	}
	if name == 0 && !valueOnly[a.Key] {
		return Suggestion{}, false
	}
	s := bestForm(a, c, values, now)
	s.Days = WindowFromName(c.Name)
	if s.Sampled == 0 {
		// An empty column holds nothing to copy, whatever it is called.
		if name < 1 {
			return Suggestion{}, false
		}
		s.Score = 0.5
		s.NeedsReview = true
		s.Reason = "the name fits, but the sample was empty"
		if s.Outside > 0 {
			s.Reason = "the name fits, but every sampled value is a place outside Oolix's list"
		}
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
	// An age, a number of days or a yes/no was true on some date, and a
	// yes/no covers some number of days: the Partner has to say which.
	s.NeedsReview = s.Score < 0.75 || s.Readable < 0.9 || len(s.Unrecognised) > 0 || s.NeedsReview ||
		s.Form.NeedsAsOf()
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
func measure(a standard.Attribute, f standard.Form, c Column, values []any, now time.Time) Suggestion {
	s := Suggestion{Attribute: a.Key, Column: c.Name, Form: f}
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
	if f != standard.FormNative {
		misses := map[string]int{}
		for _, v := range nonEmpty {
			if readsAs(f, v, now) {
				good++
			} else if f == standard.FormAgeBand {
				misses[strings.TrimSpace(clean.Text(v))]++
			}
		}
		s.Unrecognised = topValues(misses, 10)
		s.Readable = float64(good) / float64(s.Sampled)
		return s
	}
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
			switch _, ok := m.Map(v); {
			case ok:
				good++
			case m.Outside(v):
				// A place Oolix does not list (226001, Lucknow): left empty,
				// as the sync will, and no mark against the column.
				s.Outside++
			default:
				misses[strings.TrimSpace(clean.Text(v))]++
			}
		}
		s.Sampled -= s.Outside
		s.Unrecognised = topValues(misses, 10)
		if s.Sampled == 0 {
			return s
		}
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

// readsAs says whether one value reads in a form other than the native one.
func readsAs(f standard.Form, v any, now time.Time) bool {
	switch f {
	case standard.FormBirthYear:
		y, ok := clean.ParseWhole(v)
		return ok && y >= 1900 && y <= now.Year()-13
	case standard.FormAge:
		n, ok := clean.ParseWhole(v)
		return ok && n <= clean.MaxAge
	case standard.FormAgeBand:
		_, ok := clean.ParseBand(v)
		return ok
	case standard.FormDaysSince:
		n, ok := clean.ParseWhole(v)
		return ok && n <= 36500
	case standard.FormWithinDays:
		_, ok := clean.ParseBool(v)
		return ok
	}
	return false
}

// pincodeHints are names of columns that hold pincodes.
var pincodeHints = []string{"pincode", "pin_code", "pin", "zip", "zipcode", "zip_code", "postal_code",
	"postcode", "post_code", "postalcode"}

// pincodeColumn picks the column holding pincodes: most of its sampled
// values are pincodes India Post knows, and its name says so or nearly all
// of them are.
func pincodeColumn(columns []Column, samples map[string][]any) string {
	best, bestScore := "", 0.0
	for _, c := range columns {
		filled, known := 0, 0
		for _, v := range samples[c.Name] {
			if strings.TrimSpace(clean.Text(v)) == "" {
				continue
			}
			filled++
			if _, _, ok := clean.Pincode(v); ok {
				known++
			}
		}
		if filled == 0 {
			continue
		}
		share := float64(known) / float64(filled)
		name := nameScore(c.Name, pincodeHints)
		if share < 0.8 || (name == 0 && (share < 0.95 || filled < 20)) {
			continue
		}
		if s := name + share; s > bestScore {
			best, bestScore = c.Name, s
		}
	}
	return best
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
