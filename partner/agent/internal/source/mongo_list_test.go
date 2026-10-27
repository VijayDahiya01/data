package source

import (
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestListsInsideDocuments(t *testing.T) {
	doc := bson.D{
		{Key: "_id", Value: "C1"},
		// The default address counts, wherever it is in the list.
		{Key: "addresses", Value: bson.A{
			bson.D{{Key: "city", Value: "Pune"}, {Key: "is_default", Value: false}},
			bson.D{{Key: "city", Value: "Mumbai"}, {Key: "is_default", Value: true}, {Key: "pin", Value: "400001"}},
		}},
		// No mark: the first.
		{Key: "phones", Value: bson.A{bson.M{"type": "work"}, bson.M{"type": "home"}}},
		{Key: "favourite_categories", Value: bson.A{"Footwear", "Fashion"}},
		{Key: "empty", Value: bson.A{}},
		{Key: "nested", Value: bson.A{bson.A{"x"}, "y"}},
	}
	row := Row{}
	flatten("", doc, row)
	for key, want := range map[string]any{
		"addresses.city": "Mumbai", "addresses.pin": "400001", "phones.type": "work",
		"favourite_categories": "Footwear", "nested": "y",
	} {
		if row[key] != want {
			t.Errorf("%s = %v, want %v", key, row[key], want)
		}
	}
	if _, ok := row["empty"]; ok {
		t.Error("an empty list should have no value")
	}
}
