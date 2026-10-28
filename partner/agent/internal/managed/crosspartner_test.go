package managed

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/hex"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/oolix/partner-agent/internal/cleanroom"
	"github.com/oolix/partner-agent/internal/enclave"
	"github.com/oolix/partner-agent/internal/enclave/enclavetest"
	"github.com/oolix/partner-agent/internal/source"
)

const crossPartnerCSV = "id,dob,email,mobile,marketing,matching\n" +
	"C1,14/04/1990,asha@example.com,98765 43210,yes,yes\n" + // both: taken
	"C2,01/01/1985,ravi@example.com,,yes,no\n" + // not for matching
	"C3,02/02/1980,meera@example.com,91234 56789,no,yes\n" + // not in the copy: no marketing consent
	"C4,03/03/2012,kid@example.com,,yes,yes\n" + // a child: not in the copy
	"C5,04/04/1975,,+91 99887 76655,yes,yes\n" // a phone alone: taken

type fakeCleanRoomClient struct {
	tasks     []CleanRoomTask
	submitted map[string][]byte
	recipient []byte
	results   []CleanRoomResult
	acked     []string
}

func (f *fakeCleanRoomClient) CleanRoomTasks(context.Context) ([]CleanRoomTask, error) {
	return f.tasks, nil
}
func (f *fakeCleanRoomClient) SubmitCleanRoomInput(_ context.Context, runID string, sealed, recipient []byte) error {
	f.submitted[runID], f.recipient = sealed, recipient
	return nil
}
func (f *fakeCleanRoomClient) CleanRoomResults(context.Context) ([]CleanRoomResult, error) {
	return f.results, nil
}
func (f *fakeCleanRoomClient) AckCleanRoomResult(_ context.Context, runID string) error {
	f.acked = append(f.acked, runID)
	return nil
}

// Customers are sealed to the clean room only if they agreed to this
// purpose and are in the copy; only a trusted clean room gets them; and a
// joint audience comes back to the right customers.
func TestCrossPartnerMatching(t *testing.T) {
	store := localStore(t)
	ctx := context.Background()
	now := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "customers.csv"), []byte(crossPartnerCSV), 0o600); err != nil {
		t.Fatal(err)
	}
	srcCfg := source.Config{Kind: source.File, Folder: dir}
	m := Mapping{Table: "customers.csv", IDColumn: "id", Location: "Asia/Kolkata",
		Attributes: map[string]AttributeMapping{"age": {Column: "dob", Publish: true}},
		Consent:    ConsentMapping{Column: "marketing"},
		CrossPartner: &CrossPartnerMapping{EmailColumn: "email", PhoneColumn: "mobile",
			Consent: ConsentMapping{Column: "matching"}}}
	src, err := source.Open(ctx, srcCfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Sync(ctx, src, store, m, now); err != nil {
		t.Fatal(err)
	}
	_ = src.Close()
	settings := Settings{Store: store}
	if err := settings.SaveSource(ctx, srcCfg); err != nil {
		t.Fatal(err)
	}
	if err := settings.SaveMapping(ctx, m); err != nil {
		t.Fatal(err)
	}

	// The clean room: a key to seal to, named by its attestation.
	nitro := enclavetest.NewNitro(t)
	image := enclavetest.Image(5)
	box, _ := ecdh.X25519().GenerateKey(rand.Reader)
	signer := make([]byte, 32)
	doc := nitro.Document(t, enclavetest.Doc{PCRs: image, UserData: signer, PublicKey: box.PublicKey().Bytes()})
	trusted := []enclave.Measurements{{PCR0: hex.EncodeToString(image[0]), PCR1: hex.EncodeToString(image[1]),
		PCR2: hex.EncodeToString(image[2])}}

	client := &fakeCleanRoomClient{submitted: map[string][]byte{},
		tasks: []CleanRoomTask{{RunID: "run-1", Kind: "joint", Role: "base", Attestation: doc}}}
	runner := NewRunner(store, slog.New(slog.NewTextHandler(io.Discard, nil)))
	runner.Now = func() time.Time { return now }
	room := &CleanRoom{Runner: runner, Client: client, Roots: nitro.Roots, Logger: runner.Logger}

	// Trusting no image, nothing is sent.
	if err := room.Once(ctx); err != nil {
		t.Fatal(err)
	}
	if len(client.submitted) != 0 {
		t.Fatal("customers were sent to a clean room nobody trusts")
	}

	room.Trusted = trusted
	if err := room.Once(ctx); err != nil {
		t.Fatal(err)
	}
	plain, err := cleanroom.Open(box, client.submitted["run-1"])
	if err != nil {
		t.Fatal(err)
	}
	customers, _ := cleanroom.DecodeCustomers(plain)
	asha, _ := cleanroom.EmailKey("asha@example.com")
	if len(customers) != 2 || customers[0][0] != asha && customers[1][0] != asha {
		t.Fatalf("sealed %d customers: %v", len(customers), customers)
	}
	if len(client.recipient) != 32 {
		t.Fatal("a joint audience's requester sent no key for the result")
	}

	// The joint audience comes back, sealed to this Agent: Asha alone.
	to, err := ecdh.X25519().NewPublicKey(client.recipient)
	if err != nil {
		t.Fatal(err)
	}
	sealed, _ := cleanroom.Seal(to, cleanroom.EncodeKeys([]cleanroom.Key{asha}))
	client.tasks = nil
	client.results = []CleanRoomResult{{RunID: "run-1", Sealed: sealed}}
	if err := room.Once(ctx); err != nil {
		t.Fatal(err)
	}
	var members []string
	rows, _ := store.Pool.Query(ctx, `SELECT partner_user_id FROM oolix_joint_audiences WHERE run_id = 'run-1'`)
	for rows.Next() {
		var id string
		_ = rows.Scan(&id)
		members = append(members, id)
	}
	rows.Close()
	if len(members) != 1 || members[0] != store.ScrambleID("C1") || len(client.acked) != 1 {
		t.Errorf("joint audience %v, acked %v", members, client.acked)
	}
}
