package config

import (
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
	for _, rel := range []string{
		"config.example.yaml",
		"config.local.yaml",
	} {
		path := filepath.Join("..", "..", rel)
		t.Run(rel, func(t *testing.T) {
			if _, err := Load(path); err != nil {
				t.Errorf("%s no longer loads: %v", rel, err)
			}
		})
	}
}
