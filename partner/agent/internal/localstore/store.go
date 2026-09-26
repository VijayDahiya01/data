// Package localstore is the Agent's own database in managed mode: a small
// PostgreSQL on the Partner's server holding the cleaned copy of their
// customer attributes, the audience member lists, and the Agent's settings.
//
// It exists so the Partner's database is only ever READ, once a night, and
// never has anything created in it. Audience counts, member lists and ad
// decisions all run here instead -- none of that load reaches the Partner's
// production system.
//
// What it holds is minimal on purpose. Customer ids are stored scrambled
// (HMAC-SHA256 with a key that never leaves this server), so the copy holds no
// id that means anything outside it; only the attributes the Partner mapped
// are copied; names, emails and phone numbers never are.
package localstore

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/oolix/partner-agent/internal/standard"
)

// Table names, fixed so the Agent's existing SQL works unchanged against them.
const (
	AttributesTable = "oolix_audience_attributes"
	ConsentTable    = "oolix_user_consent"
)

// AnyPurpose marks consent that covers every advertising purpose: in managed
// mode the Partner maps one marketing opt-in, not one per purpose.
const AnyPurpose = "*"

// Store is an open local store.
type Store struct {
	Pool *pgxpool.Pool
	key  []byte
}

// Open connects to the local store, creates its tables if needed, and loads
// the local secret from keyFile, creating it on first start.
func Open(ctx context.Context, dsn, keyFile string) (*Store, error) {
	key, err := loadOrCreateKey(keyFile)
	if err != nil {
		return nil, fmt.Errorf("local secret: %w", err)
	}
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("local store: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("local store is not reachable: %w", err)
	}
	s := &Store{Pool: pool, key: key}
	if err := s.migrate(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("preparing the local store: %w", err)
	}
	return s, nil
}

// Close releases the connections.
func (s *Store) Close() { s.Pool.Close() }

// loadOrCreateKey reads the 32-byte local secret, creating it on first start.
// Losing it is recoverable: ids are re-scrambled at the next sync and the
// Partner re-enters the source password. Leaking it is not a disaster either:
// it unscrambles nothing without the copy, and the copy never leaves.
func loadOrCreateKey(path string) ([]byte, error) {
	raw, err := os.ReadFile(path)
	if err == nil {
		key, err := hex.DecodeString(strings.TrimSpace(string(raw)))
		if err != nil || len(key) != 32 {
			return nil, fmt.Errorf("%s is not a valid local secret", path)
		}
		return key, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(hex.EncodeToString(key)), 0o600); err != nil {
		return nil, err
	}
	return key, os.Rename(tmp, path)
}

func (s *Store) subkey(purpose string) []byte {
	m := hmac.New(sha256.New, s.key)
	m.Write([]byte("oolix-agent/" + purpose))
	return m.Sum(nil)
}

// ScrambleID turns a Partner's customer id into the value the copy holds. The
// same id always scrambles the same way on this server, so an ad decision can
// look a customer up; nobody without the local secret can go the other way.
func (s *Store) ScrambleID(id string) string {
	m := hmac.New(sha256.New, s.subkey("customer-id"))
	m.Write([]byte(id))
	return hex.EncodeToString(m.Sum(nil))
}

// Seal encrypts a secret, such as the source password, for storage.
func (s *Store) Seal(plain string) (string, error) {
	block, err := aes.NewCipher(s.subkey("secrets"))
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(gcm.Seal(nonce, nonce, []byte(plain), nil)), nil
}

// Unseal decrypts what Seal produced.
func (s *Store) Unseal(sealed string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(sealed)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(s.subkey("secrets"))
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(raw) < gcm.NonceSize() {
		return "", errors.New("sealed value is too short")
	}
	plain, err := gcm.Open(nil, raw[:gcm.NonceSize()], raw[gcm.NonceSize():], nil)
	if err != nil {
		return "", errors.New("the stored secret cannot be read; enter it again")
	}
	return string(plain), nil
}

// Get reads a setting into out; false when it has never been saved.
func (s *Store) Get(ctx context.Context, key string, out any) (bool, error) {
	var raw []byte
	err := s.Pool.QueryRow(ctx, `SELECT value FROM oolix_agent_settings WHERE key = $1`, key).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, json.Unmarshal(raw, out)
}

// Put saves a setting.
func (s *Store) Put(ctx context.Context, key string, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = s.Pool.Exec(ctx, `
		INSERT INTO oolix_agent_settings (key, value, updated_at) VALUES ($1, $2, NOW())
		ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, key, raw)
	return err
}

// Delete removes a setting.
func (s *Store) Delete(ctx context.Context, key string) error {
	_, err := s.Pool.Exec(ctx, `DELETE FROM oolix_agent_settings WHERE key = $1`, key)
	return err
}

// ColumnType is the local column type for a standard attribute.
func ColumnType(a standard.Attribute) string {
	switch a.Kind {
	case standard.KindDate:
		return "DATE"
	case standard.KindTimestamp:
		return "TIMESTAMPTZ"
	case standard.KindBool:
		return "BOOLEAN"
	case standard.KindNumber:
		return "INTEGER"
	default:
		return "TEXT"
	}
}

// AttributeDDL creates an attribute table under the given name: one column per
// standard attribute, all optional -- an attribute the Partner does not hold
// simply stays empty.
func AttributeDDL(table string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "CREATE TABLE IF NOT EXISTS %s (\n  partner_user_id TEXT NOT NULL", table)
	for _, a := range standard.Attributes {
		fmt.Fprintf(&b, ",\n  %s %s", a.Column, ColumnType(a))
	}
	b.WriteString(",\n  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()\n)")
	return b.String()
}

// ConsentDDL creates a consent table under the given name. The ad-decision
// path reads it through the connector's consent query.
func ConsentDDL(table string) string {
	return `CREATE TABLE IF NOT EXISTS ` + table + ` (
	   partner_user_id TEXT        NOT NULL,
	   purpose_id      TEXT        NOT NULL,
	   eligible        BOOLEAN     NOT NULL,
	   policy_version  TEXT        NOT NULL,
	   updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	   withdrawn_at    TIMESTAMPTZ)`
}

func (s *Store) migrate(ctx context.Context) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS oolix_agent_settings (
		   key        TEXT PRIMARY KEY,
		   value      JSONB NOT NULL,
		   updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
		`CREATE TABLE IF NOT EXISTS oolix_sync_runs (
		   id          BIGSERIAL PRIMARY KEY,
		   started_at  TIMESTAMPTZ NOT NULL,
		   finished_at TIMESTAMPTZ,
		   status      TEXT NOT NULL,
		   report      JSONB,
		   error       TEXT)`,
		AttributeDDL(AttributesTable),
		`CREATE UNIQUE INDEX IF NOT EXISTS oolix_attributes_pkey_idx ON ` + AttributesTable + ` (partner_user_id)`,
		ConsentDDL(ConsentTable),
		`CREATE UNIQUE INDEX IF NOT EXISTS oolix_consent_pkey_idx ON ` + ConsentTable + ` (partner_user_id, purpose_id)`,
		// Prebuilt segments are not offered in managed mode, but the ad-decision
		// path asks about them for any manifest that names one; an empty table
		// answers "not a member", which is the truthful answer here.
		`CREATE TABLE IF NOT EXISTS oolix_segment_membership (
		   partner_user_id TEXT        NOT NULL,
		   segment_id      TEXT        NOT NULL,
		   effective_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		   expires_at      TIMESTAMPTZ NOT NULL,
		   PRIMARY KEY (partner_user_id, segment_id))`,
		`CREATE TABLE IF NOT EXISTS oolix_audience_members (
		   partner_user_id         VARCHAR(120) NOT NULL,
		   activation_id           UUID         NOT NULL,
		   materialization_version INTEGER      NOT NULL,
		   expires_at              TIMESTAMPTZ  NOT NULL,
		   created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
		   PRIMARY KEY (activation_id, partner_user_id))`,
		`CREATE INDEX IF NOT EXISTS idx_audience_members_lookup
		   ON oolix_audience_members (partner_user_id, activation_id, expires_at)`,
		`CREATE TABLE IF NOT EXISTS oolix_audience_materialization (
		   activation_id           UUID PRIMARY KEY,
		   audience_group_id       VARCHAR(64)  NOT NULL,
		   audience_version        INTEGER      NOT NULL,
		   rule_hash               CHAR(64)     NOT NULL,
		   materialization_version INTEGER      NOT NULL DEFAULT 1,
		   member_count            INTEGER      NOT NULL DEFAULT 0,
		   status                  VARCHAR(24)  NOT NULL DEFAULT 'NOT_STARTED',
		   last_error              TEXT,
		   built_at                TIMESTAMPTZ,
		   expires_at              TIMESTAMPTZ)`,
	}
	// Attributes added in a later version arrive as new, empty columns.
	for _, a := range standard.Attributes {
		stmts = append(stmts, fmt.Sprintf(`ALTER TABLE %s ADD COLUMN IF NOT EXISTS %s %s`,
			AttributesTable, a.Column, ColumnType(a)))
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// One Agent at a time may change the schema.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(73101)`); err != nil {
		return err
	}
	for _, st := range stmts {
		if _, err := tx.Exec(ctx, st); err != nil {
			return fmt.Errorf("%s: %w", firstLine(st), err)
		}
	}
	return tx.Commit(ctx)
}

// DeleteCopiedData empties every table holding customer data, keeping the
// settings: what the "Delete all copied data" button does.
func (s *Store) DeleteCopiedData(ctx context.Context) error {
	_, err := s.Pool.Exec(ctx, `TRUNCATE `+AttributesTable+`, `+ConsentTable+`,
		oolix_audience_members, oolix_audience_materialization, oolix_segment_membership`)
	return err
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}
