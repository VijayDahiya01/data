// Package eventbuffer batches delivery counters for upload -- spec v5 §8,
// §18, §27, §45.
//
// §45's rule for this module is "No per-user central event", and §27 explains
// why batching is not merely an optimisation:
//
//	"Batch reporting instead of one central event request per impression."
//
// The Agent therefore uploads AGGREGATES -- impressions and clicks per
// activation per hour. A per-impression feed to Oolix would be a behavioural
// stream about individuals even with no identifier attached, and would put a
// network round trip on the Partner's page-render path.
package eventbuffer

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/oolix/partner-agent/internal/state"
)

// Uploader drains the local counters and posts them to Oolix.
type Uploader struct {
	client  *http.Client
	baseURL string
	agentID string
	store   state.Store
	token   func(context.Context) (string, error)
	log     *slog.Logger

	// A batch that failed to upload is retried with the SAME batch_id, which
	// is what makes the server-side dedupe in §57 work.
	mu      sync.Mutex
	pending *pendingBatch
}

type pendingBatch struct {
	BatchID  string       `json:"batch_id"`
	Counters []counterDTO `json:"counters"`
	attempts int
}

type counterDTO struct {
	ActivationID string `json:"activation_id"`
	BucketStart  string `json:"bucket_start"`
	Impressions  int64  `json:"impressions"`
	Clicks       int64  `json:"clicks"`
	SpendMinor   int64  `json:"spend_minor"`
}

// New creates an Uploader.
func New(client *http.Client, baseURL, agentID string, store state.Store, token func(context.Context) (string, error), log *slog.Logger) *Uploader {
	return &Uploader{client: client, baseURL: baseURL, agentID: agentID, store: store, token: token, log: log}
}

// Run drains and uploads on an interval until the context is cancelled.
func (u *Uploader) Run(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = 60 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			// §69.2: flush on the way out so a graceful shutdown does not lose
			// delivery the Partner has already earned.
			flushCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			if err := u.Flush(flushCtx); err != nil {
				u.log.Warn("final delivery flush failed", "error", err.Error())
			}
			cancel()
			return
		case <-ticker.C:
			if err := u.Flush(ctx); err != nil {
				u.log.Warn("delivery flush failed; will retry with the same batch id",
					"error", err.Error())
			}
		}
	}
}

// Flush drains the counters and uploads them.
//
// A failed upload keeps the batch AND its id, so the retry is deduplicated
// server-side rather than double-counted (§57: "Duplicate report batch ->
// deduplicate by partner_id + batch_id").
func (u *Uploader) Flush(ctx context.Context) error {
	u.mu.Lock()
	batch := u.pending
	u.mu.Unlock()

	if batch == nil {
		counters, err := u.store.DrainCounters(ctx)
		if err != nil {
			return fmt.Errorf("drain counters: %w", err)
		}
		if len(counters) == 0 {
			return nil
		}

		// Bucket to the hour the flush occurs in. The Agent flushes at least
		// once a minute, so a counter is never attributed to the wrong hour by
		// more than the flush interval.
		bucket := time.Now().UTC().Truncate(time.Hour).Format(time.RFC3339)

		dto := make([]counterDTO, 0, len(counters))
		for activationID, c := range counters {
			dto = append(dto, counterDTO{
				ActivationID: activationID,
				BucketStart:  bucket,
				Impressions:  c.Impressions,
				Clicks:       c.Clicks,
			})
		}

		batch = &pendingBatch{BatchID: uuid.NewString(), Counters: dto}
		u.mu.Lock()
		u.pending = batch
		u.mu.Unlock()
	}

	if err := u.upload(ctx, batch); err != nil {
		batch.attempts++
		return err
	}

	u.mu.Lock()
	u.pending = nil
	u.mu.Unlock()

	u.log.Info("delivery batch uploaded",
		"batch_id", batch.BatchID,
		"counters", len(batch.Counters),
		"attempts", batch.attempts+1)
	return nil
}

// Pending reports whether a batch is awaiting upload, for /readyz and §58.
func (u *Uploader) Pending() int {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.pending == nil {
		return 0
	}
	return len(u.pending.Counters)
}

func (u *Uploader) upload(ctx context.Context, batch *pendingBatch) error {
	access, err := u.token(ctx)
	if err != nil {
		return err
	}

	body, err := json.Marshal(batch)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		u.baseURL+"/agent/v1/reporting/batches", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+access)
	req.Header.Set("X-Agent-Id", u.agentID)
	req.Header.Set("Content-Type", "application/json")
	// §22.3: the same batch retried carries the same key.
	req.Header.Set("Idempotency-Key", batch.BatchID)

	res, err := u.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	if res.StatusCode >= 300 {
		msg, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return fmt.Errorf("delivery batch upload returned %d: %s", res.StatusCode, string(msg))
	}
	io.Copy(io.Discard, res.Body)
	return nil
}
