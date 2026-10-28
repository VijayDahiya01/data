package setupui

import (
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/oolix/partner-agent/internal/detect"
	"github.com/oolix/partner-agent/internal/managed"
)

// The pages show suggestions, the places left out, the ask buttons and the
// sharing choice -- rendered without a database, so a template mistake fails
// here and not in front of a Partner.
func TestPagesOfferHelpWithUnreadValues(t *testing.T) {
	pages, err := parsePages()
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{opts: Options{Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}, pages: pages}
	answers := []answer{
		{Raw: "Gurgoan", Count: 3, Code: "GURUGRAM", Why: "a close spelling"},
		{Raw: "Zzyzx", Count: 1},
	}

	rec := httptest.NewRecorder()
	s.render(rec, "review.html", view{Title: "Check the matches", CSRF: "c", Data: reviewData{
		Table: "customers", Columns: []columnOption{{Name: "city"}}, Sampled: 10,
		Help: helpState{CanAsk: true, Sharing: true},
		Groups: []reviewGroup{{Name: "Where they live", Rows: []attrRow{{
			Key: "city", Label: "City", Column: "city", Codes: []string{"GURUGRAM", "MUMBAI"},
			Answers: answers, CanAsk: true, Places: true, Publish: true,
			Measure: managed.Measurement{Sampled: 6, Readable: 2, Outside: 4,
				OutsideExamples: []detect.ValueCount{{Value: "Lucknow", Count: 3}, {Value: "226001", Count: 1}}},
		}}}},
	}})
	body := rec.Body.String()
	if rec.Code != 200 {
		t.Fatalf("review page: %d %s", rec.Code, body)
	}
	for _, want := range []string{
		`suggested: a close spelling`,
		`value="ask:city"`,
		`place names`,
		`outside Oolix's list (Lucknow, 226001)`,
		`name="share_answers" checked`,
		`id="attr-city"`,
		`GeoNames`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("review page lacks %q", want)
		}
	}

	rec = httptest.NewRecorder()
	s.render(rec, "activity.html", view{Title: "Orders and bookings", CSRF: "c", Data: activityData{
		Cards: []activityCard{{Kind: "orders", Title: "Orders", Table: "orders", Columns: []columnOption{{Name: "cat"}},
			Fields: []activityField{{Key: "purchase_category", Label: "Category", Column: "cat",
				Codes: []string{"FOOTWEAR"}, Answers: []answer{{Raw: "Running shoes", Count: 4}}, CanAsk: true}}}},
	}})
	body = rec.Body.String()
	if rec.Code != 200 {
		t.Fatalf("activity page: %d %s", rec.Code, body)
	}
	if !strings.Contains(body, `value="ask:orders:purchase_category"`) {
		t.Error("activity page lacks the ask button")
	}
}

func TestOnlyShortPhrasesAreAskedAbout(t *testing.T) {
	got := askable([]answer{
		{Raw: "Kurtis", Count: 4},
		{Raw: "Mumbay", Count: 2, Code: "MUMBAI"}, // the Agent already suggests one
		{Raw: "Elite", Code: "PLATINUM"},          // answered earlier
		{Raw: "asha@example.com", Count: 1},       // a person
		{Raw: "+91 98765 43210", Count: 1},        // a phone number
		{Raw: "Running shoes for men", Count: 1},
	})
	if strings.Join(got, "|") != "Kurtis|Running shoes for men" {
		t.Errorf("asked about %q", got)
	}
}
