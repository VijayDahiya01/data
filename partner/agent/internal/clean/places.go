package clean

import (
	"bufio"
	"embed"
	"strings"
	"sync"
)

// Built-in place data, from GeoNames' India postal codes (CC BY 4.0, from
// India Post's directory); gen_places.go writes it.
//
//go:generate go run gen_places.go -in IN.txt
//go:embed data/pincodes.txt data/places.txt
var placeData embed.FS

// PlaceDataCredit is the attribution the place data's licence asks for.
const PlaceDataCredit = "Pincode and place data: GeoNames (geonames.org), CC BY 4.0"

type pinPlace struct{ state, city string }

var places struct {
	once sync.Once
	pins map[string]pinPlace
	// names are district and sub-district names, normalised, with the
	// listed city each lies wholly in, or "".
	names map[string]string
}

func loadPlaces() {
	places.once.Do(func() {
		places.pins = map[string]pinPlace{}
		places.names = map[string]string{}
		read := func(file string, line func(fields []string)) {
			f, err := placeData.Open(file)
			if err != nil {
				panic(err) // embedded: present in every build
			}
			defer f.Close()
			sc := bufio.NewScanner(f)
			for sc.Scan() {
				if t := sc.Text(); t != "" && !strings.HasPrefix(t, "#") {
					line(strings.Split(t, "\t"))
				}
			}
		}
		read("data/pincodes.txt", func(f []string) {
			p := strings.Fields(f[0])
			pp := pinPlace{state: p[1]}
			if len(p) > 2 {
				pp.city = p[2]
			}
			places.pins[p[0]] = pp
		})
		read("data/places.txt", func(f []string) {
			city := ""
			if len(f) > 1 {
				city = f[1]
			}
			places.names[f[0]] = city
		})
	})
}

// pincodeOf reads a value written as an Indian pincode: six digits, the first
// not zero, perhaps with a space after the third ("400 001").
func pincodeOf(s string) (string, bool) {
	s = strings.ReplaceAll(strings.TrimSpace(s), " ", "")
	if len(s) != 6 || s[0] < '1' || s[0] > '9' {
		return "", false
	}
	for i := 1; i < 6; i++ {
		if s[i] < '0' || s[i] > '9' {
			return "", false
		}
	}
	return s, true
}

// Pincode looks a pincode up in India Post's directory: its state's code
// and, when every post office under it lies in one of the cities Oolix
// lists, that city's code. ok is false for a value that is not a pincode the
// directory knows.
func Pincode(raw any) (state, city string, ok bool) {
	pin, ok := pincodeOf(Text(raw))
	if !ok {
		return "", "", false
	}
	loadPlaces()
	p, ok := places.pins[pin]
	return p.state, p.city, ok
}

// knownPlace reports whether a normalised name is an Indian district or
// sub-district, and the listed city it lies wholly in, if any.
func knownPlace(key string) (city string, ok bool) {
	loadPlaces()
	city, ok = places.names[key]
	return city, ok
}

// stateNames are every state and union territory by its ISO 3166-2:IN code.
// The ten Oolix lists have their synonyms in enum.go; the rest are here so a
// state outside the list is recognised as one rather than asked about.
var stateNames = map[string][]string{
	"AN": {"andaman and nicobar islands", "andaman and nicobar", "andaman"},
	"AP": {"andhra pradesh", "andhra"},
	"AR": {"arunachal pradesh"},
	"AS": {"assam"},
	"BR": {"bihar"},
	"CH": {"chandigarh"},
	"CG": {"chhattisgarh", "chattisgarh"},
	"DH": {"dadra and nagar haveli and daman and diu", "dadra and nagar haveli", "daman and diu"},
	"GA": {"goa"},
	"HP": {"himachal pradesh"},
	"JK": {"jammu and kashmir"},
	"JH": {"jharkhand"},
	"KL": {"kerala", "keralam"},
	"LA": {"ladakh"},
	"LD": {"lakshadweep"},
	"MP": {"madhya pradesh"},
	"MN": {"manipur"},
	"ML": {"meghalaya"},
	"MZ": {"mizoram"},
	"NL": {"nagaland"},
	"OD": {"odisha", "orissa"},
	"PY": {"puducherry", "pondicherry"},
	"PB": {"punjab"},
	"SK": {"sikkim"},
	"TR": {"tripura"},
	"UK": {"uttarakhand", "uttaranchal"},
}

var otherStates = func() map[string]string {
	out := map[string]string{}
	for code, names := range stateNames {
		for _, n := range names {
			out[n] = code
		}
	}
	return out
}()
