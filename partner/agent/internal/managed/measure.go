package managed

import (
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/oolix/partner-agent/internal/clean"
	"github.com/oolix/partner-agent/internal/detect"
	"github.com/oolix/partner-agent/internal/source"
	"github.com/oolix/partner-agent/internal/standard"
)

// Example is one sample value before and after cleaning.
type Example struct {
	Raw   string
	Clean string
}

// Measurement is how a column fares under a mapping, measured on a sample
// exactly the way a sync would clean it -- so the setup page's numbers are the
// sync's numbers.
type Measurement struct {
	// Sampled counts non-empty values; Readable, those that cleaned.
	Sampled, Readable int
	// UnderAge counts birth dates of customers under 18, who are left out.
	UnderAge int
	// Examples show values in as many different formats as the sample has.
	Examples []Example
	// Unrecognised are list values that matched no code, most common first.
	Unrecognised []detect.ValueCount
}

// Percent is the readable share of non-empty values.
func (m Measurement) Percent() int {
	if m.Sampled == 0 {
		return 0
	}
	return int(float64(m.Readable) / float64(m.Sampled) * 100)
}

// Measure cleans a column's sample values under a mapping. The sample holds
// every sampled column, because some forms read a second one: the date an age
// was true on.
func Measure(a standard.Attribute, am AttributeMapping, loc string, sample map[string][]any, now time.Time) (Measurement, error) {
	l := location(loc)
	c, err := newCleaner(a, am, l)
	if err != nil {
		return Measurement{}, err
	}
	var out Measurement
	misses := map[string]int{}
	shown := map[string]bool{}
	for _, row := range Rows(sample) {
		raw := row[am.Column]
		asOf := c.asOf(row, now)
		v, present, ok := c.value(raw, asOf, now)
		if !present {
			continue
		}
		out.Sampled++
		text := strings.TrimSpace(clean.Text(raw))
		if !ok {
			if a.Kind == standard.KindEnum || am.Form == standard.FormAgeBand {
				misses[text]++
			}
			continue
		}
		out.Readable++
		s, isSpan := v.(span)
		if isSpan && a.Key == "age" && spanUnderAge(s, now) {
			out.UnderAge++
		}
		key := clean.Normalize(text)
		if am.Form == standard.FormNative && (a.Kind == standard.KindDate || a.Kind == standard.KindTimestamp) {
			key = shape(text)
		}
		if len(out.Examples) < 4 && !shown[key] {
			shown[key] = true
			cleaned := Display(a, v, l, now)
			if isSpan {
				cleaned = describe(a, am, s, asOf, l, now)
			}
			out.Examples = append(out.Examples, Example{Raw: text, Clean: cleaned})
		}
	}
	out.Unrecognised = top(misses, 10)
	return out, nil
}

// describe renders a range the way the setup page shows it: what the value
// says, and what it means today.
func describe(a standard.Attribute, am AttributeMapping, s span, asOf time.Time, loc *time.Location, now time.Time) string {
	on := ""
	if am.Form.NeedsAsOf() && am.AsOf != AsOfRefresh {
		on = " on " + asOf.In(loc).Format("2 Jan 2006")
	}
	lo, hasLo := s.lo.(time.Time)
	hi, hasHi := s.hi.(time.Time)
	switch a.Kind {
	case standard.KindDate:
		ages := ageWords(lo, hasLo, hi, now)
		switch am.Form {
		case standard.FormBirthYear:
			return fmt.Sprintf("born in %d (%s)", hi.Year(), ages)
		case standard.FormAge, standard.FormAgeBand:
			if on == "" {
				return ages
			}
			then := ageWords(lo, hasLo, hi, asOf)
			return fmt.Sprintf("%s%s (now %s)", then, on, strings.TrimPrefix(ages, "age "))
		}
		return fmt.Sprintf("%s (age %d)", hi.Format("2 Jan 2006"), yearsBetween(hi, now))
	case standard.KindTimestamp:
		switch am.Form {
		case standard.FormWithinDays:
			if !hasHi {
				return fmt.Sprintf("not in the %d days before%s", am.Days, orToday(on))
			}
			return fmt.Sprintf("in the %d days before%s", am.Days, orToday(on))
		case standard.FormDaysSince:
			return fmt.Sprintf("about %s (%s)", hi.In(loc).Format("2 Jan 2006"), daysAgo(hi, now))
		}
		return fmt.Sprintf("%s (%s)", hi.In(loc).Format("2 Jan 2006, 15:04"), daysAgo(hi, now))
	case standard.KindNumber:
		w := am.window()
		switch {
		case s.lo != nil && s.hi != nil:
			return fmt.Sprint(s.lo)
		case s.lo != nil:
			return fmt.Sprintf("%v in %d days: at least %v in %d", s.lo, w, s.lo, standard.FrequencyDays)
		default:
			return fmt.Sprintf("%v in %d days: at most %v in %d", s.hi, w, s.hi, standard.FrequencyDays)
		}
	}
	return fmt.Sprint(s.lo, " to ", s.hi)
}

// ageWords is the age range of birth dates lo..hi on a day: "age 25",
// "age 25 to 45", "age 60 or older".
func ageWords(lo time.Time, hasLo bool, hi time.Time, on time.Time) string {
	youngest := yearsBetween(hi, on)
	if !hasLo || yearsBetween(lo, on) >= clean.MaxAge {
		return fmt.Sprintf("age %d or older", youngest)
	}
	if oldest := yearsBetween(lo, on); oldest != youngest {
		return fmt.Sprintf("age %d to %d", youngest, oldest)
	}
	return fmt.Sprintf("age %d", youngest)
}

func orToday(on string) string {
	if on == "" {
		return " today"
	}
	return on
}

func daysAgo(t, now time.Time) string {
	switch n := int(now.Sub(t).Hours() / 24); n {
	case 0:
		return "today"
	case 1:
		return "yesterday"
	default:
		return fmt.Sprintf("%d days ago", n)
	}
}

// shape reduces a value to its format, so "14/04/1992" and "01/12/1985" count
// as one example and "1992-04-14" as another.
func shape(s string) string {
	var b strings.Builder
	var last rune
	for _, r := range s {
		k := r
		switch {
		case unicode.IsDigit(r):
			k = '9'
		case unicode.IsLetter(r):
			k = 'a'
		}
		if k != last || (k != '9' && k != 'a') {
			b.WriteRune(k)
		}
		last = k
	}
	return b.String()
}

// Display renders a cleaned value the way the setup page shows it.
func Display(a standard.Attribute, v any, loc *time.Location, now time.Time) string {
	switch x := v.(type) {
	case time.Time:
		if a.Kind == standard.KindDate {
			return fmt.Sprintf("%s (age %d)", x.UTC().Format("2 Jan 2006"), yearsBetween(x, now))
		}
		ago := fmt.Sprintf("%d days ago", int(now.Sub(x).Hours()/24))
		switch int(now.Sub(x).Hours() / 24) {
		case 0:
			ago = "today"
		case 1:
			ago = "yesterday"
		}
		return fmt.Sprintf("%s (%s)", x.In(loc).Format("2 Jan 2006, 15:04"), ago)
	case bool:
		if x {
			return "Yes"
		}
		return "No"
	case int32:
		return strconv.Itoa(int(x))
	case string:
		return x
	}
	return fmt.Sprint(v)
}

// ConsentMeasurement is how a sample answers the consent question.
type ConsentMeasurement struct {
	Rows, Agreed, Declined, Withdrawn int
}

// MeasureConsent reads consent for each sampled row the way a sync would.
func MeasureConsent(c ConsentMapping, loc string, sample map[string][]any, now time.Time) ConsentMeasurement {
	var out ConsentMeasurement
	for _, row := range Rows(sample) {
		out.Rows++
		eligible, withdrawn := consentOf(row, c, location(loc), now)
		switch {
		case withdrawn != nil:
			out.Withdrawn++
		case eligible:
			out.Agreed++
		default:
			out.Declined++
		}
	}
	return out
}

// Rows turns a column-wise sample back into rows.
func Rows(sample map[string][]any) []source.Row {
	n := 0
	for _, vs := range sample {
		n = max(n, len(vs))
	}
	rows := make([]source.Row, n)
	for i := range rows {
		rows[i] = source.Row{}
	}
	for col, vs := range sample {
		for i, v := range vs {
			rows[i][col] = v
		}
	}
	return rows
}
