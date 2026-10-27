package clean

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

// Band is a range of whole numbers, both ends included: an age group such as
// 25-45. Open is true when there is no upper end ("60+").
type Band struct {
	Lo, Hi int
	Open   bool
}

// MaxAge is the oldest age a band or an age may state.
const MaxAge = 120

// The shapes age groups are written in. Each is tried on the normalised
// text: lower-case, with "yrs", "years" and similar words removed.
var (
	bandSingle = regexp.MustCompile(`^\d{1,3}$`)
	bandRange  = regexp.MustCompile(`^(?:between\s*)?(\d{1,3})\s*(?:-|–|—|to|and|_|~)\s*(\d{1,3})$`)
	bandPlus   = regexp.MustCompile(`^(\d{1,3})\s*(?:\+|plus|and above|& above|and over|& over|or more|or older|and older)$`)
	bandAbove  = regexp.MustCompile(`^(?:above|over|older than|more than|>=|≥|>)\s*(\d{1,3})$`)
	bandBelow  = regexp.MustCompile(`^(?:under|below|less than|younger than|upto|up to|<=|≤|<)\s*(\d{1,3})$`)
	unitWords  = regexp.MustCompile(`\b(?:years? old|yrs? old|years?|yrs?|y\.?o\.?|age[sd]?|aged)\b`)
	spaces     = regexp.MustCompile(`\s+`)
)

// ParseBand reads an age group in the forms Partners write them: "25-45",
// "25 to 45", "25–45 yrs", "between 25 and 45", "60+", "60 and above",
// "above 60", "under 25", or a single age. ">60" means 61 and older, "<25"
// means up to 24.
//
// Words are read wide: "above 60" as 60 and older, "under 25" as up to 25,
// because people use them both ways. A group read too wide only leaves a
// customer out of rules it cannot answer for certain; one read too narrow
// would put a 60-year-old in a "61 to 70" audience.
//
// Anything else -- words such as "senior" -- is unknown, for the Partner to
// answer once.
func ParseBand(raw any) (Band, bool) {
	s := strings.ToLower(strings.TrimSpace(Text(raw)))
	s = unitWords.ReplaceAllString(s, " ")
	s = strings.TrimSpace(spaces.ReplaceAllString(s, " "))
	s = strings.TrimSuffix(strings.TrimPrefix(s, "("), ")")
	if s == "" {
		return Band{}, false
	}
	var b Band
	switch {
	case bandSingle.MatchString(s):
		// One age is a group of one: a column of groups may hold some.
		b = Band{Lo: atoi(s), Hi: atoi(s)}
	case bandRange.MatchString(s):
		m := bandRange.FindStringSubmatch(s)
		b = Band{Lo: atoi(m[1]), Hi: atoi(m[2])}
	case bandPlus.MatchString(s):
		b = Band{Lo: atoi(bandPlus.FindStringSubmatch(s)[1]), Open: true}
	case bandAbove.MatchString(s):
		m := bandAbove.FindStringSubmatch(s)
		b = Band{Lo: atoi(m[1]), Open: true}
		if strings.HasPrefix(s, ">") && !strings.HasPrefix(s, ">=") {
			// ">60" leaves 60 out. "Above 60" may or may not: see below.
			b.Lo++
		}
	case bandBelow.MatchString(s):
		m := bandBelow.FindStringSubmatch(s)
		b = Band{Lo: 0, Hi: atoi(m[1])}
		if strings.HasPrefix(s, "<") && !strings.HasPrefix(s, "<=") {
			// "<25" leaves 25 out.
			b.Hi--
		}
	default:
		return Band{}, false
	}
	if b.Lo < 0 || b.Lo > MaxAge || (!b.Open && (b.Hi < b.Lo || b.Hi > MaxAge)) {
		return Band{}, false
	}
	return b, true
}

// String writes a band the way ParseBand reads it back.
func (b Band) String() string {
	if b.Open {
		return strconv.Itoa(b.Lo) + "+"
	}
	if b.Lo == b.Hi {
		return strconv.Itoa(b.Lo)
	}
	return strconv.Itoa(b.Lo) + "-" + strconv.Itoa(b.Hi)
}

var quantity = regexp.MustCompile(`^(\d+(?:\.0+)?)\s*[a-z. ]*$`)

// ParseWhole reads a whole number, allowing a unit after it: 25, "25",
// "25 yrs", "12 days". A fraction is unknown rather than rounded: an age of
// 25.5 is not a whole number of years anyone writes.
func ParseWhole(raw any) (int, bool) {
	switch v := raw.(type) {
	case int, int32, int64, float32, float64:
		n, ok := ParseNumber(v)
		if !ok || n != math.Trunc(n) || n < 0 || n > math.MaxInt32 {
			return 0, false
		}
		return int(n), true
	}
	s := strings.ToLower(strings.TrimSpace(Text(raw)))
	m := quantity.FindStringSubmatch(s)
	if m == nil {
		return 0, false
	}
	f, err := strconv.ParseFloat(m[1], 64)
	if err != nil || f > math.MaxInt32 {
		return 0, false
	}
	return int(f), true
}
