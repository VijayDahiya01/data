// Package managed runs the Agent in managed mode: the Partner points it at
// their database from a web page, and it keeps a cleaned copy up to date by
// itself, publishes what it can answer, and serves ad decisions from the copy.
package managed

import (
	"context"
	"time"

	"github.com/oolix/partner-agent/internal/clean"
	"github.com/oolix/partner-agent/internal/localstore"
	"github.com/oolix/partner-agent/internal/source"
)

// Setting keys in the local store.
const (
	keyIdentity = "identity"
	keySource   = "source"
	keyMapping  = "mapping"
	keyDraft    = "mapping_draft"
	keyLastSync = "last_sync"
	keyLastGood = "last_good_sync"
	keyLastFull = "last_full_sync"
	keyMark     = "watermark"
	keyPublish  = "published"
)

// Identity is what registering with Oolix produced. The private key it goes
// with lives in the Agent's state folder, never in the database.
type Identity struct {
	AgentID          string    `json:"agent_id"`
	ClientID         string    `json:"client_id"`
	PartnerOrgID     string    `json:"partner_org_id"`
	ManifestIssuer   string    `json:"manifest_issuer"`
	ManifestAudience string    `json:"manifest_audience"`
	TokenAudience    string    `json:"token_audience"`
	RegisteredAt     time.Time `json:"registered_at"`
}

// SourceSettings is how to reach the Partner's database. The password, and a
// connection string (which may carry one), are kept sealed with the local
// secret: Config.Password and Config.URI are always empty at rest.
type SourceSettings struct {
	Config         source.Config `json:"config"`
	SealedPassword string        `json:"sealed_password,omitempty"`
	SealedURI      string        `json:"sealed_uri,omitempty"`
}

// AttributeMapping says where one standard attribute comes from.
type AttributeMapping struct {
	Column string `json:"column"`
	// Order is how numeric dates in the column are written.
	Order clean.Order `json:"order,omitempty"`
	// Overrides are the Partner's answers for values the cleaner did not
	// recognise: raw value -> code, or "" to ignore it.
	Overrides map[string]string `json:"overrides,omitempty"`
	// Publish offers the attribute to Buyers. A Partner may copy an attribute
	// and still choose not to be asked about it.
	Publish bool `json:"publish"`
}

// ConsentMapping says where marketing consent comes from. Without it nobody
// is eligible for advertising -- the safe direction.
type ConsentMapping struct {
	// Column is a yes/no flag, or the date consent was given.
	Column string `json:"column,omitempty"`
	// Withdrawal is an optional yes/no flag, or the date consent was taken back.
	Withdrawal string `json:"withdrawal,omitempty"`
	// Everyone is the Partner's statement that every customer in the table
	// agreed to marketing -- an export of opted-in customers, say. Recorded
	// with when it was made.
	Everyone   bool       `json:"everyone,omitempty"`
	AttestedAt *time.Time `json:"attested_at,omitempty"`
}

// ActivityMapping is a table with one row per order, or one per booking. It
// is read at every sync alongside the customer table, and summed up per
// customer: when they last bought, how often, what they buy most and how they
// pay; when they last booked and where.
type ActivityMapping struct {
	Table string `json:"table"`
	// CustomerColumn holds the same customer id as the customer table.
	CustomerColumn string `json:"customer_column"`
	// DateColumn is when the order was placed or the booking made.
	DateColumn string      `json:"date_column"`
	Order      clean.Order `json:"order,omitempty"`
	// Orders only: what was bought and how it was paid for.
	CategoryColumn string `json:"category_column,omitempty"`
	PaymentColumn  string `json:"payment_column,omitempty"`
	// ChannelColumn says where each order was placed; AllOnline, that every
	// order in the table was placed online.
	ChannelColumn string `json:"channel_column,omitempty"`
	AllOnline     bool   `json:"all_online,omitempty"`
	// Bookings only: domestic or international.
	TripColumn string `json:"trip_column,omitempty"`
	// Overrides are the Partner's answers for values that were not
	// recognised, per attribute key: raw value -> code, or "" to ignore it.
	Overrides map[string]map[string]string `json:"overrides,omitempty"`
	// Withhold lists attributes worked out from this table that the Partner
	// chose not to offer to advertisers. Everything else it supplies is
	// offered.
	Withhold []string `json:"withhold,omitempty"`
}

// Mapping is everything the setup page decided.
type Mapping struct {
	Table      string                      `json:"table"`
	IDColumn   string                      `json:"id_column"`
	Attributes map[string]AttributeMapping `json:"attributes"`
	Consent    ConsentMapping              `json:"consent"`
	// Orders and Bookings are optional tables with one row per order or per
	// booking. The attributes they provide are not read from the customer
	// table.
	Orders   *ActivityMapping `json:"orders,omitempty"`
	Bookings *ActivityMapping `json:"bookings,omitempty"`
	// UpdatedColumn is a date-time column the Partner's system sets whenever a
	// customer row changes. With it the nightly refresh reads only the rows
	// changed since the last one; a full refresh still runs once a week,
	// which is what notices customers deleted from the table.
	UpdatedColumn string `json:"updated_column,omitempty"`
	// Location is the time zone the Partner's times are written in. It is
	// taken from the source settings at each sync.
	Location string `json:"location,omitempty"`
	// SyncHour is when the nightly refresh runs, in Location.
	SyncHour int `json:"sync_hour"`
	// Channels are where the Partner shows ads: PARTNER_WEB, PARTNER_APP.
	Channels []string `json:"channels,omitempty"`
	// PublishedAt is set when the Partner publishes, and cleared when they
	// delete the copy. Nightly syncs run only while it is set.
	PublishedAt *time.Time `json:"published_at,omitempty"`
	UpdatedAt   time.Time  `json:"updated_at"`
}

// PublishRecord is the last attempt to tell Oolix what this Agent can answer.
type PublishRecord struct {
	At           time.Time    `json:"at"`
	Capabilities Capabilities `json:"capabilities"`
	// Withdrawn marks the attributes being taken back after a delete.
	Withdrawn bool   `json:"withdrawn,omitempty"`
	Error     string `json:"error,omitempty"`
}

// Settings reads and writes managed-mode settings.
type Settings struct{ Store *localstore.Store }

func (s Settings) Identity(ctx context.Context) (*Identity, error) {
	var id Identity
	ok, err := s.Store.Get(ctx, keyIdentity, &id)
	if err != nil || !ok {
		return nil, err
	}
	return &id, nil
}

func (s Settings) SaveIdentity(ctx context.Context, id Identity) error {
	return s.Store.Put(ctx, keyIdentity, id)
}

// Source returns the source settings with the password unsealed.
func (s Settings) Source(ctx context.Context) (*source.Config, error) {
	var ss SourceSettings
	ok, err := s.Store.Get(ctx, keySource, &ss)
	if err != nil || !ok {
		return nil, err
	}
	cfg := ss.Config
	if ss.SealedPassword != "" {
		pw, err := s.Store.Unseal(ss.SealedPassword)
		if err != nil {
			return nil, err
		}
		cfg.Password = pw
	}
	if ss.SealedURI != "" {
		uri, err := s.Store.Unseal(ss.SealedURI)
		if err != nil {
			return nil, err
		}
		cfg.URI = uri
	}
	return &cfg, nil
}

// SaveSource stores the source settings, sealing the password and any
// connection string.
func (s Settings) SaveSource(ctx context.Context, cfg source.Config) error {
	ss := SourceSettings{Config: cfg}
	var err error
	if cfg.Password != "" {
		if ss.SealedPassword, err = s.Store.Seal(cfg.Password); err != nil {
			return err
		}
	}
	if cfg.URI != "" {
		if ss.SealedURI, err = s.Store.Seal(cfg.URI); err != nil {
			return err
		}
	}
	ss.Config.Password, ss.Config.URI = "", ""
	return s.Store.Put(ctx, keySource, ss)
}

func (s Settings) Mapping(ctx context.Context) (*Mapping, error) {
	var m Mapping
	ok, err := s.Store.Get(ctx, keyMapping, &m)
	if err != nil || !ok {
		return nil, err
	}
	return &m, nil
}

func (s Settings) SaveMapping(ctx context.Context, m Mapping) error {
	m.UpdatedAt = time.Now().UTC()
	return s.Store.Put(ctx, keyMapping, m)
}

// Draft is the mapping being edited on the setup page. It replaces the live
// mapping only when the Partner publishes, so half-made choices never reach
// a nightly sync. Without a draft, editing starts from the live mapping.
func (s Settings) Draft(ctx context.Context) (*Mapping, error) {
	var m Mapping
	ok, err := s.Store.Get(ctx, keyDraft, &m)
	if err != nil {
		return nil, err
	}
	if ok {
		return &m, nil
	}
	return s.Mapping(ctx)
}

func (s Settings) SaveDraft(ctx context.Context, m Mapping) error {
	m.UpdatedAt = time.Now().UTC()
	return s.Store.Put(ctx, keyDraft, m)
}

// Publish makes the draft the live mapping.
func (s Settings) Publish(ctx context.Context, m Mapping, at time.Time) error {
	at = at.UTC()
	m.PublishedAt = &at
	if err := s.SaveMapping(ctx, m); err != nil {
		return err
	}
	return s.Store.Delete(ctx, keyDraft)
}

// Forget removes the database login and every choice made on the setup page.
// The registration with Oolix is kept.
func (s Settings) Forget(ctx context.Context) error {
	for _, key := range []string{keySource, keyMapping, keyDraft, keyPublish, keyMark, keyLastFull} {
		if err := s.Store.Delete(ctx, key); err != nil {
			return err
		}
	}
	return nil
}

// LastSync is the most recent sync, which may have failed.
func (s Settings) LastSync(ctx context.Context) (*Report, error) {
	return s.report(ctx, keyLastSync)
}

// LastFullSync is the most recent successful full sync.
func (s Settings) LastFullSync(ctx context.Context) (*Report, error) {
	return s.report(ctx, keyLastFull)
}

// Watermark is the latest change time read from the updated-at column: the
// next incremental sync reads from just before it.
func (s Settings) Watermark(ctx context.Context) (*time.Time, error) {
	var t time.Time
	ok, err := s.Store.Get(ctx, keyMark, &t)
	if err != nil || !ok {
		return nil, err
	}
	return &t, nil
}

// LastGoodSync is the sync that produced the copy being served now.
func (s Settings) LastGoodSync(ctx context.Context) (*Report, error) {
	return s.report(ctx, keyLastGood)
}

func (s Settings) report(ctx context.Context, key string) (*Report, error) {
	var r Report
	ok, err := s.Store.Get(ctx, key, &r)
	if err != nil || !ok {
		return nil, err
	}
	return &r, nil
}

func (s Settings) Published(ctx context.Context) (*PublishRecord, error) {
	var p PublishRecord
	ok, err := s.Store.Get(ctx, keyPublish, &p)
	if err != nil || !ok {
		return nil, err
	}
	return &p, nil
}
