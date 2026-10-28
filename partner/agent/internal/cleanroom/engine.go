package cleanroom

import (
	"bytes"
	"errors"
	"slices"
	"sort"
)

// Overlaps are answered in size bands, never exact counts, and nothing under
// MinOverlap: a count of three, between two Partners who each know their
// own customers, comes close to naming them.
const MinOverlap = 100

// Band names a size band, as reach estimates do.
func Band(n int) string {
	switch {
	case n < MinOverlap:
		return "UNDER_100"
	case n < 1_000:
		return "100_TO_1K"
	case n < 10_000:
		return "1K_TO_10K"
	case n < 100_000:
		return "10K_TO_100K"
	case n < 1_000_000:
		return "100K_TO_1M"
	}
	return "OVER_1M"
}

// Customer is one customer's match keys: an email's, a phone's, or both.
type Customer []Key

// Pair is the overlap of two Partners' customers.
type Pair struct {
	A    string `json:"a"`
	B    string `json:"b"`
	Band string `json:"band"`
}

// Overlap counts, for each pair of Partners, the customers they share: a
// customer is shared when any of their keys is among the other Partner's.
// Counted from both sides, the smaller count is kept -- one person each
// Partner holds twice is still one person.
func Overlap(sets map[string][]Customer) []Pair {
	names := make([]string, 0, len(sets))
	for n := range sets {
		names = append(names, n)
	}
	sort.Strings(names)
	keys := map[string][]Key{}
	for _, n := range names {
		keys[n] = allKeys(sets[n])
	}
	var out []Pair
	for i, a := range names {
		for _, b := range names[i+1:] {
			n := min(matching(sets[a], keys[b]), matching(sets[b], keys[a]))
			out = append(out, Pair{A: a, B: b, Band: Band(n)})
		}
	}
	return out
}

// Joint is the base Partner's customers also among the other Partner's --
// their keys, for the base Partner's Agent alone, which knows whose they are
// -- and how many customers that is. No keys when there are too few to hand
// over safely.
func Joint(base, other []Customer) (keys []Key, customers int, ok bool) {
	theirs := allKeys(other)
	for _, c := range base {
		if anyIn(c, theirs) {
			customers++
			keys = append(keys, c...)
		}
	}
	if customers < MinOverlap {
		return nil, customers, false
	}
	return keys, customers, true
}

func matching(customers []Customer, keys []Key) int {
	n := 0
	for _, c := range customers {
		if anyIn(c, keys) {
			n++
		}
	}
	return n
}

func anyIn(c Customer, sorted []Key) bool {
	for _, k := range c {
		if _, found := slices.BinarySearchFunc(sorted, k, compareKeys); found {
			return true
		}
	}
	return false
}

func allKeys(customers []Customer) []Key {
	var out []Key
	for _, c := range customers {
		out = append(out, c...)
	}
	slices.SortFunc(out, compareKeys)
	return slices.Compact(out)
}

func compareKeys(a, b Key) int { return bytes.Compare(a[:], b[:]) }

// EncodeCustomers writes customers compactly: for each, the number of keys
// in one byte, then the keys.
func EncodeCustomers(customers []Customer) []byte {
	var out []byte
	for _, c := range customers {
		if len(c) == 0 || len(c) > 4 {
			continue
		}
		out = append(out, byte(len(c)))
		for _, k := range c {
			out = append(out, k[:]...)
		}
	}
	return out
}

// DecodeCustomers reads what EncodeCustomers wrote.
func DecodeCustomers(b []byte) ([]Customer, error) {
	var out []Customer
	for len(b) > 0 {
		n := int(b[0])
		if n == 0 || n > 4 || len(b) < 1+32*n {
			return nil, errors.New("cleanroom: malformed customer list")
		}
		c := make(Customer, n)
		for i := range c {
			copy(c[i][:], b[1+32*i:])
		}
		out = append(out, c)
		b = b[1+32*n:]
	}
	return out, nil
}

// EncodeKeys writes keys end to end.
func EncodeKeys(keys []Key) []byte {
	out := make([]byte, 0, len(keys)*32)
	for _, k := range keys {
		out = append(out, k[:]...)
	}
	return out
}

// DecodeKeys reads what EncodeKeys wrote.
func DecodeKeys(b []byte) ([]Key, error) {
	if len(b)%32 != 0 {
		return nil, errors.New("cleanroom: not a whole number of keys")
	}
	out := make([]Key, len(b)/32)
	for i := range out {
		copy(out[i][:], b[i*32:])
	}
	return out, nil
}
