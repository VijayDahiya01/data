package managed

import (
	"context"
	"log/slog"
	"time"

	"github.com/oolix/partner-agent/internal/clean"
)

// Synonyms Partners agreed on and Oolix reviewed (docs/DESIGN-PARTNER-DATA.md
// §5.6), used by every Agent like its built-in ones. The list is kept in the
// local store, so a restart without Oolix still has it.

// UseSharedSynonyms puts the last downloaded list to use; at start.
func UseSharedSynonyms(ctx context.Context, settings Settings) {
	if cur, err := settings.SharedSynonyms(ctx); err == nil {
		clean.SetShared(cur.ByAttr)
	}
}

// KeepSharedSynonyms downloads the list now and then every so often, and
// puts a changed one to use: the next sync reads with it. A failed download
// keeps the list there is.
func KeepSharedSynonyms(ctx context.Context, settings Settings, every time.Duration, logger *slog.Logger,
	fetch func(context.Context) (string, map[string]map[string]string, error)) {
	for {
		version, byAttr, err := fetch(ctx)
		switch cur, _ := settings.SharedSynonyms(ctx); {
		case err != nil:
			if ctx.Err() == nil {
				logger.Warn("shared synonyms were not downloaded", "error", err.Error())
			}
		case version != cur.Version:
			if err := settings.SaveSharedSynonyms(ctx, SharedSynonyms{Version: version, ByAttr: byAttr}); err != nil {
				logger.Warn("shared synonyms were not saved", "error", err.Error())
				break
			}
			clean.SetShared(byAttr)
			logger.Info("shared synonyms updated", "version", version)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(every):
		}
	}
}
