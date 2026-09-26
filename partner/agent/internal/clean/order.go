package clean

// OrderReport is what a sample of a date column says about how it is written.
type OrderReport struct {
	// DayFirst counts values that can only be day-first (14/04/1992).
	DayFirst int
	// MonthFirst counts values that can only be month-first (04/14/1992).
	MonthFirst int
	// Ambiguous counts numeric dates that read validly both ways (04/05/1992).
	Ambiguous int
	// Other counts values the order does not affect: year-first, written
	// months, Unix times, and native dates.
	Other int
	// Unreadable counts values that are not dates in any reading.
	Unreadable int
}

// Decision is the order to use, and whether a person needs to confirm it.
type Decision struct {
	Order Order
	// Confident is true when the data settles the order by itself.
	Confident bool
	// Note explains the decision in words the setup page can show.
	Note string
}

// DetectOrder looks at sample values from one column.
func DetectOrder(samples []any) OrderReport {
	var r OrderReport
	for _, s := range samples {
		var text string
		switch v := s.(type) {
		case string:
			text = v
		case []byte:
			text = string(v)
		default:
			if _, ok := parse(s, DateOptions{}); ok {
				r.Other++
			} else if s != nil {
				r.Unreadable++
			}
			continue
		}
		m := numeric.FindStringSubmatch(trim(text))
		if m == nil {
			if _, ok := fromString(text, DateOptions{}); ok {
				r.Other++
			} else if trim(text) != "" {
				r.Unreadable++
			}
			continue
		}
		a, b := atoi(m[1]), atoi(m[2])
		switch {
		case a > 12 && b <= 12:
			r.DayFirst++
		case b > 12 && a <= 12:
			r.MonthFirst++
		case a <= 12 && b <= 12:
			r.Ambiguous++
		default:
			r.Unreadable++
		}
	}
	return r
}

// Decide turns the evidence into an order.
//
// Evidence one way and none the other settles it. Evidence both ways means
// the column mixes systems; if one side is a handful against thousands it is
// taken as noise, otherwise a person has to decide. No evidence at all -- every
// numeric date has a day of 12 or less -- also needs a person; day-first is
// suggested because that is how dates are written in India.
func (r OrderReport) Decide() Decision {
	switch {
	case r.DayFirst+r.MonthFirst+r.Ambiguous == 0:
		return Decision{Order: DayFirst, Confident: true,
			Note: "dates are written year-first or with month names, so the order does not matter"}
	case r.DayFirst > 0 && r.MonthFirst == 0:
		return Decision{Order: DayFirst, Confident: true, Note: "day first, e.g. 14/04/1992"}
	case r.MonthFirst > 0 && r.DayFirst == 0:
		return Decision{Order: MonthFirst, Confident: true, Note: "month first, e.g. 04/14/1992"}
	case r.DayFirst >= 20*r.MonthFirst && r.MonthFirst > 0:
		return Decision{Order: DayFirst, Confident: false,
			Note: "mostly day first; a few values look month first and may be typos"}
	case r.MonthFirst >= 20*r.DayFirst && r.DayFirst > 0:
		return Decision{Order: MonthFirst, Confident: false,
			Note: "mostly month first; a few values look day first and may be typos"}
	case r.DayFirst > 0 && r.MonthFirst > 0:
		return Decision{Order: OrderUnknown, Confident: false,
			Note: "this column mixes day-first and month-first dates; only the unmistakable ones are used"}
	default:
		return Decision{Order: DayFirst, Confident: false,
			Note: "every date here reads both ways (like 04/05/1992); please confirm day first or month first"}
	}
}

func trim(s string) string {
	start, end := 0, len(s)
	for start < end && (s[start] == ' ' || s[start] == '\t') {
		start++
	}
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t') {
		end--
	}
	return s[start:end]
}
