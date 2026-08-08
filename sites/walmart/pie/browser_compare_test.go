package pie

import (
	"encoding/json"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
)

// Live PIE key material from browser getkey.js (user-provided).
var browserPIEKeys = Keys{
	L:     6,
	E:     4,
	K:     "AFE397534A1E8FFF57DFF3CF884D5CDA",
	KeyID: "e7feb8d4",
	Phase: 1,
}

const browserPAN = "5178057728845996"
const browserCVV = "992"

type browserEncryptResult struct {
	EncryptedPan   string `json:"encryptedPan"`
	EncryptedCVV   string `json:"encryptedCVV"`
	IntegrityCheck string `json:"integrityCheck"`
}

func runBrowserPIE(t *testing.T, pan, cvv string, keys Keys) browserEncryptResult {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	script := filepath.Join(filepath.Dir(file), "testdata", "pie_oracle.js")

	cmd := exec.Command("node", script, pan, cvv,
		strconv.Itoa(keys.L),
		strconv.Itoa(keys.E),
		keys.K,
		keys.KeyID,
		strconv.Itoa(keys.Phase),
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("browser pie runner failed: %v\n%s", err, out)
	}

	var result browserEncryptResult
	if err := json.Unmarshal(out, &result); err != nil {
		t.Fatalf("parse browser output: %v\n%s", err, out)
	}
	return result
}

func TestBrowserJSMatchesGo_UserCard(t *testing.T) {
	js := runBrowserPIE(t, browserPAN, browserCVV, browserPIEKeys)
	goCard, err := EncryptCard(browserPAN, browserCVV, browserPIEKeys)
	if err != nil {
		t.Fatal(err)
	}

	t.Logf("JS  pan=%s cvv=%s integrity=%s", js.EncryptedPan, js.EncryptedCVV, js.IntegrityCheck)
	t.Logf("Go  pan=%s cvv=%s integrity=%s", goCard.EncryptedPan, goCard.EncryptedCVV, goCard.IntegrityCheck)

	if js.EncryptedPan != goCard.EncryptedPan {
		t.Errorf("encryptedPan mismatch\n  js: %s\n  go: %s", js.EncryptedPan, goCard.EncryptedPan)
	}
	if js.EncryptedCVV != goCard.EncryptedCVV {
		t.Errorf("encryptedCVV mismatch\n  js: %s\n  go: %s", js.EncryptedCVV, goCard.EncryptedCVV)
	}
	if js.IntegrityCheck != goCard.IntegrityCheck {
		t.Errorf("integrityCheck mismatch\n  js: %s\n  go: %s", js.IntegrityCheck, goCard.IntegrityCheck)
	}
}

func TestBrowserJSMatchesGo_TestVectors(t *testing.T) {
	vectors := []struct {
		name string
		pan  string
		cvv  string
		keys Keys
	}{
		{"user_card", browserPAN, browserCVV, browserPIEKeys},
		{"visa_test", "4111111111111111", "123", testKeys},
		{"mc_test", "5500000000000004", "456", Keys{
			L: 6, E: 4, K: "fedcba9876543210fedcba9876543210", KeyID: "deadbeef", Phase: 0,
		}},
	}

	for _, v := range vectors {
		t.Run(v.name, func(t *testing.T) {
			js := runBrowserPIE(t, v.pan, v.cvv, v.keys)
			goCard, err := EncryptCard(v.pan, v.cvv, v.keys)
			if err != nil {
				t.Fatal(err)
			}
			if js.EncryptedPan != goCard.EncryptedPan ||
				js.EncryptedCVV != goCard.EncryptedCVV ||
				js.IntegrityCheck != goCard.IntegrityCheck {
				t.Fatalf("mismatch for %s\n  js: pan=%s cvv=%s integrity=%s\n  go: pan=%s cvv=%s integrity=%s",
					v.name,
					js.EncryptedPan, js.EncryptedCVV, js.IntegrityCheck,
					goCard.EncryptedPan, goCard.EncryptedCVV, goCard.IntegrityCheck)
			}
		})
	}
}
