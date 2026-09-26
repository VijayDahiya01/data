package source

import (
	"context"
	"database/sql"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	_ "github.com/microsoft/go-mssqldb" // registers the "sqlserver" driver

	"github.com/oolix/partner-agent/internal/detect"
)

// dialect is what differs between PostgreSQL, MySQL and SQL Server.
type dialect struct {
	// quote makes one identifier safe to put in SQL, whatever it contains.
	quote func(string) string
	// tables lists (schema, name, estimated rows).
	tables string
	// columns lists (name, type, is primary key) for a schema and table.
	columns string
	// first limits a SELECT to n rows.
	first func(columns, from string, n int) string
	// defaultSchema is assumed when a table name has no schema.
	defaultSchema string
	// hideSchema is the schema whose tables are shown without it.
	hideSchema string
	// naive are the database types holding a date or time with no zone.
	naive map[string]bool
	// readOnlyTx says reads run inside a READ ONLY transaction, so even a
	// login that could write cannot, through this Agent.
	readOnlyTx bool
}

func doubleQuote(s string) string { return `"` + strings.ReplaceAll(s, `"`, `""`) + `"` }
func backtick(s string) string    { return "`" + strings.ReplaceAll(s, "`", "``") + "`" }
func bracket(s string) string     { return "[" + strings.ReplaceAll(s, "]", "]]") + "]" }

var dialects = map[Kind]dialect{
	Postgres: {
		quote: doubleQuote,
		tables: `SELECT n.nspname, c.relname,
		                CASE WHEN c.relkind IN ('r','p','m') THEN GREATEST(c.reltuples, -1)::bigint ELSE -1 END
		           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		          WHERE c.relkind IN ('r','p','v','m')
		            AND n.nspname NOT IN ('pg_catalog','information_schema')
		            AND n.nspname NOT LIKE 'pg_toast%'
		          ORDER BY 1, 2`,
		columns: `SELECT c.column_name, c.data_type,
		                 EXISTS (SELECT 1 FROM information_schema.table_constraints tc
		                           JOIN information_schema.key_column_usage k
		                             ON k.constraint_name = tc.constraint_name
		                            AND k.table_schema = tc.table_schema AND k.table_name = tc.table_name
		                          WHERE tc.constraint_type = 'PRIMARY KEY'
		                            AND tc.table_schema = c.table_schema AND tc.table_name = c.table_name
		                            AND k.column_name = c.column_name)
		            FROM information_schema.columns c
		           WHERE c.table_schema = $1 AND c.table_name = $2
		           ORDER BY c.ordinal_position`,
		first:         func(cols, from string, n int) string { return fmt.Sprintf("SELECT %s FROM %s LIMIT %d", cols, from, n) },
		defaultSchema: "public", hideSchema: "public",
		naive:      map[string]bool{"DATE": true, "TIMESTAMP": true},
		readOnlyTx: true,
	},
	MySQL: {
		quote: backtick,
		tables: `SELECT table_schema, table_name, COALESCE(table_rows, -1)
		           FROM information_schema.tables
		          WHERE table_schema = DATABASE()
		          ORDER BY table_name`,
		columns: `SELECT column_name, data_type, column_key = 'PRI'
		            FROM information_schema.columns
		           WHERE table_schema = ? AND table_name = ?
		           ORDER BY ordinal_position`,
		first: func(cols, from string, n int) string { return fmt.Sprintf("SELECT %s FROM %s LIMIT %d", cols, from, n) },
		// MySQL returns dates and times as text here (parseTime is off), and
		// the session runs in the Partner's zone; nothing needs converting.
		naive:      map[string]bool{},
		readOnlyTx: true,
	},
	SQLServer: {
		quote: bracket,
		tables: `SELECT s.name, o.name,
		                COALESCE((SELECT SUM(p.rows) FROM sys.partitions p
		                           WHERE p.object_id = o.object_id AND p.index_id IN (0,1)), -1)
		           FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
		          WHERE o.type IN ('U','V') AND o.is_ms_shipped = 0
		          ORDER BY 1, 2`,
		columns: `SELECT c.COLUMN_NAME, c.DATA_TYPE,
		                 CASE WHEN k.COLUMN_NAME IS NULL THEN 0 ELSE 1 END
		            FROM INFORMATION_SCHEMA.COLUMNS c
		            LEFT JOIN (SELECT ku.TABLE_SCHEMA, ku.TABLE_NAME, ku.COLUMN_NAME
		                         FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
		                         JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
		                           ON ku.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
		                        WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY') k
		              ON k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME
		             AND k.COLUMN_NAME = c.COLUMN_NAME
		           WHERE c.TABLE_SCHEMA = @p1 AND c.TABLE_NAME = @p2
		           ORDER BY c.ORDINAL_POSITION`,
		first:         func(cols, from string, n int) string { return fmt.Sprintf("SELECT TOP (%d) %s FROM %s", n, cols, from) },
		defaultSchema: "dbo",
		naive:         map[string]bool{"DATE": true, "DATETIME": true, "DATETIME2": true, "SMALLDATETIME": true},
		// SQL Server's driver has no read-only transactions; the Partner's
		// login is the guard there (db_datareader), and only SELECTs are sent.
		readOnlyTx: false,
	},
}

type sqlSource struct {
	kind Kind
	db   *sql.DB
	d    dialect
	loc  *time.Location
}

func openSQL(ctx context.Context, cfg Config) (Source, error) {
	loc := location(cfg.Location)
	var db *sql.DB
	switch cfg.Kind {
	case Postgres:
		connCfg, err := pgx.ParseConfig(postgresURL(cfg))
		if err != nil {
			return nil, fmt.Errorf("postgres settings: %w", err)
		}
		// Every transaction on this connection is read-only, not just ours.
		connCfg.RuntimeParams["default_transaction_read_only"] = "on"
		connCfg.RuntimeParams["application_name"] = "oolix-agent"
		db = stdlib.OpenDB(*connCfg)
	case MySQL:
		mc := mysql.NewConfig()
		if cfg.URI != "" {
			parsed, err := mysql.ParseDSN(cfg.URI)
			if err != nil {
				return nil, fmt.Errorf("mysql settings: %w", err)
			}
			mc = parsed
		} else {
			mc.User, mc.Passwd, mc.Net = cfg.User, cfg.Password, "tcp"
			mc.Addr = net.JoinHostPort(cfg.Host, strconv.Itoa(portOr(cfg.Port, MySQL)))
			mc.DBName = cfg.Database
			switch cfg.TLS {
			case "disable":
				mc.TLSConfig = "false"
			case "require":
				mc.TLSConfig = "skip-verify"
			default:
				mc.TLSConfig = "preferred"
			}
		}
		mc.Timeout = 10 * time.Second
		// Dates and times come back as text for the cleaner to read.
		mc.ParseTime = false
		// Show TIMESTAMP columns in the Partner's own zone, so the text the
		// cleaner reads is wall-clock time where they are.
		if mc.Params == nil {
			mc.Params = map[string]string{}
		}
		mc.Params["time_zone"] = "'" + offset(loc) + "'"
		connector, err := mysql.NewConnector(mc)
		if err != nil {
			return nil, fmt.Errorf("mysql settings: %w", err)
		}
		db = sql.OpenDB(connector)
	case SQLServer:
		var err error
		db, err = sql.Open("sqlserver", sqlServerURL(cfg))
		if err != nil {
			return nil, fmt.Errorf("sql server settings: %w", err)
		}
	}
	db.SetMaxOpenConns(2)
	db.SetConnMaxIdleTime(time.Minute)
	s := &sqlSource{kind: cfg.Kind, db: db, d: dialects[cfg.Kind], loc: loc}
	if err := s.Test(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

func (s *sqlSource) Test(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var one int
	if err := s.db.QueryRowContext(ctx, "SELECT 1").Scan(&one); err != nil {
		return fmt.Errorf("could not connect: %w", err)
	}
	return nil
}

func (s *sqlSource) Tables(ctx context.Context) ([]Table, error) {
	rows, err := s.db.QueryContext(ctx, s.d.tables)
	if err != nil {
		return nil, fmt.Errorf("listing tables: %w", err)
	}
	defer rows.Close()
	var out []Table
	for rows.Next() {
		var schema, name string
		var n int64
		if err := rows.Scan(&schema, &name, &n); err != nil {
			return nil, err
		}
		if s.kind != MySQL && schema != s.d.hideSchema {
			name = schema + "." + name
		}
		out = append(out, Table{Name: name, Rows: n})
	}
	return out, rows.Err()
}

// split separates "schema.table", filling in the dialect's default schema.
func (s *sqlSource) split(ctx context.Context, table string) (schema, name string, err error) {
	if i := strings.Index(table, "."); i > 0 && s.kind != MySQL {
		return table[:i], table[i+1:], nil
	}
	if s.kind == MySQL {
		err = s.db.QueryRowContext(ctx, "SELECT DATABASE()").Scan(&schema)
		return schema, table, err
	}
	return s.d.defaultSchema, table, nil
}

// from quotes a table name, after checking the source actually lists it --
// the name arrives from a form, and quoting alone would still let someone
// point the Agent at a system table.
func (s *sqlSource) from(ctx context.Context, table string) (string, error) {
	tables, err := s.Tables(ctx)
	if err != nil {
		return "", err
	}
	listed := false
	for _, t := range tables {
		if t.Name == table {
			listed = true
			break
		}
	}
	if !listed {
		return "", fmt.Errorf("%w: %s", ErrUnknownTable, table)
	}
	schema, name, err := s.split(ctx, table)
	if err != nil {
		return "", err
	}
	if s.kind == MySQL {
		return s.d.quote(name), nil
	}
	return s.d.quote(schema) + "." + s.d.quote(name), nil
}

func (s *sqlSource) Columns(ctx context.Context, table string) ([]detect.Column, error) {
	if _, err := s.from(ctx, table); err != nil {
		return nil, err
	}
	schema, name, err := s.split(ctx, table)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, s.d.columns, schema, name)
	if err != nil {
		return nil, fmt.Errorf("listing columns: %w", err)
	}
	defer rows.Close()
	var out []detect.Column
	for rows.Next() {
		var c detect.Column
		var pk any
		if err := rows.Scan(&c.Name, &c.Type, &pk); err != nil {
			return nil, err
		}
		c.Type = strings.ToLower(c.Type)
		c.PrimaryKey = truthy(pk)
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *sqlSource) Sample(ctx context.Context, table string, n int) (map[string][]any, error) {
	from, err := s.from(ctx, table)
	if err != nil {
		return nil, err
	}
	var sampled []Row
	err = s.read(ctx, s.d.first("*", from, n), func(r Row) error {
		sampled = append(sampled, r)
		return nil
	})
	return transpose(sampled), err
}

func (s *sqlSource) Stream(ctx context.Context, table string, columns []string, fn func(Row) error) error {
	query, err := s.selectFrom(ctx, table, columns)
	if err != nil {
		return err
	}
	return s.read(ctx, query, fn)
}

// StreamSince reads the rows whose date column is on or after since. The
// bound is written as a YYYYMMDD literal -- the one date form PostgreSQL,
// MySQL and SQL Server all read the same way, whatever the session language
// -- two days early, because the column's zone is the Partner's and not
// necessarily the Agent's. Callers filter exactly on the parsed dates.
func (s *sqlSource) StreamSince(ctx context.Context, table string, columns []string, dateColumn string,
	since time.Time, fn func(Row) error) error {
	query, err := s.selectFrom(ctx, table, columns)
	if err != nil {
		return err
	}
	bound := since.AddDate(0, 0, -2).Format("20060102")
	return s.read(ctx, query+" WHERE "+s.d.quote(dateColumn)+" >= '"+bound+"'", fn)
}

func (s *sqlSource) selectFrom(ctx context.Context, table string, columns []string) (string, error) {
	from, err := s.from(ctx, table)
	if err != nil {
		return "", err
	}
	if len(columns) == 0 {
		return "", fmt.Errorf("no columns chosen")
	}
	quoted := make([]string, len(columns))
	for i, c := range columns {
		quoted[i] = s.d.quote(c)
	}
	return "SELECT " + strings.Join(quoted, ", ") + " FROM " + from, nil
}

// read runs one SELECT, inside a read-only transaction where the database
// supports one, and hands back each row with its values made plain.
func (s *sqlSource) read(ctx context.Context, query string, fn func(Row) error) error {
	var q interface {
		QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	} = s.db
	if s.d.readOnlyTx {
		tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
		if err != nil {
			return fmt.Errorf("starting a read-only transaction: %w", err)
		}
		defer func() { _ = tx.Rollback() }()
		q = tx
	}
	rows, err := q.QueryContext(ctx, query)
	if err != nil {
		return fmt.Errorf("reading: %w", err)
	}
	defer rows.Close()
	types, err := rows.ColumnTypes()
	if err != nil {
		return err
	}
	values := make([]any, len(types))
	ptrs := make([]any, len(types))
	for i := range values {
		ptrs[i] = &values[i]
	}
	for rows.Next() {
		if err := rows.Scan(ptrs...); err != nil {
			return err
		}
		row := make(Row, len(types))
		for i, t := range types {
			row[t.Name()] = plain(values[i], s.d.naive[strings.ToUpper(t.DatabaseTypeName())], s.loc)
		}
		if err := fn(row); err != nil {
			return err
		}
	}
	return rows.Err()
}

func (s *sqlSource) Close() error { return s.db.Close() }

// plain turns a driver value into one the cleaner understands. A date or time
// the database keeps without a zone becomes text, so it is read as local wall
// clock time rather than as UTC.
func plain(v any, naive bool, loc *time.Location) any {
	switch x := v.(type) {
	case nil:
		return nil
	case []byte:
		return string(x)
	case string, int64, float64, bool:
		return x
	case int:
		return int64(x)
	case int32:
		return int64(x)
	case int16:
		return int64(x)
	case int8:
		return int64(x)
	case uint8:
		return int64(x)
	case float32:
		return float64(x)
	case time.Time:
		if naive {
			if x.Hour() == 0 && x.Minute() == 0 && x.Second() == 0 && x.Nanosecond() == 0 {
				return x.Format("2006-01-02")
			}
			return x.Format("2006-01-02 15:04:05")
		}
		return x
	case fmt.Stringer:
		return x.String()
	default:
		return fmt.Sprint(x)
	}
}

func truthy(v any) bool {
	switch x := v.(type) {
	case bool:
		return x
	case int64:
		return x != 0
	case []byte:
		return string(x) == "1"
	case string:
		return x == "1" || strings.EqualFold(x, "true")
	}
	return false
}

func postgresURL(cfg Config) string {
	if cfg.URI != "" {
		return cfg.URI
	}
	u := url.URL{
		Scheme: "postgres",
		User:   url.UserPassword(cfg.User, cfg.Password),
		Host:   net.JoinHostPort(cfg.Host, strconv.Itoa(portOr(cfg.Port, Postgres))),
		Path:   "/" + cfg.Database,
	}
	q := url.Values{}
	switch cfg.TLS {
	case "disable":
		q.Set("sslmode", "disable")
	case "require":
		q.Set("sslmode", "require")
	default:
		q.Set("sslmode", "prefer")
	}
	q.Set("connect_timeout", "10")
	u.RawQuery = q.Encode()
	return u.String()
}

func sqlServerURL(cfg Config) string {
	if cfg.URI != "" {
		return cfg.URI
	}
	u := url.URL{
		Scheme: "sqlserver",
		User:   url.UserPassword(cfg.User, cfg.Password),
		Host:   net.JoinHostPort(cfg.Host, strconv.Itoa(portOr(cfg.Port, SQLServer))),
	}
	q := url.Values{}
	q.Set("database", cfg.Database)
	q.Set("app name", "oolix-agent")
	q.Set("dial timeout", "10")
	switch cfg.TLS {
	case "disable":
		q.Set("encrypt", "disable")
	case "require":
		q.Set("encrypt", "true")
		// Internal servers usually present their own certificate.
		q.Set("TrustServerCertificate", "true")
	default:
		// Encrypt the login; the rest follows what the server asks for.
		q.Set("encrypt", "false")
	}
	u.RawQuery = q.Encode()
	return u.String()
}

func portOr(p int, k Kind) int {
	if p > 0 {
		return p
	}
	return k.DefaultPort()
}

// location resolves a zone name, defaulting to India.
func location(name string) *time.Location {
	if name == "" || name == "Asia/Kolkata" || name == "Asia/Calcutta" {
		return time.FixedZone("IST", 5*3600+30*60)
	}
	if l, err := time.LoadLocation(name); err == nil {
		return l
	}
	return time.FixedZone("IST", 5*3600+30*60)
}

// offset renders a zone's current offset as "+05:30", for MySQL.
func offset(loc *time.Location) string {
	_, secs := time.Now().In(loc).Zone()
	sign := "+"
	if secs < 0 {
		sign, secs = "-", -secs
	}
	return fmt.Sprintf("%s%02d:%02d", sign, secs/3600, secs%3600/60)
}
