package tmx

import (
	"encoding/hex"
	"math/rand"
	"strings"
	"testing"
)

const testChromeUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"

func TestGenerateLocalFingerprintShape(t *testing.T) {
	fingerprint := generateLocalFingerprint(testChromeUA, rand.New(rand.NewSource(1)))
	data := fingerprint.Data

	if data.UserAgent != testChromeUA {
		t.Fatalf("user agent = %q", data.UserAgent)
	}
	if data.Jsb != "Chrome 150" || data.Jsou != "Mac" || data.Jso != "Mac OS X" {
		t.Fatalf("browser fields = jsb:%q jsou:%q jso:%q", data.Jsb, data.Jsou, data.Jso)
	}
	if !strings.Contains(data.Uah, `"platform":"MacIntel"`) {
		t.Fatalf("uah = %q", data.Uah)
	}
	if data.Scd != 24 || data.Nmtp != 0 || data.P != "0" {
		t.Fatalf("fixed fields = scd:%d nmtp:%d p:%q", data.Scd, data.Nmtp, data.P)
	}
	if data.Jfn < 30 || data.Jfn > 60 {
		t.Fatalf("font count = %d", data.Jfn)
	}
	if fingerprint.TZD == "" || fingerprint.C == "" || fingerprint.Z == "" {
		t.Fatalf("timezone fields = %#v", fingerprint)
	}

	for name, value := range map[string]string{
		"mathr": data.Mathr,
		"medh":  data.Medh,
		"audh":  data.Audh,
		"ex3":   data.Ex3,
		"ex4":   data.Ex4,
		"ex5":   data.Ex5,
		"gl_c":  data.GlC,
		"gl_h":  data.GlH,
		"glh_h": data.GlhH,
		"ph":    data.Ph,
		"jfh":   data.Jfh,
	} {
		if len(value) != 32 {
			t.Fatalf("%s length = %d", name, len(value))
		}
		if _, err := hex.DecodeString(value); err != nil {
			t.Fatalf("%s is not hex: %v", name, err)
		}
	}
}

func TestGenerateLocalFingerprintDeterministicWithSeed(t *testing.T) {
	first := generateLocalFingerprint(testChromeUA, rand.New(rand.NewSource(42)))
	second := generateLocalFingerprint(testChromeUA, rand.New(rand.NewSource(42)))
	if first != second {
		t.Fatal("same seed produced different fingerprints")
	}
}

func TestLocalBrowserInfo(t *testing.T) {
	tests := []struct {
		ua, browser, version, jsou, platform string
	}{
		{testChromeUA, "Chrome", "150", "Mac", "MacIntel"},
		{"Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/147.0", "Firefox", "147", "Windows", "Windows"},
		{"Mozilla/5.0 (X11; Linux x86_64) Edg/151.0.0.0", "Edge", "151", "Linux", "Linux x86_64"},
	}
	for _, test := range tests {
		got := parseLocalBrowserInfo(test.ua)
		if got.browser != test.browser || got.version != test.version || got.jsou != test.jsou || got.platform != test.platform {
			t.Fatalf("parseLocalBrowserInfo(%q) = %#v", test.ua, got)
		}
	}
}
