package addecision

import (
	"errors"
	"strconv"
	"strings"
	"time"
)

// ParseISODuration parses the subset of ISO-8601 durations frequency caps use
// (spec v5 §67.2, which uses "P1D").
//
// Deliberately narrow: it accepts days, hours, minutes and seconds only.
// Months and years are rejected rather than approximated, because a cap of
// "P1M" enforced as 30 days would silently break a Partner's stated promise --
// and a frequency cap is a promise about how often a real person is shown an
// ad.
//
// Kept in lockstep with durationToSeconds in @oolix/contracts.
func ParseISODuration(s string) (time.Duration, error) {
	if len(s) < 2 || s[0] != 'P' {
		return 0, errors.New("unsupported duration: " + s)
	}

	rest := s[1:]
	var total time.Duration

	datePart, timePart, hasTime := strings.Cut(rest, "T")

	if datePart != "" {
		n, unit, err := splitNumUnit(datePart)
		if err != nil || unit != 'D' {
			// Weeks, months and years are not representable without a calendar.
			return 0, errors.New("unsupported duration component in: " + s)
		}
		total += time.Duration(n) * 24 * time.Hour
	}

	if hasTime {
		for timePart != "" {
			n, unit, err := splitNumUnit(timePart)
			if err != nil {
				return 0, errors.New("unsupported duration: " + s)
			}
			switch unit {
			case 'H':
				total += time.Duration(n) * time.Hour
			case 'M':
				total += time.Duration(n) * time.Minute
			case 'S':
				total += time.Duration(n) * time.Second
			default:
				return 0, errors.New("unsupported duration unit in: " + s)
			}
			idx := strings.IndexByte(timePart, unit)
			timePart = timePart[idx+1:]
		}
	}

	if total <= 0 {
		// A zero window would make a cap meaningless: every request would see
		// an empty window and serve.
		return 0, errors.New("duration must be positive: " + s)
	}
	return total, nil
}

func splitNumUnit(s string) (int, byte, error) {
	i := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	if i == 0 || i >= len(s) {
		return 0, 0, errors.New("malformed component")
	}
	n, err := strconv.Atoi(s[:i])
	if err != nil {
		return 0, 0, err
	}
	return n, s[i], nil
}
