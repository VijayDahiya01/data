package cleanroom

import (
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/oolix/partner-agent/internal/enclave"
)

// Service is the clean room, run in a Nitro Enclave (cmd/cleanroom). It
// makes two keys when it starts and never lets them out: an X25519 key that
// Agents seal match keys to, and an Ed25519 key that signs its answers. Its
// attestation document carries the first as its public key and the second
// as its user data, so an Agent knows whom it seals to, and Oolix whose
// answers it keeps. It keeps nothing itself: inputs live as long as the
// request that carries them.
type Service struct {
	box    *ecdh.PrivateKey
	sign   ed25519.PrivateKey
	attest func(nonce, userData, publicKey []byte) ([]byte, error)
	logger *slog.Logger
	now    func() time.Time
}

// NewService makes the clean room's keys. attest is enclave.Attest.
func NewService(attest func(nonce, userData, publicKey []byte) ([]byte, error), logger *slog.Logger) (*Service, error) {
	box, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	_, sign, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	return &Service{box: box, sign: sign, attest: attest, logger: logger, now: time.Now}, nil
}

// MaxInput bounds a request: a few million customers, sealed.
const MaxInput = 1 << 30

// Input is one Partner's customers, sealed to the clean room.
type Input struct {
	Partner string `json:"partner"`
	Sealed  []byte `json:"sealed"`
}

// Signed is an answer: the exact JSON that was signed, and the signature.
type Signed struct {
	Payload   []byte `json:"payload"`
	Signature []byte `json:"signature"`
}

// OverlapResult is what /v1/overlap signs.
type OverlapResult struct {
	RunID    string    `json:"run_id"`
	Kind     string    `json:"kind"`
	Pairs    []Pair    `json:"pairs"`
	SignedAt time.Time `json:"signed_at"`
}

// JointResult is what /v1/joint signs. Sealed holds the base Partner's
// shared customers' keys, sealed to its Agent; empty when too few.
type JointResult struct {
	RunID    string    `json:"run_id"`
	Kind     string    `json:"kind"`
	Base     string    `json:"base"`
	Other    string    `json:"other"`
	Band     string    `json:"band"`
	Sealed   []byte    `json:"sealed,omitempty"`
	SignedAt time.Time `json:"signed_at"`
}

// Handler serves the clean room's three requests.
func (s *Service) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /attestation", s.attestation)
	mux.HandleFunc("POST /v1/overlap", s.overlap)
	mux.HandleFunc("POST /v1/joint", s.joint)
	return mux
}

func (s *Service) attestation(w http.ResponseWriter, r *http.Request) {
	nonce, err := hex.DecodeString(r.URL.Query().Get("nonce"))
	if err != nil || len(nonce) < 16 || len(nonce) > 64 {
		http.Error(w, "send a nonce of 16 to 64 bytes, in hex", http.StatusBadRequest)
		return
	}
	doc, err := s.attest(nonce, s.sign.Public().(ed25519.PublicKey), s.box.PublicKey().Bytes())
	if err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/cbor")
	_, _ = w.Write(doc)
}

func (s *Service) open(in Input) ([]Customer, error) {
	plain, err := Open(s.box, in.Sealed)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", in.Partner, err)
	}
	return DecodeCustomers(plain)
}

func (s *Service) overlap(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RunID  string  `json:"run_id"`
		Inputs []Input `json:"inputs"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, MaxInput)).Decode(&req); err != nil ||
		req.RunID == "" || len(req.Inputs) < 2 {
		http.Error(w, "send a run_id and two or more inputs", http.StatusBadRequest)
		return
	}
	sets := map[string][]Customer{}
	for _, in := range req.Inputs {
		customers, err := s.open(in)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		sets[in.Partner] = customers
	}
	s.answer(w, OverlapResult{RunID: req.RunID, Kind: "overlap", Pairs: Overlap(sets), SignedAt: s.now().UTC()})
	s.logger.Info("overlap counted", "run", req.RunID, "partners", len(sets))
}

func (s *Service) joint(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RunID     string `json:"run_id"`
		Base      Input  `json:"base"`
		Other     Input  `json:"other"`
		Recipient []byte `json:"recipient"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, MaxInput)).Decode(&req); err != nil || req.RunID == "" {
		http.Error(w, "send a run_id, base, other and recipient", http.StatusBadRequest)
		return
	}
	to, err := ecdh.X25519().NewPublicKey(req.Recipient)
	if err != nil {
		http.Error(w, "the recipient is not an X25519 key", http.StatusBadRequest)
		return
	}
	base, err := s.open(req.Base)
	if err == nil {
		var other []Customer
		if other, err = s.open(req.Other); err == nil {
			res := JointResult{RunID: req.RunID, Kind: "joint", Base: req.Base.Partner, Other: req.Other.Partner,
				SignedAt: s.now().UTC()}
			shared, n, ok := Joint(base, other)
			res.Band = Band(n)
			if ok {
				if res.Sealed, err = Seal(to, EncodeKeys(shared)); err != nil {
					http.Error(w, err.Error(), http.StatusInternalServerError)
					return
				}
			}
			s.answer(w, res)
			s.logger.Info("joint audience made", "run", req.RunID, "band", res.Band)
			return
		}
	}
	http.Error(w, err.Error(), http.StatusBadRequest)
}

func (s *Service) answer(w http.ResponseWriter, v any) {
	payload, err := json.Marshal(v)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(Signed{Payload: payload, Signature: ed25519.Sign(s.sign, payload)})
}

// Recipient verifies a clean room's attestation document and returns the
// keys it names: the one to seal to, and the one its answers are signed with.
func Recipient(doc []byte, opts enclave.VerifyOptions) (*ecdh.PublicKey, ed25519.PublicKey, error) {
	d, err := enclave.Verify(doc, opts)
	if err != nil {
		return nil, nil, err
	}
	if len(d.PublicKey) != 32 || len(d.UserData) != ed25519.PublicKeySize {
		return nil, nil, errors.New("cleanroom: the attestation does not name the clean room's keys")
	}
	box, err := ecdh.X25519().NewPublicKey(d.PublicKey)
	if err != nil {
		return nil, nil, err
	}
	return box, ed25519.PublicKey(d.UserData), nil
}

// VerifySigned checks a clean room answer against the key its attestation
// named, and decodes it into v.
func VerifySigned(s Signed, key ed25519.PublicKey, v any) error {
	if !ed25519.Verify(key, s.Payload, s.Signature) {
		return errors.New("cleanroom: the answer is not signed by the clean room")
	}
	return json.Unmarshal(s.Payload, v)
}
