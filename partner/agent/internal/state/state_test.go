package state

import (
	"context"
	"strings"
	"testing"
	"time"
)

// Frequency capping is a promise the PARTNER made to their own customer --
// §44 step 8, §76.1, §76.2. "You will not see this more than twice a day" is
// the Partner's word, enforced on the Partner's own infrastructure, and Oolix
// never learns who it was enforced for.
//
// So two things are being pinned here. That the cap actually holds, because
// exceeding it breaks the Partner's promise to a person. And that the customer
// identifier never becomes a stored key, because a store an operator can read
// out is a list of that Partner's customers.

func ctx() context.Context { return context.Background() }

func TestAnImpressionCountsTowardTheCap(t *testing.T) {
	s := NewEmbedded()
	const window = time.Hour

	n, err := s.FrequencyCount(ctx(), "act-1", "USER-A", window)
	if err != nil || n != 0 {
		t.Fatalf("a user who has seen nothing = %d, %v; want 0", n, err)
	}

	for i := 1; i <= 3; i++ {
		if err := s.RecordImpression(ctx(), "act-1", "USER-A", window); err != nil {
			t.Fatalf("record: %v", err)
		}
		got, _ := s.FrequencyCount(ctx(), "act-1", "USER-A", window)
		if got != i {
			t.Errorf("after %d impressions the count is %d", i, got)
		}
	}
}

func TestTheCapIsPerUserAndPerActivation(t *testing.T) {
	// A cap that leaked across users would silence a campaign for everyone
	// after the first person hit it. One that leaked across activations would
	// let one campaign consume another's budget of attention.
	s := NewEmbedded()
	const window = time.Hour

	for i := 0; i < 5; i++ {
		_ = s.RecordImpression(ctx(), "act-1", "USER-A", window)
	}

	if n, _ := s.FrequencyCount(ctx(), "act-1", "USER-B", window); n != 0 {
		t.Errorf("a different user shows %d impressions; want 0", n)
	}
	if n, _ := s.FrequencyCount(ctx(), "act-2", "USER-A", window); n != 0 {
		t.Errorf("the same user on a different activation shows %d; want 0", n)
	}
	if n, _ := s.FrequencyCount(ctx(), "act-1", "USER-A", window); n != 5 {
		t.Errorf("the original pair shows %d; want 5", n)
	}
}

func TestImpressionsOutsideTheWindowStopCounting(t *testing.T) {
	// A cap of "twice a day" has to forget yesterday, or a returning customer
	// is silently excluded for ever.
	//
	// Timed with a real elapsed interval rather than a nanosecond window.
	// time.Now() on Windows is coarse enough that two calls in quick
	// succession return the SAME instant, so a sub-millisecond window makes an
	// impression look like it is still inside it -- which says something about
	// the clock, not about the cap.
	s := NewEmbedded()

	_ = s.RecordImpression(ctx(), "act-1", "USER-A", time.Hour)
	if n, _ := s.FrequencyCount(ctx(), "act-1", "USER-A", time.Hour); n != 1 {
		t.Fatal("setup: the impression was not recorded")
	}

	time.Sleep(40 * time.Millisecond)

	if n, _ := s.FrequencyCount(ctx(), "act-1", "USER-A", 20*time.Millisecond); n != 0 {
		t.Errorf("an impression older than the window still counts (%d)", n)
	}
}

func TestAFreshImpressionStaysInsideTheWindow(t *testing.T) {
	// The other half, and the one that matters more: expiry must not be so
	// eager that the cap never accumulates and a customer sees the ad without
	// limit.
	s := NewEmbedded()

	for i := 0; i < 3; i++ {
		_ = s.RecordImpression(ctx(), "act-1", "USER-A", time.Hour)
	}
	time.Sleep(20 * time.Millisecond)

	if n, _ := s.FrequencyCount(ctx(), "act-1", "USER-A", time.Hour); n != 3 {
		t.Errorf("recent impressions inside an hour window count %d; want 3", n)
	}
}

func TestTheCustomerIdentifierIsNeverAStoredKey(t *testing.T) {
	// §78.1 forbids the raw id in anything log-like, and a store is worse than
	// a log: an operator reading it, or a memory dump, would enumerate the
	// Partner's customers.
	const raw = "CUSTOMER-12345-alice@example.com"

	h := hashUser("act-1", raw)
	if strings.Contains(h, raw) || strings.Contains(h, "alice") || strings.Contains(h, "12345") {
		t.Fatalf("the key %q contains the identifier", h)
	}
	if len(h) != 32 {
		t.Errorf("key length %d; want a 32-char truncated SHA-256", len(h))
	}
	for _, c := range h {
		if !strings.ContainsRune("0123456789abcdef", c) {
			t.Fatalf("key %q is not lower-case hex", h)
		}
	}
}

func TestTheSameCustomerIsNotCorrelatableAcrossCampaigns(t *testing.T) {
	// The activation salts the hash. Without that, one key would identify the
	// same person across every campaign they were ever shown -- which is the
	// cross-campaign profile this architecture exists to not build.
	const user = "USER-A"
	a := hashUser("act-1", user)
	b := hashUser("act-2", user)

	if a == b {
		t.Error("the same customer produces the same key on two activations")
	}
	// Deterministic within one activation, or the cap would never accumulate.
	if a != hashUser("act-1", user) {
		t.Error("the key is not stable for one activation")
	}
}

func TestCountersAccumulateAndDrainExactlyOnce(t *testing.T) {
	// These are the numbers the Partner is paid on. Draining twice would
	// report the delivery twice; not clearing would report it for ever.
	s := NewEmbedded()

	for i := 0; i < 4; i++ {
		_ = s.RecordImpression(ctx(), "act-1", "USER-A", time.Hour)
	}
	_ = s.RecordClick(ctx(), "act-1")
	_ = s.RecordClick(ctx(), "act-1")

	first, err := s.DrainCounters(ctx())
	if err != nil {
		t.Fatalf("drain: %v", err)
	}
	if first["act-1"].Impressions != 4 || first["act-1"].Clicks != 2 {
		t.Errorf("drained %+v; want 4 impressions and 2 clicks", first["act-1"])
	}

	second, err := s.DrainCounters(ctx())
	if err != nil {
		t.Fatalf("second drain: %v", err)
	}
	if len(second) != 0 {
		t.Errorf("a second drain returned %+v; the same delivery would be reported twice", second)
	}
}

func TestDrainingCountersDoesNotResetTheFrequencyCap(t *testing.T) {
	// They are different lifetimes. Counters are drained every minute for
	// reporting; the cap has to survive that or a customer sees the ad again
	// within the window the Partner promised they would not.
	s := NewEmbedded()
	const window = time.Hour

	for i := 0; i < 3; i++ {
		_ = s.RecordImpression(ctx(), "act-1", "USER-A", window)
	}
	if _, err := s.DrainCounters(ctx()); err != nil {
		t.Fatalf("drain: %v", err)
	}

	if n, _ := s.FrequencyCount(ctx(), "act-1", "USER-A", window); n != 3 {
		t.Errorf("after a counter drain the cap shows %d; want 3 -- the customer would see it again", n)
	}
}

func TestSpendEstimateAccumulates(t *testing.T) {
	// §103 pacing reads this to stop serving past budget. An estimate that
	// reset would let an activation overspend.
	s := NewEmbedded()

	if v, _ := s.SpendEstimate(ctx(), "act-1"); v != 0 {
		t.Fatalf("a new activation starts at %d; want 0", v)
	}
	_ = s.AddSpendEstimate(ctx(), "act-1", 250)
	_ = s.AddSpendEstimate(ctx(), "act-1", 125)

	if v, _ := s.SpendEstimate(ctx(), "act-1"); v != 375 {
		t.Errorf("spend estimate = %d; want 375", v)
	}
	if v, _ := s.SpendEstimate(ctx(), "act-2"); v != 0 {
		t.Errorf("a different activation shows %d; spend must not leak across activations", v)
	}
}

func TestConcurrentImpressionsAreNotLost(t *testing.T) {
	// A page-render path is concurrent by definition. A lost increment is an
	// impression the Partner is not paid for; a double one is a cap breached.
	s := NewEmbedded()
	const window = time.Hour
	const n = 200

	done := make(chan struct{})
	for i := 0; i < n; i++ {
		go func() {
			_ = s.RecordImpression(ctx(), "act-1", "USER-A", window)
			done <- struct{}{}
		}()
	}
	for i := 0; i < n; i++ {
		<-done
	}

	if got, _ := s.FrequencyCount(ctx(), "act-1", "USER-A", window); got != n {
		t.Errorf("after %d concurrent impressions the count is %d", n, got)
	}
	drained, _ := s.DrainCounters(ctx())
	if drained["act-1"].Impressions != n {
		t.Errorf("counter shows %d of %d impressions", drained["act-1"].Impressions, n)
	}
}
