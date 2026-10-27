package source

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/oolix/partner-agent/internal/detect"
)

// Shopify reads a store's customers and orders through the Admin GraphQL
// API, with the access token of a custom app the merchant creates in their
// own admin (Settings -> Apps -> Develop apps) with read_customers and
// read_orders -- read_all_orders too, for more than the last 60 days.
//
// It offers two tables shaped for the setup page: customers, with the
// numeric ID the storefront knows a signed-in customer by and Shopify's own
// marketing consent as a yes/no; and orders, one row per order. The matches
// step then finds them like any table's columns.
const Shopify Kind = "shopify"

// shopifyAPIVersion is the Admin API version the queries are written for.
const shopifyAPIVersion = "2026-07"

var shopifyColumns = map[string][]detect.Column{
	"customers": {
		{Name: "id", Type: "text", PrimaryKey: true}, {Name: "accepts_marketing", Type: "boolean"},
		{Name: "marketing_consent_at", Type: "timestamp"}, {Name: "city", Type: "text"},
		{Name: "province_code", Type: "text"}, {Name: "country_code", Type: "text"},
		{Name: "lifetime_orders", Type: "integer"}, {Name: "last_order_at", Type: "timestamp"},
		{Name: "tags", Type: "text"}, {Name: "created_at", Type: "timestamp"}, {Name: "updated_at", Type: "timestamp"},
	},
	"orders": {
		{Name: "id", Type: "text", PrimaryKey: true}, {Name: "customer_id", Type: "text"},
		{Name: "created_at", Type: "timestamp"}, {Name: "channel", Type: "text"},
		{Name: "payment_gateway", Type: "text"}, {Name: "product_type", Type: "text"},
	},
}

const shopifyCustomers = `query($after: String) {
  customers(first: 250, after: $after, sortKey: ID) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id createdAt updatedAt tags numberOfOrders
      emailMarketingConsent { marketingState consentUpdatedAt }
      defaultAddress { city provinceCode countryCodeV2 }
      lastOrder { createdAt }
    }
  }
}`

const shopifyOrders = `query($after: String, $query: String) {
  orders(first: 250, after: $after, sortKey: CREATED_AT, query: $query) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id createdAt sourceName paymentGatewayNames
      customer { id }
      lineItems(first: 1) { nodes { product { productType } } }
    }
  }
}`

type shopifySource struct {
	endpoint string
	token    string
	http     *http.Client
	// history bounds a full read of orders: older ones count for nothing.
	history time.Duration
}

func openShopify(ctx context.Context, cfg Config) (Source, error) {
	shop := strings.TrimSpace(cfg.Host)
	if shop == "" || cfg.Password == "" {
		return nil, errors.New("Shopify needs the store's address and the custom app's Admin API access token")
	}
	endpoint := shop
	if !strings.Contains(shop, "://") {
		endpoint = "https://" + strings.TrimSuffix(shop, "/")
	}
	s := &shopifySource{endpoint: endpoint + "/admin/api/" + shopifyAPIVersion + "/graphql.json",
		token: cfg.Password, http: &http.Client{Timeout: 2 * time.Minute}, history: 730 * 24 * time.Hour}
	return s, s.Test(ctx)
}

func (s *shopifySource) graphql(ctx context.Context, query string, vars map[string]any, out any) error {
	for attempt := 1; ; attempt++ {
		body, _ := json.Marshal(map[string]any{"query": query, "variables": vars})
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.endpoint, bytes.NewReader(body))
		if err != nil {
			return err
		}
		req.Header.Set("X-Shopify-Access-Token", s.token)
		req.Header.Set("Content-Type", "application/json")
		res, err := s.http.Do(req)
		if err != nil {
			return err
		}
		raw, _ := io.ReadAll(io.LimitReader(res.Body, 32<<20))
		_ = res.Body.Close()
		if res.StatusCode != http.StatusOK {
			return fmt.Errorf("Shopify answered %d: %s", res.StatusCode, strings.TrimSpace(string(raw[:min(len(raw), 300)])))
		}
		var env struct {
			Data   json.RawMessage `json:"data"`
			Errors []struct {
				Message    string `json:"message"`
				Extensions struct {
					Code string `json:"code"`
				} `json:"extensions"`
			} `json:"errors"`
		}
		if err := json.Unmarshal(raw, &env); err != nil {
			return err
		}
		if len(env.Errors) > 0 {
			if env.Errors[0].Extensions.Code == "THROTTLED" && attempt < 6 {
				// The store's query budget refills in seconds.
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(time.Duration(attempt) * 2 * time.Second):
				}
				continue
			}
			return fmt.Errorf("Shopify: %s", env.Errors[0].Message)
		}
		return json.Unmarshal(env.Data, out)
	}
}

func (s *shopifySource) Test(ctx context.Context) error {
	var out struct {
		Shop struct{ Name string } `json:"shop"`
	}
	if err := s.graphql(ctx, `{ shop { name } }`, nil, &out); err != nil {
		return fmt.Errorf("could not reach the store: %w", err)
	}
	return nil
}

func (s *shopifySource) Tables(context.Context) ([]Table, error) {
	return []Table{{Name: "customers", Rows: -1}, {Name: "orders", Rows: -1}}, nil
}

func (s *shopifySource) Columns(_ context.Context, table string) ([]detect.Column, error) {
	cols, ok := shopifyColumns[table]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrUnknownTable, table)
	}
	return cols, nil
}

func (s *shopifySource) Sample(ctx context.Context, table string, n int) (map[string][]any, error) {
	var rows []Row
	err := s.read(ctx, table, time.Now().Add(-s.history), func(r Row) error {
		rows = append(rows, r)
		if len(rows) >= n {
			return errStop
		}
		return nil
	})
	if errors.Is(err, errStop) {
		err = nil
	}
	return transpose(rows), err
}

func (s *shopifySource) Stream(ctx context.Context, table string, columns []string, fn func(Row) error) error {
	keep := map[string]bool{}
	for _, c := range columns {
		keep[c] = true
	}
	return s.read(ctx, table, time.Now().Add(-s.history), func(r Row) error {
		for k := range r {
			if !keep[k] {
				delete(r, k)
			}
		}
		return fn(r)
	})
}

// StreamSince reads orders placed on or after since; customers, all.
func (s *shopifySource) StreamSince(ctx context.Context, table string, columns []string, _ string, since time.Time,
	fn func(Row) error) error {
	keep := map[string]bool{}
	for _, c := range columns {
		keep[c] = true
	}
	return s.read(ctx, table, since.AddDate(0, 0, -2), func(r Row) error {
		for k := range r {
			if !keep[k] {
				delete(r, k)
			}
		}
		return fn(r)
	})
}

func (s *shopifySource) Close() error { return nil }

// numericID turns gid://shopify/Customer/123 into 123: what Liquid's
// customer.id and the storefront know.
func numericID(gid string) string {
	if i := strings.LastIndex(gid, "/"); i >= 0 {
		return gid[i+1:]
	}
	return gid
}

func (s *shopifySource) read(ctx context.Context, table string, ordersSince time.Time, fn func(Row) error) error {
	var after any
	for {
		var conn struct {
			PageInfo struct {
				HasNextPage bool
				EndCursor   string
			} `json:"pageInfo"`
			Nodes []json.RawMessage `json:"nodes"`
		}
		switch table {
		case "customers":
			var out struct{ Customers *json.RawMessage }
			if err := s.graphql(ctx, shopifyCustomers, map[string]any{"after": after}, &out); err != nil {
				return err
			}
			if out.Customers != nil {
				_ = json.Unmarshal(*out.Customers, &conn)
			}
		case "orders":
			var out struct{ Orders *json.RawMessage }
			if err := s.graphql(ctx, shopifyOrders, map[string]any{"after": after,
				"query": "created_at:>=" + ordersSince.UTC().Format("2006-01-02")}, &out); err != nil {
				return err
			}
			if out.Orders != nil {
				_ = json.Unmarshal(*out.Orders, &conn)
			}
		default:
			return fmt.Errorf("%w: %s", ErrUnknownTable, table)
		}
		for _, raw := range conn.Nodes {
			row, err := shopifyRow(table, raw)
			if err != nil {
				return err
			}
			if err := fn(row); err != nil {
				return err
			}
		}
		if !conn.PageInfo.HasNextPage {
			return nil
		}
		after = conn.PageInfo.EndCursor
	}
}

func shopifyRow(table string, raw json.RawMessage) (Row, error) {
	if table == "customers" {
		var c struct {
			ID, CreatedAt, UpdatedAt string
			Tags                     []string
			NumberOfOrders           any
			EmailMarketingConsent    *struct{ MarketingState, ConsentUpdatedAt string }
			DefaultAddress           *struct{ City, ProvinceCode, CountryCodeV2 string }
			LastOrder                *struct{ CreatedAt string }
		}
		if err := json.Unmarshal(raw, &c); err != nil {
			return nil, err
		}
		row := Row{"id": numericID(c.ID), "created_at": c.CreatedAt, "updated_at": c.UpdatedAt,
			"lifetime_orders": fmt.Sprint(c.NumberOfOrders), "accepts_marketing": false}
		if len(c.Tags) > 0 {
			row["tags"] = c.Tags[0]
		}
		if m := c.EmailMarketingConsent; m != nil {
			row["accepts_marketing"] = m.MarketingState == "SUBSCRIBED"
			if m.ConsentUpdatedAt != "" {
				row["marketing_consent_at"] = m.ConsentUpdatedAt
			}
		}
		if a := c.DefaultAddress; a != nil {
			row["city"], row["province_code"], row["country_code"] = a.City, a.ProvinceCode, a.CountryCodeV2
		}
		if c.LastOrder != nil {
			row["last_order_at"] = c.LastOrder.CreatedAt
		}
		return row, nil
	}
	var o struct {
		ID, CreatedAt, SourceName string
		PaymentGatewayNames       []string
		Customer                  *struct{ ID string }
		LineItems                 struct {
			Nodes []struct {
				Product *struct{ ProductType string }
			}
		}
	}
	if err := json.Unmarshal(raw, &o); err != nil {
		return nil, err
	}
	row := Row{"id": numericID(o.ID), "created_at": o.CreatedAt, "channel": "ONLINE"}
	if strings.EqualFold(o.SourceName, "pos") {
		row["channel"] = "OFFLINE"
	}
	if o.Customer != nil {
		row["customer_id"] = numericID(o.Customer.ID)
	}
	if len(o.PaymentGatewayNames) > 0 {
		row["payment_gateway"] = o.PaymentGatewayNames[0]
	}
	if len(o.LineItems.Nodes) > 0 && o.LineItems.Nodes[0].Product != nil {
		row["product_type"] = o.LineItems.Nodes[0].Product.ProductType
	}
	return row, nil
}
