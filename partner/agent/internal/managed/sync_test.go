package managed

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/oolix/partner-agent/internal/audience"
	"github.com/oolix/partner-agent/internal/clean"
	"github.com/oolix/partner-agent/internal/detect"
	"github.com/oolix/partner-agent/internal/localstore"
	"github.com/oolix/partner-agent/internal/source"
	"github.com/oolix/partner-agent/internal/testdb"
)

// Needs a PostgreSQL to act as the Agent's local store, e.g.
//
//	OOLIX_TEST_LOCALSTORE_URL=postgres://user:pass@host:5432/postgres
//
// This package gets its own database there, emptied and reused.
func localStore(t *testing.T) *localstore.Store {
	t.Helper()
	url := testdb.URL(t, "managed")
	ctx := context.Background()
	s, err := localstore.Open(ctx, url, filepath.Join(t.TempDir(), "local.key"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	if err := s.DeleteCopiedData(ctx); err != nil {
		t.Fatal(err)
	}
	// Each test starts from an Agent nobody has set up.
	if _, err := s.Pool.Exec(ctx, `DELETE FROM oolix_agent_settings; DELETE FROM oolix_sync_runs`); err != nil {
		t.Fatal(err)
	}
	return s
}

// The messy customer table from the Partner's side: every trap at once.
const messyCSV = `customer_id,Full Name,DOB,sex,City,tier,is_app_user,lastLogin,marketing_opt_in,unsubscribed_at
C1,Asha Rao,14/04/1992,F,Bombay,Gold,Y,2026-09-01 10:30:00,yes,
C2,Ravi Iyer,14-04-1993,M,bangalore,Silver,N,2026-08-01 00:00:00,true,
C3,Mira Das,1992-04-13T18:30:00Z,female,Mumbai,Elite,1,2026-09-20 09:00:00,Y,
C4,Kid Kumar,01/01/2015,M,Mumbai,Gold,Y,2026-09-01 10:00:00,yes,
C5,No Consent,,2,Pune,,0,,no,
,Orphan Row,12/12/1980,M,Pune,Gold,Y,,yes,
C6,Bad Date,31/02/1990,M,Thane,Platinum,Y,2026-09-01 10:30:00,yes,
C7,Withdrew,05/05/1985,F,Delhi,Gold,Y,2026-09-01 10:30:00,yes,2026-09-10
C8,Listed Twice,06/06/1986,M,Pune,Gold,Y,2026-09-01 10:30:00,yes,
C8,Listed Twice,06/06/1986,M,Pune,Gold,Y,2026-09-01 10:30:00,no,
`

var now = time.Date(2026, 9, 26, 12, 0, 0, 0, time.UTC)

// A mapping made the way the setup page makes it: from detect's suggestions.
func mappingFor(t *testing.T, src source.Source, table string) Mapping {
	t.Helper()
	ctx := context.Background()
	cols, err := src.Columns(ctx, table)
	if err != nil {
		t.Fatal(err)
	}
	sample, err := src.Sample(ctx, table, 1000)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := detect.SuggestID(cols, sample)
	consent, withdrawal := detect.SuggestConsent(cols)
	m := Mapping{
		Table: table, IDColumn: id, Attributes: map[string]AttributeMapping{},
		Consent: ConsentMapping{Column: consent, Withdrawal: withdrawal},
	}
	for _, s := range detect.Suggest(cols, sample, now) {
		if s.Column != "" {
			m.Attributes[s.Attribute] = AttributeMapping{Column: s.Column, Order: s.Order, Publish: true}
		}
	}
	return m
}

func TestSyncCleansAndCopiesAMessyTable(t *testing.T) {
	store := localStore(t)
	ctx := context.Background()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "customers.csv"), []byte(messyCSV), 0o600); err != nil {
		t.Fatal(err)
	}
	src, err := source.Open(ctx, source.Config{Kind: source.File, Folder: dir})
	if err != nil {
		t.Fatal(err)
	}
	m := mappingFor(t, src, "customers.csv")
	if m.IDColumn != "customer_id" || m.Consent.Column != "marketing_opt_in" {
		t.Fatalf("detected mapping: %+v", m)
	}

	rep, err := Sync(ctx, src, store, m, now)
	if err != nil {
		t.Fatal(err)
	}

	// Copied: C1, C2, C3, C6. The orphan row has no id; C4 was born in
	// 2015; C5 said no, C7 withdrew, and C8 is listed twice with different
	// answers -- which is a no.
	if rep.RowsRead != 10 || rep.WithoutID != 1 || rep.UnderAge != 1 || rep.Duplicates != 1 ||
		rep.Customers != 4 || rep.NotConsented != 3 {
		t.Errorf("counts: %+v", rep)
	}
	// Thane and Elite are not codes: reported for the Partner, not guessed.
	if u := rep.Attributes["city"].Unrecognised; len(u) != 1 || u[0].Value != "Thane" {
		t.Errorf("unrecognised cities: %+v", u)
	}
	if u := rep.Attributes["loyalty_tier"].Unrecognised; len(u) != 1 || u[0].Value != "Elite" {
		t.Errorf("unrecognised tiers: %+v", u)
	}
	if f := rep.Attributes["age"].Filled; f != 3 {
		t.Errorf("customers with an age: %d", f)
	}
	// 31/02/1990 is not a date.
	if rep.Attributes["age"].Unreadable != 1 {
		t.Errorf("unreadable dates of birth: %+v", rep.Attributes["age"])
	}

	type row struct {
		dob          *time.Time
		gender, city *string
		appActive    *bool
	}
	get := func(id string) (row, bool) {
		var r row
		err := store.Pool.QueryRow(ctx,
			`SELECT dob, gender, city, app_active FROM oolix_audience_attributes WHERE partner_user_id = $1`,
			store.ScrambleID(id)).Scan(&r.dob, &r.gender, &r.city, &r.appActive)
		return r, err == nil
	}
	c1, ok := get("C1")
	if !ok || c1.dob.Format("2006-01-02") != "1992-04-14" || *c1.gender != "FEMALE" || *c1.city != "MUMBAI" || !*c1.appActive {
		t.Errorf("C1: %+v", c1)
	}
	if c2, _ := get("C2"); c2.dob.Format("2006-01-02") != "1993-04-14" || *c2.city != "BENGALURU" {
		t.Errorf("C2: %+v", c2)
	}
	// Midnight in India, stored as UTC: still the 14th.
	if c3, _ := get("C3"); c3.dob.Format("2006-01-02") != "1992-04-14" || *c3.city != "MUMBAI" {
		t.Errorf("C3: %+v", c3)
	}
	if c6, _ := get("C6"); c6.dob != nil || c6.city != nil {
		t.Errorf("C6 kept an impossible date or an unknown city: %+v", c6)
	}
	for _, id := range []string{"C4", "C5", "C7", "C8"} {
		if _, found := get(id); found {
			t.Errorf("%s was copied", id)
		}
	}

	// The copy holds no customer id that means anything outside it.
	var raw int
	_ = store.Pool.QueryRow(ctx, `SELECT count(*) FROM oolix_audience_attributes
		WHERE partner_user_id IN ('C1','C2','C3','C6')`).Scan(&raw)
	if raw != 0 {
		t.Errorf("%d raw customer ids in the copy", raw)
	}

	// The Agent's own audience code works on the copy unchanged: women aged
	// 30 to 40 in Mumbai are C1 and C3.
	pool := store.Pool
	ev := audience.NewEvaluator(audience.EvaluatorOptions{
		Pool: pool, AttributeTable: localstore.AttributesTable,
		Mappings: EvaluatorMappings(), MappingVersion: MappingVersion,
	})
	rules := []audience.Rule{
		{Attribute: "age", Operator: audience.OpBETWEEN, Value: []interface{}{30.0, 40.0}, Required: true},
		{Attribute: "gender", Operator: audience.OpIN, Value: []interface{}{"FEMALE"}, Required: true},
		{Attribute: "city", Operator: audience.OpIN, Value: []interface{}{"MUMBAI"}, Required: true},
	}
	activation := uuid.NewString()
	res, err := ev.Materialize(ctx, activation, "ag-test", 1, rules, "", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if res.MemberCount != 2 {
		t.Errorf("members: %d", res.MemberCount)
	}
	if member, _, _ := ev.IsMaterializedMember(ctx, store.ScrambleID("C1"), activation); !member {
		t.Error("C1 should be a member, looked up by scrambled id")
	}
}

func TestSyncReplacesTheCopyAndForgetsRemovedCustomers(t *testing.T) {
	store := localStore(t)
	ctx := context.Background()
	dir := t.TempDir()
	path := filepath.Join(dir, "customers.csv")
	write := func(body string) {
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("customer_id,DOB\nA,14/04/1990\nB,15/05/1991\n")
	src, _ := source.Open(ctx, source.Config{Kind: source.File, Folder: dir})
	m := Mapping{Table: "customers.csv", IDColumn: "customer_id",
		Attributes: map[string]AttributeMapping{"age": {Column: "DOB", Order: clean.DayFirst}},
		Consent:    ConsentMapping{Everyone: true}}

	if rep, err := Sync(ctx, src, store, m, now); err != nil || rep.Customers != 2 {
		t.Fatalf("first sync: %+v, %v", rep, err)
	}
	// B left the Partner's system. The next copy must not keep them.
	write("customer_id,DOB\nA,14/04/1990\n")
	rep, err := Sync(ctx, src, store, m, now)
	if err != nil || rep.Customers != 1 {
		t.Fatalf("second sync: %+v, %v", rep, err)
	}
	var n int
	_ = store.Pool.QueryRow(ctx, `SELECT count(*) FROM oolix_audience_attributes WHERE partner_user_id = $1`,
		store.ScrambleID("B")).Scan(&n)
	if n != 0 {
		t.Error("a removed customer survived the refresh")
	}
	// With no consent recorded nobody is copied: the safe direction.
	m.Consent = ConsentMapping{}
	if rep, err := Sync(ctx, src, store, m, now); err != nil || rep.Customers != 0 || rep.NotConsented != 1 {
		t.Errorf("sync without consent: %+v, %v", rep, err)
	}
}
