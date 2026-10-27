package source

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
)

// Real databases rarely keep a customer in one tidy table. The details are
// split: a profiles table beside users, several addresses per customer, or
// key-value rows such as WordPress's wp_usermeta (user_id, meta_key,
// meta_value). The Agent joins them itself, in one read-only query, so the
// Partner creates nothing in their database: no view, no new table.
//
// A joined column is named "<table>.<column>" -- or "<table>.<field>" for a
// key-value table -- in the mapping and in every row read.

// Join adds another table's columns to the customer table's rows.
type Join struct {
	// Table is the other table.
	Table string `json:"table"`
	// Key is its column holding the customer ID: the customer table's ID.
	Key string `json:"key"`
	// Latest, for a table with several rows per customer, is the column
	// whose largest value picks the row that counts -- updated_at, say.
	// Empty: any one row.
	Latest string `json:"latest,omitempty"`
	// NameColumn and ValueColumn make it a key-value table: one row per
	// customer and field. Fields are the field names read, each becoming
	// a column.
	NameColumn  string   `json:"name_column,omitempty"`
	ValueColumn string   `json:"value_column,omitempty"`
	Fields      []string `json:"fields,omitempty"`
}

// KeyValue says whether the joined table holds one row per field.
func (j Join) KeyValue() bool { return j.NameColumn != "" && j.ValueColumn != "" }

// Joiner is a source that can join other tables to a customer table.
type Joiner interface {
	// StreamJoined reads the customer table's columns and the joined
	// columns ("<table>.<column>"), one row per customer-table row.
	StreamJoined(ctx context.Context, table, idColumn string, columns []string, joins []Join, fn func(Row) error) error
	// SampleJoined reads up to n joined rows, column by column.
	SampleJoined(ctx context.Context, table, idColumn string, joins []Join, n int) (map[string][]any, error)
}

// JoinedColumn splits "<table>.<column>" when table is one of the joins.
func JoinedColumn(name string, joins []Join) (Join, string, bool) {
	for _, j := range joins {
		if rest, ok := strings.CutPrefix(name, j.Table+"."); ok && rest != "" {
			return j, rest, true
		}
	}
	return Join{}, "", false
}

var errNoJoins = errors.New("joining tables needs a SQL database")

// joinQuery builds the SELECT list and FROM clause for a customer table with
// its joins: m is the customer table, j1, j2... the joins. Every column comes
// back under its mapping name. Only the columns asked for are read.
func (s *sqlSource) joinQuery(ctx context.Context, table, idColumn string, columns []string,
	joins []Join, all bool) (list, from string, err error) {
	main, err := s.from(ctx, table)
	if err != nil {
		return "", "", err
	}
	q := s.d.quote
	wanted := map[string][]string{}
	var selects []string
	for _, c := range columns {
		if j, col, ok := JoinedColumn(c, joins); ok {
			wanted[j.Table] = append(wanted[j.Table], col)
			continue
		}
		selects = append(selects, "m."+q(c)+" AS "+q(c))
	}
	from = main + " m"
	for i, j := range joins {
		alias := fmt.Sprintf("j%d", i+1)
		other, err := s.from(ctx, j.Table)
		if err != nil {
			return "", "", err
		}
		cols := wanted[j.Table]
		if all {
			cols, err = s.joinColumns(ctx, j)
			if err != nil {
				return "", "", err
			}
		}
		if len(cols) == 0 {
			continue
		}
		var sub string
		switch {
		case j.KeyValue():
			// One column per field: the value of its row, if any.
			var pivots, names []string
			for _, f := range cols {
				lit := "'" + strings.ReplaceAll(f, "'", "''") + "'"
				names = append(names, lit)
				pivots = append(pivots, fmt.Sprintf("MAX(CASE WHEN %s = %s THEN %s END) AS %s",
					q(j.NameColumn), lit, q(j.ValueColumn), q(f)))
			}
			sub = fmt.Sprintf("(SELECT %s AS oolix_key, %s FROM %s WHERE %s IN (%s) GROUP BY %s)",
				q(j.Key), strings.Join(pivots, ", "), other, q(j.NameColumn), strings.Join(names, ", "), q(j.Key))
		case j.Latest != "":
			// The row with the largest Latest per customer.
			var inner []string
			for _, c := range cols {
				inner = append(inner, q(c))
			}
			sub = fmt.Sprintf("(SELECT * FROM (SELECT %s AS oolix_key, %s, ROW_NUMBER() OVER (PARTITION BY %s ORDER BY %s DESC) AS oolix_rn FROM %s) x WHERE oolix_rn = 1)",
				q(j.Key), strings.Join(inner, ", "), q(j.Key), q(j.Latest), other)
		default:
			var inner []string
			for _, c := range cols {
				inner = append(inner, q(c))
			}
			sub = fmt.Sprintf("(SELECT %s AS oolix_key, %s FROM %s)", q(j.Key), strings.Join(inner, ", "), other)
		}
		from += fmt.Sprintf(" LEFT JOIN %s %s ON %s.oolix_key = m.%s", sub, alias, alias, q(idColumn))
		for _, c := range cols {
			selects = append(selects, alias+"."+q(c)+" AS "+q(j.Table+"."+c))
		}
	}
	return strings.Join(selects, ", "), from, nil
}

// joinColumns are what a sample shows of a joined table: its columns but the
// key, or the fields of a key-value table.
func (s *sqlSource) joinColumns(ctx context.Context, j Join) ([]string, error) {
	if j.KeyValue() {
		return j.Fields, nil
	}
	cols, err := s.Columns(ctx, j.Table)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, c := range cols {
		if c.Name != j.Key {
			out = append(out, c.Name)
		}
	}
	return out, nil
}

func (s *sqlSource) StreamJoined(ctx context.Context, table, idColumn string, columns []string, joins []Join,
	fn func(Row) error) error {
	if len(joins) == 0 {
		return s.Stream(ctx, table, columns, fn)
	}
	key, err := s.pagingKey(ctx, table)
	if err != nil {
		return err
	}
	for _, c := range []string{idColumn, key} {
		if c != "" && !slices.Contains(columns, c) {
			columns = append(slices.Clone(columns), c)
		}
	}
	list, from, err := s.joinQuery(ctx, table, idColumn, columns, joins, false)
	if err != nil {
		return err
	}
	if key == "" {
		return s.read(ctx, "SELECT "+list+" FROM "+from, fn)
	}
	return s.pages(ctx, list, from, "", "m."+s.d.quote(key), key, fn)
}

func (s *sqlSource) SampleJoined(ctx context.Context, table, idColumn string, joins []Join, n int) (map[string][]any, error) {
	if len(joins) == 0 {
		return s.Sample(ctx, table, n)
	}
	cols, err := s.Columns(ctx, table)
	if err != nil {
		return nil, err
	}
	var names []string
	for _, c := range cols {
		names = append(names, c.Name)
	}
	list, from, err := s.joinQuery(ctx, table, idColumn, names, joins, true)
	if err != nil {
		return nil, err
	}
	var sampled []Row
	err = s.read(ctx, s.d.first(list, from, n), func(r Row) error {
		sampled = append(sampled, r)
		return nil
	})
	return transpose(sampled), err
}

// StreamJoined on a source that cannot join reads the customer table alone
// when there is nothing to join.
func StreamJoined(ctx context.Context, src Source, table, idColumn string, columns []string, joins []Join,
	fn func(Row) error) error {
	if len(joins) == 0 {
		return src.Stream(ctx, table, columns, fn)
	}
	j, ok := src.(Joiner)
	if !ok {
		return errNoJoins
	}
	return j.StreamJoined(ctx, table, idColumn, columns, joins, fn)
}

// SampleJoined is SampleJoined for any source, as StreamJoined is.
func SampleJoined(ctx context.Context, src Source, table, idColumn string, joins []Join, n int) (map[string][]any, error) {
	if len(joins) == 0 {
		return src.Sample(ctx, table, n)
	}
	j, ok := src.(Joiner)
	if !ok {
		return nil, errNoJoins
	}
	return j.SampleJoined(ctx, table, idColumn, joins, n)
}
