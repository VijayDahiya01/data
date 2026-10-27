package managed

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/oolix/partner-agent/internal/detect"
	"github.com/oolix/partner-agent/internal/localstore"
	"github.com/oolix/partner-agent/internal/source"
)

// What the Partner's own system can tell its Agent directly, between nightly
// refreshes (docs/DESIGN-PARTNER-DATA.md §3.1, rung 7):
//
//   - a customer withdrew consent: out of the copy and every audience at
//     once, and remembered, so the next refresh cannot bring them back while
//     the table still says yes;
//   - a customer gave it again: the withdrawal is forgotten, and the next
//     refresh copies them if the table agrees;
//   - customers changed: whole rows, as in the table, cleaned with the same
//     choices as the nightly refresh and applied to the copy straight away.
//
// Calls carry a token the setup page shows; nothing else on the Partner's
// network can change the copy.

const (
	keyPushToken = "push_token"
	// MaxPushRows caps one call; a bigger change is what the nightly refresh is for.
	MaxPushRows = 1000
)

var (
	// ErrBusy means a refresh is running; pushed customers wait for it.
	ErrBusy = errors.New("a refresh is running: send these customers again in a few minutes")
	// ErrNotPublished means there is no copy to change yet.
	ErrNotPublished = errors.New("this Agent has not published a copy yet: finish the setup page first")
)

// PushRowsError says what is wrong with pushed rows, for the caller to fix.
type PushRowsError struct{ Problem string }

func (e *PushRowsError) Error() string { return e.Problem }

// PushToken is the token the Partner's system sends with each push, made the
// first time it is asked for.
func PushToken(ctx context.Context, store *localstore.Store) (string, error) {
	var token string
	if ok, err := store.Get(ctx, keyPushToken, &token); err != nil {
		return "", err
	} else if ok && token != "" {
		return token, nil
	}
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	token = "oxp_" + hex.EncodeToString(b)
	return token, store.Put(ctx, keyPushToken, token)
}

// PushAuthorized checks a token sent with a push.
func PushAuthorized(ctx context.Context, store *localstore.Store, given string) bool {
	var token string
	if ok, err := store.Get(ctx, keyPushToken, &token); err != nil || !ok || token == "" || given == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(token), []byte(given)) == 1
}

// WithdrawConsent takes a customer out of the copy and every audience, at
// once, and remembers it.
func WithdrawConsent(ctx context.Context, store *localstore.Store, partnerUserID string, now time.Time) error {
	id := strings.TrimSpace(partnerUserID)
	if id == "" {
		return &PushRowsError{"partner_user_id is empty"}
	}
	scrambled := store.ScrambleID(id)
	return inTx(ctx, store, func(tx pgx.Tx) error {
		for _, st := range []struct {
			sql  string
			args []any
		}{
			{`INSERT INTO ` + localstore.WithdrawalsTable + ` (partner_user_id, withdrawn_at) VALUES ($1, $2)
			  ON CONFLICT (partner_user_id) DO UPDATE SET withdrawn_at = excluded.withdrawn_at`,
				[]any{scrambled, now.UTC()}},
			{`DELETE FROM ` + localstore.AttributesTable + ` WHERE partner_user_id = $1`, []any{scrambled}},
			{`DELETE FROM ` + localstore.ConsentTable + ` WHERE partner_user_id = $1`, []any{scrambled}},
			{`DELETE FROM oolix_audience_members WHERE partner_user_id = $1`, []any{scrambled}},
		} {
			if _, err := tx.Exec(ctx, st.sql, st.args...); err != nil {
				return err
			}
		}
		return nil
	})
}

// RestoreConsent forgets a withdrawal: the customer is copied again at the
// next refresh, if the table says they agreed.
func RestoreConsent(ctx context.Context, store *localstore.Store, partnerUserID string) error {
	id := strings.TrimSpace(partnerUserID)
	if id == "" {
		return &PushRowsError{"partner_user_id is empty"}
	}
	_, err := store.Pool.Exec(ctx, `DELETE FROM `+localstore.WithdrawalsTable+` WHERE partner_user_id = $1`,
		store.ScrambleID(id))
	return err
}

// withdrawals are the customers withdrawn through a push, by scrambled id.
func withdrawals(ctx context.Context, store *localstore.Store) (map[string]time.Time, error) {
	rows, err := store.Pool.Query(ctx, `SELECT partner_user_id, withdrawn_at FROM `+localstore.WithdrawalsTable)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]time.Time{}
	for rows.Next() {
		var id string
		var at time.Time
		if err := rows.Scan(&id, &at); err != nil {
			return nil, err
		}
		out[id] = at
	}
	return out, rows.Err()
}

// ApplyPushed applies customers the Partner's system sent: whole rows, keyed
// by the table's own column names, cleaned exactly as the nightly refresh
// would clean them. A row whose consent says no takes the customer out.
func (r *Runner) ApplyPushed(ctx context.Context, rows []source.Row) (Report, error) {
	if !r.mu.TryLock() {
		return Report{}, ErrBusy
	}
	defer r.mu.Unlock()
	s := Settings{r.Store}
	m, err := s.Mapping(ctx)
	if err != nil {
		return Report{}, err
	}
	if m == nil || m.PublishedAt == nil {
		return Report{}, ErrNotPublished
	}
	if cfg, err := s.Source(ctx); err == nil && cfg != nil {
		m.Location = cfg.Location
	}
	if len(rows) == 0 {
		return Report{}, &PushRowsError{"no rows"}
	}
	if len(rows) > MaxPushRows {
		return Report{}, &PushRowsError{fmt.Sprintf("at most %d rows a call", MaxPushRows)}
	}
	// Whole rows only: a column left out would blank that attribute, and a
	// row without its consent column would read as "no".
	need := m.PushColumns()
	for i, row := range rows {
		var missing []string
		for _, c := range need {
			if _, ok := row[c]; !ok {
				missing = append(missing, c)
			}
		}
		if len(missing) > 0 {
			return Report{}, &PushRowsError{fmt.Sprintf("row %d lacks %s: send whole rows, with every column "+
				"the setup page matched", i+1, strings.Join(missing, ", "))}
		}
	}
	return run(ctx, pushedRows(rows), r.Store, *m, r.Now(), runOptions{pushed: true})
}

// PushColumns are the columns a pushed row must carry.
func (m Mapping) PushColumns() []string {
	cols := []string{m.IDColumn}
	add := func(c string) {
		if c != "" && !slices.Contains(cols, c) {
			cols = append(cols, c)
		}
	}
	provides := ActivityProvides(m)
	for key, am := range m.Attributes {
		if provides[key] {
			continue
		}
		add(am.Column)
		if am.Form.NeedsAsOf() && am.AsOf == AsOfColumn {
			add(am.AsOfColumn)
		}
	}
	if !m.Consent.Everyone {
		add(m.Consent.Column)
	}
	add(m.Consent.Withdrawal)
	slices.Sort(cols[1:])
	return cols
}

// pushedRows is a source made of rows the Partner's system sent.
type pushedRows []source.Row

func (p pushedRows) Test(context.Context) error                     { return nil }
func (p pushedRows) Tables(context.Context) ([]source.Table, error) { return nil, nil }
func (p pushedRows) Columns(context.Context, string) ([]detect.Column, error) {
	return nil, nil
}
func (p pushedRows) Sample(context.Context, string, int) (map[string][]any, error) { return nil, nil }
func (p pushedRows) Close() error                                                  { return nil }

func (p pushedRows) Stream(_ context.Context, _ string, columns []string, fn func(source.Row) error) error {
	for _, r := range p {
		row := make(source.Row, len(columns))
		for _, c := range columns {
			row[c] = r[c]
		}
		if err := fn(row); err != nil {
			return err
		}
	}
	return nil
}
