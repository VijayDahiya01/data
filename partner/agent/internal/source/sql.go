package source

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	mssql "github.com/microsoft/go-mssqldb"
	goora "github.com/sijms/go-ora/v2"

	"github.com/oolix/partner-agent/internal/detect"
	"github.com/oolix/partner-agent/internal/netx"
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
	// readOnlySQL, for a driver that cannot begin a read-only transaction
	// itself, makes one read-only as its first statement.
	readOnlySQL string
	// ping is the cheapest query: SELECT 1, or Oracle's SELECT 1 FROM dual.
	ping string
	// timeout, when set, is run first in the read-only transaction to stop a
	// slow query on the server itself, not only in the Agent.
	timeout string
	// page is one slice of a table in key order: up to n rows, after the key
	// bound as the one parameter when after is true.
	page func(cols, from, where, key string, after bool, n int) string
}

// pageWhere joins a slice's conditions.
func pageWhere(where, keyAfter string) string {
	switch {
	case where != "" && keyAfter != "":
		return " WHERE " + where + " AND " + keyAfter
	case where != "":
		return " WHERE " + where
	case keyAfter != "":
		return " WHERE " + keyAfter
	}
	return ""
}

// limitPage is the slice query for databases with LIMIT.
func limitPage(placeholder string) func(cols, from, where, key string, after bool, n int) string {
	return func(cols, from, where, key string, after bool, n int) string {
		keyAfter := ""
		if after {
			keyAfter = key + " > " + placeholder
		}
		return fmt.Sprintf("SELECT %s FROM %s%s ORDER BY %s LIMIT %d", cols, from, pageWhere(where, keyAfter), key, n)
	}
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
		timeout:    "SET LOCAL statement_timeout = '" + strconv.Itoa(int(pageTimeout/time.Millisecond)) + "'",
		page:       limitPage("$1"),
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
		page:       limitPage("?"),
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
		page: func(cols, from, where, key string, after bool, n int) string {
			keyAfter := ""
			if after {
				keyAfter = key + " > @p1"
			}
			return fmt.Sprintf("SELECT TOP (%d) %s FROM %s%s ORDER BY %s", n, cols, from, pageWhere(where, keyAfter), key)
		},
	},
	// Oracle Database 12c and later. Tables in every schema the login can
	// see, except Oracle's own; names come back as SCHEMA.TABLE.
	Oracle: {
		quote: doubleQuote,
		tables: `SELECT owner, table_name, NVL(num_rows, -1) FROM all_tables
		          WHERE owner IN (SELECT username FROM all_users WHERE oracle_maintained = 'N')
		         UNION ALL
		         SELECT owner, view_name, -1 FROM all_views
		          WHERE owner IN (SELECT username FROM all_users WHERE oracle_maintained = 'N')
		         ORDER BY 1, 2`,
		columns: `SELECT c.column_name, c.data_type,
		                 CASE WHEN EXISTS (SELECT 1 FROM all_constraints k
		                                    JOIN all_cons_columns cc
		                                      ON cc.owner = k.owner AND cc.constraint_name = k.constraint_name
		                                   WHERE k.constraint_type = 'P' AND k.owner = c.owner
		                                     AND k.table_name = c.table_name AND cc.column_name = c.column_name)
		                      THEN 1 ELSE 0 END
		            FROM all_tab_columns c
		           WHERE c.owner = :1 AND c.table_name = :2
		           ORDER BY c.column_id`,
		first: func(cols, from string, n int) string {
			return fmt.Sprintf("SELECT %s FROM %s FETCH FIRST %d ROWS ONLY", cols, from, n)
		},
		naive:       map[string]bool{"DATE": true, "OCIDATE": true, "TIMESTAMP": true, "TIMESTAMPDTY": true},
		readOnlySQL: "SET TRANSACTION READ ONLY",
		ping:        "SELECT 1 FROM dual",
		page: func(cols, from, where, key string, after bool, n int) string {
			keyAfter := ""
			if after {
				keyAfter = key + " > :1"
			}
			return fmt.Sprintf("SELECT %s FROM %s%s ORDER BY %s FETCH FIRST %d ROWS ONLY", cols, from,
				pageWhere(where, keyAfter), key, n)
		},
	},
}

type sqlSource struct {
	kind Kind
	db   *sql.DB
	d    dialect
	loc  *time.Location
	// pageSize is the rows per slice; rowsPerSecond caps the read rate (0:
	// no cap).
	pageSize, rowsPerSecond int
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
		connCfg.DialFunc = netx.Dial
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
			case "verify":
				mc.TLSConfig = "true"
			default:
				mc.TLSConfig = "preferred"
			}
		}
		mc.Timeout = 10 * time.Second
		mc.DialFunc = netx.Dial
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
		connector, err := mssql.NewConnector(sqlServerURL(cfg))
		if err != nil {
			return nil, fmt.Errorf("sql server settings: %w", err)
		}
		connector.Dialer = netx.Dialer{}
		db = sql.OpenDB(connector)
	case Oracle:
		connector := goora.NewConnector(oracleURL(cfg))
		oc, ok := connector.(*goora.OracleConnector)
		if !ok {
			return nil, errors.New("oracle settings: unexpected connector")
		}
		oc.Dialer(netx.Dialer{})
		db = sql.OpenDB(oc)
	}
	db.SetMaxOpenConns(2)
	db.SetConnMaxIdleTime(time.Minute)
	s := &sqlSource{kind: cfg.Kind, db: db, d: dialects[cfg.Kind], loc: loc,
		pageSize: pageSize, rowsPerSecond: cfg.RowsPerSecond}
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
	ping := s.d.ping
	if ping == "" {
		ping = "SELECT 1"
	}
	if err := s.db.QueryRowContext(ctx, ping).Scan(&one); err != nil {
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
	return s.stream(ctx, table, columns, "", fn)
}

// StreamSince reads the rows whose date column is on or after since. The
// bound is written as a YYYYMMDD literal -- the one date form PostgreSQL,
// MySQL and SQL Server all read the same way, whatever the session language
// -- two days early, because the column's zone is the Partner's and not
// necessarily the Agent's. Callers filter exactly on the parsed dates.
func (s *sqlSource) StreamSince(ctx context.Context, table string, columns []string, dateColumn string,
	since time.Time, fn func(Row) error) error {
	bound := "'" + since.AddDate(0, 0, -2).Format("20060102") + "'"
	if s.kind == Oracle {
		// Oracle reads a bare string by the session's date format; a DATE
		// literal it reads the same way everywhere.
		bound = "DATE '" + since.AddDate(0, 0, -2).Format("2006-01-02") + "'"
	}
	return s.stream(ctx, table, columns, s.d.quote(dateColumn)+" >= "+bound, fn)
}

// Reading a large table from a Partner's production database must not hurt
// it. A table with a single-column primary key is read in slices of pageSize
// rows, in key order (`WHERE key > last ORDER BY key`), each slice its own
// short query with a time limit -- never one transaction held open for hours.
// A slice that fails, say on a dropped connection, is tried again from the
// last row read, so a sync does not start over. A Partner may also cap the
// rows read per second. A table without such a key -- a view, usually -- is
// read in one query, as before.
const (
	pageSize     = 10000
	pageTimeout  = 2 * time.Minute
	pageAttempts = 3
)

// callbackError marks an error from the caller's row function, which is not
// the database's and is never retried.
type callbackError struct{ err error }

func (e callbackError) Error() string { return e.err.Error() }
func (e callbackError) Unwrap() error { return e.err }

func (s *sqlSource) stream(ctx context.Context, table string, columns []string, where string, fn func(Row) error) error {
	query, err := s.selectFrom(ctx, table, columns)
	if err != nil {
		return err
	}
	key, err := s.pagingKey(ctx, table)
	if err != nil {
		return err
	}
	if key == "" {
		if where != "" {
			query += " WHERE " + where
		}
		return s.read(ctx, query, fn)
	}
	from, _ := s.from(ctx, table)
	cols := columns
	if !slices.Contains(cols, key) {
		// The key is read too, to know where the next slice starts.
		cols = append(slices.Clone(cols), key)
	}
	quoted := make([]string, len(cols))
	for i, c := range cols {
		quoted[i] = s.d.quote(c)
	}
	return s.pages(ctx, strings.Join(quoted, ", "), from, where, s.d.quote(key), key, fn)
}

// pages reads SELECT list FROM from in slices ordered by the expression
// ordered, which comes back as the column key.
func (s *sqlSource) pages(ctx context.Context, list, from, where, ordered, key string, fn func(Row) error) error {
	var last any
	var err error
	started, total := time.Now(), 0
	for {
		var got int
		for attempt := 1; ; attempt++ {
			query := s.d.page(list, from, where, ordered, last != nil, s.pageSize)
			var args []any
			if last != nil {
				args = []any{last}
			}
			got = 0
			err = s.readRaw(ctx, query, args, pageTimeout, func(row Row, raw map[string]any) error {
				if err := fn(row); err != nil {
					return callbackError{err}
				}
				last = raw[key]
				got++
				total++
				return nil
			})
			var cbErr callbackError
			if err == nil || errors.As(err, &cbErr) || ctx.Err() != nil || attempt == pageAttempts {
				break
			}
			// Carry on from the last row read, after a pause.
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Duration(attempt) * 2 * time.Second):
			}
		}
		var cbErr callbackError
		if errors.As(err, &cbErr) {
			return cbErr.err
		}
		if err != nil {
			return fmt.Errorf("reading rows after %d: %w", total, err)
		}
		if got < s.pageSize {
			return nil
		}
		if err := s.pace(ctx, started, total); err != nil {
			return err
		}
	}
}

// pace waits, when the Partner set a limit, until reading total rows has
// taken at least total/rowsPerSecond seconds.
func (s *sqlSource) pace(ctx context.Context, started time.Time, total int) error {
	if s.rowsPerSecond <= 0 {
		return nil
	}
	due := time.Duration(float64(total) / float64(s.rowsPerSecond) * float64(time.Second))
	if wait := due - time.Since(started); wait > 0 {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
	}
	return nil
}

// pagingKey is the table's primary key when it is a single column, or "".
func (s *sqlSource) pagingKey(ctx context.Context, table string) (string, error) {
	cols, err := s.Columns(ctx, table)
	if err != nil {
		return "", err
	}
	key := ""
	for _, c := range cols {
		if c.PrimaryKey {
			if key != "" {
				return "", nil
			}
			key = c.Name
		}
	}
	return key, nil
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
	return s.readRaw(ctx, query, nil, 0, func(row Row, _ map[string]any) error { return fn(row) })
}

// readRaw runs one SELECT with bound arguments and, when timeout is set, a
// time limit -- in the Agent, and on the server where the database has one.
// fn also gets each value as the driver returned it, before plain() made it
// readable: a slice's key must go back to the database exactly as it came.
func (s *sqlSource) readRaw(ctx context.Context, query string, args []any, timeout time.Duration,
	fn func(Row, map[string]any) error) error {
	if timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	var q interface {
		QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	} = s.db
	if s.d.readOnlyTx || s.d.readOnlySQL != "" {
		tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: s.d.readOnlyTx})
		if err != nil {
			return fmt.Errorf("starting a read-only transaction: %w", err)
		}
		defer func() { _ = tx.Rollback() }()
		if s.d.readOnlySQL != "" {
			if _, err := tx.ExecContext(ctx, s.d.readOnlySQL); err != nil {
				return fmt.Errorf("making the transaction read-only: %w", err)
			}
		}
		if timeout > 0 && s.d.timeout != "" {
			if _, err := tx.ExecContext(ctx, s.d.timeout); err != nil {
				return fmt.Errorf("setting a time limit: %w", err)
			}
		}
		q = tx
	}
	rows, err := q.QueryContext(ctx, query, args...)
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
		raw := make(map[string]any, len(types))
		for i, t := range types {
			row[t.Name()] = plain(values[i], s.d.naive[strings.ToUpper(t.DatabaseTypeName())], s.loc)
			raw[t.Name()] = values[i]
		}
		if err := fn(row, raw); err != nil {
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
	case "verify":
		q.Set("sslmode", "verify-full")
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
	case "verify":
		q.Set("encrypt", "true")
		q.Set("TrustServerCertificate", "false")
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

// oracleURL connects to an Oracle service: Database is the service name
// (FREEPDB1, ORCLPDB1...). TLS "require" uses TCPS.
func oracleURL(cfg Config) string {
	if cfg.URI != "" {
		return cfg.URI
	}
	opts := map[string]string{}
	switch cfg.TLS {
	case "require":
		opts["SSL"] = "true" // go-ora checks the certificate unless told not to
	case "verify":
		opts["SSL"] = "true"
		opts["SSL VERIFY"] = "true"
	}
	return goora.BuildUrl(cfg.Host, portOr(cfg.Port, Oracle), cfg.Database, cfg.User, cfg.Password, opts)
}
