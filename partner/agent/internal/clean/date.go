// Package clean turns the values a Partner's database actually holds into the
// standard form the Agent's local copy stores.
//
// Real customer tables are inconsistent: one column may hold `14/04/1992`,
// `14-04-1993`, `1992-04-14T18:30:00Z` and a Unix timestamp side by side,
// because three systems wrote to it over the years. Nothing here asks the
// Partner to fix that. Each value is read on its own, anything that cannot be
// read with confidence becomes empty, and the setup page reports how much was
// readable -- an empty value just means that customer does not match rules on
// that attribute.
package clean

import (
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Order is how a numeric date like 04/05/1992 is read.
type Order int

const (
	// OrderUnknown reads only values that cannot be misread: those with a day
	// above 12, and every year-first or written-month form.
	OrderUnknown Order = iota
	// DayFirst reads 04/05/1992 as 4 May, the usual way in India.
	DayFirst
	// MonthFirst reads 04/05/1992 as 5 April.
	MonthFirst
)

// India has one time zone and no daylight saving, so a fixed zone is exact --
// and it needs no time zone database, which the Agent's minimal image lacks.
var India = time.FixedZone("IST", 5*3600+30*60)

// DateOptions says how to read ambiguous values.
type DateOptions struct {
	// Order resolves dates whose day and month are both 12 or less.
	Order Order
	// Location is the wall clock of values that carry no zone, and the zone a
	// moment is turned into a calendar date in. Defaults to India.
	Location *time.Location
}

func (o DateOptions) loc() *time.Location {
	if o.Location == nil {
		return India
	}
	return o.Location
}

// ParseDate reads a calendar date, such as a date of birth. The result is
// midnight UTC on that date, so it compares and stores as a plain date.
//
// A moment with a zone is turned into a date in the configured location
// first. A birth date saved as `1992-04-13T18:30:00Z` is midnight on 14 April
// in India; read naively in UTC it is the 13th -- a whole day early.
func ParseDate(raw any, opts DateOptions) (time.Time, bool) {
	t, ok := parse(raw, opts)
	if !ok {
		return time.Time{}, false
	}
	y, m, d := t.In(opts.loc()).Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC), true
}

// ParseTimestamp reads a moment, such as a last order. A value without a zone
// is taken as wall-clock time in the configured location.
func ParseTimestamp(raw any, opts DateOptions) (time.Time, bool) {
	t, ok := parse(raw, opts)
	if !ok {
		return time.Time{}, false
	}
	return t.UTC(), true
}

var (
	// 2024-05-01, 2024/5/1, 2024.05.01, optionally with a time and zone.
	yearFirst = regexp.MustCompile(
		`^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?\s*(Z|[+-]\d{2}:?\d{2}|[+-]\d{2}|UTC|GMT)?)?$`)
	// 14/04/1992, 4-5-92, 14.04.1992, optionally with a time.
	numeric = regexp.MustCompile(
		`^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{4}|\d{2})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$`)
	// 14 Apr 1992, 14-April-92, 14th April, 1992
	dayMonthName = regexp.MustCompile(
		`^(\d{1,2})(?:st|nd|rd|th)?[\s\-/.,]+([A-Za-z]{3,9})\.?[\s\-/.,]+(\d{4}|\d{2})$`)
	// April 14, 1992 / Apr 14 1992
	monthNameDay = regexp.MustCompile(
		`^([A-Za-z]{3,9})\.?[\s\-/.,]+(\d{1,2})(?:st|nd|rd|th)?[\s\-/.,]+(\d{4}|\d{2})$`)
	digitsOnly = regexp.MustCompile(`^\d+$`)
)

var months = map[string]time.Month{
	"jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3,
	"apr": 4, "april": 4, "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7,
	"aug": 8, "august": 8, "sep": 9, "sept": 9, "september": 9, "oct": 10, "october": 10,
	"nov": 11, "november": 11, "dec": 12, "december": 12,
}

func parse(raw any, opts DateOptions) (time.Time, bool) {
	switch v := raw.(type) {
	case nil:
		return time.Time{}, false
	case time.Time:
		if v.IsZero() {
			return time.Time{}, false
		}
		return plausible(v)
	case *time.Time:
		if v == nil {
			return time.Time{}, false
		}
		return parse(*v, opts)
	case int:
		return fromInteger(int64(v), opts)
	case int32:
		return fromInteger(int64(v), opts)
	case int64:
		return fromInteger(v, opts)
	case float64:
		if math.IsInf(v, 0) || math.IsNaN(v) {
			return time.Time{}, false
		}
		// A fraction only makes sense on a Unix time (fractions of a second);
		// on anything smaller it is not a date at all.
		if v != math.Trunc(v) && math.Abs(v) < 1e8 {
			return time.Time{}, false
		}
		return fromInteger(int64(v), opts)
	case []byte:
		return fromString(string(v), opts)
	case string:
		return fromString(v, opts)
	default:
		return time.Time{}, false
	}
}

func fromString(s string, opts DateOptions) (time.Time, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, false
	}
	loc := opts.loc()

	if digitsOnly.MatchString(s) {
		n, err := strconv.ParseInt(s, 10, 64)
		if err != nil {
			return time.Time{}, false
		}
		if len(s) == 8 {
			// 19920414, or 14041992 read by the column's order.
			if t, ok := build(atoi(s[0:4]), atoi(s[4:6]), atoi(s[6:8]), 0, 0, 0, loc); ok {
				return t, true
			}
			return dayMonth(atoi(s[0:2]), atoi(s[2:4]), atoi(s[4:8]), 0, 0, 0, opts)
		}
		return fromInteger(n, opts)
	}

	if m := yearFirst.FindStringSubmatch(s); m != nil {
		hh, mm, ss := atoi(m[4]), atoi(m[5]), atoi(m[6])
		zone := loc
		if m[8] != "" {
			z, ok := parseZone(m[8])
			if !ok {
				return time.Time{}, false
			}
			zone = z
		}
		t, ok := build(atoi(m[1]), atoi(m[2]), atoi(m[3]), hh, mm, ss, zone)
		if !ok {
			return time.Time{}, false
		}
		return plausible(t)
	}

	if m := numeric.FindStringSubmatch(s); m != nil {
		hh, mm, ss := atoi(m[4]), atoi(m[5]), atoi(m[6])
		switch strings.ToLower(m[7]) {
		case "pm":
			if hh < 12 {
				hh += 12
			}
		case "am":
			if hh == 12 {
				hh = 0
			}
		}
		return dayMonth(atoi(m[1]), atoi(m[2]), fullYear(m[3]), hh, mm, ss, opts)
	}

	if m := dayMonthName.FindStringSubmatch(s); m != nil {
		month, ok := months[strings.ToLower(m[2])]
		if !ok {
			return time.Time{}, false
		}
		return build(fullYear(m[3]), int(month), atoi(m[1]), 0, 0, 0, loc)
	}
	if m := monthNameDay.FindStringSubmatch(s); m != nil {
		month, ok := months[strings.ToLower(m[1])]
		if !ok {
			return time.Time{}, false
		}
		return build(fullYear(m[3]), int(month), atoi(m[2]), 0, 0, 0, loc)
	}
	return time.Time{}, false
}

// dayMonth reads a numeric date whose first two parts are a day and a month
// in an order the value itself may or may not reveal.
func dayMonth(a, b, year, hh, mm, ss int, opts DateOptions) (time.Time, bool) {
	var day, month int
	switch {
	case a > 12 && b <= 12:
		// Only one reading exists: 14/04 cannot be the 4th of month 14.
		day, month = a, b
	case b > 12 && a <= 12:
		day, month = b, a
	case a <= 12 && b <= 12:
		switch opts.Order {
		case DayFirst:
			day, month = a, b
		case MonthFirst:
			day, month = b, a
		default:
			// Both readings are real dates; guessing would store the wrong
			// birthday for up to a third of the table without anyone noticing.
			if a != b {
				return time.Time{}, false
			}
			day, month = a, b
		}
	default:
		return time.Time{}, false
	}
	return build(year, month, day, hh, mm, ss, opts.loc())
}

// fromInteger reads a number: YYYYMMDD, Unix seconds or Unix milliseconds.
// Birthdays before 1970 are negative Unix times, so both signs are read.
func fromInteger(n int64, opts DateOptions) (time.Time, bool) {
	abs := n
	if abs < 0 {
		abs = -abs
	}
	switch {
	case n >= 19000101 && n <= 21001231:
		return build(int(n/10000), int(n/100%100), int(n%100), 0, 0, 0, opts.loc())
	case abs >= 1e8 && abs < 1e11:
		return plausible(time.Unix(n, 0))
	case abs >= 1e11 && abs < 1e14:
		return plausible(time.UnixMilli(n))
	default:
		return time.Time{}, false
	}
}

// build makes a time only from a real calendar date: 31/02 is refused rather
// than quietly rolled over into March.
func build(y, mo, d, hh, mm, ss int, loc *time.Location) (time.Time, bool) {
	if mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mm > 59 || ss > 60 {
		return time.Time{}, false
	}
	t := time.Date(y, time.Month(mo), d, hh, mm, ss, 0, loc)
	if t.Year() != y || int(t.Month()) != mo || t.Day() != d {
		return time.Time{}, false
	}
	return plausible(t)
}

// plausible refuses years no customer record means: before 1900, or so far
// ahead that it can only be a typo or a placeholder like 9999-12-31.
func plausible(t time.Time) (time.Time, bool) {
	if t.Year() < 1900 || t.Year() > 2100 {
		return time.Time{}, false
	}
	return t, true
}

// fullYear widens a two-digit year the way people write them: 92 is 1992, 05
// is 2005 -- anything not after this year's last two digits is this century.
func fullYear(s string) int {
	y := atoi(s)
	if len(s) != 2 {
		return y
	}
	if y > time.Now().Year()%100 {
		return 1900 + y
	}
	return 2000 + y
}

func parseZone(z string) (*time.Location, bool) {
	switch strings.ToUpper(z) {
	case "Z", "UTC", "GMT":
		return time.UTC, true
	}
	sign := 1
	if z[0] == '-' {
		sign = -1
	}
	digits := strings.ReplaceAll(z[1:], ":", "")
	if len(digits) == 2 {
		digits += "00"
	}
	if len(digits) != 4 {
		return nil, false
	}
	h, m := atoi(digits[:2]), atoi(digits[2:])
	if h > 14 || m > 59 {
		return nil, false
	}
	return time.FixedZone("", sign*(h*3600+m*60)), true
}

func atoi(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}
