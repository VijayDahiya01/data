package source

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/oolix/partner-agent/internal/detect"
)

// Snowflake reads tables through Snowflake's SQL API with key-pair sign-in:
// the Partner registers a public key for a user whose role can only SELECT
// the customer table, and gives the Agent the private key -- no password is
// kept. Results come in partitions, read one after another.
const Snowflake Kind = "snowflake"

type snowflakeSource struct {
	base                        string
	account, user               string
	key                         *rsa.PrivateKey
	fingerprint                 string
	database, schema, warehouse string
	role                        string
	http                        *http.Client
}

func openSnowflake(ctx context.Context, cfg Config) (Source, error) {
	if cfg.Host == "" || cfg.User == "" || cfg.Password == "" || cfg.Database == "" {
		return nil, errors.New("Snowflake needs the account, the user, its private key and the database")
	}
	block, _ := pem.Decode([]byte(cfg.Password))
	if block == nil {
		return nil, errors.New("paste the user's private key, unencrypted, in PEM form")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("the private key could not be read (PKCS#8, unencrypted): %w", err)
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("Snowflake key-pair sign-in needs an RSA key")
	}
	pub, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(pub)
	s := &snowflakeSource{account: snowflakeAccount(cfg.Host), user: strings.ToUpper(cfg.User), key: key,
		fingerprint: "SHA256:" + base64.StdEncoding.EncodeToString(sum[:]), database: cfg.Database,
		schema: cfg.Path, warehouse: cfg.Warehouse, role: cfg.Role, http: &http.Client{Timeout: 10 * time.Minute}}
	if strings.Contains(cfg.Host, "://") {
		s.base = strings.TrimRight(cfg.Host, "/")
	} else {
		s.base = "https://" + strings.TrimSuffix(strings.ToLower(cfg.Host), ".snowflakecomputing.com") +
			".snowflakecomputing.com"
	}
	return s, s.Test(ctx)
}

// snowflakeAccount is the account name as Snowflake's JWT wants it: upper
// case, without region or cloud ("xy12345.ap-south-1.aws" is XY12345), and
// an organization-account name with "-" for ".".
func snowflakeAccount(host string) string {
	h := strings.ToLower(host)
	if u, err := url.Parse(h); err == nil && u.Host != "" {
		h = u.Hostname()
	}
	h = strings.TrimSuffix(h, ".snowflakecomputing.com")
	if i := strings.Index(h, "."); i >= 0 {
		h = h[:i]
	}
	return strings.ToUpper(h)
}

func (s *snowflakeSource) jwt() (string, error) {
	now := time.Now()
	enc := base64.RawURLEncoding
	header := enc.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT"}`))
	claims, _ := json.Marshal(map[string]any{
		"iss": s.account + "." + s.user + "." + s.fingerprint,
		"sub": s.account + "." + s.user,
		"iat": now.Unix(), "exp": now.Add(59 * time.Minute).Unix(),
	})
	unsigned := header + "." + enc.EncodeToString(claims)
	h := sha256.Sum256([]byte(unsigned))
	sig, err := rsa.SignPKCS1v15(rand.Reader, s.key, crypto.SHA256, h[:])
	if err != nil {
		return "", err
	}
	return unsigned + "." + enc.EncodeToString(sig), nil
}

type sfResult struct {
	StatementHandle    string `json:"statementHandle"`
	StatementStatusURL string `json:"statementStatusUrl"`
	Message            string `json:"message"`
	ResultSetMetaData  struct {
		PartitionInfo []struct{} `json:"partitionInfo"`
		RowType       []struct {
			Name string `json:"name"`
			Type string `json:"type"`
		} `json:"rowType"`
	} `json:"resultSetMetaData"`
	Data [][]*string `json:"data"`
}

func (s *snowflakeSource) do(ctx context.Context, method, path string, body any) (*sfResult, int, error) {
	token, err := s.jwt()
	if err != nil {
		return nil, 0, err
	}
	var reader io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		reader = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, s.base+path, reader)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Snowflake-Authorization-Token-Type", "KEYPAIR_JWT")
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := s.http.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer res.Body.Close()
	var out sfResult
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil && err != io.EOF {
		return nil, res.StatusCode, fmt.Errorf("Snowflake answered %d", res.StatusCode)
	}
	if res.StatusCode != http.StatusOK && res.StatusCode != http.StatusAccepted {
		return nil, res.StatusCode, fmt.Errorf("Snowflake answered %d: %s", res.StatusCode, out.Message)
	}
	return &out, res.StatusCode, nil
}

// run executes one read and calls fn with each row, partition by partition,
// as values made plain by their column type.
func (s *snowflakeSource) run(ctx context.Context, statement string, binds []string, fn func([]string, []any) error) error {
	body := map[string]any{"statement": statement, "timeout": 600, "database": s.database}
	if s.schema != "" {
		body["schema"] = s.schema
	}
	if s.warehouse != "" {
		body["warehouse"] = s.warehouse
	}
	if s.role != "" {
		body["role"] = s.role
	}
	if len(binds) > 0 {
		b := map[string]any{}
		for i, v := range binds {
			b[strconv.Itoa(i+1)] = map[string]string{"type": "TEXT", "value": v}
		}
		body["bindings"] = b
	}
	res, code, err := s.do(ctx, http.MethodPost, "/api/v2/statements", body)
	for err == nil && code == http.StatusAccepted {
		// Still running: ask again.
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
		}
		res, code, err = s.do(ctx, http.MethodGet, "/api/v2/statements/"+url.PathEscape(res.StatementHandle), nil)
	}
	if err != nil {
		return err
	}
	meta := res.ResultSetMetaData
	names := make([]string, len(meta.RowType))
	for i, c := range meta.RowType {
		names[i] = c.Name
	}
	emit := func(data [][]*string) error {
		for _, r := range data {
			vals := make([]any, len(r))
			for i, v := range r {
				if v != nil && i < len(meta.RowType) {
					vals[i] = sfValue(meta.RowType[i].Type, *v)
				}
			}
			if err := fn(names, vals); err != nil {
				return err
			}
		}
		return nil
	}
	if err := emit(res.Data); err != nil {
		return err
	}
	for p := 1; p < len(meta.PartitionInfo); p++ {
		part, _, err := s.do(ctx, http.MethodGet, "/api/v2/statements/"+url.PathEscape(res.StatementHandle)+
			"?partition="+strconv.Itoa(p), nil)
		if err != nil {
			return err
		}
		if err := emit(part.Data); err != nil {
			return err
		}
	}
	return nil
}

// sfValue makes a value plain. The SQL API writes a date as days since 1970
// and a timestamp as seconds since 1970 with a fraction (and, for TZ, an
// offset after a space); a timestamp without a zone stays wall-clock text.
func sfValue(typ, v string) any {
	switch strings.ToLower(typ) {
	case "date":
		if days, err := strconv.ParseInt(v, 10, 64); err == nil {
			return time.Unix(days*86400, 0).UTC().Format("2006-01-02")
		}
	case "timestamp_ntz", "timestamp_ltz", "timestamp_tz":
		secs, _, _ := strings.Cut(v, " ")
		whole, frac, _ := strings.Cut(secs, ".")
		sec, err := strconv.ParseInt(whole, 10, 64)
		if err != nil {
			return v
		}
		nanos, _ := strconv.ParseInt((frac + "000000000")[:9], 10, 64)
		t := time.Unix(sec, nanos).UTC()
		if strings.EqualFold(typ, "timestamp_ntz") {
			return t.Format("2006-01-02 15:04:05")
		}
		return t
	}
	return v
}

func (s *snowflakeSource) Test(ctx context.Context) error {
	return s.run(ctx, "SELECT 1", nil, func([]string, []any) error { return nil })
}

func (s *snowflakeSource) Tables(ctx context.Context) ([]Table, error) {
	var out []Table
	err := s.run(ctx, `SELECT table_schema, table_name, COALESCE(row_count, -1) FROM information_schema.tables
		WHERE table_schema <> 'INFORMATION_SCHEMA'`, nil, func(_ []string, v []any) error {
		n, _ := strconv.ParseInt(fmt.Sprint(v[2]), 10, 64)
		out = append(out, Table{Name: fmt.Sprint(v[0]) + "." + fmt.Sprint(v[1]), Rows: n})
		return nil
	})
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, err
}

// from quotes a listed table: the name arrives from a form.
func (s *snowflakeSource) from(ctx context.Context, table string) (schema, name, quoted string, err error) {
	tables, err := s.Tables(ctx)
	if err != nil {
		return "", "", "", err
	}
	for _, t := range tables {
		if t.Name == table {
			schema, name, _ = strings.Cut(table, ".")
			return schema, name, doubleQuote(schema) + "." + doubleQuote(name), nil
		}
	}
	return "", "", "", fmt.Errorf("%w: %s", ErrUnknownTable, table)
}

func (s *snowflakeSource) Columns(ctx context.Context, table string) ([]detect.Column, error) {
	schema, name, _, err := s.from(ctx, table)
	if err != nil {
		return nil, err
	}
	var cols []detect.Column
	err = s.run(ctx, `SELECT column_name, data_type FROM information_schema.columns
		WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`, []string{schema, name},
		func(_ []string, v []any) error {
			cols = append(cols, detect.Column{Name: fmt.Sprint(v[0]), Type: strings.ToLower(fmt.Sprint(v[1]))})
			return nil
		})
	return cols, err
}

func (s *snowflakeSource) Sample(ctx context.Context, table string, n int) (map[string][]any, error) {
	_, _, quoted, err := s.from(ctx, table)
	if err != nil {
		return nil, err
	}
	var rows []Row
	err = s.run(ctx, "SELECT * FROM "+quoted+" LIMIT "+strconv.Itoa(n), nil, func(names []string, v []any) error {
		rows = append(rows, sfRow(names, v))
		return nil
	})
	return transpose(rows), err
}

func (s *snowflakeSource) Stream(ctx context.Context, table string, columns []string, fn func(Row) error) error {
	_, _, quoted, err := s.from(ctx, table)
	if err != nil {
		return err
	}
	if len(columns) == 0 {
		return errors.New("no columns chosen")
	}
	q := make([]string, len(columns))
	for i, c := range columns {
		q[i] = doubleQuote(c)
	}
	return s.run(ctx, "SELECT "+strings.Join(q, ", ")+" FROM "+quoted, nil, func(names []string, v []any) error {
		return fn(sfRow(names, v))
	})
}

func sfRow(names []string, v []any) Row {
	r := make(Row, len(names))
	for i, n := range names {
		r[n] = v[i]
	}
	return r
}

func (s *snowflakeSource) Close() error { return nil }
