package managed

import (
	"fmt"
	"math"
	"slices"
	"strings"
	"time"

	"github.com/oolix/partner-agent/internal/clean"
	"github.com/oolix/partner-agent/internal/source"
	"github.com/oolix/partner-agent/internal/standard"
)

// Partners hold the same fact in many forms: a date of birth, a year of birth,
// an age, an age group; a date, a number of days, a yes/no for "in the last 30
// days"; a count over 30 days or over 90. Each is read into one stored form --
// a range, from the earliest to the latest the value can be -- so everything
// downstream sees the same columns whatever the Partner wrote.
//
// A range answers a rule only when every value in it does. "Age 30 to 40"
// reaches a customer whose age group is 25-45 only if they are certainly 30
// to 40, which they are not; it reaches one born on 14 April 1992 exactly when
// they are. Nobody is shown an ad because they might be in the audience.

// span is a cleaned value held as a range: the earliest and latest it can be,
// or the smallest and largest count. A nil end has no bound on that side.
type span struct{ lo, hi any }

// When a value in a form that needs one was true.
const (
	// AsOfRefresh: the Partner keeps the value up to date, so it is true at
	// each refresh.
	AsOfRefresh = ""
	// AsOfColumn: true on the date in another column of the same row, such as
	// when the customer signed up.
	AsOfColumn = "column"
	// AsOfDate: true on one fixed day, such as when a file was exported.
	AsOfDate = "date"
	// AsOfAsk: not answered yet. Guessing would be wrong for years: an age
	// recorded at sign-up five years ago is five years out of date.
	AsOfAsk = "ask"
)

// FrequencyWindows are the windows a purchase count may cover. Up to 90 days,
// a count is a lower bound on purchases in 90 days -- at least that many --
// which can answer "3 or more in 90 days" with certainty. A longer window only
// gives an upper bound, which can never put a customer in an audience.
var FrequencyWindows = []int{7, 14, 30, 60, standard.FrequencyDays}

// maxDaysSince caps a number of days anyone could mean: a hundred years.
const maxDaysSince = 36500

// checkForm says what is wrong with a mapping's form, as a sentence the setup
// page can show.
func checkForm(a standard.Attribute, am AttributeMapping) error {
	if am.Form != standard.FormNative {
		if _, ok := a.Forms[am.Form]; !ok || a.Upper == "" {
			return fmt.Errorf("%s cannot be read as %s", strings.ToLower(a.Label), FormName(am.Form))
		}
	}
	if am.Form.NeedsAsOf() {
		switch am.AsOf {
		case AsOfRefresh:
		case AsOfAsk:
			return fmt.Errorf("say whether each %s is kept up to date or was true on an earlier date",
				FormName(am.Form))
		case AsOfColumn:
			if am.AsOfColumn == "" {
				return fmt.Errorf("choose the column with the date each %s was true on", FormName(am.Form))
			}
		case AsOfDate:
			if am.AsOfDate == nil {
				return fmt.Errorf("give the date each %s was true on", FormName(am.Form))
			}
		default:
			return fmt.Errorf("unknown as-of choice %q", am.AsOf)
		}
	}
	if am.Form == standard.FormWithinDays && (am.Days < 1 || am.Days > standard.HistoryDays) {
		return fmt.Errorf("say how many days the yes/no covers, from 1 to %d", standard.HistoryDays)
	}
	if a.Key == "purchase_frequency" && am.Days != 0 && !slices.Contains(FrequencyWindows, am.Days) {
		return fmt.Errorf("a purchase count can cover 7, 14, 30, 60 or 90 days; " +
			"for a longer one, add your orders table on the next step instead")
	}
	return nil
}

// CheckAttribute says what is wrong with one attribute's choices, if
// anything: an unanswered question, or a window the attribute cannot use.
func CheckAttribute(a standard.Attribute, am AttributeMapping) error {
	return checkForm(a, am)
}

// Problems lists, by attribute key, the mapped attributes whose choices are
// incomplete or wrong -- a question the Partner has not answered yet. A
// mapping with problems cannot be copied, so it is not published.
func (m Mapping) Problems() map[string]string {
	out := map[string]string{}
	provides := ActivityProvides(m)
	for _, a := range standard.Attributes {
		am, ok := m.Attributes[a.Key]
		if !ok || am.Column == "" || provides[a.Key] {
			continue
		}
		if err := checkForm(a, am); err != nil {
			out[a.Key] = err.Error()
		}
	}
	return out
}

// FormName names a form in words.
func FormName(f standard.Form) string {
	switch f {
	case standard.FormBirthYear:
		return "year of birth"
	case standard.FormAge:
		return "age"
	case standard.FormAgeBand:
		return "age group"
	case standard.FormDaysSince:
		return "number of days"
	case standard.FormWithinDays:
		return "yes/no"
	}
	return "value"
}

// window is a purchase count's window in days.
func (am AttributeMapping) window() int {
	if am.Days == 0 {
		return standard.FrequencyDays
	}
	return am.Days
}

// asOf is when the value in one row was true, for the forms that need it. The
// zero time means it cannot be told, and the value is unusable.
func (c cleaner) asOf(row source.Row, now time.Time) time.Time {
	switch c.am.AsOf {
	case AsOfColumn:
		t, ok := clean.ParseTimestamp(row[c.am.AsOfColumn], clean.DateOptions{Order: clean.DayFirst, Location: c.opts.Location})
		if !ok || t.Year() < 1900 || t.After(now.Add(24*time.Hour)) {
			return time.Time{}
		}
		return t
	case AsOfDate:
		if c.am.AsOfDate != nil {
			return *c.am.AsOfDate
		}
		return time.Time{}
	}
	return now
}

// day is the calendar date of a moment in the Partner's zone, as midnight UTC:
// the way dates of birth are stored.
func (c cleaner) day(t time.Time) time.Time {
	loc := c.opts.Location
	if loc == nil {
		loc = clean.India
	}
	y, m, d := t.In(loc).Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

// span cleans one raw value of a range attribute.
func (c cleaner) span(raw any, asOf, now time.Time) (any, bool, bool) {
	unusable := func() (any, bool, bool) { return nil, true, false }
	if c.am.Form.NeedsAsOf() && (asOf.IsZero() || asOf.After(now.Add(24*time.Hour))) {
		return unusable()
	}
	switch c.am.Form {
	case standard.FormNative:
		switch c.attr.Kind {
		case standard.KindDate:
			d, ok := clean.ParseDate(raw, c.opts)
			if !ok || d.Year() < 1900 || d.After(now) {
				return unusable()
			}
			return span{d, d}, true, true
		case standard.KindTimestamp:
			t, ok := clean.ParseTimestamp(raw, c.opts)
			if !ok || t.After(now.Add(24*time.Hour)) {
				return unusable()
			}
			return span{t, t}, true, true
		case standard.KindNumber:
			n, ok := clean.ParseNumber(raw)
			if !ok || n < 0 || n > math.MaxInt32 {
				return unusable()
			}
			v := int32(math.Round(n))
			switch w := c.am.window(); {
			case w == standard.FrequencyDays:
				return span{v, v}, true, true
			case w < standard.FrequencyDays:
				// At least this many in 90 days.
				return span{v, nil}, true, true
			default:
				return span{nil, v}, true, true
			}
		}
	case standard.FormBirthYear:
		y, ok := clean.ParseWhole(raw)
		if !ok || y < 1900 || y > now.Year() {
			return unusable()
		}
		return span{time.Date(y, 1, 1, 0, 0, 0, 0, time.UTC), time.Date(y, 12, 31, 0, 0, 0, 0, time.UTC)}, true, true
	case standard.FormAge:
		age, ok := clean.ParseWhole(raw)
		if !ok || age > clean.MaxAge {
			return unusable()
		}
		return ageSpan(c.day(asOf), clean.Band{Lo: age, Hi: age}), true, true
	case standard.FormAgeBand:
		band, ignored, ok := c.band(raw)
		if ignored {
			return nil, false, false
		}
		if !ok {
			return unusable()
		}
		return ageSpan(c.day(asOf), band), true, true
	case standard.FormDaysSince:
		n, ok := clean.ParseWhole(raw)
		if !ok || n > maxDaysSince {
			return unusable()
		}
		// n whole days before asOf: some time in the day that ended n days
		// before it.
		return span{asOf.Add(-time.Duration(n+1) * 24 * time.Hour).UTC(),
			asOf.Add(-time.Duration(n) * 24 * time.Hour).UTC()}, true, true
	case standard.FormWithinDays:
		yes, ok := clean.ParseBool(raw)
		if !ok {
			return unusable()
		}
		if !yes {
			// Not in the window -- some time before it, or never. That puts
			// the customer in no recency audience, so nothing is stored.
			return span{}, true, true
		}
		return span{asOf.Add(-time.Duration(c.am.Days) * 24 * time.Hour).UTC(), asOf.UTC()}, true, true
	}
	return unusable()
}

// ageSpan is the range of birth dates of someone whose age was within band on
// day d. Aged exactly a on d means born after d - (a+1) years and on or before
// d - a years. An open group ends at the oldest age the taxonomy allows, so
// "60+" answers "60 to 120" -- the widest rule a Buyer can write.
func ageSpan(d time.Time, band clean.Band) span {
	if band.Open {
		band.Hi = clean.MaxAge
	}
	return span{lo: d.AddDate(-(band.Hi + 1), 0, 1), hi: d.AddDate(-band.Lo, 0, 0)}
}

// band reads an age group, using the Partner's answers first.
func (c cleaner) band(raw any) (b clean.Band, ignored, ok bool) {
	if answer, found := c.bands[clean.Normalize(clean.Text(raw))]; found {
		if answer == nil {
			return clean.Band{}, true, false
		}
		return *answer, false, true
	}
	b, ok = clean.ParseBand(raw)
	return b, false, ok
}

// maxBands caps the age groups kept per attribute. A column with more distinct
// groups than this is not a list of groups.
const maxBands = 30

// sortedBands lists age groups youngest first.
func sortedBands(seen map[clean.Band]bool) []string {
	list := make([]clean.Band, 0, len(seen))
	for b := range seen {
		list = append(list, b)
	}
	slices.SortFunc(list, func(x, y clean.Band) int {
		if x.Lo != y.Lo {
			return x.Lo - y.Lo
		}
		return x.Hi - y.Hi
	})
	out := make([]string, len(list))
	for i, b := range list {
		out[i] = b.String()
	}
	return out
}

// carryBands keeps the age groups a full read found, for a report whose read
// saw only changed customers.
func carryBands(rep *Report, prev *Report) {
	for key, ar := range rep.Attributes {
		if old, ok := prev.Attributes[key]; ok && len(ar.Bands) == 0 {
			ar.Bands = old.Bands
			rep.Attributes[key] = ar
		}
	}
}

// spanAge says whether a stored birth-date range belongs to someone who may be
// under 18. They are left out of the copy: possibly a child is a child, as far
// as advertising goes.
func spanUnderAge(s span, now time.Time) bool {
	hi, ok := s.hi.(time.Time)
	return ok && yearsBetween(hi, now) < standard.MinimumAge
}
