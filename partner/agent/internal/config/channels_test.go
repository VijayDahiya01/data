package config

import (
	"strings"
	"testing"
)

// An external channel that is switched on but not configured parses cleanly,
// starts cleanly, and fails only when an upload is attempted -- by which point
// a Buyer has been told the campaign is live. These tests pin the start-up
// refusal that prevents that.

func TestEnabledMetaWithoutCredentialsIsRefusedAtStartup(t *testing.T) {
	c := &Config{}
	c.Channels.Meta.Enabled = true
	c.Channels.Meta.AdAccountID = "act-1"

	err := c.validate()
	if err == nil {
		t.Fatal("expected a refusal when meta is enabled with no token")
	}
	if !strings.Contains(err.Error(), "access_token") {
		t.Errorf("error should name the missing field; got %q", err)
	}
}

func TestEnabledMetaWithoutAdAccountIsRefused(t *testing.T) {
	c := &Config{}
	c.Channels.Meta.Enabled = true
	c.Channels.Meta.AccessToken = "t"

	err := c.validate()
	if err == nil || !strings.Contains(err.Error(), "ad_account_id") {
		t.Errorf("expected a complaint about ad_account_id; got %v", err)
	}
}

func TestEnabledGoogleRequiresTheWholeAccountPath(t *testing.T) {
	// The destination is the part people forget: without a user list there is
	// nothing to ingest into, and the API error for that is not obvious.
	c := &Config{}
	c.Channels.Google.Enabled = true
	c.Channels.Google.AccessToken = "t"
	c.Channels.Google.OperatingAccountID = "111"

	err := c.validate()
	if err == nil || !strings.Contains(err.Error(), "product_destination_id") {
		t.Errorf("expected a complaint about the destination id; got %v", err)
	}
}

func TestDisabledChannelsNeedNoConfiguration(t *testing.T) {
	// The default state. A Partner running owned media only must not be asked
	// for Meta credentials.
	c := &Config{}
	if err := c.validate(); err != nil {
		if strings.Contains(err.Error(), "channels.") {
			t.Errorf("a disabled channel demanded configuration: %v", err)
		}
	}
}

func TestSecretReferenceResolvesFromTheEnvironment(t *testing.T) {
	t.Setenv("META_TOKEN_TEST", "resolved-token")

	c := &Config{}
	c.Channels.Meta.AccessTokenSecretRef = "secret://meta-token-test"

	got, err := c.ResolveMetaToken()
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got != "resolved-token" {
		t.Errorf("token = %q; want the value from the environment", got)
	}
}

func TestUnresolvableSecretIsAnErrorRatherThanAnEmptyToken(t *testing.T) {
	// An adapter built with an empty token sends unauthenticated requests, and
	// the resulting 401 says nothing about the missing secret.
	c := &Config{}
	c.Channels.Google.AccessTokenSecretRef = "secret://definitely-not-set-anywhere"

	_, err := c.ResolveGoogleToken()
	if err == nil {
		t.Fatal("expected an error for an unresolvable secret reference")
	}
	if !strings.Contains(err.Error(), "did not resolve") {
		t.Errorf("error should say the reference did not resolve; got %q", err)
	}
}

func TestInlineTokenIsUsedWhenNoReferenceIsGiven(t *testing.T) {
	c := &Config{}
	c.Channels.Meta.AccessToken = "inline"

	got, err := c.ResolveMetaToken()
	if err != nil || got != "inline" {
		t.Errorf("got %q, %v; want the inline token", got, err)
	}
}
