package channel

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Meta Custom Audiences from a customer list -- spec v5 §15, §47.
//
// The audience is created against the advertiser's ad account and populated
// from the Partner's own database, hashed locally on the way out. §15's
// framing matters: the Partner is an "authorized data partner uploading on
// behalf of an advertiser", which is why the ad account belongs to the
// advertiser while the credential belongs to the Partner.
//
// MAX_USERS_PER_REQUEST is Meta's documented cap. Going over it fails the
// whole request rather than truncating, so a large audience that was not
// batched uploads nothing at all -- and the error does not say so clearly.
const (
	metaMaxUsersPerRequest = 10000
	metaDefaultAPIVersion  = "v21.0"
	metaDefaultBaseURL     = "https://graph.facebook.com"
)

// MetaConfig is everything the adapter needs, and nothing it does not.
type MetaConfig struct {
	// AccessToken is a system-user token held by the PARTNER (§17). It never
	// travels to Oolix and is never logged.
	AccessToken string
	// AdAccountID is the advertiser's account, without the "act_" prefix.
	AdAccountID string
	BusinessID  string
	APIVersion  string
	// BaseURL is overridable so the adapter can be tested against a fake.
	BaseURL string
	Timeout time.Duration
}

type MetaAdapter struct {
	cfg    MetaConfig
	client *http.Client
	log    *slog.Logger
}

func NewMetaAdapter(cfg MetaConfig, log *slog.Logger) (*MetaAdapter, error) {
	if cfg.AccessToken == "" || cfg.AdAccountID == "" {
		return nil, fmt.Errorf("%w: meta requires an access token and an ad account id", ErrNotConfigured)
	}
	if cfg.APIVersion == "" {
		cfg.APIVersion = metaDefaultAPIVersion
	}
	if cfg.BaseURL == "" {
		cfg.BaseURL = metaDefaultBaseURL
	}
	if cfg.Timeout == 0 {
		cfg.Timeout = 60 * time.Second
	}
	return &MetaAdapter{
		cfg:    cfg,
		client: &http.Client{Timeout: cfg.Timeout},
		log:    log,
	}, nil
}

func (a *MetaAdapter) Provider() Provider { return ProviderMeta }

// metaSchema is the column order for the uploaded rows.
//
// The schema and every data row must agree positionally; a mismatch is not
// rejected, it is matched against the wrong field, which produces a valid
// upload that matches nobody.
var metaSchema = []string{"EMAIL", "PHONE", "FN", "LN", "COUNTRY", "ZIP", "MADID"}

func (a *MetaAdapter) Sync(ctx context.Context, req SyncRequest) (SyncResult, error) {
	audienceID := req.ExistingResourceID
	if audienceID == "" {
		id, err := a.createAudience(ctx, req.AudienceName)
		if err != nil {
			return SyncResult{}, err
		}
		audienceID = id
	}

	rows, skipped := a.buildRows(req.Members)
	if len(rows) == 0 {
		// An upload of nothing would report success and leave an empty
		// audience, which looks identical to a working one until delivery
		// numbers arrive.
		return SyncResult{ResourceID: audienceID, Accepted: 0, Skipped: skipped},
			fmt.Errorf("no member produced a usable identifier; check the attribute mapping")
	}

	accepted := 0
	for _, chunk := range batch(rows, metaMaxUsersPerRequest) {
		if err := a.postUsers(ctx, audienceID, chunk, http.MethodPost); err != nil {
			return SyncResult{ResourceID: audienceID, Accepted: accepted, Skipped: skipped}, err
		}
		accepted += len(chunk)
	}

	a.log.Info("meta audience synced",
		"audience_id", audienceID,
		"uploaded", redactedCount(accepted),
		"skipped", skipped)

	return SyncResult{ResourceID: audienceID, Accepted: accepted, Skipped: skipped}, nil
}

// buildRows hashes each member into the positional row Meta expects.
//
// A member contributing no usable identifier is skipped rather than uploaded
// as a row of empty strings: empty hashes match nobody and inflate the count,
// making a broken mapping look like a working upload.
func (a *MetaAdapter) buildRows(members []Member) (rows [][]string, skipped int) {
	rows = make([][]string, 0, len(members))
	for _, m := range members {
		row := make([]string, len(metaSchema))
		any := false

		put := func(i int, k Kind, raw string) {
			if raw == "" {
				return
			}
			if v, ok := NormalizeAndHash(ProviderMeta, k, raw); ok {
				row[i] = v
				any = true
			}
		}

		put(0, KindEmail, m.Email)
		put(1, KindPhone, m.Phone)
		put(2, KindFirstName, m.FirstName)
		put(3, KindLastName, m.LastName)
		put(4, KindCountry, m.Country)
		put(5, KindZip, m.Zip)
		put(6, KindMobileID, m.MobileID)

		if !any {
			skipped++
			continue
		}
		rows = append(rows, row)
	}
	return rows, skipped
}

func (a *MetaAdapter) createAudience(ctx context.Context, name string) (string, error) {
	form := url.Values{}
	form.Set("name", name)
	form.Set("subtype", "CUSTOM")
	// PARTNER_PROVIDED_ONLY is the honest declaration for this architecture:
	// the data came from the Partner, not from the advertiser's own customers.
	// Declaring it wrongly is a terms violation, not a cosmetic field.
	form.Set("customer_file_source", "PARTNER_PROVIDED_ONLY")
	form.Set("description", "Created by Oolix Partner Agent")
	form.Set("access_token", a.cfg.AccessToken)

	endpoint := fmt.Sprintf("%s/%s/act_%s/customaudiences",
		strings.TrimRight(a.cfg.BaseURL, "/"), a.cfg.APIVersion, a.cfg.AdAccountID)

	body, err := a.do(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()),
		"application/x-www-form-urlencoded")
	if err != nil {
		return "", err
	}

	var out struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(body, &out); err != nil || out.ID == "" {
		return "", fmt.Errorf("meta returned no audience id")
	}
	return out.ID, nil
}

func (a *MetaAdapter) postUsers(ctx context.Context, audienceID string, rows [][]string, method string) error {
	form := url.Values{}
	form.Set("payload", string(mustJSON(map[string]any{
		"schema": metaSchema,
		"data":   rows,
	})))
	form.Set("access_token", a.cfg.AccessToken)

	endpoint := fmt.Sprintf("%s/%s/%s/users",
		strings.TrimRight(a.cfg.BaseURL, "/"), a.cfg.APIVersion, audienceID)

	_, err := a.do(ctx, method, endpoint, strings.NewReader(form.Encode()),
		"application/x-www-form-urlencoded")
	return err
}

// Remove clears the audience membership at expiry or revocation (§47.14).
//
// The members are deleted rather than the audience object: a Custom Audience
// referenced by a live ad set cannot be deleted, and attempting it fails in a
// way that leaves the members in place -- the opposite of what revocation
// needs.
func (a *MetaAdapter) Remove(ctx context.Context, resourceID string) error {
	if resourceID == "" {
		return fmt.Errorf("%w: no audience id to remove", ErrNotConfigured)
	}
	endpoint := fmt.Sprintf("%s/%s/%s/users",
		strings.TrimRight(a.cfg.BaseURL, "/"), a.cfg.APIVersion, resourceID)

	form := url.Values{}
	form.Set("access_token", a.cfg.AccessToken)
	form.Set("payload", string(mustJSON(map[string]any{
		"schema": metaSchema,
		"data":   [][]string{},
	})))

	_, err := a.do(ctx, http.MethodDelete, endpoint, strings.NewReader(form.Encode()),
		"application/x-www-form-urlencoded")
	if err != nil {
		return err
	}
	a.log.Info("meta audience membership removed", "audience_id", resourceID)
	return nil
}

func (a *MetaAdapter) do(ctx context.Context, method, endpoint string, body io.Reader, contentType string) ([]byte, error) {
	httpReq, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", contentType)

	res, err := a.client.Do(httpReq)
	if err != nil {
		// A transport error is almost always worth retrying; a permanent
		// misconfiguration surfaces as a 4xx instead.
		return nil, retryable(err, 5*time.Second)
	}
	defer res.Body.Close()

	// Bounded: a runaway error page must not become a memory problem on a
	// Partner's host.
	raw, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return nil, retryable(err, 5*time.Second)
	}

	switch {
	case res.StatusCode >= 200 && res.StatusCode < 300:
		return raw, nil
	case res.StatusCode == http.StatusTooManyRequests || res.StatusCode >= 500:
		return nil, retryable(
			fmt.Errorf("meta %s: %s", res.Status, metaErrorMessage(raw)),
			retryAfter(res.Header.Get("Retry-After"), 30*time.Second))
	default:
		// 4xx is a configuration or permission problem. Retrying it hammers a
		// platform that has already given a definite answer.
		return nil, fmt.Errorf("meta %s: %s", res.Status, metaErrorMessage(raw))
	}
}

// metaErrorMessage pulls the human-readable part out of Meta's error envelope.
//
// The raw body is NOT returned wholesale: on some endpoints it echoes request
// parameters, and the request carries an access token.
func metaErrorMessage(raw []byte) string {
	var env struct {
		Error struct {
			Message string `json:"message"`
			Type    string `json:"type"`
			Code    int    `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &env); err == nil && env.Error.Message != "" {
		return fmt.Sprintf("%s (type=%s code=%d)", env.Error.Message, env.Error.Type, env.Error.Code)
	}
	return "unrecognised error response"
}

func retryAfter(header string, fallback time.Duration) time.Duration {
	if header == "" {
		return fallback
	}
	if d, err := time.ParseDuration(header + "s"); err == nil && d > 0 {
		return d
	}
	return fallback
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		return []byte("{}")
	}
	return b
}
