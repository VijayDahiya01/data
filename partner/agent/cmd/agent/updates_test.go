package main

import (
	"errors"
	"testing"
	"time"

	"github.com/oolix/partner-agent/internal/clean"
	"github.com/oolix/partner-agent/internal/update"
)

// Automatic updates install in the hour before the nightly refresh, in the
// Partner's time, and a failure waits for the next night.
func TestAutomaticUpdatesInstallAtNight(t *testing.T) {
	ist := func(hour int) time.Time { return time.Date(2026, 10, 28, hour, 30, 0, 0, clean.India) }
	if !due(update.Status{}, true, 2, clean.India, ist(1)) {
		t.Error("not due at 01:30 with the refresh at 02:00")
	}
	for _, hour := range []int{0, 2, 13} {
		if due(update.Status{}, true, 2, clean.India, ist(hour)) {
			t.Errorf("due at %02d:30", hour)
		}
	}
	if due(update.Status{}, false, 2, clean.India, ist(1)) {
		t.Error("due with nothing offered")
	}
	failed := update.Status{LastError: "downloading: 404", LastTry: ist(1).Add(-10 * time.Minute)}
	if due(failed, true, 2, clean.India, ist(1)) {
		t.Error("a failed update was tried again the same night")
	}
	failed.LastTry = ist(1).Add(-24 * time.Hour)
	if !due(failed, true, 2, clean.India, ist(1)) {
		t.Error("a failed update was not tried the next night")
	}
	// A Partner whose refresh runs at midnight: 23:00 the evening before.
	if !due(update.Status{}, true, 0, clean.India, ist(23)) {
		t.Error("not due at 23:30 with the refresh at midnight")
	}
	if err := restartOnUpdate(errors.New("other")); err == nil || errors.Is(err, errRestart) {
		t.Error("restartOnUpdate changed an error that was not a restart")
	}
}
