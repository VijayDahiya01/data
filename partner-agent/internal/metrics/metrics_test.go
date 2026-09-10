package metrics

import (
	"strings"
	"testing"
	"time"
)

// The exposition has to be parseable and the histogram has to be cumulative.
// Prometheus rejects a malformed scrape whole, so one bad line silences every
// alert built on it -- including the ones that would have reported the outage.

func TestHistogramBucketsAreCumulative(t *testing.T) {
	r := New()
	r.ObserveDecision("SHOW", "", 3*time.Millisecond)
	r.ObserveDecision("SHOW", "", 40*time.Millisecond)
	r.ObserveDecision("NO_AD", "FREQUENCY_CAPPED", 400*time.Millisecond)
	r.ObserveDecision("SHOW", "", 5*time.Second)

	out := r.Render()

	// A cumulative bucket must never be smaller than a tighter one.
	var last int
	for _, want := range []string{`le="5"`, `le="50"`, `le="500"`, `le="+Inf"`} {
		v := valueOfLine(t, out, want)
		if v < last {
			t.Errorf("bucket %s went backwards: %d after %d\n%s", want, v, last, out)
		}
		last = v
	}
	if got := valueOfLine(t, out, `le="+Inf"`); got != 4 {
		t.Errorf("+Inf bucket should hold every observation, got %d", got)
	}
	if !strings.Contains(out, "oolix_agent_ad_decision_duration_ms_count 4") {
		t.Errorf("count missing or wrong:\n%s", out)
	}
}

func TestBudgetBreachesAreCountedSeparately(t *testing.T) {
	r := New()
	r.ObserveDecision("SHOW", "", 99*time.Millisecond)  // inside §103
	r.ObserveDecision("SHOW", "", 101*time.Millisecond) // outside
	out := r.Render()

	if !strings.Contains(out, "oolix_agent_decision_budget_breaches_total 1") {
		t.Errorf("expected exactly one breach:\n%s", out)
	}
}

func TestNeverHavingSyncedIsNotReportedAsHealthy(t *testing.T) {
	// Zero would read as "synced a moment ago" on every dashboard, which is
	// the opposite of the truth for an Agent that has never reached Oolix.
	out := New().Render()
	if !strings.Contains(out, "oolix_agent_last_control_sync_age_seconds -1") {
		t.Errorf("expected -1 for a never-synced agent:\n%s", out)
	}

	r := New()
	r.ObserveControlSync(true)
	if strings.Contains(r.Render(), "age_seconds -1") {
		t.Error("a successful sync should replace the sentinel")
	}
}

func TestNoLabelCanCarryAPerson(t *testing.T) {
	// The reason string is the only free-ish text that reaches a label, and it
	// comes from a fixed enum. This asserts the shape stays that way: a label
	// is the easiest place for an identifier to end up, and monitoring data is
	// copied further and kept longer than anyone intends.
	r := New()
	r.ObserveDecision("NO_AD", "USER_NOT_IN_SEGMENT", time.Millisecond)
	out := r.Render()

	for _, forbidden := range []string{"partner_user_id", "user_id=", "customer", "email"} {
		if strings.Contains(strings.ToLower(out), forbidden) {
			t.Errorf("exposition contains %q:\n%s", forbidden, out)
		}
	}
}

func TestEveryMetricIsDeclared(t *testing.T) {
	r := New()
	r.ObserveDecision("SHOW", "", time.Millisecond)
	r.ObserveControlSync(false)

	declared := map[string]bool{}
	for _, line := range strings.Split(r.Render(), "\n") {
		if strings.HasPrefix(line, "# TYPE ") {
			declared[strings.Fields(line)[2]] = true
		}
	}
	for _, line := range strings.Split(r.Render(), "\n") {
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		name := line
		if i := strings.IndexAny(name, "{ "); i >= 0 {
			name = name[:i]
		}
		// Histogram series carry suffixes the TYPE line does not repeat.
		base := strings.TrimSuffix(strings.TrimSuffix(strings.TrimSuffix(
			name, "_bucket"), "_sum"), "_count")
		if !declared[base] {
			t.Errorf("metric %q was emitted without a TYPE declaration", name)
		}
	}
}

func valueOfLine(t *testing.T, out, contains string) int {
	t.Helper()
	for _, line := range strings.Split(out, "\n") {
		if strings.Contains(line, contains) {
			fields := strings.Fields(line)
			n := 0
			for _, c := range fields[len(fields)-1] {
				if c < '0' || c > '9' {
					t.Fatalf("non-numeric value in %q", line)
				}
				n = n*10 + int(c-'0')
			}
			return n
		}
	}
	t.Fatalf("no line containing %q in:\n%s", contains, out)
	return 0
}
