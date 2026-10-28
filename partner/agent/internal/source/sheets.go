package source

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/oolix/partner-agent/internal/detect"
	"github.com/oolix/partner-agent/internal/netx"
)

// GoogleSheets reads a spreadsheet the Partner shares with a service account
// (the email in its key, as a viewer). Each sheet is a table; its first row
// names the columns. Values are read as shown -- 14/04/1992, not a serial
// number -- and cleaned like any CSV.
const GoogleSheets Kind = "google_sheets"

const sheetsReadOnly = "https://www.googleapis.com/auth/spreadsheets.readonly"

var sheetID = regexp.MustCompile(`/spreadsheets/d/([a-zA-Z0-9_-]+)`)

type sheetsSource struct {
	id   string
	api  string
	auth *googleAuth
	http *http.Client
}

func openSheets(ctx context.Context, cfg Config) (Source, error) {
	id := strings.TrimSpace(cfg.Database)
	if m := sheetID.FindStringSubmatch(id); m != nil {
		id = m[1]
	}
	if id == "" {
		return nil, errors.New("paste the spreadsheet's link or ID")
	}
	sa, err := parseServiceAccount(cfg.Password)
	if err != nil {
		return nil, err
	}
	api := "https://sheets.googleapis.com"
	if cfg.Host != "" {
		api = strings.TrimRight(cfg.Host, "/")
	}
	client := netx.Client(5 * time.Minute)
	s := &sheetsSource{id: id, api: api, auth: newGoogleAuth(sa, sheetsReadOnly, client), http: client}
	return s, s.Test(ctx)
}

func (s *sheetsSource) get(ctx context.Context, path string, out any) error {
	token, err := s.auth.token(ctx)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.api+"/v4/spreadsheets/"+url.PathEscape(s.id)+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := s.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
		if res.StatusCode == http.StatusForbidden || res.StatusCode == http.StatusNotFound {
			return fmt.Errorf("Google Sheets answered %d: share the spreadsheet with the service account's "+
				"email, as a viewer (%s)", res.StatusCode, strings.TrimSpace(string(msg)))
		}
		return fmt.Errorf("Google Sheets answered %d: %s", res.StatusCode, strings.TrimSpace(string(msg)))
	}
	return json.NewDecoder(res.Body).Decode(out)
}

func (s *sheetsSource) Test(ctx context.Context) error {
	_, err := s.Tables(ctx)
	return err
}

func (s *sheetsSource) Tables(ctx context.Context) ([]Table, error) {
	var res struct {
		Sheets []struct {
			Properties struct {
				Title          string `json:"title"`
				GridProperties struct {
					RowCount int64 `json:"rowCount"`
				} `json:"gridProperties"`
			} `json:"properties"`
		} `json:"sheets"`
	}
	if err := s.get(ctx, "?fields=sheets.properties(title,gridProperties.rowCount)", &res); err != nil {
		return nil, err
	}
	var out []Table
	for _, sh := range res.Sheets {
		out = append(out, Table{Name: sh.Properties.Title, Rows: max(sh.Properties.GridProperties.RowCount-1, -1)})
	}
	return out, nil
}

// each reads a sheet as rows of text, the first naming the columns.
func (s *sheetsSource) each(ctx context.Context, table string, fn func([]string, []string) error) error {
	tables, err := s.Tables(ctx)
	if err != nil {
		return err
	}
	listed := false
	for _, t := range tables {
		listed = listed || t.Name == table
	}
	if !listed {
		return fmt.Errorf("%w: %s", ErrUnknownTable, table)
	}
	var res struct {
		Values [][]any `json:"values"`
	}
	sheetRange := "'" + strings.ReplaceAll(table, "'", "''") + "'"
	if err := s.get(ctx, "/values/"+url.PathEscape(sheetRange)+"?valueRenderOption=FORMATTED_VALUE", &res); err != nil {
		return err
	}
	if len(res.Values) == 0 {
		return nil
	}
	text := func(cells []any) []string {
		out := make([]string, len(cells))
		for i, c := range cells {
			out[i] = strings.TrimSpace(fmt.Sprint(c))
		}
		return out
	}
	header := text(res.Values[0])
	for _, r := range res.Values[1:] {
		if err := fn(header, text(r)); err != nil {
			return err
		}
	}
	return nil
}

func (s *sheetsSource) Columns(ctx context.Context, table string) ([]detect.Column, error) {
	var cols []detect.Column
	err := s.each(ctx, table, func(header, _ []string) error {
		for _, h := range header {
			if h != "" {
				cols = append(cols, detect.Column{Name: h, Type: "text"})
			}
		}
		return errStop
	})
	if errors.Is(err, errStop) {
		err = nil
	}
	return cols, err
}

func (s *sheetsSource) Sample(ctx context.Context, table string, n int) (map[string][]any, error) {
	var rows []Row
	err := s.each(ctx, table, func(header, rec []string) error {
		rows = append(rows, toRow(header, rec, nil))
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

func (s *sheetsSource) Stream(ctx context.Context, table string, columns []string, fn func(Row) error) error {
	keep := map[string]bool{}
	for _, c := range columns {
		keep[c] = true
	}
	return s.each(ctx, table, func(header, rec []string) error {
		return fn(toRow(header, rec, keep))
	})
}

func (s *sheetsSource) Close() error { return nil }
