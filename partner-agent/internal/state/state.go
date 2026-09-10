// Package state holds Partner-LOCAL frequency and pacing counters --
// spec v5 §45, §76.1.
//
// This data never leaves the Partner. §3's ownership table lists "Per-user
// frequency state" as Partner-local with "Can Oolix see it? No", and §45
// repeats it: "Frequency: local only."
//
// §76.1 sets the replica rule that makes this package's shape necessary:
//
//	"If one Partner Agent has multiple replicas, frequency/pacing state MUST
//	 use shared Partner-local Redis or another shared state service.
//	 In-process memory is not acceptable for multi-replica production."
//
// Two implementations satisfy one interface so the choice is a config value
// (§69.1 state.mode) rather than a code change.
package state

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// Store tracks per-user frequency and per-activation pacing.
type Store interface {
	// FrequencyCount returns impressions served to this user for this
	// activation inside the window.
	FrequencyCount(ctx context.Context, activationID, partnerUserID string, window time.Duration) (int, error)

	// RecordImpression increments both the per-user frequency counter and the
	// activation's aggregate delivery counter.
	RecordImpression(ctx context.Context, activationID, partnerUserID string, window time.Duration) error

	// RecordClick increments the activation's aggregate click counter.
	RecordClick(ctx context.Context, activationID string) error

	// Counters returns and CLEARS the aggregate counters, for batch upload
	// (§45 event buffer, §18).
	DrainCounters(ctx context.Context) (map[string]Counter, error)

	// SpendEstimate is the Agent's local view of spend, used for the §76.1
	// hard stop at 98% of allocation.
	SpendEstimate(ctx context.Context, activationID string) (int64, error)
	AddSpendEstimate(ctx context.Context, activationID string, amountMinor int64) error

	Close() error
}

// Counter is one activation's aggregate delivery for a batch.
type Counter struct {
	Impressions int64
	Clicks      int64
}

// hashUser derives the key under which a user's frequency is stored.
//
// The raw partner_user_id is never used as a key. It stays inside the Partner
// either way, but hashing means an operator reading Redis, or a memory dump,
// does not enumerate the Partner's customers -- and §78.1 forbids the raw id
// appearing in anything log-like. The activation id salts the hash so the same
// user is not correlatable across campaigns.
func hashUser(activationID, partnerUserID string) string {
	sum := sha256.Sum256([]byte(activationID + "\x00" + partnerUserID))
	return hex.EncodeToString(sum[:16])
}

// ---------------------------------------------------------------------------
// Embedded (single replica only)
// ---------------------------------------------------------------------------

type embedded struct {
	mu       sync.Mutex
	freq     map[string][]time.Time
	counters map[string]*Counter
	spend    map[string]int64
}

// NewEmbedded returns an in-process store.
//
// SINGLE REPLICA ONLY. §76.1 forbids this in multi-replica production: each
// replica would keep its own counters, so a cap of 2 impressions per day with
// three replicas becomes 6.
//
// NOTHING HERE CAN ENFORCE THAT. A process does not know how many copies of
// itself are running -- replica count is a deployment fact, not a config one.
// So the guard is where the decision is made: the shipped Kubernetes manifest
// pairs replicas: 2 with mode: "redis" and says in a comment that going back
// to embedded means returning to one replica. The Agent logs a warning at
// start-up, which is the most it can honestly do.
//
// The failure this leaves possible is silent and it costs the Partner their
// promise to a customer, so it is worth stating plainly rather than implying
// a safeguard that does not exist.
func NewEmbedded() Store {
	return &embedded{
		freq:     make(map[string][]time.Time),
		counters: make(map[string]*Counter),
		spend:    make(map[string]int64),
	}
}

func (e *embedded) FrequencyCount(_ context.Context, activationID, partnerUserID string, window time.Duration) (int, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	key := hashUser(activationID, partnerUserID)
	cutoff := time.Now().Add(-window)

	kept := e.freq[key][:0]
	for _, t := range e.freq[key] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	e.freq[key] = kept
	return len(kept), nil
}

func (e *embedded) RecordImpression(_ context.Context, activationID, partnerUserID string, _ time.Duration) error {
	e.mu.Lock()
	defer e.mu.Unlock()

	key := hashUser(activationID, partnerUserID)
	e.freq[key] = append(e.freq[key], time.Now())

	if e.counters[activationID] == nil {
		e.counters[activationID] = &Counter{}
	}
	e.counters[activationID].Impressions++
	return nil
}

func (e *embedded) RecordClick(_ context.Context, activationID string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.counters[activationID] == nil {
		e.counters[activationID] = &Counter{}
	}
	e.counters[activationID].Clicks++
	return nil
}

func (e *embedded) DrainCounters(_ context.Context) (map[string]Counter, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	out := make(map[string]Counter, len(e.counters))
	for k, v := range e.counters {
		out[k] = *v
	}
	e.counters = make(map[string]*Counter)
	return out, nil
}

func (e *embedded) SpendEstimate(_ context.Context, activationID string) (int64, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.spend[activationID], nil
}

func (e *embedded) AddSpendEstimate(_ context.Context, activationID string, amountMinor int64) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.spend[activationID] += amountMinor
	return nil
}

func (e *embedded) Close() error { return nil }

// ---------------------------------------------------------------------------
// Redis (multi-replica)
// ---------------------------------------------------------------------------

type redisStore struct {
	client *redis.Client
	prefix string
}

// NewRedis returns a shared store backed by PARTNER-LOCAL Redis.
//
// §64 is specific that this instance belongs to the Partner: "Partner-local
// Redis required only for multi-replica Agent state." It must never be the
// Oolix control-plane Redis -- that would put per-user frequency data outside
// the Partner boundary and break §3.
func NewRedis(url, prefix string) (Store, error) {
	opts, err := redis.ParseURL(url)
	if err != nil {
		return nil, fmt.Errorf("parse partner-local redis url: %w", err)
	}
	return &redisStore{client: redis.NewClient(opts), prefix: prefix}, nil
}

func (r *redisStore) freqKey(activationID, partnerUserID string) string {
	return fmt.Sprintf("%s:freq:%s", r.prefix, hashUser(activationID, partnerUserID))
}

func (r *redisStore) FrequencyCount(ctx context.Context, activationID, partnerUserID string, window time.Duration) (int, error) {
	key := r.freqKey(activationID, partnerUserID)
	cutoff := time.Now().Add(-window).UnixMilli()

	pipe := r.client.TxPipeline()
	pipe.ZRemRangeByScore(ctx, key, "0", fmt.Sprintf("%d", cutoff))
	count := pipe.ZCard(ctx, key)
	if _, err := pipe.Exec(ctx); err != nil {
		return 0, err
	}
	return int(count.Val()), nil
}

func (r *redisStore) RecordImpression(ctx context.Context, activationID, partnerUserID string, window time.Duration) error {
	key := r.freqKey(activationID, partnerUserID)
	now := time.Now()

	pipe := r.client.TxPipeline()
	pipe.ZAdd(ctx, key, redis.Z{Score: float64(now.UnixMilli()), Member: now.UnixNano()})
	// Expire the whole key one window out so frequency data does not
	// accumulate indefinitely (§81 retention).
	pipe.PExpire(ctx, key, window)
	pipe.HIncrBy(ctx, r.prefix+":counters:impressions", activationID, 1)
	_, err := pipe.Exec(ctx)
	return err
}

func (r *redisStore) RecordClick(ctx context.Context, activationID string) error {
	return r.client.HIncrBy(ctx, r.prefix+":counters:clicks", activationID, 1).Err()
}

func (r *redisStore) DrainCounters(ctx context.Context) (map[string]Counter, error) {
	impKey := r.prefix + ":counters:impressions"
	clkKey := r.prefix + ":counters:clicks"

	// Rename-then-read so counts recorded during the drain are not lost: a
	// concurrent HIncrBy lands on a fresh key rather than one being deleted.
	batch := fmt.Sprintf("%s:drain:%d", r.prefix, time.Now().UnixNano())
	impSnap, clkSnap := batch+":imp", batch+":clk"

	_ = r.client.Rename(ctx, impKey, impSnap).Err()
	_ = r.client.Rename(ctx, clkKey, clkSnap).Err()

	out := map[string]Counter{}

	imps, _ := r.client.HGetAll(ctx, impSnap).Result()
	for act, v := range imps {
		c := out[act]
		fmt.Sscanf(v, "%d", &c.Impressions)
		out[act] = c
	}
	clks, _ := r.client.HGetAll(ctx, clkSnap).Result()
	for act, v := range clks {
		c := out[act]
		fmt.Sscanf(v, "%d", &c.Clicks)
		out[act] = c
	}

	r.client.Del(ctx, impSnap, clkSnap)
	return out, nil
}

func (r *redisStore) SpendEstimate(ctx context.Context, activationID string) (int64, error) {
	v, err := r.client.HGet(ctx, r.prefix+":spend", activationID).Int64()
	if err == redis.Nil {
		return 0, nil
	}
	return v, err
}

func (r *redisStore) AddSpendEstimate(ctx context.Context, activationID string, amountMinor int64) error {
	return r.client.HIncrBy(ctx, r.prefix+":spend", activationID, amountMinor).Err()
}

func (r *redisStore) Close() error { return r.client.Close() }
