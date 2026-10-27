package managed

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/oolix/partner-agent/internal/audience"
	"github.com/oolix/partner-agent/internal/clean"
	"github.com/oolix/partner-agent/internal/localstore"
	"github.com/oolix/partner-agent/internal/source"
	"github.com/oolix/partner-agent/internal/standard"
)

var formsNow = time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)

func dayUTC(y int, m time.Month, d int) time.Time { return time.Date(y, m, d, 0, 0, 0, 0, time.UTC) }

func spanOf(t *testing.T, key string, am AttributeMapping, raw any, row source.Row) (span, bool, bool) {
	t.Helper()
	a, _ := standard.ByKey(key)
	c, err := newCleaner(a, am, clean.India)
	if err != nil {
		t.Fatalf("%s %+v: %v", key, am, err)
	}
	if row == nil {
		row = source.Row{}
	}
	v, present, ok := c.value(raw, c.asOf(row, formsNow), formsNow)
	s, _ := v.(span)
	return s, present, ok
}

func TestEachFormBecomesARange(t *testing.T) {
	signedUp := dayUTC(2025, 10, 25)
	for _, tc := range []struct {
		name   string
		key    string
		am     AttributeMapping
		raw    any
		row    source.Row
		lo, hi any
	}{
		{"date of birth", "age", AttributeMapping{Order: clean.DayFirst}, "14/04/1992",
			nil, dayUTC(1992, 4, 14), dayUTC(1992, 4, 14)},
		{"year of birth", "age", AttributeMapping{Form: standard.FormBirthYear}, "1992",
			nil, dayUTC(1992, 1, 1), dayUTC(1992, 12, 31)},
		// 25 on 25 Oct 2025: born after 25 Oct 1999, on or before 25 Oct 2000.
		{"age as of a column", "age", AttributeMapping{Form: standard.FormAge, AsOf: AsOfColumn, AsOfColumn: "signed_up"},
			"25", source.Row{"signed_up": "25/10/2025"}, dayUTC(1999, 10, 26), dayUTC(2000, 10, 25)},
		{"age as of a date", "age", AttributeMapping{Form: standard.FormAge, AsOf: AsOfDate, AsOfDate: &signedUp},
			25, nil, dayUTC(1999, 10, 26), dayUTC(2000, 10, 25)},
		{"age group kept up to date", "age", AttributeMapping{Form: standard.FormAgeBand}, "25-45",
			nil, dayUTC(1980, 10, 28), dayUTC(2001, 10, 27)},
		// Open groups end at the taxonomy's oldest age, 120.
		{"open age group", "age", AttributeMapping{Form: standard.FormAgeBand}, "60+",
			nil, dayUTC(1905, 10, 28), dayUTC(1966, 10, 27)},
		{"age group answered in words", "age",
			AttributeMapping{Form: standard.FormAgeBand, Overrides: map[string]string{"Senior": "60+"}}, "senior",
			nil, dayUTC(1905, 10, 28), dayUTC(1966, 10, 27)},
		{"days since", "purchase_recency_days", AttributeMapping{Form: standard.FormDaysSince}, "12",
			nil, formsNow.Add(-13 * 24 * time.Hour), formsNow.Add(-12 * 24 * time.Hour)},
		{"yes in the last 30 days", "purchase_recency_days", AttributeMapping{Form: standard.FormWithinDays, Days: 30},
			"Y", nil, formsNow.Add(-30 * 24 * time.Hour), formsNow},
		{"no in the last 30 days", "purchase_recency_days", AttributeMapping{Form: standard.FormWithinDays, Days: 30},
			"N", nil, nil, nil},
		{"count over 90 days", "purchase_frequency", AttributeMapping{Days: 90}, "5", nil, int32(5), int32(5)},
		{"count before windows existed", "purchase_frequency", AttributeMapping{}, 5, nil, int32(5), int32(5)},
		// 5 in 30 days is at least 5 in 90; how many more is unknown.
		{"count over 30 days", "purchase_frequency", AttributeMapping{Days: 30}, "5", nil, int32(5), nil},
	} {
		s, present, ok := spanOf(t, tc.key, tc.am, tc.raw, tc.row)
		if !present || !ok {
			t.Errorf("%s: present %v ok %v", tc.name, present, ok)
			continue
		}
		if !same(s.lo, tc.lo) || !same(s.hi, tc.hi) {
			t.Errorf("%s: got %v to %v, want %v to %v", tc.name, s.lo, s.hi, tc.lo, tc.hi)
		}
	}
}

func same(a, b any) bool {
	if x, ok := a.(time.Time); ok {
		y, ok := b.(time.Time)
		return ok && x.Equal(y)
	}
	return a == b
}

func TestFormsRefuseWhatTheyCannotRead(t *testing.T) {
	band := AttributeMapping{Form: standard.FormAgeBand, Overrides: map[string]string{"unknown": ""}}
	if _, present, _ := spanOf(t, "age", band, "Unknown", nil); present {
		t.Error("an ignored age group was read")
	}
	if _, _, ok := spanOf(t, "age", band, "young", nil); ok {
		t.Error("an unanswered word was read as an age group")
	}
	// An age whose as-of date is missing cannot be placed in time.
	asOf := AttributeMapping{Form: standard.FormAge, AsOf: AsOfColumn, AsOfColumn: "signed_up"}
	if _, _, ok := spanOf(t, "age", asOf, "25", source.Row{"signed_up": ""}); ok {
		t.Error("an age without its date was read")
	}
	if _, _, ok := spanOf(t, "age", AttributeMapping{Form: standard.FormBirthYear}, "2030", nil); ok {
		t.Error("a year of birth in the future was read")
	}
}

func TestUnansweredQuestionsStopTheCopy(t *testing.T) {
	age, _ := standard.ByKey("age")
	freq, _ := standard.ByKey("purchase_frequency")
	recency, _ := standard.ByKey("purchase_recency_days")
	gender, _ := standard.ByKey("gender")
	for _, tc := range []struct {
		a  standard.Attribute
		am AttributeMapping
	}{
		{age, AttributeMapping{Column: "age", Form: standard.FormAge, AsOf: AsOfAsk}},
		{age, AttributeMapping{Column: "age", Form: standard.FormAge, AsOf: AsOfColumn}},
		{age, AttributeMapping{Column: "age", Form: standard.FormDaysSince}},
		{recency, AttributeMapping{Column: "r", Form: standard.FormWithinDays}},
		{freq, AttributeMapping{Column: "f", Days: 365}},
		{gender, AttributeMapping{Column: "g", Form: standard.FormAgeBand}},
	} {
		if err := CheckAttribute(tc.a, tc.am); err == nil {
			t.Errorf("%s %+v: accepted", tc.a.Key, tc.am)
		}
	}
	m := Mapping{Attributes: map[string]AttributeMapping{
		"age":    {Column: "age", Form: standard.FormAge, AsOf: AsOfAsk},
		"gender": {Column: "g"},
	}}
	if p := m.Problems(); len(p) != 1 || p["age"] == "" {
		t.Errorf("problems: %v", p)
	}
}

func TestPossiblyUnder18IsLeftOut(t *testing.T) {
	for raw, want := range map[string]bool{"15-25": true, "18-24": false, "17": true, "60+": false} {
		s, _, _ := spanOf(t, "age", AttributeMapping{Form: standard.FormAgeBand}, raw, nil)
		if got := spanUnderAge(s, formsNow); got != want {
			t.Errorf("%s: under age %v, want %v", raw, got, want)
		}
	}
}

func TestPrecisionDescribesTheFormat(t *testing.T) {
	age, _ := standard.ByKey("age")
	freq, _ := standard.ByKey("purchase_frequency")
	recency, _ := standard.ByKey("purchase_recency_days")
	report := AttributeReport{Bands: []string{"18-24", "25-45", "46+"}}
	bands := precisionOf(age, AttributeMapping{Form: standard.FormAgeBand}, report)
	if bands == nil || bands.Kind != "BANDS" || len(bands.Bands) != 3 || bands.Bands[2].Hi != nil ||
		*bands.Bands[1].Hi != 45 {
		t.Errorf("bands: %+v", bands)
	}
	// Groups recorded at sign-up have drifted apart: only their width is left.
	drifted := precisionOf(age, AttributeMapping{Form: standard.FormAgeBand, AsOf: AsOfColumn}, report)
	if drifted == nil || drifted.Kind != "APPROXIMATE" || drifted.Width != clean.MaxAge-46 {
		t.Errorf("drifted: %+v", drifted)
	}
	if p := precisionOf(age, AttributeMapping{Form: standard.FormAge}, AttributeReport{}); p == nil || p.Width != 1 {
		t.Errorf("age: %+v", p)
	}
	if p := precisionOf(age, AttributeMapping{}, AttributeReport{}); p != nil {
		t.Errorf("date of birth: %+v", p)
	}
	if p := precisionOf(recency, AttributeMapping{Form: standard.FormWithinDays, Days: 30}, AttributeReport{}); p == nil ||
		p.Kind != "WITHIN" || p.Days != 30 {
		t.Errorf("within: %+v", p)
	}
	if p := precisionOf(freq, AttributeMapping{Days: 30}, AttributeReport{}); p == nil || p.Kind != "WINDOW" {
		t.Errorf("window: %+v", p)
	}
	if p := precisionOf(freq, AttributeMapping{}, AttributeReport{}); p != nil {
		t.Errorf("90-day count: %+v", p)
	}
}

// formsCSV is the same customers, held several ways. Dates are relative to
// now, so the ages it implies do not drift as the years pass: C1 was 25 a
// year ago, and was born 34 years before this year.
func formsCSV(now time.Time) string {
	y := now.Year()
	return fmt.Sprintf(`customer_id,marketing_opt_in,age_group,age,signed_up,yob,days_since_order,bought_30d,orders_30d
C1,yes,25-45,25,%s,%d,3,Y,5
C2,yes,30-34,31,,%d,40,N,1
C3,yes,15-25,16,,%d,,,
C4,yes,senior,70,,%d,,Y,0
`, now.AddDate(-1, 0, -2).Format("02/01/2006"), y-34, y-36, y-16, y-76)
}

func TestRulesReachOnlyCustomersWhoCertainlyMatch(t *testing.T) {
	store := localStore(t)
	ctx := context.Background()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "customers.csv"), []byte(formsCSV(time.Now())), 0o600); err != nil {
		t.Fatal(err)
	}
	src, err := source.Open(ctx, source.Config{Kind: source.File, Folder: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	ev := audience.NewEvaluator(audience.EvaluatorOptions{
		Pool: store.Pool, AttributeTable: localstore.AttributesTable,
		Mappings: EvaluatorMappings(), MappingVersion: MappingVersion,
	})
	members := func(rule audience.Rule) []string {
		t.Helper()
		id := uuid.NewString()
		if _, err := ev.Materialize(ctx, id, "ag", 1, []audience.Rule{rule}, "", time.Hour); err != nil {
			t.Fatal(err)
		}
		rows, err := store.Pool.Query(ctx, `SELECT partner_user_id FROM oolix_audience_members WHERE activation_id = $1`, id)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var got []string
		for rows.Next() {
			var scrambled string
			if err := rows.Scan(&scrambled); err != nil {
				t.Fatal(err)
			}
			for _, c := range []string{"C1", "C2", "C3", "C4"} {
				if store.ScrambleID(c) == scrambled {
					got = append(got, c)
				}
			}
		}
		slices.Sort(got)
		return got
	}
	between := func(lo, hi float64) audience.Rule {
		return audience.Rule{Attribute: "age", Operator: audience.OpBETWEEN, Value: []any{lo, hi}, Required: true}
	}

	// Rules stay clear of their bounds by a year or more: the database's clock
	// and the sync's differ by the time the test takes.
	for _, tc := range []struct {
		name      string
		attribute string
		am        AttributeMapping
		underAge  int
		rules     []audience.Rule
		want      [][]string
	}{
		{
			name: "age groups kept up to date", attribute: "age", underAge: 1,
			am: AttributeMapping{Column: "age_group", Form: standard.FormAgeBand, Publish: true,
				Overrides: map[string]string{"senior": "60+"}},
			// 25-45 is not certainly 30-40; 30-34 is. 15-25 may be a child.
			rules: []audience.Rule{between(29, 41), between(24, 46), between(59, 120)},
			want:  [][]string{{"C2"}, {"C1", "C2"}, {"C4"}},
		},
		{
			name: "ages recorded at sign-up", attribute: "age",
			am: AttributeMapping{Column: "age", Form: standard.FormAge, AsOf: AsOfColumn, AsOfColumn: "signed_up",
				Publish: true},
			// C1 was 25 a year and two days ago: 26 or 27 now. Nobody else
			// has a date.
			rules: []audience.Rule{between(25, 28), between(20, 26)},
			want:  [][]string{{"C1"}, nil},
		},
		{
			name: "years of birth", attribute: "age", underAge: 1,
			am:    AttributeMapping{Column: "yob", Form: standard.FormBirthYear, Publish: true},
			rules: []audience.Rule{between(32, 35), between(34, 40)},
			want:  [][]string{{"C1"}, {"C2"}},
		},
		{
			name: "days since the last order", attribute: "purchase_recency_days",
			am: AttributeMapping{Column: "days_since_order", Form: standard.FormDaysSince, AsOf: AsOfRefresh,
				Publish: true},
			rules: []audience.Rule{{Attribute: "purchase_recency_days", Operator: audience.OpLTE, Value: 7.0, Required: true}},
			want:  [][]string{{"C1"}},
		},
		{
			name: "bought in the last 30 days", attribute: "purchase_recency_days",
			am: AttributeMapping{Column: "bought_30d", Form: standard.FormWithinDays, Days: 30, AsOf: AsOfRefresh,
				Publish: true},
			// Yes means some time in 30 days: certain for 31, never for 7.
			rules: []audience.Rule{
				{Attribute: "purchase_recency_days", Operator: audience.OpLTE, Value: 31.0, Required: true},
				{Attribute: "purchase_recency_days", Operator: audience.OpLTE, Value: 7.0, Required: true},
			},
			want: [][]string{{"C1", "C4"}, nil},
		},
		{
			name: "a count over 30 days", attribute: "purchase_frequency",
			am: AttributeMapping{Column: "orders_30d", Days: 30, Publish: true},
			// At least 5 in 90 days for C1, at least 1 for C2.
			rules: []audience.Rule{
				{Attribute: "purchase_frequency", Operator: audience.OpGTE, Value: 3.0, Required: true},
				{Attribute: "purchase_frequency", Operator: audience.OpGTE, Value: 1.0, Required: true},
			},
			want: [][]string{{"C1"}, {"C1", "C2"}},
		},
	} {
		m := Mapping{Table: "customers.csv", IDColumn: "customer_id",
			Attributes: map[string]AttributeMapping{tc.attribute: tc.am},
			Consent:    ConsentMapping{Column: "marketing_opt_in"}}
		rep, err := Sync(ctx, src, store, m, time.Now())
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if rep.UnderAge != tc.underAge {
			t.Errorf("%s: %d under 18, want %d", tc.name, rep.UnderAge, tc.underAge)
		}
		for i, rule := range tc.rules {
			if got := members(rule); !slices.Equal(got, tc.want[i]) {
				t.Errorf("%s: %v %v reaches %v, want %v", tc.name, rule.Operator, rule.Value, got, tc.want[i])
			}
		}
		if tc.am.Form == standard.FormAgeBand {
			if got := rep.Attributes["age"].Bands; !slices.Equal(got, []string{"25-45", "30-34", "60+"}) {
				t.Errorf("%s: bands %v", tc.name, got)
			}
		}
	}
}

func TestYearsBetweenOnBirthdaysInLeapYears(t *testing.T) {
	for _, tc := range []struct {
		born, on time.Time
		want     int
	}{
		{dayUTC(2008, 10, 27), dayUTC(2026, 10, 27), 18},
		{dayUTC(2008, 10, 28), dayUTC(2026, 10, 27), 17},
		{dayUTC(2008, 2, 29), dayUTC(2026, 2, 28), 17},
		{dayUTC(2008, 2, 29), dayUTC(2026, 3, 1), 18},
		{dayUTC(1992, 4, 14), dayUTC(2026, 4, 14), 34},
	} {
		if got := yearsBetween(tc.born, tc.on); got != tc.want {
			t.Errorf("born %s, on %s: %d, want %d", tc.born.Format("2006-01-02"), tc.on.Format("2006-01-02"), got, tc.want)
		}
	}
}
