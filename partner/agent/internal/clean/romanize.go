package clean

import (
	"regexp"
	"strings"
)

// Romanize writes text in India's Brahmic scripts in Latin letters, the way
// the same words are usually spelled in English: गुरुग्राम -> gurugraam,
// சென்னை -> chennai. It is for matching, not for display, so it is loose: the
// result is compared after folding (see fold), which forgives long vowels and
// doubled letters. Other text passes through unchanged. script names the
// first Indian script seen, or "".
//
// The nine scripts share one layout -- each occupies 128 code points from
// U+0900 with letters at the same offsets -- so one table serves them all,
// with a few letters of their own.
func Romanize(s string) (latin, script string) {
	var b strings.Builder
	runes := []rune(s)
	// afterVowel is true when what was written last ends in a vowel sound.
	afterVowel := false
	for i := 0; i < len(runes); i++ {
		r := runes[i]
		blk, off, ok := indic(r)
		if !ok {
			if r != zwj && r != zwnj {
				b.WriteRune(r)
				afterVowel = false
			}
			continue
		}
		if script == "" {
			script = scriptNames[blk]
		}
		l := letterAt(blk, off)
		switch l.kind {
		case consonant:
			cons, vowel := l.text, "a"
			// Look past joiners and a nukta to the sign the consonant carries.
			j := i + 1
			next := func() (letter, bool) {
				for j < len(runes) && (runes[j] == zwj || runes[j] == zwnj) {
					j++
				}
				if j < len(runes) {
					if nb, noff, ok := indic(runes[j]); ok && nb == blk {
						return letterAt(nb, noff), true
					}
				}
				return letter{}, false
			}
			n, inWord := next()
			if inWord && n.kind == nukta {
				if form, ok := nuktaForms[off]; ok {
					cons = form
				}
				j++
				n, inWord = next()
			}
			switch {
			case inWord && n.kind == matra:
				vowel = n.text
				j++
			case inWord && n.kind == virama:
				vowel = ""
				j++
			case !inWord && blk <= 3:
				// The end of a word: north Indian scripts drop the inherent
				// vowel there (राम is "ram"); southern ones say it.
				vowel = ""
			case blk <= 3 && afterVowel && n.kind == consonant && carriesVowel(runes, j, blk):
				// And between a vowel and a consonant that has its own:
				// गुड़गांव is "gurgaanv", कोलकाता is "kolkaata".
				vowel = ""
			}
			b.WriteString(cons + vowel)
			afterVowel = vowel != ""
			i = j - 1
		case nukta, virama, ignored:
		case vowel:
			b.WriteString(l.text)
			afterVowel = true
		default:
			b.WriteString(l.text)
			afterVowel = false
		}
	}
	// An anusvara before p, b or m is said m: मुंबई is "mumbai".
	latin = strings.NewReplacer("nb", "mb", "np", "mp", "nm", "mm").Replace(b.String())
	// गांव, गाँव and गाव ("village") end many place names, and are always
	// written "gaon" in them: गुड़गांव is Gurgaon, गोरेगाव is Goregaon.
	return gaon.ReplaceAllString(latin, "gaon"), script
}

var gaon = regexp.MustCompile(`gaa?n?v\b`)

// carriesVowel reports whether the consonant at runes[j] is said with a
// vowel: it is not joined to the next letter by a virama.
func carriesVowel(runes []rune, j, blk int) bool {
	for k := j + 1; k < len(runes); k++ {
		if runes[k] == zwj || runes[k] == zwnj {
			continue
		}
		nb, off, ok := indic(runes[k])
		if !ok || nb != blk {
			return false // the word's last letter, which loses its vowel
		}
		switch letterAt(nb, off).kind {
		case nukta:
			continue
		case virama:
			return false
		}
		return true
	}
	return false
}

const (
	zwnj = '‌'
	zwj  = '‍'
)

type letterKind int

const (
	ignored   letterKind = iota
	vowel                // an independent vowel: written as is
	consonant            // takes the inherent "a" unless a sign follows
	matra                // a vowel sign, replacing the inherent "a"
	virama               // removes the inherent "a"
	nukta                // turns the consonant before it into another
	sign                 // a nasal or breath mark, a digit, a stop
)

type letter struct {
	kind letterKind
	text string
}

var scriptNames = [9]string{"Devanagari", "Bengali", "Gurmukhi", "Gujarati", "Odia", "Tamil",
	"Telugu", "Kannada", "Malayalam"}

func indic(r rune) (blk, off int, ok bool) {
	if r < 0x0900 || r > 0x0D7F {
		return 0, 0, false
	}
	return int(r-0x0900) / 0x80, int(r-0x0900) % 0x80, true
}

func letterAt(blk, off int) letter {
	if l, ok := scriptLetters[blk][off]; ok {
		return l
	}
	return layout[off]
}

// layout is the shared table, by offset within a script's block.
var layout = func() [0x80]letter {
	var t [0x80]letter
	set := func(kind letterKind, from int, texts ...string) {
		for i, s := range texts {
			if s != "" {
				t[from+i] = letter{kind, s}
			}
		}
	}
	set(sign, 0x00, "n", "n", "n", "h")
	set(vowel, 0x04, "a", "a", "aa", "i", "ii", "u", "uu", "ri", "li", "e", "e", "e", "ai", "o", "o", "o", "au")
	set(consonant, 0x15, "k", "kh", "g", "gh", "ng", "ch", "chh", "j", "jh", "ny",
		"t", "th", "d", "dh", "n", "t", "th", "d", "dh", "n", "n",
		"p", "ph", "b", "bh", "m", "y", "r", "r", "l", "l", "zh", "v", "sh", "sh", "s", "h")
	set(matra, 0x3A, "o", "o")
	t[0x3C] = letter{nukta, ""}
	set(matra, 0x3E, "aa", "i", "ii", "u", "uu", "ri", "rii", "e", "e", "e", "ai", "o", "o", "o", "au")
	t[0x4D] = letter{virama, ""}
	set(matra, 0x4E, "e", "au")
	set(sign, 0x50, "om")
	set(consonant, 0x58, "q", "kh", "g", "z", "r", "rh", "f", "y")
	set(vowel, 0x60, "ri", "li")
	set(matra, 0x62, "li", "li")
	set(sign, 0x64, " ", " ", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9")
	return t
}()

// scriptLetters are where a script departs from the shared layout.
var scriptLetters = [9]map[int]letter{
	1: { // Bengali: khanda ta, and Assamese ra and wa
		0x4E: {consonant, "t"}, 0x70: {consonant, "r"}, 0x71: {consonant, "w"},
	},
	2: { // Gurmukhi: tippi is a nasal; addak doubles the next letter
		0x70: {sign, "n"}, 0x71: {ignored, ""}, 0x72: {ignored, ""}, 0x73: {ignored, ""}, 0x75: {consonant, "y"},
	},
	4: {0x71: {consonant, "w"}}, // Odia wa
	5: { // Tamil: numbers ten and above, and the aytham
		0x03: {sign, "h"}, 0x70: {ignored, ""}, 0x71: {ignored, ""}, 0x72: {ignored, ""},
	},
	6: {0x55: {ignored, ""}, 0x56: {ignored, ""}}, // Telugu length marks
	7: {0x55: {ignored, ""}, 0x56: {ignored, ""}}, // Kannada length marks
	8: { // Malayalam: the au length mark, and the chillu letters (a final consonant)
		0x54: {sign, "m"}, 0x55: {sign, "y"}, 0x56: {sign, "l"}, 0x57: {ignored, ""},
		0x7A: {sign, "n"}, 0x7B: {sign, "n"}, 0x7C: {sign, "r"}, 0x7D: {sign, "l"}, 0x7E: {sign, "l"}, 0x7F: {sign, "k"},
	},
}

// nuktaForms are the consonants a nukta makes, by the base consonant's
// offset: ज़ is "z", फ़ is "f", ड़ is "r".
var nuktaForms = map[int]string{
	0x15: "q", 0x16: "kh", 0x17: "g", 0x1C: "z", 0x21: "r", 0x22: "rh", 0x2B: "f", 0x2F: "y",
}
