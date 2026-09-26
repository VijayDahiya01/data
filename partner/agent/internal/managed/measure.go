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

// Measure cleans a column's sample values under a mapping.
func Measure(a standard.Attribute, am AttributeMapping, loc string, values []any, now time.Time) (Measurement, error) {
	l := location(loc)
	c, err := newCleaner(a, am, l)
	if err != nil {
		return Measurement{}, err
	}
	var out Measurement
	misses := map[string]int{}
	shown := map[string]bool{}
	for _, raw := range values {
		v, present, ok := c.value(raw, now)
		if !present {
			continue
		}
		out.Sampled++
		text := strings.TrimSpace(clean.Text(raw))
		if !ok {
			if a.Kind == standard.KindEnum {
				misses[text]++
			}
			continue
		}
		out.Readable++
		if d, isTime := v.(time.Time); isTime && a.Kind == standard.KindDate && yearsBetween(d, now) < standard.MinimumAge {
			out.UnderAge++
		}
		key := clean.Normalize(text)
		if a.Kind == standard.KindDate || a.Kind == standard.KindTimestamp {
			key = shape(text)
		}
		if len(out.Examples) < 4 && !shown[key] {
			shown[key] = true
			out.Examples = append(out.Examples, Example{Raw: text, Clean: Display(a, v, l, now)})
		}
	}
	out.Unrecognised = top(misses, 10)
	return out, nil
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
