package source

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/oolix/partner-agent/internal/detect"
)

func TestShopifyStore(t *testing.T) {
	var throttled atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Shopify-Access-Token") != "shpat_test" ||
			r.URL.Path != "/admin/api/"+shopifyAPIVersion+"/graphql.json" {
			http.Error(w, "no", http.StatusUnauthorized)
			return
		}
		var body struct {
			Query     string         `json:"query"`
			Variables map[string]any `json:"variables"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		switch {
		case strings.Contains(body.Query, "shop { name }"):
			fmt.Fprint(w, `{"data":{"shop":{"name":"Test Store"}}}`)
		case strings.Contains(body.Query, "customers(") && body.Variables["after"] == nil:
			if !throttled.Load() {
				throttled.Store(true)
				fmt.Fprint(w, `{"errors":[{"message":"Throttled","extensions":{"code":"THROTTLED"}}]}`)
				return
			}
			fmt.Fprint(w, `{"data":{"customers":{"pageInfo":{"hasNextPage":true,"endCursor":"c1"},"nodes":[
			  {"id":"gid://shopify/Customer/101","createdAt":"2024-01-01T00:00:00Z","tags":["vip"],"numberOfOrders":"7",
			   "emailMarketingConsent":{"marketingState":"SUBSCRIBED","consentUpdatedAt":"2024-02-01T00:00:00Z"},
			   "defaultAddress":{"city":"Bombay","provinceCode":"MH","countryCodeV2":"IN"},
			   "lastOrder":{"createdAt":"2026-10-20T10:00:00Z"}}]}}}`)
		case strings.Contains(body.Query, "customers("):
			fmt.Fprint(w, `{"data":{"customers":{"pageInfo":{"hasNextPage":false},"nodes":[
			  {"id":"gid://shopify/Customer/102","numberOfOrders":"0",
			   "emailMarketingConsent":{"marketingState":"UNSUBSCRIBED"},"defaultAddress":null,"lastOrder":null}]}}}`)
		case strings.Contains(body.Query, "orders("):
			if !strings.HasPrefix(fmt.Sprint(body.Variables["query"]), "created_at:>=") {
				t.Errorf("orders are read within the history window: %v", body.Variables["query"])
			}
			fmt.Fprint(w, `{"data":{"orders":{"pageInfo":{"hasNextPage":false},"nodes":[
			  {"id":"gid://shopify/Order/9","createdAt":"2026-10-20T10:00:00Z","sourceName":"pos",
			   "paymentGatewayNames":["cash_on_delivery"],"customer":{"id":"gid://shopify/Customer/101"},
			   "lineItems":{"nodes":[{"product":{"productType":"Sneakers"}}]}}]}}}`)
		}
	}))
	defer srv.Close()

	ctx := context.Background()
	src, err := Open(ctx, Config{Kind: Shopify, Host: srv.URL, Password: "shpat_test"})
	if err != nil {
		t.Fatal(err)
	}
	var customers []Row
	if err := src.Stream(ctx, "customers", []string{"id", "accepts_marketing", "city", "province_code",
		"last_order_at"}, func(r Row) error {
		customers = append(customers, r)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(customers) != 2 || customers[0]["id"] != "101" || customers[0]["accepts_marketing"] != true ||
		customers[0]["city"] != "Bombay" || customers[1]["accepts_marketing"] != false {
		t.Errorf("customers: %v", customers)
	}
	var orders []Row
	if err := src.(SinceStreamer).StreamSince(ctx, "orders", []string{"customer_id", "created_at", "channel",
		"payment_gateway", "product_type"}, "created_at", time.Now().AddDate(0, 0, -30), func(r Row) error {
		orders = append(orders, r)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(orders) != 1 || orders[0]["customer_id"] != "101" || orders[0]["channel"] != "OFFLINE" ||
		orders[0]["product_type"] != "Sneakers" {
		t.Errorf("orders: %v", orders)
	}

	// The setup page's detection finds the attributes, the ID and consent in
	// the customers table by itself.
	cols, _ := src.Columns(ctx, "customers")
	sample, err := src.Sample(ctx, "customers", 10)
	if err != nil {
		t.Fatal(err)
	}
	if id, _ := detect.SuggestID(cols, sample); id != "id" {
		t.Errorf("customer ID suggested: %q", id)
	}
	if consent, _ := detect.SuggestConsent(cols); consent != "accepts_marketing" {
		t.Errorf("consent suggested: %q", consent)
	}
	matched := map[string]string{}
	for _, sg := range detect.Suggest(cols, sample, time.Now()) {
		matched[sg.Attribute] = sg.Column
	}
	for attr, col := range map[string]string{"city": "city", "state_region": "province_code",
		"country": "country_code", "purchase_recency_days": "last_order_at"} {
		if matched[attr] != col {
			t.Errorf("%s matched to %q, want %q", attr, matched[attr], col)
		}
	}
	if matched["purchase_frequency"] != "" {
		t.Error("a lifetime order count must not be read as purchases in 90 days")
	}
}
