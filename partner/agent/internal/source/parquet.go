package source

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math/big"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/parquet-go/parquet-go"
	"github.com/parquet-go/parquet-go/format"
)

// --- Parquet --------------------------------------------------------------------
//
// What data warehouses and lakes export -- BigQuery, Snowflake, Spark, pandas:
// columns with types, compressed. Each file is a table. Values are written as
// the text the cleaner reads: a DATE as 2024-05-01, a timestamp the file says
// is UTC with a Z, one in local time without a zone (the Partner's time zone
// then applies), a number as its digits -- so a mobile number pandas stored as
// a float reads 9876543210, not 9.87654321e+09. Nested fields are dotted
// paths, a list is read as its primary element and a map as one column per
// key, as for JSON lines and MongoDB.

// parquetLeaf is one column of values in the file.
type parquetLeaf struct {
	// name is what the column is read as; for a map's key or value, the
	// map's name.
	name string
	// text writes a value as text; nil for a column that is not read
	// (binary data, a map's nested values).
	text func(parquet.Value) string
	// group is the list or map the column sits in, or -1; depth counts the
	// lists and maps around it.
	group, depth int
	inMap        bool
}

// parquetGroup is a list or a map at the top of its nesting.
type parquetGroup struct {
	isMap bool
	name  string
	// primary, in a list of records, is the column marking the record that
	// counts (primary, is_default...); -1 for none: the first counts.
	primary int
	// key and value are a map's columns, or -1.
	key, value int
}

// parquetLayout turns the file's rows -- one value per column, several for a
// column inside a list -- into named text fields.
type parquetLayout struct {
	leaves []parquetLeaf
	groups []parquetGroup
	// fixed are the names every row has, and the column each comes from.
	fixed     []string
	fixedLeaf []int

	byColumn [][]parquet.Value
	chosen   []int
}

func newParquetLayout(root *parquet.Column, columns int) *parquetLayout {
	l := &parquetLayout{leaves: make([]parquetLeaf, columns), byColumn: make([][]parquet.Value, columns)}
	for i := range l.leaves {
		l.leaves[i].group = -1
	}
	for _, c := range root.Columns() {
		l.walk(c, c.Name(), -1, 0, false)
	}
	seen := map[string]bool{}
	for i, leaf := range l.leaves {
		if leaf.text != nil && !leaf.inMap && !seen[leaf.name] {
			seen[leaf.name] = true
			l.fixed = append(l.fixed, leaf.name)
			l.fixedLeaf = append(l.fixedLeaf, i)
		}
	}
	l.chosen = make([]int, len(l.groups))
	return l
}

// elementNames are the wrappers Parquet writers put around a list's element.
var elementNames = []string{"element", "item", "array", "array_element"}

// walk names the columns under c, whose own name is path. listWrapper says c
// is the repeated group of a LIST, whose single element field takes no name.
func (l *parquetLayout) walk(c *parquet.Column, path string, group, depth int, listWrapper bool) {
	if c.Repeated() {
		depth++
		if depth == 1 {
			group = len(l.groups)
			l.groups = append(l.groups, parquetGroup{primary: -1, key: -1, value: -1})
		}
	}
	if c.Leaf() {
		i := c.Index()
		if i < 0 || i >= len(l.leaves) {
			return
		}
		l.leaves[i] = parquetLeaf{name: path, text: parquetText(c.Type()), group: group, depth: depth}
		if group >= 0 && depth == 1 && c.Type().Kind() == parquet.Boolean && slices.Contains(primaryMarks, c.Name()) {
			l.groups[group].primary = i
		}
		return
	}
	children := c.Columns()
	if isParquetMap(c) {
		l.walkMap(c, path, depth)
		return
	}
	list := isParquetList(c)
	for _, child := range children {
		switch {
		case list:
			// name (LIST) -> list (repeated) -> element: the wrappers take
			// no name.
			l.walk(child, path, group, depth, true)
		case listWrapper && len(children) == 1 && slices.Contains(elementNames, child.Name()):
			l.walk(child, path, group, depth, false)
		default:
			l.walk(child, path+"."+child.Name(), group, depth, false)
		}
	}
}

// walkMap reads name (MAP) -> key_value (repeated) -> key, value as one column
// per key: name.<key>. A map inside a list, or of records, is not read.
func (l *parquetLayout) walkMap(c *parquet.Column, path string, depth int) {
	kv := c.Columns()
	if depth > 0 || len(kv) != 1 || kv[0].Leaf() {
		return
	}
	g := parquetGroup{isMap: true, name: path, primary: -1, key: -1, value: -1}
	for _, f := range kv[0].Columns() {
		if !f.Leaf() || f.Index() < 0 || f.Index() >= len(l.leaves) {
			continue
		}
		switch f.Name() {
		case "key":
			g.key = f.Index()
		case "value":
			g.value = f.Index()
		default:
			continue
		}
		l.leaves[f.Index()] = parquetLeaf{name: path, text: parquetText(f.Type()), group: len(l.groups), depth: 1, inMap: true}
	}
	l.groups = append(l.groups, g)
}

func isParquetList(c *parquet.Column) bool {
	lt := c.Type().LogicalType()
	_, ok := logicalValue(lt).(*format.ListType)
	return ok && len(c.Columns()) == 1
}

func isParquetMap(c *parquet.Column) bool {
	lt := c.Type().LogicalType()
	_, ok := logicalValue(lt).(*format.MapType)
	return ok
}

func logicalValue(lt *format.LogicalType) format.LogicalTypeValue {
	if lt == nil {
		return nil
	}
	return lt.Value
}

// row writes one row's values as header and record, reusing both.
func (l *parquetLayout) row(values parquet.Row, header, rec []string) ([]string, []string) {
	for i := range l.byColumn {
		l.byColumn[i] = l.byColumn[i][:0]
	}
	for _, v := range values {
		if c := v.Column(); c >= 0 && c < len(l.byColumn) {
			l.byColumn[c] = append(l.byColumn[c], v)
		}
	}
	// A list of records is read as the one marked primary, else the first.
	for g, grp := range l.groups {
		l.chosen[g] = 0
		if grp.primary < 0 {
			continue
		}
		for i, v := range l.byColumn[grp.primary] {
			if !v.IsNull() && v.Boolean() {
				l.chosen[g] = i
				break
			}
		}
	}
	header, rec = append(header[:0], l.fixed...), rec[:0]
	for _, i := range l.fixedLeaf {
		rec = append(rec, l.value(i))
	}
	for _, grp := range l.groups {
		if !grp.isMap || grp.key < 0 || grp.value < 0 || l.leaves[grp.key].text == nil || l.leaves[grp.value].text == nil {
			continue
		}
		keys, vals := l.byColumn[grp.key], l.byColumn[grp.value]
		for i, k := range keys {
			if k.IsNull() || i >= len(vals) || vals[i].IsNull() {
				continue
			}
			if name := l.leaves[grp.key].text(k); name != "" {
				header = append(header, grp.name+"."+name)
				rec = append(rec, l.leaves[grp.value].text(vals[i]))
			}
		}
	}
	return header, rec
}

// value is a column's text in the current row: "" for no value.
func (l *parquetLayout) value(i int) string {
	leaf, vals := l.leaves[i], l.byColumn[i]
	switch {
	case leaf.depth == 0:
		if len(vals) > 0 && !vals[0].IsNull() {
			return leaf.text(vals[0])
		}
	case leaf.depth == 1:
		// The chosen element of its list: one value per element.
		if e := l.chosen[leaf.group]; e < len(vals) && !vals[e].IsNull() {
			return leaf.text(vals[e])
		}
	default:
		// A list inside a list: its first value.
		for _, v := range vals {
			if !v.IsNull() {
				return leaf.text(v)
			}
		}
	}
	return ""
}

// parquetText writes a column's values as text, by its logical type, else
// its physical one; nil for a column that holds nothing a customer
// attribute could be read from.
func parquetText(t parquet.Type) func(parquet.Value) string {
	switch lt := logicalValue(t.LogicalType()).(type) {
	case *format.StringType, *format.EnumType, *format.JsonType:
		return textOf
	case *format.UUIDType:
		return func(v parquet.Value) string {
			if b := v.ByteArray(); len(b) == 16 {
				return uuid.UUID(b).String()
			}
			return ""
		}
	case *format.DateType:
		return func(v parquet.Value) string {
			return time.Unix(int64(v.Int32())*86400, 0).UTC().Format(time.DateOnly)
		}
	case *format.TimestampType:
		unit, utc := lt.Unit.Value, lt.IsAdjustedToUTC
		return func(v parquet.Value) string {
			var at time.Time
			switch unit.(type) {
			case *format.MilliSeconds:
				at = time.UnixMilli(v.Int64())
			case *format.MicroSeconds:
				at = time.UnixMicro(v.Int64())
			default:
				at = time.Unix(0, v.Int64())
			}
			if utc {
				return at.UTC().Format(time.RFC3339Nano)
			}
			// Local time: the clock reading, without a zone.
			return at.UTC().Format("2006-01-02T15:04:05.999999999")
		}
	case *format.DecimalType:
		scale := int(lt.Scale)
		return func(v parquet.Value) string {
			var n *big.Int
			switch v.Kind() {
			case parquet.Int32:
				n = big.NewInt(int64(v.Int32()))
			case parquet.Int64:
				n = big.NewInt(v.Int64())
			default:
				n = signedBigEndian(v.ByteArray())
			}
			return decimalText(n, scale)
		}
	case *format.IntType:
		if !lt.IsSigned {
			if lt.BitWidth == 64 {
				return func(v parquet.Value) string { return strconv.FormatUint(uint64(v.Int64()), 10) }
			}
			return func(v parquet.Value) string { return strconv.FormatUint(uint64(uint32(v.Int32())), 10) }
		}
	case nil:
	default:
		// Times of day, BSON, geometry, variants: nothing to read.
		return nil
	}
	switch t.Kind() {
	case parquet.Boolean:
		return func(v parquet.Value) string { return strconv.FormatBool(v.Boolean()) }
	case parquet.Int32:
		return func(v parquet.Value) string { return strconv.FormatInt(int64(v.Int32()), 10) }
	case parquet.Int64:
		return func(v parquet.Value) string { return strconv.FormatInt(v.Int64(), 10) }
	case parquet.Int96:
		// The old Impala and Spark timestamp: nanoseconds into a Julian day,
		// in UTC.
		return func(v parquet.Value) string {
			i := v.Int96()
			nanos := int64(i[1])<<32 | int64(i[0])
			days := int64(i[2]) - 2440588
			return time.Unix(days*86400, nanos).UTC().Format(time.RFC3339Nano)
		}
	case parquet.Float:
		return func(v parquet.Value) string { return strconv.FormatFloat(float64(v.Float()), 'f', -1, 32) }
	case parquet.Double:
		return func(v parquet.Value) string { return strconv.FormatFloat(v.Double(), 'f', -1, 64) }
	case parquet.ByteArray:
		// Text without the annotation, as older writers leave it.
		return textOf
	}
	return nil
}

func textOf(v parquet.Value) string {
	b := v.ByteArray()
	if !utf8.Valid(b) {
		return ""
	}
	return string(b)
}

// signedBigEndian reads a two's-complement big-endian integer.
func signedBigEndian(b []byte) *big.Int {
	n := new(big.Int).SetBytes(b)
	if len(b) > 0 && b[0]&0x80 != 0 {
		n.Sub(n, new(big.Int).Lsh(big.NewInt(1), uint(len(b))*8))
	}
	return n
}

// decimalText writes an unscaled decimal: 12345 at scale 2 is 123.45.
func decimalText(n *big.Int, scale int) string {
	if scale <= 0 {
		return new(big.Int).Mul(n, new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(-scale)), nil)).String()
	}
	digits := new(big.Int).Abs(n).String()
	for len(digits) <= scale {
		digits = "0" + digits
	}
	s := digits[:len(digits)-scale] + "." + digits[len(digits)-scale:]
	if n.Sign() < 0 {
		s = "-" + s
	}
	return s
}

func eachParquet(ctx context.Context, path string, fn func([]string, []string) error) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	var (
		file   *parquet.File
		layout *parquetLayout
	)
	if err := parquetSafely(path, func() error {
		file, err = parquet.OpenFile(f, info.Size(), parquet.SkipBloomFilters(true))
		if err != nil {
			return err
		}
		layout = newParquetLayout(file.Root(), len(file.Schema().Columns()))
		return nil
	}); err != nil {
		return err
	}
	buf := make([]parquet.Row, 256)
	var header, rec []string
	read := 0
	for _, group := range file.RowGroups() {
		rows := group.Rows()
		for done := false; !done; {
			var n int
			if err := parquetSafely(path, func() error {
				var err error
				n, err = rows.ReadRows(buf)
				if errors.Is(err, io.EOF) {
					done = true
					return nil
				}
				return err
			}); err != nil {
				_ = rows.Close()
				return err
			}
			for _, r := range buf[:n] {
				if read++; read%1000 == 0 && ctx.Err() != nil {
					_ = rows.Close()
					return ctx.Err()
				}
				header, rec = layout.row(r, header, rec)
				if err := fn(header, rec); err != nil {
					_ = rows.Close()
					return err
				}
			}
			if n == 0 && !done {
				done = true
			}
		}
		if err := rows.Close(); err != nil {
			return err
		}
	}
	return nil
}

// parquetSafely runs part of reading a file, turning a damaged file's panic in
// the library into an error: one bad export must not stop the Agent.
func parquetSafely(path string, fn func() error) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("%s could not be read as Parquet: %v", filepath.Base(path), r)
		}
	}()
	if err := fn(); err != nil {
		return fmt.Errorf("%s could not be read as Parquet: %w", filepath.Base(path), err)
	}
	return nil
}
