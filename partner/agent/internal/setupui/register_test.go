package setupui

import (
	"context"
	"net/url"
	"strings"
	"testing"
)

// The portal's install command passes a one-time code in
// OOLIX_BOOTSTRAP_TOKEN, and the Agent registers itself as it starts: its
// setup page then has nothing to ask but the database. A code Oolix refuses
// is said; starting again with the same command changes nothing.
func TestTheAgentRegistersAtStartWithTheInstallCommandsCode(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	err := h.ui.RegisterAtStart(ctx, "spent-code")
	if err == nil || !strings.Contains(err.Error(), "Oolix did not accept the code") {
		t.Fatalf("a refused code: %v", err)
	}
	if len(h.registered) != 0 {
		t.Fatal("registered with a refused code")
	}

	if err := h.ui.RegisterAtStart(ctx, " one-time-code\n"); err != nil {
		t.Fatal(err)
	}
	if len(h.registered) != 1 || h.registered[0].AgentID != "agent-1" {
		t.Fatalf("registered: %+v", h.registered)
	}

	// The same command again, after a restart: already registered.
	if err := h.ui.RegisterAtStart(ctx, "one-time-code"); err != nil || len(h.registered) != 1 {
		t.Fatalf("a second start registered again: %v, %d", err, len(h.registered))
	}

	// The setup page no longer asks for a code.
	h.post("/login", url.Values{"password": {"correct horse battery"}})
	if _, body := h.get("/register"); strings.Contains(body, `name="code"`) {
		t.Error("the setup page still asks for a one-time code")
	}
}
