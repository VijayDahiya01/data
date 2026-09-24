package config

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

// Every config we ship or run must survive strict parsing.
//
// Turning on KnownFields is the right call -- a silently skipped key cost a
// full day of this integration -- but it converts yesterday's harmless typo
// into a refusal to start. That trade is only safe if the configs we actually
// hand people are clean, so this checks them rather than assuming.
func TestShippedConfigsParse(t *testing.T) {
	for _, c := range []struct {
		rel string
		// A shipped config must exist. A local one is generated per machine by
		// `pnpm agent:provision` and gitignored, so a fresh checkout -- which is
		// exactly what CI runs -- never has it. Requiring it failed this test on
		// every CI run the repository ever had, while it passed on the one
		// machine where the file happened to be sitting. It is still checked
		// wherever it exists, because a stale local config refusing to start is
		// precisely what this test is here to surface.
		required bool
	}{
		{rel: "config.example.yaml", required: true},
		{rel: "config.local.yaml", required: false},
	} {
		path := filepath.Join("..", "..", c.rel)
		t.Run(c.rel, func(t *testing.T) {
			if _, err := os.Stat(path); errors.Is(err, fs.ErrNotExist) && !c.required {
				t.Skipf("%s is generated per machine by `pnpm agent:provision` and absent here", c.rel)
			}
			if _, err := Load(path); err != nil {
				t.Errorf("%s no longer loads: %v", c.rel, err)
			}
		})
	}
}
