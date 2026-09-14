package queueit

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strconv"
	"strings"
	"testing"
)

func TestSolvePowPrefix(t *testing.T) {
	input := "f02b931c-52f0-4507-9406-f1221678dc16"
	b64, err := SolvePow(input, 2, 1)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		t.Fatal(err)
	}
	var rows []powSolution
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("got %d solutions", len(rows))
	}
	sum := sha256.Sum256([]byte(input + strconv.Itoa(rows[0].Postfix)))
	hash := hex.EncodeToString(sum[:])
	if hash != rows[0].Hash {
		t.Fatalf("hash mismatch")
	}
	if !strings.HasPrefix(hash, "00") {
		t.Fatalf("hash %s missing prefix", hash)
	}
}
