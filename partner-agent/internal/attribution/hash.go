package attribution

import (
	"crypto/sha256"
	"encoding/hex"
)

// hashToken returns SHA-256(token) as lowercase hex.
//
// §90: "Store only SHA-256(token), never the raw token." The Agent transmits
// only this; the raw token goes to the browser and nowhere else.
func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
