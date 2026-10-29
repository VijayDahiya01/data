package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"time"

	"github.com/oolix/partner-agent/internal/clean"
	"github.com/oolix/partner-agent/internal/managed"
	"github.com/oolix/partner-agent/internal/update"
)

// Updates (internal/update): a release the Partner allowed is installed into
// the state folder, and the Agent stops to start again as it.

// errRestart is how the Agent stops to restart into an update it installed.
var errRestart = errors.New("restarting into the installed update")

// launchKept runs the update kept in the state folder in place of this binary,
// once it checks out again; never inside an enclave, whose image is the one
// its Partner verified.
func launchKept() {
	if enclaveMode() {
		return
	}
	update.Launch(os.Getenv("OOLIX_STATE_DIR"), slog.New(slog.NewJSONHandler(os.Stderr, nil)))
}

// restartOnUpdate starts the update the Agent has just installed when run
// stopped for it, and does not return then; other outcomes pass through.
func restartOnUpdate(err error) error {
	if errors.Is(err, errRestart) {
		update.Relaunch(os.Getenv("OOLIX_STATE_DIR"), slog.New(slog.NewJSONHandler(os.Stderr, nil)))
	}
	return err
}

// autoUpdateRetry is how long a failed automatic update waits before the
// next try: the next night.
const autoUpdateRetry = 6 * time.Hour

// autoUpdate installs an offered release when the Partner lets the Agent
// update itself: in the hour before the nightly refresh, in their time zone,
// so a restart never cuts a refresh short.
func autoUpdate(ctx context.Context, u *update.Updater, settings managed.Settings, every time.Duration,
	now func() time.Time, logger *slog.Logger) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		if !dueForUpdate(ctx, u, settings, now()) {
			continue
		}
		if err := u.Install(ctx); err != nil {
			logger.Warn("automatic update failed; trying again tomorrow night", "error", err.Error())
		}
	}
}

func dueForUpdate(ctx context.Context, u *update.Updater, settings managed.Settings, now time.Time) bool {
	if on, err := settings.AutoUpdate(ctx); err != nil || !on {
		return false
	}
	hour, loc := 2, clean.India
	if m, err := settings.Mapping(ctx); err == nil && m != nil {
		hour, loc = m.SyncHour, m.TimeZone()
	}
	return due(u.Status(), u.Pending(), hour, loc, now)
}

// due says an automatic update installs now: one is offered, none failed
// since the night before, and it is the hour before the nightly refresh.
func due(st update.Status, pending bool, syncHour int, loc *time.Location, now time.Time) bool {
	if !pending || st.LastError != "" && now.Sub(st.LastTry) < autoUpdateRetry {
		return false
	}
	return now.In(loc).Hour() == update.NightHour(syncHour)
}
