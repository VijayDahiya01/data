package setupui

import (
	"context"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/oolix/partner-agent/internal/managed"
	"github.com/oolix/partner-agent/internal/standard"
)

// A members file that holds age as groups, with the date each member joined.
const membersCSV = `member_id,age_group,joined_on,opted_in
M1,25-45,01/03/2025,Y
M2,30-34,15/06/2024,Y
M3,senior,01/01/2023,Y
M4,18-24,01/01/2026,N
`

// An age group was true on some date. The page asks which, keeps the question
// open until it is answered, and will not publish a copy without the answer:
// guessing could put every age years out.
func TestAgeGroupsAskWhenTheyWereTrue(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	if err := os.WriteFile(filepath.Join(h.importDir, "members.csv"), []byte(membersCSV), 0o600); err != nil {
		t.Fatal(err)
	}
	h.post("/login", url.Values{"password": {"correct horse battery"}})
	csrf := h.csrf()
	h.post("/register", url.Values{"csrf": {csrf}, "code": {"one-time-code"}})
	h.post("/source", url.Values{"csrf": {csrf}, "kind": {"file"}, "location": {"Asia/Kolkata"}})
	_, at, body := h.post("/table", url.Values{"csrf": {csrf}, "table": {"members.csv"}})
	if at != "/review" {
		t.Fatalf("table choice ended at %s", at)
	}
	for _, want := range []string{
		`<option value="age_band" selected>An age group, such as 25-45 or 60&#43;</option>`,
		`<option value="ask" selected>Choose</option>`,
		"<code>25-45</code>", "age 25 to 45",
		// "senior" is not a group the Agent can read: the Partner says which.
		`<code>senior</code>`, `aria-label="Age group for senior"`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("review page lacks %q", want)
		}
	}

	form := url.Values{"csrf": {csrf}, "id_column": {"member_id"}, "col_age": {"age_group"},
		"publish_age": {"on"}, "form_age": {"age_band"}, "asof_age": {"ask"},
		"raw_age_0": {"senior"}, "code_age_0": {"60 and above"}, "action": {"next"}}
	if _, at, _ := h.post("/review", form); at != "/activity" {
		t.Fatalf("review ended at %s", at)
	}
	publish := url.Values{"csrf": {csrf}, "consent_column": {"opted_in"}, "web": {"on"}, "sync_hour": {"3"},
		"action": {"publish"}}
	if _, _, body := h.post("/consent", publish); !strings.Contains(body, "Answer the question about age") {
		t.Error("publishing with the as-of question open should be refused")
	}

	// Each group was true on the day the member joined.
	form.Set("asof_age", "column")
	form.Set("asof_column_age", "joined_on")
	if _, at, _ := h.post("/review", form); at != "/activity" {
		t.Fatalf("review ended at %s", at)
	}
	draft, _ := managed.Settings{Store: h.store}.Draft(ctx)
	age := draft.Attributes["age"]
	if age.Form != standard.FormAgeBand || age.AsOf != managed.AsOfColumn || age.AsOfColumn != "joined_on" ||
		age.Overrides["senior"] != "60+" {
		t.Fatalf("answers not kept: %+v", age)
	}
	if _, body := h.get("/review"); !strings.Contains(body, "on 1 Mar 2025 (now") {
		t.Error("examples should say when each group was true, and what it means now")
	}
	if _, at, _ := h.post("/consent", publish); at != "/?notice=publishing" {
		t.Fatalf("publish ended at %s", at)
	}

	rep, err := h.runner.SyncOnce(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if rep.Customers != 3 || rep.Attributes["age"].Filled != 3 {
		t.Errorf("sync: %+v", rep)
	}
	// Groups recorded on different days have drifted apart, so Oolix hears
	// only how wide they are.
	if len(h.published) != 1 || h.published[0].Attributes[0].Precision == nil ||
		h.published[0].Attributes[0].Precision.Kind != "APPROXIMATE" {
		t.Errorf("published: %+v", h.published)
	}
}
