package managed

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/x509"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/oolix/partner-agent/internal/clean"
	"github.com/oolix/partner-agent/internal/cleanroom"
	"github.com/oolix/partner-agent/internal/enclave"
	"github.com/oolix/partner-agent/internal/localstore"
	"github.com/oolix/partner-agent/internal/source"
)

// CrossPartnerMapping is the Partner's opt-in to cross-Partner matching
// (docs/DESIGN-PARTNER-DATA.md §5.7, phase 7): the columns holding email
// and phone, and the consent customers gave for this purpose -- asked for
// separately from marketing consent, and needed as well as it.
type CrossPartnerMapping struct {
	EmailColumn string         `json:"email_column,omitempty"`
	PhoneColumn string         `json:"phone_column,omitempty"`
	Consent     ConsentMapping `json:"consent"`
}

// Enabled is whether the Partner set it up: a key column, and consent.
func (c *CrossPartnerMapping) Enabled() bool {
	return c != nil && (c.EmailColumn != "" || c.PhoneColumn != "") && (c.Consent.Column != "" || c.Consent.Everyone)
}

const collectBatch = 10_000

// CollectCustomers reads the match keys of the customers who may be matched
// with another Partner's: in the copy -- adults who agreed to marketing --
// and agreeing to cross-Partner matching besides. Which customer each key
// belongs to is kept here, for a joint audience to come back to; the keys
// leave only sealed to the clean room.
func CollectCustomers(ctx context.Context, src source.Source, store *localstore.Store, m Mapping,
	now time.Time) ([]cleanroom.Customer, error) {
	cp := m.CrossPartner
	if !cp.Enabled() {
		return nil, errors.New("cross-Partner matching is not set up")
	}
	loc := location(m.Location)
	var columns []string
	seen := map[string]bool{}
	for _, c := range []string{m.IDColumn, cp.EmailColumn, cp.PhoneColumn, cp.Consent.Withdrawal} {
		if c != "" && !seen[c] {
			seen[c] = true
			columns = append(columns, c)
		}
	}
	if !cp.Consent.Everyone && !seen[cp.Consent.Column] {
		columns = append(columns, cp.Consent.Column)
	}
	if _, err := store.Pool.Exec(ctx, `TRUNCATE `+localstore.MatchKeysTable); err != nil {
		return nil, err
	}

	type pending struct {
		id string
		c  cleanroom.Customer
	}
	var batch []pending
	var out []cleanroom.Customer
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		ids := make([]string, len(batch))
		for i, p := range batch {
			ids[i] = p.id
		}
		rows, err := store.Pool.Query(ctx, `SELECT partner_user_id FROM `+localstore.ConsentTable+
			` WHERE purpose_id = $1 AND eligible AND partner_user_id = ANY($2)`, localstore.AnyPurpose, ids)
		if err != nil {
			return err
		}
		inCopy := map[string]bool{}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			inCopy[id] = true
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		var keyRows [][]any
		for _, p := range batch {
			if !inCopy[p.id] {
				continue
			}
			out = append(out, p.c)
			for _, k := range p.c {
				keyRows = append(keyRows, []any{k[:], p.id})
			}
		}
		batch = batch[:0]
		if len(keyRows) == 0 {
			return nil
		}
		_, err = store.Pool.CopyFrom(ctx, pgx.Identifier{localstore.MatchKeysTable},
			[]string{"match_key", "partner_user_id"}, pgx.CopyFromRows(keyRows))
		return err
	}
	each := func(row source.Row) error {
		id := strings.TrimSpace(clean.Text(row[m.IDColumn]))
		if id == "" {
			return nil
		}
		if agreed, _, _ := consentOf(row, cp.Consent, loc, now); !agreed {
			return nil
		}
		var c cleanroom.Customer
		if cp.EmailColumn != "" {
			if k, ok := cleanroom.EmailKey(clean.Text(row[cp.EmailColumn])); ok {
				c = append(c, k)
			}
		}
		if cp.PhoneColumn != "" {
			if k, ok := cleanroom.PhoneKey(clean.Text(row[cp.PhoneColumn])); ok {
				c = append(c, k)
			}
		}
		if len(c) == 0 {
			return nil
		}
		batch = append(batch, pending{id: store.ScrambleID(id), c: c})
		if len(batch) >= collectBatch {
			return flush()
		}
		return nil
	}
	if err := source.StreamJoined(ctx, src, m.Table, m.IDColumn, columns, m.Joins, each); err != nil {
		return nil, err
	}
	return out, flush()
}

// StoreJointAudience keeps the customers a joint audience names, by the
// match keys the clean room sent back.
func StoreJointAudience(ctx context.Context, store *localstore.Store, runID string, keys []cleanroom.Key) (int, error) {
	raw := make([][]byte, len(keys))
	for i := range keys {
		raw[i] = keys[i][:]
	}
	tag, err := store.Pool.Exec(ctx, `INSERT INTO `+localstore.JointAudiencesTable+` (run_id, partner_user_id)
		SELECT DISTINCT $1, partner_user_id FROM `+localstore.MatchKeysTable+` WHERE match_key = ANY($2)
		ON CONFLICT DO NOTHING`, runID, raw)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

const keyCleanRoom = "cleanroom_key"

// CleanRoomKey is the X25519 key joint audiences are sealed to: made on
// first use, kept sealed with the store's key.
func (s Settings) CleanRoomKey(ctx context.Context) (*ecdh.PrivateKey, error) {
	var stored string
	ok, err := s.Store.Get(ctx, keyCleanRoom, &stored)
	if err != nil {
		return nil, err
	}
	if ok {
		raw, err := s.Store.Unseal(stored)
		if err != nil {
			return nil, err
		}
		return ecdh.X25519().NewPrivateKey([]byte(raw))
	}
	key, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	sealed, err := s.Store.Seal(string(key.Bytes()))
	if err != nil {
		return nil, err
	}
	return key, s.Store.Put(ctx, keyCleanRoom, sealed)
}

// CleanRoomClient is Oolix's side of a clean-room run (controlsync.Syncer).
type CleanRoomClient interface {
	CleanRoomTasks(ctx context.Context) ([]CleanRoomTask, error)
	SubmitCleanRoomInput(ctx context.Context, runID string, sealed, recipient []byte) error
	CleanRoomResults(ctx context.Context) ([]CleanRoomResult, error)
	AckCleanRoomResult(ctx context.Context, runID string) error
}

// CleanRoomTask is a run waiting for this Partner's customers: the clean
// room's attestation names the key to seal them to. Role "base" is a joint
// audience's requester, who gets the result.
type CleanRoomTask struct {
	RunID       string `json:"run_id"`
	Kind        string `json:"kind"`
	Role        string `json:"role"`
	Attestation []byte `json:"attestation"`
}

// CleanRoomResult is a joint audience, sealed to this Agent.
type CleanRoomResult struct {
	RunID  string `json:"run_id"`
	Sealed []byte `json:"sealed"`
}

// CleanRoom answers clean-room runs for this Agent.
type CleanRoom struct {
	Runner *Runner
	Client CleanRoomClient
	// Trusted are the clean room images this Agent will seal to; none means
	// it seals to none.
	Trusted []enclave.Measurements
	// Roots are AWS's Nitro root unless a test says otherwise.
	Roots  *x509.CertPool
	Logger *slog.Logger
}

// Run checks for work every so often until ctx ends.
func (c *CleanRoom) Run(ctx context.Context, every time.Duration) {
	for {
		if err := c.Once(ctx); err != nil && ctx.Err() == nil {
			c.Logger.Warn("cross-Partner matching", "error", err.Error())
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(every):
		}
	}
}

// Once answers what is waiting: tasks first, then joint audiences.
func (c *CleanRoom) Once(ctx context.Context) error {
	settings := Settings{Store: c.Runner.Store}
	m, err := settings.Mapping(ctx)
	if err != nil || m == nil || !m.CrossPartner.Enabled() {
		return err
	}
	tasks, err := c.Client.CleanRoomTasks(ctx)
	if err != nil {
		return err
	}
	for _, t := range tasks {
		if err := c.answer(ctx, settings, *m, t); err != nil {
			c.Logger.Warn("a clean-room run was not answered", "run", t.RunID, "error", err.Error())
		}
	}
	results, err := c.Client.CleanRoomResults(ctx)
	if err != nil {
		return err
	}
	for _, r := range results {
		key, err := settings.CleanRoomKey(ctx)
		if err != nil {
			return err
		}
		plain, err := cleanroom.Open(key, r.Sealed)
		if err != nil {
			c.Logger.Warn("a joint audience did not open", "run", r.RunID, "error", err.Error())
			continue
		}
		keys, err := cleanroom.DecodeKeys(plain)
		if err != nil {
			continue
		}
		n, err := StoreJointAudience(ctx, c.Runner.Store, r.RunID, keys)
		if err != nil {
			return err
		}
		c.Logger.Info("joint audience received", "run", r.RunID, "customers", n)
		if err := c.Client.AckCleanRoomResult(ctx, r.RunID); err != nil {
			return err
		}
	}
	return nil
}

func (c *CleanRoom) answer(ctx context.Context, settings Settings, m Mapping, t CleanRoomTask) error {
	if len(c.Trusted) == 0 {
		return errors.New("no clean room image is trusted (OOLIX_CLEANROOM_MEASUREMENTS): nothing is sent")
	}
	box, _, err := cleanroom.Recipient(t.Attestation, enclave.VerifyOptions{Roots: c.Roots, Expect: c.Trusted,
		MaxAge: time.Hour})
	if err != nil {
		return fmt.Errorf("the clean room is not a trusted one: %w", err)
	}
	cfg, err := settings.Source(ctx)
	if err != nil || cfg == nil {
		return errors.New("no database is set up")
	}
	src, err := c.Runner.Open(ctx, *cfg)
	if err != nil {
		return err
	}
	defer src.Close()
	customers, err := CollectCustomers(ctx, src, c.Runner.Store, m, c.Runner.Now())
	if err != nil {
		return err
	}
	sealed, err := cleanroom.Seal(box, cleanroom.EncodeCustomers(customers))
	if err != nil {
		return err
	}
	var recipient []byte
	if t.Role == "base" {
		key, err := settings.CleanRoomKey(ctx)
		if err != nil {
			return err
		}
		recipient = key.PublicKey().Bytes()
	}
	c.Logger.Info("customers sealed to the clean room", "run", t.RunID, "customers", len(customers))
	return c.Client.SubmitCleanRoomInput(ctx, t.RunID, sealed, recipient)
}
