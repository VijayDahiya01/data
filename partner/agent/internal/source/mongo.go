package source

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"sort"
	"strconv"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"go.mongodb.org/mongo-driver/v2/mongo/readpref"

	"github.com/oolix/partner-agent/internal/detect"
)

// mongoSource reads MongoDB. Documents have no fixed schema, so a "column" is
// a field path found in a sample -- profile.dob for {profile: {dob: ...}}.
// Arrays are skipped: a customer with three addresses has no single city.
type mongoSource struct {
	client *mongo.Client
	db     *mongo.Database
}

func openMongo(ctx context.Context, cfg Config) (Source, error) {
	uri := cfg.URI
	if uri == "" {
		u := url.URL{
			Scheme: "mongodb",
			Host:   net.JoinHostPort(cfg.Host, strconv.Itoa(portOr(cfg.Port, MongoDB))),
			Path:   "/",
		}
		if cfg.User != "" {
			u.User = url.UserPassword(cfg.User, cfg.Password)
		}
		q := url.Values{}
		q.Set("authSource", "admin")
		if cfg.TLS == "require" {
			q.Set("tls", "true")
		}
		u.RawQuery = q.Encode()
		uri = u.String()
	}
	opts := options.Client().ApplyURI(uri).
		SetAppName("oolix-agent").
		SetServerSelectionTimeout(10 * time.Second).
		// Read from a secondary when there is one, so the Partner's primary
		// carries none of the load.
		SetReadPreference(readpref.SecondaryPreferred())
	client, err := mongo.Connect(opts)
	if err != nil {
		return nil, fmt.Errorf("mongodb settings: %w", err)
	}
	if cfg.Database == "" {
		_ = client.Disconnect(ctx)
		return nil, fmt.Errorf("a database name is required for MongoDB")
	}
	s := &mongoSource{client: client, db: client.Database(cfg.Database)}
	if err := s.Test(ctx); err != nil {
		_ = client.Disconnect(ctx)
		return nil, err
	}
	return s, nil
}

func (s *mongoSource) Test(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if err := s.client.Ping(ctx, readpref.SecondaryPreferred()); err != nil {
		return fmt.Errorf("could not connect: %w", err)
	}
	return nil
}

func (s *mongoSource) Tables(ctx context.Context) ([]Table, error) {
	names, err := s.db.ListCollectionNames(ctx, bson.D{})
	if err != nil {
		return nil, fmt.Errorf("listing collections: %w", err)
	}
	sort.Strings(names)
	out := make([]Table, 0, len(names))
	for _, n := range names {
		rows := int64(-1)
		if c, err := s.db.Collection(n).EstimatedDocumentCount(ctx); err == nil {
			rows = c
		}
		out = append(out, Table{Name: n, Rows: rows})
	}
	return out, nil
}

func (s *mongoSource) listed(ctx context.Context, table string) error {
	tables, err := s.Tables(ctx)
	if err != nil {
		return err
	}
	for _, t := range tables {
		if t.Name == table {
			return nil
		}
	}
	return fmt.Errorf("%w: %s", ErrUnknownTable, table)
}

func (s *mongoSource) sampleDocs(ctx context.Context, table string, n int) ([]Row, error) {
	if err := s.listed(ctx, table); err != nil {
		return nil, err
	}
	// $sample picks documents at random, so the sample is not just the oldest
	// records -- which is where old formats hide, but not only there.
	cur, err := s.db.Collection(table).Aggregate(ctx, mongo.Pipeline{{{Key: "$sample", Value: bson.D{{Key: "size", Value: n}}}}})
	if err != nil {
		return nil, fmt.Errorf("sampling: %w", err)
	}
	defer cur.Close(ctx)
	var out []Row
	for cur.Next(ctx) {
		var doc bson.D
		if err := cur.Decode(&doc); err != nil {
			return nil, err
		}
		row := Row{}
		flatten("", doc, row)
		out = append(out, row)
	}
	return out, cur.Err()
}

func (s *mongoSource) Columns(ctx context.Context, table string) ([]detect.Column, error) {
	docs, err := s.sampleDocs(ctx, table, 500)
	if err != nil {
		return nil, err
	}
	return columnsFromSample(docs, "_id"), nil
}

func (s *mongoSource) Sample(ctx context.Context, table string, n int) (map[string][]any, error) {
	docs, err := s.sampleDocs(ctx, table, n)
	return transpose(docs), err
}

func (s *mongoSource) Stream(ctx context.Context, table string, columns []string, fn func(Row) error) error {
	return s.find(ctx, table, columns, bson.D{}, fn)
}

// StreamSince reads the documents whose date field is on or after since (two
// days early; callers filter exactly). Only for a field holding BSON dates: a
// range on a date never matches a string.
func (s *mongoSource) StreamSince(ctx context.Context, table string, columns []string, dateColumn string,
	since time.Time, fn func(Row) error) error {
	filter := bson.D{{Key: dateColumn, Value: bson.D{{Key: "$gte", Value: since.AddDate(0, 0, -2)}}}}
	return s.find(ctx, table, columns, filter, fn)
}

func (s *mongoSource) find(ctx context.Context, table string, columns []string, filter bson.D, fn func(Row) error) error {
	if err := s.listed(ctx, table); err != nil {
		return err
	}
	// Only the chosen fields cross the wire: a projection, not a filter
	// applied after the whole document has been read.
	proj := bson.D{}
	for _, c := range columns {
		proj = append(proj, bson.E{Key: c, Value: 1})
	}
	cur, err := s.db.Collection(table).Find(ctx, filter,
		options.Find().SetProjection(proj).SetBatchSize(1000))
	if err != nil {
		return fmt.Errorf("reading: %w", err)
	}
	defer cur.Close(ctx)
	for cur.Next(ctx) {
		var doc bson.D
		if err := cur.Decode(&doc); err != nil {
			return err
		}
		all := Row{}
		flatten("", doc, all)
		row := make(Row, len(columns))
		for _, c := range columns {
			row[c] = all[c]
		}
		if err := fn(row); err != nil {
			return err
		}
	}
	return cur.Err()
}

func (s *mongoSource) Close() error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return s.client.Disconnect(ctx)
}

// flatten turns nested documents into dotted paths with plain values.
func flatten(prefix string, doc bson.D, out Row) {
	for _, e := range doc {
		key := e.Key
		if prefix != "" {
			key = prefix + "." + e.Key
		}
		switch v := e.Value.(type) {
		case bson.D:
			flatten(key, v, out)
		case bson.M:
			d := bson.D{}
			for k, x := range v {
				d = append(d, bson.E{Key: k, Value: x})
			}
			flatten(key, d, out)
		case bson.A:
			// Skipped: a list has no single value to copy.
		default:
			out[key] = mongoValue(v)
		}
	}
}

func mongoValue(v any) any {
	switch x := v.(type) {
	case nil, bson.Null, bson.Undefined:
		return nil
	case string, bool, int64, float64:
		return x
	case int32:
		return int64(x)
	case bson.DateTime:
		return x.Time().UTC()
	case bson.ObjectID:
		return x.Hex()
	case bson.Decimal128:
		return x.String()
	case bson.Timestamp:
		return time.Unix(int64(x.T), 0).UTC()
	case time.Time:
		return x.UTC()
	default:
		return fmt.Sprint(x)
	}
}
