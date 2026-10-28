package clean

import (
	"strings"
	"sync"
	"unicode"
)

// Suggestion is a likely meaning for a value no rule recognised. It is only
// ever offered: the setup page shows it chosen, and the Partner's save is
// what makes it an answer.
type Suggestion struct {
	// Code is the suggested code.
	Code string
	// Why says where it came from, in a few words for the page.
	Why string
}

// Suggest offers a code for a value Map does not recognise: one written in an
// Indian script (गुरुग्राम), misspelled by a letter or two (Gurgoan), or
// naming a part of a listed city (South Delhi, Secunderabad). It offers
// nothing when the value could as well be something else -- another place
// (Mangalore is not a misspelled Bangalore), or two codes equally close.
func (m *EnumMapper) Suggest(raw any) (Suggestion, bool) {
	text := strings.TrimSpace(Text(raw))
	key := Normalize(text)
	if key == "" {
		return Suggestion{}, false
	}
	if _, ok := m.Map(raw); ok {
		return Suggestion{}, false
	}
	why := "a close spelling"
	if latin, script := Romanize(text); script != "" {
		key, why = Normalize(latin), "written in "+script
		if code, ok := m.lookup(key); ok {
			return Suggestion{code, why}, true
		}
	}
	if code, ok := m.partOf(key); ok {
		return Suggestion{code, "a part of " + CodeLabel(code)}, true
	}
	if m.key == "city" {
		if city, ok := knownPlace(key); ok {
			if city != "" && m.allowed[city] {
				return Suggestion{city, "lies in " + CodeLabel(city)}, true
			}
			return Suggestion{}, false
		}
	}
	if code, ok := m.near(key); ok {
		return Suggestion{code, why}, true
	}
	return Suggestion{}, false
}

// CodeLabel writes a code the way a page shows it: CREDIT_CARD as "Credit card".
func CodeLabel(code string) string {
	s := strings.ToLower(strings.ReplaceAll(code, "_", " "))
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// partWords name a part of a city: South Delhi, Bangalore North, Pune City,
// Mumbai Suburban. "Rural" is not among them -- Bangalore Rural is outside
// Bengaluru -- and nor are "greater" or "navi", which name other cities.
var partWords = map[string]bool{
	"north": true, "south": true, "east": true, "west": true, "central": true,
	"city": true, "urban": true, "suburban": true, "metro": true, "metropolitan": true,
	"corporation": true, "municipal": true, "cantonment": true, "cantt": true,
}

func (m *EnumMapper) partOf(key string) (string, bool) {
	if m.key != "city" {
		return "", false
	}
	var kept []string
	for _, w := range strings.Fields(key) {
		if !partWords[w] {
			kept = append(kept, w)
		}
	}
	rest := strings.Join(kept, " ")
	if rest == "" || rest == key {
		return "", false
	}
	return m.lookup(rest)
}

// near finds the one code whose names are a letter or two from the value,
// after folding away the spellings Indian names vary in.
func (m *EnumMapper) near(key string) (string, bool) {
	k := []rune(fold(key))
	if len(k) == 0 {
		return "", false
	}
	best, code, tie := len(k)+1, "", false
	consider := func(name, c string) {
		switch d := distance(k, []rune(fold(name))); {
		case d < best:
			best, code, tie = d, c, false
		case d == best && c != code:
			tie = true
		}
	}
	for name, c := range m.synonyms {
		consider(name, c)
	}
	for name, c := range m.shared {
		consider(name, c)
	}
	for c := range m.allowed {
		consider(strings.ToLower(strings.ReplaceAll(c, "_", " ")), c)
	}
	if m.key == "state_region" {
		for name, c := range otherStates {
			consider(name, c)
		}
	}
	// The allowance goes by the value as written: folding shortens "footware".
	if tie || code == "" || !m.allowed[code] || best > allowance(len([]rune(strings.ReplaceAll(key, " ", "")))) {
		return "", false
	}
	if m.key == "city" && m.nearerPlace(k, best) {
		return "", false
	}
	return code, true
}

// nearerPlace reports whether some place outside the list is at least as
// close to the value as the code near found: "Mangalor" is nearer Mangalore
// than Bangalore.
func (m *EnumMapper) nearerPlace(k []rune, best int) bool {
	loadPlaces()
	for name, city := range places.names {
		if city != "" {
			continue
		}
		n := []rune(fold(name))
		if len(n) > len(k)+best || len(n) < len(k)-best {
			continue
		}
		if _, ours := m.lookup(name); ours {
			continue
		}
		if distance(k, n) <= best {
			return true
		}
	}
	return false
}

// allowance is how many letters a value of n letters may be from a name:
// none for short ones, where one letter makes another word.
func allowance(n int) int {
	switch {
	case n <= 4:
		return 0
	case n <= 7:
		return 1
	}
	return 2
}

var (
	foldLetters = strings.NewReplacer("ph", "f", "ee", "i", "oo", "u", "aa", "a", "ii", "i", "uu", "u", "ck", "k",
		"w", "v", "z", "j", "q", "k", "y", "i")
	// Then the diphthongs, said as plain vowels in most Indian names:
	// Haidarabad is Hyderabad, Bangalaur is Bangalore.
	foldVowels = strings.NewReplacer("ai", "e", "au", "o")
)

// fold reduces a normalised Latin value to how it sounds, roughly, so the
// usual variations in spelling Indian names cost nothing: Chennai and Chenai,
// Calcutta and Calcuta, Poona and Puna. Spaces go too.
func fold(s string) string {
	s = foldVowels.Replace(foldLetters.Replace(s))
	out := make([]rune, 0, len(s))
	for _, r := range s {
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) {
			continue
		}
		n := len(out)
		if n > 0 && (out[n-1] == r || (r == 'h' && consonantLetter(out[n-1]))) {
			continue
		}
		out = append(out, r)
	}
	return string(out)
}

func consonantLetter(r rune) bool {
	return r >= 'a' && r <= 'z' && !strings.ContainsRune("aeiouh", r)
}

// distance is the optimal string alignment distance: insertions, deletions,
// substitutions, and swaps of two neighbouring letters (Gurgoan, Gurgaon).
func distance(a, b []rune) int {
	prev2 := make([]int, len(b)+1)
	prev := make([]int, len(b)+1)
	cur := make([]int, len(b)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(a); i++ {
		cur[0] = i
		for j := 1; j <= len(b); j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			cur[j] = min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
			if i > 1 && j > 1 && a[i-1] == b[j-2] && a[i-2] == b[j-1] {
				cur[j] = min(cur[j], prev2[j-2]+1)
			}
		}
		prev2, prev, cur = prev, cur, prev2
	}
	return prev[len(b)]
}

// shared are synonyms Partners agreed on and Oolix reviewed, published to
// every Agent: by attribute, normalised value -> code. They rank below the
// built-in synonyms and the Partner's own answers.
var shared struct {
	sync.RWMutex
	byAttr map[string]map[string]string
}

// SetShared replaces the shared synonyms.
func SetShared(byAttr map[string]map[string]string) {
	norm := make(map[string]map[string]string, len(byAttr))
	for attr, values := range byAttr {
		norm[attr] = make(map[string]string, len(values))
		for raw, code := range values {
			norm[attr][Normalize(raw)] = code
		}
	}
	shared.Lock()
	shared.byAttr = norm
	shared.Unlock()
}

func sharedFor(attr string) map[string]string {
	shared.RLock()
	defer shared.RUnlock()
	return shared.byAttr[attr]
}
