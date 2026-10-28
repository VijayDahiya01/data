//go:build ignore

// gen_places writes the Agent's built-in place data from GeoNames' India
// postal codes, which GeoNames publishes under CC BY 4.0
// (https://creativecommons.org/licenses/by/4.0/) from India Post's directory:
//
//	curl -fLO https://download.geonames.org/export/zip/IN.zip && unzip IN.zip IN.txt
//	go run gen_places.go -in IN.txt
//
// It writes data/pincodes.txt (each pincode's state, and its city when the
// city is certain) and data/places.txt (district and sub-district names). A
// state name it does not know stops it, so a renamed state is never dropped
// quietly.
package main

import (
	"bufio"
	"flag"
	"fmt"
	"log"
	"os"
	"regexp"
	"sort"
	"strings"
)

// states maps GeoNames' state names to ISO 3166-2:IN codes.
var states = map[string]string{
	"Andaman & Nicobar Islands": "AN", "Andhra Pradesh": "AP", "Arunachal Pradesh": "AR",
	"Assam": "AS", "Bihar": "BR", "Chandigarh": "CH", "Chhattisgarh": "CG",
	"Dadra and Nagar Haveli and Daman and Diu": "DH", "Delhi": "DL", "Goa": "GA",
	"Gujarat": "GJ", "Haryana": "HR", "Himachal Pradesh": "HP", "Jammu & Kashmir": "JK",
	"Jharkhand": "JH", "Karnataka": "KA", "Kerala": "KL", "Lakshadweep": "LD",
	"Madhya Pradesh": "MP", "Maharashtra": "MH", "Manipur": "MN", "Meghalaya": "ML",
	"Mizoram": "MZ", "Nagaland": "NL", "Odisha": "OD", "Pondicherry": "PY", "Punjab": "PB",
	"Rajasthan": "RJ", "Sikkim": "SK", "Tamil Nadu": "TN", "Telangana": "TG", "Tripura": "TR",
	"Uttar Pradesh": "UP", "Uttarakhand": "UK", "West Bengal": "WB",
}

type office struct {
	pin, place, state, district, taluk string
}

// cities decide when a post office lies in one of the cities Oolix lists. A
// pincode is given a city only when every office under it does, so a
// customer is never placed in a city they might not live in.
//
// Most cities are their postal sorting district (the first three digits):
// an address under 560xxx is written "Bengaluru", wherever the district
// line falls. The exceptions are spelled out: 400xxx also covers Thane and
// Raigad; Gurugram is 122001-122018, since the rest of 122xxx is Manesar,
// camps and the district's villages; and 2013xx mixes Noida's sectors with
// Dadri's villages.
var cities = []struct {
	code string
	in   func(o office) bool
}{
	{"DELHI", func(o office) bool { return o.state == "DL" }},
	{"MUMBAI", func(o office) bool { return pre(o, "400") && o.district == "Mumbai" }},
	{"BENGALURU", func(o office) bool { return pre(o, "560") && o.state == "KA" }},
	{"CHENNAI", func(o office) bool { return pre(o, "600") && o.state == "TN" }},
	{"KOLKATA", func(o office) bool { return pre(o, "700") && o.state == "WB" }},
	{"HYDERABAD", func(o office) bool { return pre(o, "500") && o.state == "TG" }},
	{"PUNE", func(o office) bool { return pre(o, "411") && o.district == "Pune" }},
	{"AHMEDABAD", func(o office) bool { return pre(o, "380") && o.district == "Ahmedabad" }},
	{"GURUGRAM", func(o office) bool { return pre(o, "1220") && o.pin < "122050" && o.district == "Gurgaon" }},
	{"NOIDA", func(o office) bool {
		place := strings.ToLower(o.place)
		return pre(o, "2013") && !strings.Contains(place, "greater noida") &&
			(o.taluk == "Noida" || strings.Contains(place, "noida"))
	}},
}

func pre(o office, prefix string) bool { return strings.HasPrefix(o.pin, prefix) }

var (
	pinShape  = regexp.MustCompile(`^[1-9][0-9]{5}$`)
	qualifier = regexp.MustCompile(`\s*\([^)]*\)`)
)

// normalize is clean.Normalize, repeated here because the package cannot be
// built before this program has written its data.
func normalize(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.NewReplacer("_", " ", "-", " ", ".", " ", "/", " ", "&", " and ", "'", "").Replace(s)
	return strings.Join(strings.Fields(s), " ")
}

func main() {
	in := flag.String("in", "IN.txt", "GeoNames' India postal codes, tab-separated")
	flag.Parse()
	f, err := os.Open(*in)
	if err != nil {
		log.Fatal(err)
	}
	defer f.Close()

	byPin := map[string][]office{}
	var all []office
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		c := strings.Split(sc.Text(), "\t")
		if len(c) < 8 || !pinShape.MatchString(c[1]) {
			continue
		}
		state, ok := states[c[3]]
		if !ok {
			log.Fatalf("unknown state %q (pincode %s): add it to states", c[3], c[1])
		}
		o := office{pin: c[1], place: c[2], state: state, district: c[5], taluk: c[7]}
		if state == "JK" && (o.district == "Leh" || o.district == "Kargil") {
			o.state = "LA" // Ladakh, a union territory of its own since 2019
		}
		byPin[o.pin] = append(byPin[o.pin], o)
		all = append(all, o)
	}
	if err := sc.Err(); err != nil {
		log.Fatal(err)
	}

	pins := make([]string, 0, len(byPin))
	for p := range byPin {
		pins = append(pins, p)
	}
	sort.Strings(pins)
	var b strings.Builder
	b.WriteString("# Indian pincodes: the state, then the city when every post office under the\n")
	b.WriteString("# pincode lies in it. Written by gen_places.go from GeoNames' India postal codes\n")
	b.WriteString("# (https://www.geonames.org), CC BY 4.0. Do not edit by hand.\n")
	perCity := map[string]int{}
	ambiguous := 0
	for _, p := range pins {
		offices := byPin[p]
		state := offices[0].state
		for _, o := range offices {
			if o.state != state {
				state = ""
			}
		}
		if state == "" {
			ambiguous++
			continue
		}
		city := cityOf(offices)
		perCity[city]++
		if city != "" {
			fmt.Fprintf(&b, "%s %s %s\n", p, state, city)
		} else {
			fmt.Fprintf(&b, "%s %s\n", p, state)
		}
	}
	if err := os.WriteFile("data/pincodes.txt", []byte(b.String()), 0o644); err != nil {
		log.Fatal(err)
	}

	// Districts and sub-districts by name, with the offices under each: a
	// name all of whose offices lie in one listed city (Secunderabad) is
	// written with that city.
	byName := map[string][]office{}
	for _, o := range all {
		for _, n := range []string{o.district, o.taluk} {
			n = normalize(qualifier.ReplaceAllString(n, ""))
			if len([]rune(n)) >= 3 && n != "na" {
				byName[n] = append(byName[n], o)
			}
		}
	}
	sorted := make([]string, 0, len(byName))
	for n := range byName {
		sorted = append(sorted, n)
	}
	sort.Strings(sorted)
	b.Reset()
	b.WriteString("# Indian districts and sub-districts, normalised, one per line; then the city\n")
	b.WriteString("# when every post office under the name lies in it. Written by gen_places.go\n")
	b.WriteString("# from GeoNames' India postal codes (https://www.geonames.org), CC BY 4.0.\n")
	b.WriteString("# Do not edit by hand.\n")
	inCity := 0
	for _, n := range sorted {
		if city := cityOf(byName[n]); city != "" {
			inCity++
			b.WriteString(n + "\t" + city + "\n")
		} else {
			b.WriteString(n + "\n")
		}
	}
	if err := os.WriteFile("data/places.txt", []byte(b.String()), 0o644); err != nil {
		log.Fatal(err)
	}

	log.Printf("%d pincodes (%d left out: offices in two states), %d place names (%d inside a listed city)",
		len(pins)-ambiguous, ambiguous, len(sorted), inCity)
	for _, c := range cities {
		log.Printf("  %-10s %d pincodes", c.code, perCity[c.code])
	}
}

// cityOf is the listed city every office lies in, or "".
func cityOf(offices []office) string {
	for _, c := range cities {
		every := true
		for _, o := range offices {
			every = every && c.in(o)
		}
		if every {
			return c.code
		}
	}
	return ""
}
