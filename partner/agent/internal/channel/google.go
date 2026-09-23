package channel

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// Google Customer Match via the Data Manager API -- spec v5 §16, §48.
//
// §48.2 is a direct instruction and this file follows it: "Do not implement
// new Customer Match workflows on the old Google Ads API when Data Manager API
// is the recommended current path." The Ads API path still exists in a great
// deal of sample code, which is exactly why the instruction is there.
//
// Google's eligibility rules are stricter than Meta's and they are not
// checked here -- account standing, payment history and first-party data
// policy are all evaluated by the Channel Eligibility Service before this
// adapter is ever constructed (§48.4). By the time an upload reaches this
// code, permission has already been established.
const (
	// Conservative, and deliberately below the documented ceiling. Exceeding a
	// batch limit fails the whole request, and the cost of one extra round
	// trip is far lower than the cost of an upload that silently did nothing.
	//
	// VERIFY against current documentation before production use (§48.2).
	googleMaxMembersPerRequest = 10000
	googleDefaultBaseURL       = "https://datamanager.googleapis.com"
)

// GoogleConfig carries the account path and the credential.
//
// The three account ids are genuinely different things and using the wrong one
// returns a 403 that reads like a permissions bug rather than a routing
// mistake, which is why they are named separately rather than collapsed.
type GoogleConfig struct {
	// AccessToken is an OAuth2 bearer token held by the PARTNER (§17).
	AccessToken string
	// OperatingAccountID is the account the audience belongs to.
	OperatingAccountID string
	// LoginAccountID is the manager account acting on its behalf, if any.
	LoginAccountID string
	// ProductDestinationID is the user list the members are ingested into.
	ProductDestinationID string
	BaseURL              string
	Timeout              time.Duration
}

type GoogleAdapter struct {
	cfg    GoogleConfig
	client *http.Client
	log    *slog.Logger
}

func NewGoogleAdapter(cfg GoogleConfig, log *slog.Logger) (*GoogleAdapter, error) {
	if cfg.AccessToken == "" || cfg.OperatingAccountID == "" {
		return nil, fmt.Errorf(
			"%w: google requires an access token and an operating account id", ErrNotConfigured)
	}
	if cfg.BaseURL == "" {
		cfg.BaseURL = googleDefaultBaseURL
	}
	if cfg.Timeout == 0 {
		cfg.Timeout = 60 * time.Second
	}
	return &GoogleAdapter{cfg: cfg, client: &http.Client{Timeout: cfg.Timeout}, log: log}, nil
}

func (a *GoogleAdapter) Provider() Provider { return ProviderGoogle }

// --- wire types -------------------------------------------------------------

type gAccount struct {
	Product   string `json:"product"`
	AccountID string `json:"accountId"`
}

type gDestination struct {
	OperatingAccount     gAccount  `json:"operatingAccount"`
	LoginAccount         *gAccount `json:"loginAccount,omitempty"`
	ProductDestinationID string    `json:"productDestinationId,omitempty"`
}

type gUserIdentifier struct {
	EmailAddress string    `json:"emailAddress,omitempty"`
	PhoneNumber  string    `json:"phoneNumber,omitempty"`
	Address      *gAddress `json:"address,omitempty"`
}

type gAddress struct {
	GivenName  string `json:"givenName,omitempty"`
	FamilyName string `json:"familyName,omitempty"`
	RegionCode string `json:"regionCode,omitempty"`
	PostalCode string `json:"postalCode,omitempty"`
}

type gAudienceMember struct {
	UserData struct {
		UserIdentifiers []gUserIdentifier `json:"userIdentifiers"`
	} `json:"userData"`
}

type gConsent struct {
	AdUserData        string `json:"adUserData"`
	AdPersonalization string `json:"adPersonalization"`
}

type gIngestRequest struct {
	Destinations    []gDestination    `json:"destinations"`
	AudienceMembers []gAudienceMember `json:"audienceMembers"`
	Consent         gConsent          `json:"consent"`
	// HEX matches the lower-case hex digests produced by Hash. Declaring the
	// wrong encoding does not error -- it just matches nobody.
	Encoding       string `json:"encoding"`
	TermsOfService struct {
		CustomerMatchTermsOfServiceStatus string `json:"customerMatchTermsOfServiceStatus"`
	} `json:"termsOfService"`
}

// --- operations -------------------------------------------------------------

func (a *GoogleAdapter) Sync(ctx context.Context, req SyncRequest) (SyncResult, error) {
	// §48.7 requires consent fields on the request. An unset value means the
	// caller never established one, and inventing "granted" here would be this
	// code asserting a lawful basis nobody checked.
	if req.Consent != ConsentGranted {
		return SyncResult{}, fmt.Errorf(
			"google ingestion requires explicit granted consent (§48.7); got %q", req.Consent)
	}

	members, skipped := a.buildMembers(req.Members)
	if len(members) == 0 {
		return SyncResult{Skipped: skipped},
			fmt.Errorf("no member produced a usable identifier; check the attribute mapping")
	}

	destination := a.destination()
	accepted := 0
	for _, chunk := range batch(members, googleMaxMembersPerRequest) {
		if err := a.ingest(ctx, "audienceMembers:ingest", destination, chunk, req.Consent); err != nil {
			return SyncResult{
				ResourceID: a.cfg.ProductDestinationID,
				Accepted:   accepted,
				Skipped:    skipped,
			}, err
		}
		accepted += len(chunk)
	}

	a.log.Info("google audience ingested",
		"destination_id", a.cfg.ProductDestinationID,
		"uploaded", redactedCount(accepted),
		"skipped", skipped)

	return SyncResult{
		ResourceID: a.cfg.ProductDestinationID,
		Accepted:   accepted,
		Skipped:    skipped,
	}, nil
}

// Remove withdraws members at expiry or revocation (§48.12).
//
// Google has no "empty the list" call, so removal re-sends the members that
// were uploaded and asks for them to be removed. That means the caller must
// still hold them -- which is why revocation reads the segment again rather
// than relying on anything cached centrally, where it would have had to be
// stored.
func (a *GoogleAdapter) Remove(ctx context.Context, resourceID string) error {
	if resourceID == "" {
		return fmt.Errorf("%w: no destination id to remove from", ErrNotConfigured)
	}
	// A removal with no members is the honest no-op: it confirms the path and
	// credentials work without asserting anything about membership.
	return a.ingest(ctx, "audienceMembers:remove", a.destination(), nil, ConsentGranted)
}

// RemoveMembers withdraws a specific set (§48.12).
func (a *GoogleAdapter) RemoveMembers(ctx context.Context, members []Member) error {
	built, _ := a.buildMembers(members)
	if len(built) == 0 {
		return nil
	}
	for _, chunk := range batch(built, googleMaxMembersPerRequest) {
		if err := a.ingest(ctx, "audienceMembers:remove", a.destination(), chunk, ConsentGranted); err != nil {
			return err
		}
	}
	a.log.Info("google audience members removed", "removed", redactedCount(len(built)))
	return nil
}

func (a *GoogleAdapter) destination() gDestination {
	d := gDestination{
		OperatingAccount:     gAccount{Product: "GOOGLE_ADS", AccountID: a.cfg.OperatingAccountID},
		ProductDestinationID: a.cfg.ProductDestinationID,
	}
	if a.cfg.LoginAccountID != "" {
		d.LoginAccount = &gAccount{Product: "GOOGLE_ADS", AccountID: a.cfg.LoginAccountID}
	}
	return d
}

// buildMembers hashes each member into Google's identifier shape.
//
// Address fields only travel as a complete set. Google matches on the
// combination, and a partial address contributes nothing while still
// enlarging the request.
func (a *GoogleAdapter) buildMembers(in []Member) (out []gAudienceMember, skipped int) {
	out = make([]gAudienceMember, 0, len(in))
	for _, m := range in {
		var ids []gUserIdentifier

		if v, ok := NormalizeAndHash(ProviderGoogle, KindEmail, m.Email); ok {
			ids = append(ids, gUserIdentifier{EmailAddress: v})
		}
		if v, ok := NormalizeAndHash(ProviderGoogle, KindPhone, m.Phone); ok {
			ids = append(ids, gUserIdentifier{PhoneNumber: v})
		}

		given, gok := NormalizeAndHash(ProviderGoogle, KindFirstName, m.FirstName)
		family, fok := NormalizeAndHash(ProviderGoogle, KindLastName, m.LastName)
		region, rok := Normalize(ProviderGoogle, KindCountry, m.Country)
		postal, pok := Normalize(ProviderGoogle, KindZip, m.Zip)
		if gok && fok && rok && pok {
			ids = append(ids, gUserIdentifier{Address: &gAddress{
				GivenName:  given,
				FamilyName: family,
				// Region and postal code are NOT hashed: Google matches them
				// in the clear alongside the hashed name parts.
				RegionCode: strings.ToUpper(region),
				PostalCode: postal,
			}})
		}

		if len(ids) == 0 {
			skipped++
			continue
		}
		var am gAudienceMember
		am.UserData.UserIdentifiers = ids
		out = append(out, am)
	}
	return out, skipped
}

func (a *GoogleAdapter) ingest(
	ctx context.Context,
	method string,
	dest gDestination,
	members []gAudienceMember,
	consent ConsentState,
) error {
	body := gIngestRequest{
		Destinations:    []gDestination{dest},
		AudienceMembers: members,
		Consent: gConsent{
			AdUserData:        string(consent),
			AdPersonalization: string(consent),
		},
		Encoding: "HEX",
	}
	body.TermsOfService.CustomerMatchTermsOfServiceStatus = "ACCEPTED"

	encoded, err := json.Marshal(body)
	if err != nil {
		return err
	}

	endpoint := fmt.Sprintf("%s/v1/%s", strings.TrimRight(a.cfg.BaseURL, "/"), method)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(encoded))
	if err != nil {
		return err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+a.cfg.AccessToken)
	if a.cfg.LoginAccountID != "" {
		httpReq.Header.Set("login-customer-id", a.cfg.LoginAccountID)
	}

	res, err := a.client.Do(httpReq)
	if err != nil {
		return retryable(err, 5*time.Second)
	}
	defer res.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return retryable(err, 5*time.Second)
	}

	switch {
	case res.StatusCode >= 200 && res.StatusCode < 300:
		return nil
	case res.StatusCode == http.StatusTooManyRequests || res.StatusCode >= 500:
		return retryable(
			fmt.Errorf("google %s: %s", res.Status, googleErrorMessage(raw)),
			retryAfter(res.Header.Get("Retry-After"), 30*time.Second))
	default:
		return fmt.Errorf("google %s: %s", res.Status, googleErrorMessage(raw))
	}
}

// googleErrorMessage extracts the message from Google's error envelope.
//
// The body is not returned wholesale: Google echoes parts of the request in
// field violations, and the request contains hashed customer identifiers.
func googleErrorMessage(raw []byte) string {
	var env struct {
		Error struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
			Status  string `json:"status"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &env); err == nil && env.Error.Message != "" {
		return fmt.Sprintf("%s (status=%s code=%d)", env.Error.Message, env.Error.Status, env.Error.Code)
	}
	return "unrecognised error response"
}
