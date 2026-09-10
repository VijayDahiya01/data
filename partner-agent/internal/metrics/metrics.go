// Package metrics aggregates what the Agent already knew but never counted.
//
// The decision path logs its duration and its reason on every call, which is
// perfect for reconstructing one decision and useless for answering "is this
// Partner serving?". A Partner running this inside their own infrastructure
// needs the second question answered, and they cannot get it from Oolix: the
// Agent is theirs, on their network, and Oolix deliberately cannot reach it.
//
// So the numbers are exposed here, for the Partner's own collector.
//
// WHAT IS DELIBERATELY NOT COUNTED. There is no per-user label anywhere. A
// counter keyed by customer would rebuild, inside the Partner's monitoring, the
// per-person record this whole architecture exists to avoid -- and monitoring
// data is copied to more places, and kept longer, than anyone plans for.
// Placement is also left out: it is unbounded in principle, and cardinality
// that grows with a Partner's catalogue turns a metrics endpoint into an
// outage of its own.
package metrics

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// Buckets in milliseconds, chosen around the §103 budget of 100ms.
//
// Tight at the bottom because a decision that is healthy is expected to take
// single-digit milliseconds, and the interesting question is not "how slow was
// the slowest" but "what fraction crossed the budget".
var buckets = []float64{1, 2, 5, 10, 25, 50, 100, 250, 500, 1000}

// Recorder is safe for concurrent use: every ad decision goes through it.
type Recorder struct {
	mu sync.Mutex

	decisions map[string]uint64 // "SHOW|" or "NO_AD|FREQUENCY_CAPPED"
	counts    []uint64          // per bucket, cumulative computed at render
	overflow  uint64            // slower than the last bucket
	sumMillis float64
	total     uint64
	breaches  uint64

	syncFailures uint64
	lastSyncOK   time.Time
	started      time.Time
}

func New() *Recorder {
	return &Recorder{
		decisions: make(map[string]uint64),
		counts:    make([]uint64, len(buckets)),
		started:   time.Now(),
	}
}

// ObserveDecision records one ad decision and how long it took.
func (r *Recorder) ObserveDecision(decision, reason string, took time.Duration) {
	ms := float64(took.Nanoseconds()) / 1e6

	r.mu.Lock()
	defer r.mu.Unlock()

	r.decisions[decision+"|"+reason]++
	r.total++
	r.sumMillis += ms

	placed := false
	for i, b := range buckets {
		if ms <= b {
			r.counts[i]++
			placed = true
			break
		}
	}
	if !placed {
		r.overflow++
	}
	if ms > 100 {
		r.breaches++
	}
}

// ObserveControlSync records the outcome of a control-plane check-in.
func (r *Recorder) ObserveControlSync(ok bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if ok {
		r.lastSyncOK = time.Now()
		return
	}
	r.syncFailures++
}

// Render produces Prometheus text exposition.
func (r *Recorder) Render() string {
	r.mu.Lock()
	defer r.mu.Unlock()

	var b strings.Builder

	b.WriteString("# HELP oolix_agent_ad_decisions_total Ad decisions by outcome and reason.\n")
	b.WriteString("# TYPE oolix_agent_ad_decisions_total counter\n")
	keys := make([]string, 0, len(r.decisions))
	for k := range r.decisions {
		keys = append(keys, k)
	}
	// Sorted so a diff between two scrapes is readable by a human.
	sort.Strings(keys)
	for _, k := range keys {
		parts := strings.SplitN(k, "|", 2)
		fmt.Fprintf(&b, "oolix_agent_ad_decisions_total{decision=%q,reason=%q} %d\n",
			parts[0], parts[1], r.decisions[k])
	}

	b.WriteString("# HELP oolix_agent_ad_decision_duration_ms How long a decision took (§103 budget: 100ms).\n")
	b.WriteString("# TYPE oolix_agent_ad_decision_duration_ms histogram\n")
	var cumulative uint64
	for i, bound := range buckets {
		cumulative += r.counts[i]
		fmt.Fprintf(&b, "oolix_agent_ad_decision_duration_ms_bucket{le=\"%g\"} %d\n", bound, cumulative)
	}
	fmt.Fprintf(&b, "oolix_agent_ad_decision_duration_ms_bucket{le=\"+Inf\"} %d\n", cumulative+r.overflow)
	fmt.Fprintf(&b, "oolix_agent_ad_decision_duration_ms_sum %g\n", r.sumMillis)
	fmt.Fprintf(&b, "oolix_agent_ad_decision_duration_ms_count %d\n", r.total)

	b.WriteString("# HELP oolix_agent_decision_budget_breaches_total Decisions slower than the 100ms budget.\n")
	b.WriteString("# TYPE oolix_agent_decision_budget_breaches_total counter\n")
	fmt.Fprintf(&b, "oolix_agent_decision_budget_breaches_total %d\n", r.breaches)

	b.WriteString("# HELP oolix_agent_control_sync_failures_total Failed check-ins with the Oolix control plane.\n")
	b.WriteString("# TYPE oolix_agent_control_sync_failures_total counter\n")
	fmt.Fprintf(&b, "oolix_agent_control_sync_failures_total %d\n", r.syncFailures)

	b.WriteString("# HELP oolix_agent_last_control_sync_age_seconds Seconds since the last successful check-in.\n")
	b.WriteString("# TYPE oolix_agent_last_control_sync_age_seconds gauge\n")
	if r.lastSyncOK.IsZero() {
		// -1, not 0: never having synced is a different condition from having
		// synced a moment ago, and zero would read as perfectly healthy.
		b.WriteString("oolix_agent_last_control_sync_age_seconds -1\n")
	} else {
		fmt.Fprintf(&b, "oolix_agent_last_control_sync_age_seconds %d\n",
			int(time.Since(r.lastSyncOK).Seconds()))
	}

	b.WriteString("# HELP oolix_agent_uptime_seconds Seconds since this Agent process started.\n")
	b.WriteString("# TYPE oolix_agent_uptime_seconds gauge\n")
	fmt.Fprintf(&b, "oolix_agent_uptime_seconds %d\n", int(time.Since(r.started).Seconds()))

	return b.String()
}
