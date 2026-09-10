// Package config loads the Partner Agent configuration file described in
// spec v5 §69.1.
//
// The Agent runs INSIDE the Data Partner. Everything it needs is declared in
// one YAML file the Partner controls; there is no Oolix-supplied setting that
// can widen what the Agent reads or where it sends data.
package config

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Config mirrors §69.1's example configuration file.
type Config struct {
	Agent     AgentConfig     `yaml:"agent"`
	Oolix     OolixConfig     `yaml:"oolix"`
	Connector ConnectorConfig `yaml:"connector"`
	State     StateConfig     `yaml:"state"`
	Channels  ChannelsConfig  `yaml:"channels"`
	Logging   LoggingConfig   `yaml:"logging"`
}

type AgentConfig struct {
	PartnerID string `yaml:"partner_id"`
	// ListenAddr binds the PRIVATE local API (§12). It must never be exposed
	// to the public internet: the Partner backend reaches it over a private
	// network, and it is the one hop that carries a customer identifier.
	ListenAddr          string        `yaml:"listen_addr"`
	ControlSyncInterval time.Duration `yaml:"control_sync_interval"`
	// StaleGrace bounds how long the Agent may keep serving from cache when
	// Oolix is unreachable (§75). Also bounded by config_expires_at inside
	// each manifest, whichever is sooner.
	StaleGrace time.Duration `yaml:"stale_grace"`
	// DecisionTimeout caps the whole ad decision. §103 budgets p95 < 100ms and
	// the SDK gives up at 150ms, so exceeding this is worse than NO_AD.
	DecisionTimeout time.Duration `yaml:"decision_timeout"`
}

type OolixConfig struct {
	APIBaseURL string `yaml:"api_base_url"`
	// Credentials issued during §92 registration.
	ClientID string `yaml:"client_id"`
	AgentID  string `yaml:"agent_id"`
	// PrivateKeyPath holds the Agent's P-256 private key. §92.2: it never
	// leaves Partner infrastructure.
	PrivateKeyPath string `yaml:"private_key_path"`
	// ManifestIssuer and ManifestAudience are PINNED, not discovered. §75
	// requires the Agent to pin them so a manifest signed for another
	// environment cannot be replayed here.
	ManifestIssuer   string `yaml:"manifest_issuer"`
	ManifestAudience string `yaml:"manifest_audience"`
	TokenAudience    string `yaml:"token_audience"`
	JWKSPath         string `yaml:"jwks_path"`
}

type ConnectorConfig struct {
	// Type selects a §7.1 integration mode. Only postgres_view is implemented
	// for the MVP; the interface exists so a warehouse or internal-API
	// connector slots in without touching the decision path.
	Type string `yaml:"type"`
	// DSN is read from a secret reference where possible (§69.1). A literal
	// dsn is permitted for local development only.
	DSN          string `yaml:"dsn"`
	DSNSecretRef string `yaml:"dsn_secret_ref"`
	// MembershipQuery is Partner-authored and parameterised. §7.2 requires it
	// to hit a PRE-COMPUTED membership table, never a booking/order join.
	MembershipQuery string `yaml:"membership_query"`
	ConsentQuery    string `yaml:"consent_query"`
	MaxOpenConns    int    `yaml:"max_open_conns"`
	// QueryTimeout keeps a slow source inside the decision budget (§103:
	// segment lookup p95 < 30ms). On timeout the Agent fails CLOSED.
	QueryTimeout time.Duration `yaml:"query_timeout"`

	// Audience is the v6 §5.2 local mapping. It is PARTNER-OWNED: Oolix asks
	// about `payment_method`, this Partner stores `pay_mode`, and nothing Oolix
	// sends can change or widen what is mapped here.
	Audience AudienceConfig `yaml:"audience"`
}

// AudienceConfig is the Partner-local half of v6.
//
// §5.2 is explicit that the mapping stays local, and §17 restates it: Oolix
// stores "Partner capability metadata, not Partner customer records or Partner
// local field names". Everything in this struct is a local field name, which is
// exactly why it lives in the Partner's config file and nowhere else.
type AudienceConfig struct {
	// AttributeTable is the restricted, PRE-COMPUTED source the Agent may read
	// (§5.2: "Do not dynamically join a large transactional production schema
	// for every estimate or ad request").
	AttributeTable string `yaml:"attribute_table"`

	// MappingVersion is reported alongside a reach estimate so the answer can be
	// tied to the mapping that produced it (§8.2, §16).
	MappingVersion int `yaml:"mapping_version"`

	// Mapping translates an Oolix attribute key to a local SQL expression.
	// Derived attributes are the norm rather than the exception -- §5.2's own
	// examples are age "derived from dob" and purchase_recency_days "derived
	// from last_order_at".
	Mapping map[string]AttributeMapping `yaml:"mapping"`

	// EvaluationTimeout bounds a full-table count. It is deliberately far
	// larger than QueryTimeout: an estimate is an offline operation a Buyer
	// waits seconds for, not an ad decision on a page-render path.
	EvaluationTimeout time.Duration `yaml:"evaluation_timeout"`

	// MaterializationTTL is how long a compiled audience stays servable before
	// the Agent must rebuild it (§11 refresh schedule).
	MaterializationTTL time.Duration `yaml:"materialization_ttl"`
}

// AttributeMapping is one Oolix attribute expressed in the Partner's schema.
type AttributeMapping struct {
	Expr string `yaml:"expr"`
	Type string `yaml:"type"`

	// Column and Derive turn a derived attribute into something an index can
	// serve.
	//
	// Expr alone is correct but unindexable: `date_part('year', age(dob))`
	// wraps the column in a function, so no index on dob applies and every
	// audience carrying an age rule reads the whole table. Naming the raw
	// column, and how the value is derived from it, lets the compiler emit a
	// range over dob instead. Optional -- an attribute without them keeps using
	// Expr exactly as before.
	Column string `yaml:"column"`
	Derive string `yaml:"derive"`
}

// UnmarshalYAML accepts either a bare column name or the full form.
//
//	payment_method: pay_mode          # a plain rename
//	age:                              # a derived attribute
//	  expr: "date_part('year', age(dob))"
//	  type: NUMBER
//	  column: dob
//	  derive: years_since
//
// Most mappings are a rename and nothing more, and making a Partner write three
// lines to say so invites the copy-paste mistakes this file is trying to
// prevent. The shorthand is also the form the integration guide teaches, and a
// documented form the parser rejects is a defect in one of the two.
//
// Unknown keys are still refused. yaml.v3 does not carry KnownFields into a
// custom unmarshaler, so the check is made explicitly rather than assumed.
func (m *AttributeMapping) UnmarshalYAML(node *yaml.Node) error {
	if node.Kind == yaml.ScalarNode {
		var expr string
		if err := node.Decode(&expr); err != nil {
			return err
		}
		if strings.TrimSpace(expr) == "" {
			return fmt.Errorf("line %d: an attribute mapping cannot be empty", node.Line)
		}
		m.Expr = expr
		return nil
	}
	if node.Kind != yaml.MappingNode {
		return fmt.Errorf(
			"line %d: an attribute mapping must be a column name or a block with `expr`", node.Line)
	}

	known := map[string]bool{"expr": true, "type": true, "column": true, "derive": true}
	for i := 0; i < len(node.Content)-1; i += 2 {
		if key := node.Content[i].Value; !known[key] {
			return fmt.Errorf("line %d: unknown mapping field %q", node.Content[i].Line, key)
		}
	}

	// An alias, so decoding the block does not call this method again.
	type plain AttributeMapping
	var p plain
	if err := node.Decode(&p); err != nil {
		return err
	}
	*m = AttributeMapping(p)
	return nil
}

type StateConfig struct {
	// Mode is "embedded" for a single replica or "redis" for several.
	//
	// §76.1 is explicit: "If one Partner Agent has multiple replicas,
	// frequency/pacing state MUST use shared Partner-local Redis. In-process
	// memory is not acceptable for multi-replica production." Getting this
	// wrong silently multiplies a Partner's frequency cap by the replica count.
	Mode           string `yaml:"mode"`
	Path           string `yaml:"path"`
	RedisURL       string `yaml:"redis_url"`
	RedisKeyPrefix string `yaml:"redis_key_prefix"`
}

type ChannelsConfig struct {
	Meta   MetaChannelConfig   `yaml:"meta"`
	Google GoogleChannelConfig `yaml:"google"`
	// Export names where matching identifiers live. Required for any external
	// activation, and deliberately separate from the targeting attributes.
	Export ExportConfig `yaml:"export"`
}

// ExportConfig is the only place the Agent is told how to read contact
// details in bulk (§47.8, §47.9).
//
// It is separate from connector.audience on purpose. The attribute table holds
// TARGETING attributes -- age band, city code, loyalty tier -- and deliberately
// holds no contact details, because the ad-decision path never needs them and a
// table without an email address cannot leak one. Matching identifiers live
// somewhere else, and a Partner names that place here or not at all.
//
// §47.9: "Agent selects only allowed matching fields." A field absent from
// `fields` is one the Agent cannot read -- not one it chooses not to send.
type ExportConfig struct {
	// IdentityTable is keyed by partner_user_id.
	IdentityTable string `yaml:"identity_table"`
	// MembersTable defaults to oolix_audience_members.
	MembersTable string `yaml:"members_table"`
	// Fields maps an Oolix identifier kind (email, phone, first_name,
	// last_name, country, zip, mobile_id) to the Partner's own column.
	Fields map[string]string `yaml:"fields"`
}

// MetaChannelConfig is the Partner's side of a Meta activation (§15, §47).
//
// The credential lives HERE, in the Partner's own configuration, and never
// reaches Oolix. §17: "raw audience data and ingestion credentials execute
// inside Partner Agent; Oolix stores account IDs, authorization state,
// resource IDs and non-sensitive configuration." Oolix knows the ad account
// number; only this file knows the token that acts on it.
type MetaChannelConfig struct {
	Enabled bool `yaml:"enabled"`

	// AccessTokenSecretRef is the preferred form: `secret://name` resolved
	// from the environment, so a real secret manager can be substituted
	// without a config change. AccessToken exists for local development and
	// should not be used on a Partner's host.
	AccessTokenSecretRef string `yaml:"access_token_secret_ref"`
	AccessToken          string `yaml:"access_token"`

	// AdAccountID is the ADVERTISER's account, without the "act_" prefix.
	AdAccountID string `yaml:"ad_account_id"`
	BusinessID  string `yaml:"business_id"`
	APIVersion  string `yaml:"api_version"`
}

// GoogleChannelConfig is the Partner's side of a Google activation (§16, §48).
//
// The three account ids are distinct things: the operating account owns the
// audience, the login account is the manager acting on its behalf, and the
// destination is the user list itself. Using the wrong one returns a 403 that
// reads like a permissions problem rather than a routing mistake.
type GoogleChannelConfig struct {
	Enabled bool `yaml:"enabled"`

	AccessTokenSecretRef string `yaml:"access_token_secret_ref"`
	AccessToken          string `yaml:"access_token"`

	OperatingAccountID   string `yaml:"operating_account_id"`
	LoginAccountID       string `yaml:"login_account_id"`
	ProductDestinationID string `yaml:"product_destination_id"`
}

// resolveSecret follows the same `secret://` convention as ResolveDSN.
//
// A reference that does not resolve is an error rather than a silent fallback
// to empty: an adapter built with an empty token sends unauthenticated
// requests, and the resulting 401 says nothing about the missing secret.
func resolveSecret(ref, inline, what string) (string, error) {
	if ref == "" {
		return inline, nil
	}
	name := strings.TrimPrefix(ref, "secret://")
	envKey := strings.ToUpper(strings.NewReplacer("/", "_", "-", "_").Replace(name))
	if v := os.Getenv(envKey); v != "" {
		return v, nil
	}
	if inline != "" {
		return inline, nil
	}
	return "", fmt.Errorf("%s secret reference %q did not resolve (looked for env %s)", what, ref, envKey)
}

// ResolveMetaToken returns the Meta access token, from the secret store if one
// is referenced.
func (c *Config) ResolveMetaToken() (string, error) {
	return resolveSecret(c.Channels.Meta.AccessTokenSecretRef, c.Channels.Meta.AccessToken, "meta")
}

// ResolveGoogleToken returns the Google OAuth token.
func (c *Config) ResolveGoogleToken() (string, error) {
	return resolveSecret(c.Channels.Google.AccessTokenSecretRef, c.Channels.Google.AccessToken, "google")
}

type LoggingConfig struct {
	Level  string `yaml:"level"`
	Format string `yaml:"format"`
	// RedactFields names what must never reach a log line (§69.1, §78.1).
	RedactFields []string `yaml:"redact_fields"`
}

// Load reads, defaults and validates the configuration file.
func Load(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}

	// Strict decoding: an unrecognised key is an error, not something to skip.
	//
	// A silently ignored key is the worst outcome available here. Writing
	// `mappings:` where the parser expects `mapping:` left the Agent running
	// happily with audience evaluation switched off -- matching nobody, logging
	// one INFO line, and looking entirely healthy. A Partner has no way to spot
	// that from the outside. Refusing to start names the typo instead.
	var cfg Config
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	dec.KnownFields(true)
	if err := dec.Decode(&cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}

	cfg.applyDefaults()
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func (c *Config) applyDefaults() {
	if c.Agent.ListenAddr == "" {
		c.Agent.ListenAddr = "0.0.0.0:8082"
	}
	if c.Agent.ControlSyncInterval == 0 {
		c.Agent.ControlSyncInterval = 30 * time.Second // §75
	}
	if c.Agent.StaleGrace == 0 {
		c.Agent.StaleGrace = 15 * time.Minute // §75 canonical stale grace
	}
	if c.Agent.DecisionTimeout == 0 {
		// Comfortably inside the SDK's 150ms hard timeout (§68).
		c.Agent.DecisionTimeout = 100 * time.Millisecond
	}
	if c.Connector.QueryTimeout == 0 {
		c.Connector.QueryTimeout = 30 * time.Millisecond // §103
	}
	if c.Connector.MaxOpenConns == 0 {
		c.Connector.MaxOpenConns = 10
	}
	if c.State.Mode == "" {
		c.State.Mode = "embedded"
	}
	if c.State.RedisKeyPrefix == "" {
		c.State.RedisKeyPrefix = "oolix:agent"
	}
	if c.Oolix.ManifestAudience == "" {
		c.Oolix.ManifestAudience = "oolix-partner-agent"
	}
	if c.Oolix.TokenAudience == "" {
		c.Oolix.TokenAudience = "oolix-agent-api"
	}
	if c.Logging.Level == "" {
		c.Logging.Level = "info"
	}
	if c.Logging.Format == "" {
		c.Logging.Format = "json"
	}
	if len(c.Logging.RedactFields) == 0 {
		c.Logging.RedactFields = []string{"partner_user_id", "email", "phone", "mobile_id"}
	}
}

func (c *Config) validate() error {
	var problems []string

	// A half-written audience block is the failure that hides. Naming the table
	// but no mapping parses cleanly, starts cleanly, and matches nobody -- the
	// Partner appears integrated and is invisible to every Buyer. Say so at
	// start-up instead. Omitting the whole block stays perfectly valid: that is
	// a Partner who has deliberately published no attributes.
	a := c.Connector.Audience
	if a.AttributeTable != "" && len(a.Mapping) == 0 {
		problems = append(problems,
			"connector.audience.attribute_table is set but connector.audience.mapping is empty: "+
				"audience evaluation would be silently disabled and this Partner would match no "+
				"campaign. The key is `mapping:`, not `mappings:`")
	}
	for key, m := range a.Mapping {
		if m.Expr == "" {
			problems = append(problems,
				"connector.audience.mapping."+key+" has no `expr`")
		}
		// Half a derived mapping is worse than none: it reads as tuned while
		// quietly using the slow path.
		if (m.Column == "") != (m.Derive == "") {
			problems = append(problems,
				"connector.audience.mapping."+key+" needs `column` and `derive` together, or neither")
		}
	}

	if c.Agent.PartnerID == "" {
		problems = append(problems, "agent.partner_id is required")
	}
	if c.Oolix.APIBaseURL == "" {
		problems = append(problems, "oolix.api_base_url is required")
	}
	if c.Oolix.ManifestIssuer == "" {
		// §75 requires issuer pinning. Without it the Agent would accept a
		// manifest signed by any environment holding a trusted key.
		problems = append(problems, "oolix.manifest_issuer is required (spec §75 issuer pinning)")
	}
	if c.Connector.Type == "" {
		problems = append(problems, "connector.type is required")
	}
	if c.Connector.Type == "postgres_view" {
		if c.Connector.DSN == "" && c.Connector.DSNSecretRef == "" {
			problems = append(problems, "connector.dsn or connector.dsn_secret_ref is required")
		}
		if c.Connector.MembershipQuery == "" {
			problems = append(problems, "connector.membership_query is required")
		}
	}
	if c.State.Mode == "redis" && c.State.RedisURL == "" {
		// §76.1: a multi-replica Agent with no shared store would enforce the
		// frequency cap per replica, silently multiplying a Partner's cap.
		problems = append(problems, "state.redis_url is required when state.mode is redis (spec §76.1)")
	}
	if c.State.Mode != "embedded" && c.State.Mode != "redis" {
		problems = append(problems, `state.mode must be "embedded" or "redis"`)
	}

	// An external channel switched on but not configured is the same class of
	// failure as a half-written audience block: it parses, it starts, and it
	// only fails at the moment an upload is attempted -- by which point a Buyer
	// has been told the campaign is live. §47.1 and §48.1 both require the
	// account relationship to exist BEFORE any activation.
	if m := c.Channels.Meta; m.Enabled {
		if m.AccessToken == "" && m.AccessTokenSecretRef == "" {
			problems = append(problems,
				"channels.meta.enabled is true but no access_token_secret_ref (or access_token) is set")
		}
		if m.AdAccountID == "" {
			problems = append(problems,
				"channels.meta.enabled is true but channels.meta.ad_account_id is empty")
		}
	}
	if g := c.Channels.Google; g.Enabled {
		if g.AccessToken == "" && g.AccessTokenSecretRef == "" {
			problems = append(problems,
				"channels.google.enabled is true but no access_token_secret_ref (or access_token) is set")
		}
		if g.OperatingAccountID == "" {
			problems = append(problems,
				"channels.google.enabled is true but channels.google.operating_account_id is empty")
		}
		if g.ProductDestinationID == "" {
			problems = append(problems,
				"channels.google.enabled is true but channels.google.product_destination_id is empty: "+
					"there is no user list to ingest into")
		}
	}

	if len(problems) > 0 {
		return errors.New("invalid agent configuration:\n  - " + strings.Join(problems, "\n  - "))
	}
	return nil
}

// ResolveDSN returns the connector DSN, preferring a secret reference.
//
// §69.1: "Secrets stay in partner secret store, not plain environment files
// where possible." The secret:// scheme is resolved from the environment here
// so a real secret manager can be substituted without a config change.
func (c *Config) ResolveDSN() (string, error) {
	if c.Connector.DSNSecretRef != "" {
		ref := strings.TrimPrefix(c.Connector.DSNSecretRef, "secret://")
		envKey := strings.ToUpper(strings.NewReplacer("/", "_", "-", "_").Replace(ref))
		if v := os.Getenv(envKey); v != "" {
			return v, nil
		}
		if c.Connector.DSN == "" {
			return "", fmt.Errorf("secret reference %q did not resolve (looked for env %s)", c.Connector.DSNSecretRef, envKey)
		}
	}
	return c.Connector.DSN, nil
}
