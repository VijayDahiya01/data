// Command agent runs the Oolix Partner Agent -- spec v5 §8, §45, §69.
//
// The Agent runs INSIDE the Data Partner's environment. It is the component
// that makes the whole architecture's central claim true: user-level ad
// decisions happen here, against the Partner's own data, and no customer
// identifier ever reaches Oolix (§3, §12).
//
// It is deliberately a single binary with no external orchestration: §69.2
// gives it modest resource requests and §8.1 expects it to run as one
// container, ECS task or systemd service on Partner-managed infrastructure.
package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/oolix/partner-agent/internal/addecision"
	"github.com/oolix/partner-agent/internal/attribution"
	"github.com/oolix/partner-agent/internal/audience"
	"github.com/oolix/partner-agent/internal/channel"
	"github.com/oolix/partner-agent/internal/config"
	"github.com/oolix/partner-agent/internal/connector"
	"github.com/oolix/partner-agent/internal/controlsync"
	"github.com/oolix/partner-agent/internal/eventbuffer"
	"github.com/oolix/partner-agent/internal/httpapi"
	"github.com/oolix/partner-agent/internal/localstore"
	"github.com/oolix/partner-agent/internal/managed"
	"github.com/oolix/partner-agent/internal/metrics"
	"github.com/oolix/partner-agent/internal/setupui"
	"github.com/oolix/partner-agent/internal/state"
)

func main() {
	configPath := flag.String("config", "config.local.yaml", "path to the agent configuration file")
	showVersion := flag.Bool("version", false, "print the agent version and exit")
	register := flag.Bool("register", false,
		"exchange a bootstrap token for an identity, then exit (§92.2)")
	managedMode := flag.Bool("managed", false,
		"run in managed mode, configured from OOLIX_* environment variables (the Compose bundle)")
	flag.Parse()

	if *showVersion {
		fmt.Println(controlsync.Version)
		return
	}

	// Registration is its own mode rather than something start-up does when it
	// finds no key. It spends a single-use token and creates a lasting
	// identity, so it should happen because someone asked for it — not because
	// a volume was lost and the Agent quietly minted a second one while the
	// first still showed as live in the Partner's console.
	if *register {
		if *managedMode {
			fmt.Fprintln(os.Stderr, "in managed mode the Agent registers from its setup page")
			os.Exit(2)
		}
		if err := runRegister(*configPath); err != nil {
			fmt.Fprintf(os.Stderr, "registration failed: %v\n", err)
			os.Exit(1)
		}
		return
	}

	if err := run(*configPath, *managedMode); err != nil {
		fmt.Fprintf(os.Stderr, "agent failed: %v\n", err)
		os.Exit(1)
	}
}

// runRegister performs §92.2 and prints what belongs in the configuration file.
//
// The token comes from the environment rather than a flag so it does not land
// in shell history or a process listing.
func runRegister(configPath string) error {
	cfg, err := config.Load(configPath)
	if err != nil {
		return err
	}

	token := os.Getenv("OOLIX_BOOTSTRAP_TOKEN")
	if token == "" {
		return fmt.Errorf(
			"set OOLIX_BOOTSTRAP_TOKEN to the single-use token from the Oolix portal " +
				"(Integrations -> Register a new Agent). It expires in 15 minutes")
	}

	result, err := controlsync.Register(
		context.Background(),
		&http.Client{Timeout: 30 * time.Second},
		cfg.Oolix.APIBaseURL,
		token,
		cfg.Oolix.PrivateKeyPath,
		[]string{"PARTNER_WEB", "PARTNER_APP"},
	)
	if err != nil {
		return err
	}

	fmt.Printf("Registered.\n\n")
	fmt.Printf("  private key: %s (keep it; it never leaves this machine)\n\n",
		cfg.Oolix.PrivateKeyPath)
	fmt.Printf("Add these to the `oolix:` block of %s:\n\n", configPath)
	fmt.Printf("  agent_id:  \"%s\"\n", result.AgentID)
	fmt.Printf("  client_id: \"%s\"\n", result.ClientID)
	if result.Issuer != "" {
		fmt.Printf("  manifest_issuer: \"%s\"\n", result.Issuer)
	}
	if result.Audience != "" {
		fmt.Printf("  token_audience:  \"%s\"\n", result.Audience)
	}
	fmt.Printf("\nThen start the agent normally.\n")
	return nil
}

func run(configPath string, managedMode bool) error {
	var cfg *config.Config
	var err error
	if managedMode {
		cfg, err = config.FromEnv()
	} else {
		cfg, err = config.Load(configPath)
	}
	if err != nil {
		return err
	}

	logger := newLogger(cfg)
	logger.Info("starting Oolix Partner Agent",
		"version", controlsync.Version,
		"partner_id", cfg.Agent.PartnerID,
		"connector", cfg.Connector.Type,
		"state_mode", cfg.State.Mode,
	)

	// §8.1 / §84: external channel adapters stay off unless explicitly
	// enabled AND cleared by the eligibility service. Announced at boot so an
	// operator never has to guess whether a connector is live.
	logger.Info("external channel adapters",
		"meta_enabled", cfg.Channels.Meta.Enabled,
		"google_enabled", cfg.Channels.Google.Enabled)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if cfg.IsManaged() {
		return runManaged(ctx, cfg, logger)
	}

	// --- connector (§7.1) --------------------------------------------------
	dsn, err := cfg.ResolveDSN()
	if err != nil {
		return err
	}
	if cfg.Connector.Type != "postgres_view" {
		return fmt.Errorf("connector type %q is not implemented in the MVP (spec §7.1)", cfg.Connector.Type)
	}
	conn, err := connector.NewPostgresView(ctx, connector.PostgresOptions{
		DSN:             dsn,
		MembershipQuery: cfg.Connector.MembershipQuery,
		ConsentQuery:    cfg.Connector.ConsentQuery,
		MaxOpenConns:    cfg.Connector.MaxOpenConns,
		QueryTimeout:    cfg.Connector.QueryTimeout,
	})
	if err != nil {
		return fmt.Errorf("connector: %w", err)
	}
	defer conn.Close()

	// --- v6 audience evaluation (§5.2, §8.2, §11, §12) ---------------------
	//
	// Optional by design. A Partner that has published no attribute mapping
	// simply cannot be matched to an Audience Group (§7), so there is nothing
	// for this to evaluate -- and an audience-targeted manifest that somehow
	// arrived anyway serves nothing, because addecision fails closed on a nil
	// index rather than assuming membership.
	var evaluator *audience.Evaluator
	// Shared with the external-channel export below: both are offline
	// workloads against the same tables, and a second pool would be more
	// connections against the Partner's database for no benefit.
	var audiencePool *pgxpool.Pool
	if len(cfg.Connector.Audience.Mapping) > 0 {
		// A SEPARATE pool from the connector's, and a small one. An estimate is
		// a full-table count that can hold a connection for seconds; sharing the
		// decision path's pool would let an offline Buyer query eat into §103's
		// p95 budget for a live page render.
		poolCfg, err := pgxpool.ParseConfig(dsn)
		if err != nil {
			return fmt.Errorf("audience pool: %w", err)
		}
		poolCfg.MaxConns = 2
		audiencePool, err = pgxpool.NewWithConfig(ctx, poolCfg)
		if err != nil {
			return fmt.Errorf("audience pool: %w", err)
		}
		defer audiencePool.Close()

		// Translated by a tested function rather than inline. This loop used to
		// live here and quietly dropped Column and Derive, which made the
		// indexable query path unreachable in a real deployment while its own
		// unit tests kept passing.
		mappings := audience.MappingsFromConfig(cfg.Connector.Audience.Mapping)

		evaluator = audience.NewEvaluator(audience.EvaluatorOptions{
			Pool:           audiencePool,
			AttributeTable: cfg.Connector.Audience.AttributeTable,
			Mappings:       mappings,
			MappingVersion: cfg.Connector.Audience.MappingVersion,
			Timeout:        cfg.Connector.Audience.EvaluationTimeout,
		})

		// The attribute KEYS are Oolix's standardized vocabulary and safe to
		// log. The expressions they map to are this Partner's local field names
		// (§17), so they stay out of the log line.
		logger.Info("v6 audience evaluation enabled",
			"attribute_table", cfg.Connector.Audience.AttributeTable,
			"mapping_version", cfg.Connector.Audience.MappingVersion,
			"mapped_attributes", len(mappings))
	} else {
		logger.Info("v6 audience evaluation disabled: no local attribute mapping configured")
	}

	return serve(ctx, cfg, logger, serving{
		conn:         conn,
		evaluator:    evaluator,
		index:        audienceIndex(evaluator),
		audiencePool: audiencePool,
	})
}

// serving is what differs between the two ways of running: where ad
// decisions and audience counts read from.
type serving struct {
	conn connector.Connector
	// evaluator answers reach estimates and compiles audiences; nil when the
	// Partner has published no attribute mapping.
	evaluator *audience.Evaluator
	index     addecision.AudienceIndex
	// audiencePool is shared with the external-channel export; nil in managed
	// mode, which does not export.
	audiencePool *pgxpool.Pool
	// onSyncer is told the control-plane client once it exists.
	onSyncer func(*controlsync.Syncer)
}

// serve runs the parts both modes share: the decision engine, the private
// ad-decision API, control sync and the reporting loops.
func serve(ctx context.Context, cfg *config.Config, logger *slog.Logger, parts serving) error {
	conn, evaluator, audiencePool := parts.conn, parts.evaluator, parts.audiencePool
	var err error

	// --- partner-local state (§76.1) --------------------------------------
	var store state.Store
	switch cfg.State.Mode {
	case "redis":
		store, err = state.NewRedis(cfg.State.RedisURL, cfg.State.RedisKeyPrefix)
		if err != nil {
			return fmt.Errorf("partner-local redis: %w", err)
		}
	default:
		// §76.1: single replica only. With several replicas each would keep
		// its own counters and a Partner's frequency cap would be multiplied
		// by the replica count.
		logger.Warn("using embedded state: SINGLE REPLICA ONLY (spec §76.1)")
		store = state.NewEmbedded()
	}
	defer store.Close()

	// --- workload identity (§92) ------------------------------------------
	key, err := loadPrivateKey(cfg.Oolix.PrivateKeyPath)
	if err != nil {
		return fmt.Errorf("agent private key: %w", err)
	}

	httpClient := &http.Client{Timeout: 10 * time.Second}

	syncer := controlsync.New(controlsync.Options{
		APIBaseURL:       cfg.Oolix.APIBaseURL,
		AgentID:          cfg.Oolix.AgentID,
		ClientID:         cfg.Oolix.ClientID,
		PartnerOrgID:     cfg.Agent.PartnerID,
		PrivateKey:       key,
		TokenAudience:    cfg.Oolix.TokenAudience,
		ManifestIssuer:   cfg.Oolix.ManifestIssuer,
		ManifestAudience: cfg.Oolix.ManifestAudience,
		Interval:         cfg.Agent.ControlSyncInterval,
		StaleGrace:       cfg.Agent.StaleGrace,
		HTTPClient:       httpClient,
		Logger:           logger,
	})

	tokens := attribution.NewIssuer(httpClient, cfg.Oolix.APIBaseURL, cfg.Oolix.AgentID, syncer.AccessToken)

	engine := &addecision.Engine{
		Connector: conn,
		State:     store,
		Tokens:    tokens,
		// §12: membership for an audience-targeted manifest is one indexed read
		// against what was materialized locally, never a rule evaluation on the
		// decision path.
		Audience:   parts.index,
		StaleGrace: cfg.Agent.StaleGrace,
		CacheTTLMs: 30_000,
	}

	// The Partner's own view of their Agent. Oolix cannot scrape this -- the
	// Agent sits inside their network by design -- so without it a Partner has
	// no numbers on the thing running on their infrastructure.
	recorder := metrics.New()
	syncer.OnSyncResult(recorder.ObserveControlSync)
	if parts.onSyncer != nil {
		parts.onSyncer(syncer)
	}

	server := &httpapi.Server{
		Engine:     engine,
		Syncer:     syncer,
		Connector:  conn,
		State:      store,
		Logger:     logger,
		Timeout:    cfg.Agent.DecisionTimeout,
		StaleGrace: cfg.Agent.StaleGrace,
		Metrics:    recorder,
	}

	httpServer := &http.Server{
		Addr:    cfg.Agent.ListenAddr,
		Handler: server.Handler(),
		// Generous relative to the decision budget so a slow Partner backend
		// cannot hold a connection open indefinitely.
		ReadHeaderTimeout: 3 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	// §18 / §27: delivery counters are batched and uploaded, never sent one
	// request per impression.
	delivery := eventbuffer.New(httpClient, cfg.Oolix.APIBaseURL, cfg.Oolix.AgentID, store, syncer.AccessToken, logger)

	go syncer.Run(ctx)
	go delivery.Run(ctx, 30*time.Second)
	go flushLoop(ctx, tokens, logger)

	if evaluator != nil {
		// §8.2 and §11 both run here, on their own cadence: answering the
		// Buyer's reach questions and compiling approved audiences. Kept off
		// the control-sync ticker because either can take seconds, and §75's
		// 30-second manifest refresh must not wait on them.
		go syncer.RunAudienceWorker(ctx, evaluator,
			30*time.Second, cfg.Connector.Audience.MaterializationTTL)
	}

	// --- external channel activation (§15, §16, §47, §48) ------------------
	//
	// Only runs when a channel is switched on AND the export is configured.
	// Both halves are required: an enabled channel with no readable matching
	// fields would start cleanly and fail at the moment an upload was due.
	if channelSyncer, err := buildChannelSyncer(cfg, audiencePool, syncer, logger); err != nil {
		// Refused rather than skipped. A Partner who switched Meta on and got
		// silence would reasonably conclude it was working.
		return fmt.Errorf("external channels: %w", err)
	} else if channelSyncer != nil {
		go runChannelSync(ctx, channelSyncer, syncer, logger)
	}

	errCh := make(chan error, 1)
	go func() {
		logger.Info("private ad-decision API listening",
			"addr", cfg.Agent.ListenAddr,
			"decision_timeout_ms", cfg.Agent.DecisionTimeout.Milliseconds())
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
	}

	// §69.2: 30-second graceful shutdown -- stop accepting decisions, then
	// flush the buffer so counters and attribution metadata are not lost.
	logger.Info("shutting down; flushing buffers")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	_ = httpServer.Shutdown(shutdownCtx)
	if err := tokens.Flush(shutdownCtx); err != nil {
		logger.Warn("failed to flush attribution tokens on shutdown", "error", err.Error())
	}
	if err := delivery.Flush(shutdownCtx); err != nil {
		logger.Warn("failed to flush delivery counters on shutdown", "error", err.Error())
	}
	logger.Info("stopped")
	return nil
}

// flushLoop uploads queued attribution metadata and delivery counters (§18).
//
// §27: "Batch reporting instead of one central event request per impression."
func flushLoop(ctx context.Context, tokens *attribution.Issuer, logger *slog.Logger) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := tokens.Flush(ctx); err != nil {
				// §57: buffer and retry. The batch stays queued.
				logger.Warn("attribution flush failed; will retry",
					"error", err.Error(), "pending", tokens.Pending())
			}
		}
	}
}

// loadPrivateKey reads the Agent's P-256 key from a PEM file.
//
// §92.2: this key is generated locally at registration and never leaves
// Partner infrastructure. Oolix holds only the matching public JWK.
func loadPrivateKey(path string) (*ecdsa.PrivateKey, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		return nil, errors.New("no PEM block found")
	}

	if key, err := x509.ParseECPrivateKey(block.Bytes); err == nil {
		return key, nil
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse private key: %w", err)
	}
	key, ok := parsed.(*ecdsa.PrivateKey)
	if !ok {
		return nil, errors.New("private key is not an ECDSA key (spec §92.2 requires P-256)")
	}
	return key, nil
}

func newLogger(cfg *config.Config) *slog.Logger {
	level := slog.LevelInfo
	switch cfg.Logging.Level {
	case "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	}

	opts := &slog.HandlerOptions{
		Level: level,
		// §78.1 / §69.1: a hard backstop. Even if a call site passes a
		// redacted field by mistake, it never reaches the output.
		ReplaceAttr: redactor(cfg.Logging.RedactFields),
	}

	var handler slog.Handler = slog.NewJSONHandler(os.Stdout, opts)
	if cfg.Logging.Format == "text" {
		handler = slog.NewTextHandler(os.Stdout, opts)
	}
	return slog.New(handler)
}

func redactor(fields []string) func([]string, slog.Attr) slog.Attr {
	blocked := make(map[string]bool, len(fields))
	for _, f := range fields {
		blocked[f] = true
	}
	return func(_ []string, a slog.Attr) slog.Attr {
		if blocked[a.Key] {
			return slog.String(a.Key, "[REDACTED]")
		}
		return a
	}
}

// audienceIndex converts a possibly-absent evaluator into the decision
// engine's interface.
//
// The explicit nil check is the point. Assigning a nil *audience.Evaluator
// straight into an interface field produces a NON-nil interface holding a nil
// pointer, so addecision's `e.Audience == nil` fail-closed guard would pass and
// the first membership call would panic on the decision path -- the one place
// §43 says must never fail loudly ("ad placement failure cannot block
// checkout").
func audienceIndex(e *audience.Evaluator) addecision.AudienceIndex {
	if e == nil {
		return nil
	}
	return e
}

// buildChannelSyncer wires the external adapters, or returns nil when no
// external channel is enabled.
//
// Returns an error rather than nil when a channel is enabled but unusable:
// §47.1 and §48.1 both require the account relationship to exist before an
// activation, and a Partner who enabled Meta and saw nothing happen would
// reasonably assume it was working.
func buildChannelSyncer(
	cfg *config.Config,
	pool *pgxpool.Pool,
	reporter channel.Reporter,
	logger *slog.Logger,
) (*channel.Syncer, error) {
	adapters := map[string]channel.Adapter{}

	if cfg.Channels.Meta.Enabled {
		token, err := cfg.ResolveMetaToken()
		if err != nil {
			return nil, err
		}
		a, err := channel.NewMetaAdapter(channel.MetaConfig{
			AccessToken: token,
			AdAccountID: cfg.Channels.Meta.AdAccountID,
			BusinessID:  cfg.Channels.Meta.BusinessID,
			APIVersion:  cfg.Channels.Meta.APIVersion,
		}, logger)
		if err != nil {
			return nil, err
		}
		adapters["META"] = a
	}

	if cfg.Channels.Google.Enabled {
		token, err := cfg.ResolveGoogleToken()
		if err != nil {
			return nil, err
		}
		a, err := channel.NewGoogleAdapter(channel.GoogleConfig{
			AccessToken:          token,
			OperatingAccountID:   cfg.Channels.Google.OperatingAccountID,
			LoginAccountID:       cfg.Channels.Google.LoginAccountID,
			ProductDestinationID: cfg.Channels.Google.ProductDestinationID,
		}, logger)
		if err != nil {
			return nil, err
		}
		adapters["GOOGLE"] = a
	}

	if len(adapters) == 0 {
		return nil, nil
	}

	if pool == nil {
		return nil, fmt.Errorf(
			"an external channel is enabled but no audience mapping is configured: " +
				"external activation uploads the materialized audience, so connector.audience is required")
	}

	exportCfg, err := channel.ExportConfigFromStrings(
		cfg.Channels.Export.IdentityTable,
		cfg.Channels.Export.MembersTable,
		cfg.Channels.Export.Fields,
	)
	if err != nil {
		return nil, err
	}

	source, err := channel.NewPgMemberSource(pool, exportCfg)
	if err != nil {
		return nil, err
	}

	logger.Info("external channel activation enabled",
		"channels", len(adapters),
		"matching_fields", len(exportCfg.Fields))

	return channel.NewSyncer(channel.SyncerOptions{
		Adapters: adapters,
		Source:   source,
		Reporter: reporter,
		Logger:   logger,
		// The lawful basis was established by the eligibility gate before any
		// manifest was signed (§47.5, §48.4). It is passed rather than assumed
		// so the thing asserting consent to a platform is downstream of the
		// thing that checked it.
		Consent: channel.ConsentGranted,
	}), nil
}

// runChannelSync reconciles external audiences on its own slow cadence.
//
// Far slower than the control sync: membership changes on the order of a day,
// platform ingestion is rate-limited, and re-uploading a large audience every
// thirty seconds would exhaust a Partner's quota to no purpose. The Syncer
// enforces the real refresh interval; this ticker only decides how often it is
// asked.
func runChannelSync(
	ctx context.Context,
	cs *channel.Syncer,
	syncer *controlsync.Syncer,
	logger *slog.Logger,
) {
	const tick = 5 * time.Minute

	run := func() {
		snap := syncer.Snapshot()
		if snap == nil {
			return
		}
		views := externalViews(snap)
		if len(views) == 0 {
			return
		}
		for _, err := range cs.Reconcile(ctx, views) {
			logger.Error("external channel sync failed", "error", err.Error())
		}
	}

	// Once at start-up, so a restarted Agent does not leave a revoked audience
	// sitting in a platform for a whole tick.
	run()

	t := time.NewTicker(tick)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			run()
		}
	}
}

// externalViews picks the external activations out of the control snapshot.
//
// The kill switch is applied HERE rather than left to the adapter, because for
// an external channel "stopped" has to mean the audience comes back out of the
// platform (§24). An audience already inside Meta is not stopped by the Agent
// declining to do anything.
func externalViews(snap *addecision.ConfigSnapshot) []channel.ActivationView {
	var out []channel.ActivationView
	for _, c := range snap.Candidates {
		m := c.Manifest
		if m == nil || (m.Channel != "META" && m.Channel != "GOOGLE") {
			continue
		}
		stopped := snap.KillSwitchAll ||
			snap.KilledActivationIDs[m.ActivationID] ||
			snap.RevokedActivationIDs[m.ActivationID]

		out = append(out, channel.ActivationView{
			ActivationID: m.ActivationID,
			Channel:      m.Channel,
			// Names the activation, never the segment's rules: an audience
			// called "high-value lapsed customers" tells everyone with access
			// to the ad account something the Partner never agreed to publish.
			AudienceName: "Oolix activation " + m.ActivationID,
			StartAt:      m.StartAt,
			EndAt:        m.EndAt,
			Stopped:      stopped,
		})
	}
	return out
}

// runManaged runs the Agent in managed mode (Partner Connect).
//
// The setup page comes up first and stays up: it is how the Partner registers
// the Agent, points it at their database and watches the copy. Ad decisions,
// control sync and audience counting start once the Agent has an identity --
// immediately on a restart, or the moment the Partner registers.
func runManaged(ctx context.Context, cfg *config.Config, logger *slog.Logger) error {
	dsn, err := cfg.Managed.LocalStoreDSN()
	if err != nil {
		return err
	}
	store, err := openLocalStore(ctx, dsn, filepath.Join(cfg.Managed.StateDir, "local.key"), logger)
	if err != nil {
		return err
	}
	defer store.Close()

	runner := managed.NewRunner(store, logger)
	go runner.Run(ctx)

	keyPath := filepath.Join(cfg.Managed.StateDir, "agent-key.pem")
	registered := make(chan managed.Identity, 1)
	ui, err := setupui.New(ctx, setupui.Options{
		Store: store, Runner: runner, Logger: logger,
		APIBaseURL:   cfg.Oolix.APIBaseURL,
		KeyPath:      keyPath,
		ImportFolder: cfg.Managed.ImportFolder,
		Password:     os.Getenv("OOLIX_SETUP_PASSWORD"),
		OnRegistered: func(id managed.Identity) {
			select {
			case registered <- id:
			default:
			}
		},
	})
	if err != nil {
		return fmt.Errorf("setup page: %w", err)
	}
	setupServer := &http.Server{
		Addr:              cfg.Managed.SetupListenAddr,
		Handler:           ui.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		// Reading a sample of a large table can take a while.
		WriteTimeout: 3 * time.Minute,
		IdleTimeout:  60 * time.Second,
	}
	setupErr := make(chan error, 1)
	go func() {
		logger.Info("setup page listening", "addr", cfg.Managed.SetupListenAddr)
		if err := setupServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			setupErr <- err
		}
	}()
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = setupServer.Shutdown(shutdownCtx)
	}()

	id, err := managed.Settings{Store: store}.Identity(ctx)
	if err != nil {
		return err
	}
	if id == nil {
		logger.Info("not connected to Oolix yet: open the setup page to finish setting up this Agent")
		select {
		case <-ctx.Done():
			return nil
		case err := <-setupErr:
			return fmt.Errorf("setup page: %w", err)
		case v := <-registered:
			id = &v
		}
	}

	// The identity the setup page stored stands in for the hand-written
	// `oolix:` block of a classic configuration.
	cfg.Agent.PartnerID = id.PartnerOrgID
	cfg.Oolix.AgentID, cfg.Oolix.ClientID = id.AgentID, id.ClientID
	cfg.Oolix.ManifestIssuer = id.ManifestIssuer
	if id.ManifestAudience != "" {
		cfg.Oolix.ManifestAudience = id.ManifestAudience
	}
	if id.TokenAudience != "" {
		cfg.Oolix.TokenAudience = id.TokenAudience
	}
	cfg.Oolix.PrivateKeyPath = keyPath

	// Ad decisions and audience counts read the local copy, never the
	// Partner's database. The copy holds scrambled ids, so every lookup
	// scrambles the id it was asked about the same way.
	view, err := connector.NewPostgresView(ctx, connector.PostgresOptions{
		DSN:             dsn,
		MembershipQuery: managed.MembershipQuery,
		ConsentQuery:    managed.ConsentQuery,
		MaxOpenConns:    cfg.Connector.MaxOpenConns,
		QueryTimeout:    cfg.Connector.QueryTimeout,
	})
	if err != nil {
		return fmt.Errorf("local store connector: %w", err)
	}
	defer view.Close()

	poolCfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return fmt.Errorf("audience pool: %w", err)
	}
	poolCfg.MaxConns = 2
	audiencePool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		return fmt.Errorf("audience pool: %w", err)
	}
	defer audiencePool.Close()
	evaluator := audience.NewEvaluator(audience.EvaluatorOptions{
		Pool:           audiencePool,
		AttributeTable: localstore.AttributesTable,
		Mappings:       managed.EvaluatorMappings(),
		MappingVersion: managed.MappingVersion,
		Timeout:        cfg.Connector.Audience.EvaluationTimeout,
	})
	logger.Info("managed mode serving from the local copy", "agent_id", id.AgentID)

	return serve(ctx, cfg, logger, serving{
		conn:      managed.ScrambledConnector{Connector: view, Scramble: store.ScrambleID},
		evaluator: evaluator,
		index:     managed.ScrambledAudience{AudienceIndex: evaluator, Scramble: store.ScrambleID},
		onSyncer: func(s *controlsync.Syncer) {
			runner.SetQualityReporter(func(ctx context.Context, q managed.Quality) error {
				return s.ReportQuality(ctx, q)
			})
			// In the background: publishing anything left over from before a
			// restart needs a token, and serving should not wait for it.
			go runner.SetPublisher(ctx, func(ctx context.Context, c managed.Capabilities) error {
				return s.PublishCapabilities(ctx, c)
			})
		},
	})
}

// openLocalStore connects to the local store, waiting for it while it starts:
// in the Compose bundle both containers come up together.
func openLocalStore(ctx context.Context, dsn, keyFile string, logger *slog.Logger) (*localstore.Store, error) {
	deadline := time.Now().Add(90 * time.Second)
	for {
		store, err := localstore.Open(ctx, dsn, keyFile)
		if err == nil {
			return store, nil
		}
		if time.Now().After(deadline) || ctx.Err() != nil {
			return nil, fmt.Errorf("local store: %w", err)
		}
		logger.Info("waiting for the local store to start", "error", err.Error())
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(3 * time.Second):
		}
	}
}
