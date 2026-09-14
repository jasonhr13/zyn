package queueit

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strconv"
	"strings"
)

type powSolution struct {
	Hash    string `json:"hash"`
	Postfix int    `json:"postfix"`
}

// SolvePow is Queue-it's public SHA-256 prefix challenge
// (input+postfix, hex must start with zeroCount zeros).
func SolvePow(input string, zeroCount, runs int) (string, error) {
	if runs < 1 {
		runs = 1
	}
	if zeroCount < 0 {
		zeroCount = 0
	}
	zeros := strings.Repeat("0", zeroCount)
	out := make([]powSolution, 0, runs)
	for postfix := 1; len(out) < runs; postfix++ {
		sum := sha256.Sum256([]byte(input + strconv.Itoa(postfix)))
		hash := hex.EncodeToString(sum[:])
		if zeros == "" || strings.HasPrefix(hash, zeros) {
			out = append(out, powSolution{Hash: hash, Postfix: postfix})
		}
	}
	raw, err := json.Marshal(out)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(raw), nil
}
