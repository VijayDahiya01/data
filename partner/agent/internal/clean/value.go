package clean

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

// Text renders any source value as a string, for matching and display.
func Text(raw any) string {
	switch v := raw.(type) {
	case nil:
		return ""
	case string:
		return v
	case []byte:
		return string(v)
	case time.Time:
		return v.Format(time.RFC3339)
	case float64:
		if v == math.Trunc(v) && math.Abs(v) < 1e15 {
			return strconv.FormatInt(int64(v), 10)
		}
		return strconv.FormatFloat(v, 'f', -1, 64)
	default:
		return fmt.Sprint(v)
	}
}

var (
	truthy = map[string]bool{"1": true, "y": true, "yes": true, "true": true, "t": true, "on": true}
	falsy  = map[string]bool{"0": true, "n": true, "no": true, "false": true, "f": true, "off": true}
)

// ParseBool reads yes/no in the forms databases actually use: booleans, 1/0,
// Y/N, yes/no, true/false. Anything else is unknown rather than false.
func ParseBool(raw any) (value bool, ok bool) {
	switch v := raw.(type) {
	case bool:
		return v, true
	case int, int32, int64, float64:
		n, _ := ParseNumber(v)
		if n == 1 {
			return true, true
		}
		if n == 0 {
			return false, true
		}
		return false, false
	}
	s := Normalize(Text(raw))
	switch {
	case truthy[s]:
		return true, true
	case falsy[s]:
		return false, true
	default:
		return false, false
	}
}

// ParseNumber reads a count such as orders in 90 days. Thousands separators
// are allowed ("1,204"); anything that is not a plain number is unknown.
func ParseNumber(raw any) (float64, bool) {
	switch v := raw.(type) {
	case int:
		return float64(v), true
	case int32:
		return float64(v), true
	case int64:
		return float64(v), true
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return 0, false
		}
		return v, true
	case float32:
		return ParseNumber(float64(v))
	}
	s := strings.ReplaceAll(strings.TrimSpace(Text(raw)), ",", "")
	if s == "" {
		return 0, false
	}
	n, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsNaN(n) || math.IsInf(n, 0) {
		return 0, false
	}
	return n, true
}
