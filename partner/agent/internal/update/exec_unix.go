//go:build !windows

package update

import (
	"log/slog"
	"os"
	"path/filepath"
	"syscall"
)

// activate has nothing more to do here: the kept release runs in place of
// the installed binary from the next start, through Launch.
func activate(string, string, *Release) error { return nil }

// Launch runs the kept release in place of this binary when one newer than it
// checks out again: the process becomes the release, keeping its process ID
// for systemd or the container runtime, and Launch does not return.
// Otherwise it returns and this binary runs.
//
// The release is checked from its file and then run from it. Only the Agent's
// own user can write its state folder, so nobody who could swap the file in
// between could not already run anything as the Agent.
func Launch(stateDir string, logger *slog.Logger) {
	key, err := Key(ReleaseKey)
	if err != nil || stateDir == "" || builtAt().IsZero() {
		return
	}
	bin, err := kept(filepath.Join(stateDir, "updates"), key, builtAt(), Platform())
	if err != nil {
		logger.Warn("not starting the kept update", "err", err)
	}
	if bin == "" {
		return
	}
	logger.Info("starting the installed update", "binary", bin)
	argv := append([]string{bin}, os.Args[1:]...)
	if err := syscall.Exec(bin, argv, os.Environ()); err != nil {
		logger.Error("could not start the update; running the installed Agent instead", "err", err)
	}
}

// Relaunch restarts the Agent into the update it has just installed. If that
// fails it exits, and its service manager starts it again -- into the update,
// which then has one start fewer left to prove itself.
func Relaunch(stateDir string, logger *slog.Logger) {
	Launch(stateDir, logger)
	os.Exit(1)
}
