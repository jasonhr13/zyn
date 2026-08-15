package tmx

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/md5"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"fmt"
	"math/big"
	"math/rand"
	"net/url"
	"strconv"
	"strings"
	"time"

	cryptoRand "crypto/rand"
)

var jsb = "Chrome 150" //update based off ua

func (t *TMXConfig) GenBrowserSmallPayload() string {
	return EncodePayload(
		[]string{"jsou", "jso", "jsbu", "jsb"},
		map[string]string{
			"":     "",
			"jsou": t.Device.Data.Jsou,
			"jso":  EncodeURIComponent(t.Device.Data.Jso),
			"jsbu": "Windows",
			"jsb":  EncodeURIComponent(jsb),
		},
		t.SessionID,
	)
}

func (t *TMXConfig) GenBrowserGeneralPayload() string {
	return EncodePayload(
		[]string{"c", "z", "f", "af", "sxy", "dpr", "mt", "mn", "scd", "lh", "pl", "ph", "hh", "jso", "jsb", "jsou", "jsbu", "nhc", "ndm", "nmtp", "tzd", "mathr"},
		map[string]string{
			"":      "",
			"c":     t.Device.C,                         //Math.min(-(new Date(new Date().getFullYear(),5,1).getTimezoneOffset()), -(new Date(new Date().getFullYear(),11,1).getTimezoneOffset()));
			"z":     t.Device.Z,                         // Math.abs((-new Date(new Date().getFullYear(), 5, 1).getTimezoneOffset()) - (-new Date(new Date().getFullYear(), 11, 1).getTimezoneOffset()));
			"f":     t.Device.Data.F,                    //`${screen?.width || window?.screen?.width || 0}x${screen?.height || window?.screen?.height || 0}`
			"af":    t.Device.Data.Af,                   //(screen.availWidth && screen.availHeight) ? `${screen.availWidth * (window.devicePixelRatio || 1)}x${screen.availHeight * (window.devicePixelRatio || 1)}` : ""
			"sxy":   t.Device.Data.Sxy,                  //(typeof window !== "undefined" && window.screenX != null && window.screenY != null) ? `${window.screenX * (window.devicePixelRatio || 1)}x${window.screenY * (window.devicePixelRatio || 1)}` : "";
			"dpr":   t.Device.Data.Dpr,                  //[window.devicePixelRatio || 1, screen.width, screen.height, screen.availWidth, screen.availHeight, window.innerWidth, window.innerHeight, window.outerWidth, window.outerHeight, window.screenX, window.screenY].join(",")
			"mt":    t.Device.Data.Mt,                   //[...navigator.mimeTypes].map(m => m.type).join(",") encoded
			"mn":    strconv.Itoa(t.Device.Data.Mn),     //navigator.mimeTypes.length
			"scd":   strconv.Itoa(t.Device.Data.Scd),    //screen.colorDepth
			"lh":    EncodeURIComponent(t.CurrentUrl),   //location.href.substring(0, 255)
			"pl":    strconv.Itoa(t.Device.Data.Pl),     //navigator.plugins.length
			"ph":    CreatePluginHash(t.Device.Data.Ph), //[...navigator.plugins].map(p => p.name + p.description + p.filename + p.length).join(""); encoded
			"hh":    md5Hex(t.SiteID + t.SessionID),
			"jso":   EncodeURIComponent(t.Device.Data.Jso),
			"jsb":   EncodeURIComponent(jsb),
			"jsou":  t.Device.Data.Jsou,
			"jsbu":  "Windows",
			"nhc":   strconv.Itoa(t.Device.Data.Nhc),  //navigator.hardwareConcurrency
			"ndm":   strconv.Itoa(t.Device.Data.Ndm),  //(Math && Math.floor ? Math.floor(navigator.deviceMemory + 0.5) : navigator.deviceMemory)
			"nmtp":  strconv.Itoa(t.Device.Data.Nmtp), //navigator.maxTouchPoints //always 0 from desktop
			"tzd":   t.Device.TZD,                     //Intl.DateTimeFormat().resolvedOptions().timeZone //parse from device/proxy maybe
			"mathr": Encode256(t.Device.Data.Mathr),   //math engine fingerprint
		},
		t.SessionID,
	)
}

func (t *TMXConfig) GenLQPayload() string {
	return EncodePayload(
		[]string{"lq"},
		map[string]string{
			"lq": EncodeURIComponent(t.UserAgent),
		},
		t.SessionID,
	)
}

func (t *TMXConfig) GenLSAPayload(LSAValue string) string {
	return EncodePayload(
		[]string{"lsa"},
		map[string]string{
			"lsa": EncodeURIComponent(LSAValue), //Local Storage Value
		},
		t.SessionID,
	)
}

func (t *TMXConfig) GenWGLPayload() string {
	// ual, _ := json.Marshal(t.Device.UAL)
	return EncodePayload(
		[]string{"lh", "dr", "p", "pm", "batst", "audh", "uah", "ual", "uistl", "shd"},
		map[string]string{
			"":      "",
			"lh":    EncodeURIComponent(t.CurrentUrl),                         // encodeURIComponent(location.href.substring(0, 255))
			"dr":    EncodeURIComponent(t.PrevUrl),                            //encodeURIComponent(document.referrer.substring(0, 255))
			"p":     t.Device.Data.P,                                          //plug in check
			"pm":    "no",                                                     //result above
			"batst": EncodeURIComponent(`{"level":1.00,"status":"charging"}`), //navigator.getBattery().then(b => console.log(JSON.stringify({"level":parseFloat(b.level.toFixed(2)),"status":b.charging?"charging":"unplugged"})))
			"audh":  t.Device.Data.Audh,                                       //audio fp hashing
			"uah":   EncodeURIComponent(t.Device.Data.Uah),                    //navigator.userAgentData.getHighEntropyValues(["architecture","model","formFactor","platformVersion","fullVersionList","bitness","wow64"]).then(v => console.log(JSON.stringify(v)))
			"ual":   EncodeURIComponent(t.Device.Data.Ual),                    //var td_nQ = {brands: navigator.userAgentData.brands, mobile: navigator.userAgentData.mobile, platform: navigator.userAgentData.platform};
			"uistl": EncodeURIComponent("dark"),                               //window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark" //make this 50/50
			"ssi":   "1,0,0,aa413579abef9aab90ea5d1aff7f9eabc557974f",         //shadowRoot
		},
		t.SessionID,
	)
}

func (t *TMXConfig) GenHashPayload() string {
	return EncodePayload(
		[]string{"ex3", "ex6", "ex6s", "gl_h", "wglv", "wglr", "glh_h", "ex4", "ex5", "ex7", "ex7s", "ccd", "jfn", "jfh", "jftn", "bbv"},
		map[string]string{
			"ex3":   t.Device.Data.Ex3,                      //canvas hash
			"ex6":   "87dfb6409ec2d99ddb02bbe2db36bdee",     //propHash
			"ex6s":  "1345956925505",                        //propHash count
			"gl_h":  t.Device.Data.GlH,                      //WglAgentHash
			"wglv":  EncodeURIComponent(t.Device.Data.Wglv), //WGLVendor //pull from ua
			"wglr":  EncodeURIComponent(t.Device.Data.Wglr), //WGLRenderer
			"glh_h": t.Device.Data.GlhH,                     //WglAgentHash2
			"ex4":   t.Device.Data.Ex4,                      //WGLHash1
			"ex5":   t.Device.Data.Ex5,                      //WGLHash2
			"ex7":   "a756abef66cd7d049829a124c66c8fce",     //prophash
			"ex7s":  "1513036640162",                        //prophash count                                                                                                                                      //hardcoded
			"ccd":   "2",
			"jfn":   strconv.Itoa(t.Device.Data.Jfn),
			"jfh":   t.Device.Data.Jfh,
			"jftn":  BuildJFTN(t.Device.Data.Jfn),
			"bbv":   "3",
		},
		t.SessionID,
	)
}

func (t *TMXConfig) GenMEDHPayload() string {
	return EncodePayload(
		[]string{"medh"},
		map[string]string{
			"":     "",
			"medh": t.Device.Data.Medh, //video audio string
		},
		t.SessionID,
	)
}
func (t *TMXConfig) GenLSBPayload(LSBValue string) string {
	return EncodePayload(
		[]string{"lsb"},
		map[string]string{
			"lsb": EncodeURIComponent(strings.Split(LSBValue, "_")[0]), //Local Storage Value
		},
		t.SessionID,
	)
}
func (t *TMXConfig) GenIPV4Payload() string {
	return EncodePayload(
		[]string{"wei", "wim"},
		map[string]string{
			"":    "",
			"wei": t.IPv4,
			"wim": "webrtc_internal_mdns", //voiceURI and hash
		},
		t.SessionID,
	)
}
func (t *TMXConfig) GenJFPayload() string {
	return EncodePayload(
		[]string{"jfn", "jfh", "jftn", "bbv"},
		map[string]string{
			"":     "",
			"jfn":  strconv.Itoa(t.Device.Data.Jfn),                  //fount count
			"jfh":  EncodeURIComponent(t.Device.Data.Jfh),            //font string encoded
			"jftn": EncodeURIComponent(BuildJFTN(t.Device.Data.Jfn)), //ElapsedTime MAYBE CALCULATE
			"bbv":  "3",                                              //hard coded
		},
		t.SessionID,
	)
}

func (t *TMXConfig) GenPortCheckPayload() string {
	return EncodePayload(
		[]string{"rd", "rdt", "bbv"},
		map[string]string{
			"rd":  "",            //detected ports
			"rdt": generateRdt(), //check ports and timming
			"bbv": "3",           //hard coded
		},
		t.SessionID,
	)
}


func (t *TMXConfig) GenSigPayload(nonce string) string {
	timeSeconds := fmt.Sprint(time.Now().UnixMilli() / 1000)
	rnd := "tdr_" + randString(16)
	enc := generateEncryptedFingerprint(timeSeconds, rnd, nonce)
	return EncodePayload(
		[]string{"sid_rnd", "sid_date", "sid_type", "sid_key", "sid_sig", "sifr"},
		map[string]string{
			"sid_rnd":  rnd,
			"sid_date": timeSeconds,
			"sid_type": "web:ecdsa",
			"sid_key":  enc.PubKeyEncoded,
			"sid_sig":  enc.Output,
			"sifr":     "0",
		},
		t.SessionID,
	)
}

func generateEncryptedFingerprint(timeSeconds, rnd, nonce string) *encFP {
	out := &encFP{}
	privKey, err := ecdsa.GenerateKey(elliptic.P256(), cryptoRand.Reader)
	if err != nil {
		fmt.Println("Error generating key:", err)
		return nil
	}
	derBytes, err := x509.MarshalPKIXPublicKey(&privKey.PublicKey)
	if err != nil {
		fmt.Println("Error marshaling public key:", err)
		return nil
	}
	hexString := hex.EncodeToString(derBytes)
	out.PubKeyEncoded = hexString
	message := rnd + nonce + timeSeconds + "web:ecdsa"
	hash := sha256.Sum256([]byte(message))
	r, s, err := ecdsa.Sign(cryptoRand.Reader, privKey, hash[:])
	if err != nil {
		fmt.Println("Error signing message:", err)
		return nil
	}

	// Manually encode the signature to DER format.
	derSignature := encodeSignature(r, s)

	// Convert the DER-encoded signature to a hex string.
	hexSignature := hex.EncodeToString(derSignature)
	out.Output = hexSignature
	return out
}

func encodeSignature(r, s *big.Int) []byte {
	// Encode each integer (r and s) individually.
	rEncoded := encodeInteger(r)
	sEncoded := encodeInteger(s)

	// Concatenate the two INTEGER encodings.
	sequenceContent := append(rEncoded, sEncoded...)

	// Wrap the concatenated content in a SEQUENCE.
	// 0x30 is the tag for a SEQUENCE.
	der := []byte{0x30, byte(len(sequenceContent))}
	der = append(der, sequenceContent...)
	return der
}

func encodeInteger(i *big.Int) []byte {
	// Get the minimal big-endian representation.
	b := i.Bytes()
	if len(b) == 0 {
		b = []byte{0x00}
	}

	// If the most significant bit is set, prepend a zero byte.
	if b[0] >= 0x80 {
		b = append([]byte{0x00}, b...)
	}

	// Wrap with the INTEGER tag (0x02) and the length.
	result := []byte{0x02, byte(len(b))}
	result = append(result, b...)
	return result
}

func randString(length int) string {
	out := ""
	for i := 0; i < length; i++ {
		randInt := rand.Intn(62)
		if randInt < 10 {
			out += fmt.Sprint(randInt)
			continue
		}
		if randInt < 36 {
			out += fromCharCode(randInt + 55)
			continue
		}
		out += fromCharCode(randInt + 61)
	}
	return out
}
func fromCharCode(c int) string {
	return string(rune(c))
}

func generateRdt() string {
	ports := []int{
		63333,
		5900,
		5901,
		5902,
		5903,
		3389,
		5950,
		5931,
		5939,
		6039,
		5944,
		6040,
		5938,
		5279,
		7070,
		2112,
	}

	r := rand.New(rand.NewSource(time.Now().UnixNano()))

	var b strings.Builder
	for i, port := range ports {
		if i > 0 {
			b.WriteByte(',')
		}

		interval := r.Intn(4) + 5 // 5-8
		b.WriteString(strconv.Itoa(port))
		b.WriteByte('-')
		b.WriteString(strconv.Itoa(interval))
	}

	return b.String()
}

func md5Hex(s string) string {
	sum := md5.Sum([]byte(s))
	return hex.EncodeToString(sum[:])
}


func BuildJFTN(fontCount int) string {
	r := rand.New(rand.NewSource(time.Now().UnixNano()))
	timeout := 0
	if r.Intn(100) == 0 {
		timeout = 1
	}

	var elapsed int
	if timeout == 0 {
		// Typical browser font scan time
		elapsed = 15 + r.Intn(120) // 15-134 ms
	} else {
		// Timed out after ~5 seconds
		elapsed = 5000 + r.Intn(400)
	}

	return fmt.Sprintf("%d:%d:%d", timeout, elapsed, fontCount)
}

// XOREncode implements td_0B.td_4X: length+"&"+body, XOR with cycling key (& 10), hex encode.
func XOREncode(body string, key string) string {
	if key == "" {
		key = "0"
	}
	chars := "0123456789abcdef"
	finalStr := fmt.Sprintf("%d&%s", len(body), body)
	result := strings.Builder{}

	n := 0
	for i := 0; i < len(finalStr); i++ {
		H := int(finalStr[i]) ^ int(key[n])&10
		n++
		if n == len(key) {
			n = 0
		}
		result.WriteByte(chars[(H>>4)&15])
		result.WriteByte(chars[H&15])
	}
	return result.String()
}

func CreatePluginHash(ph string) string {
	sum := md5.Sum([]byte(ph))
	return hex.EncodeToString(sum[:])
}

func EncodePayload(keyOrder []string, payload map[string]string, xorKey string) string {
	var b strings.Builder
	first := true
	for _, k := range keyOrder {
		v, ok := payload[k]
		if !ok {
			continue
		}
		if !first {
			b.WriteByte('&')
		}
		first = false
		b.WriteString(k)
		if v != "" {
			b.WriteByte('=')
			b.WriteString(v)
		}
	}

	body := b.String()

	if _, ok := payload[""]; ok {
		body = "&" + body
	}

	return XOREncode(body, xorKey)
}

func EncodeURIComponent(s string) string {
	var b strings.Builder
	for _, r := range s {
		// Characters encodeURIComponent does NOT encode
		if (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') ||
			r == '-' || r == '_' || r == '.' || r == '!' || r == '~' || r == '*' || r == '\'' || r == '(' || r == ')' {
			b.WriteRune(r)
		} else {
			// percent-encode each byte of the UTF-8 encoding
			encoded := url.QueryEscape(string(r))
			// QueryEscape uses + for space, we need %20
			encoded = strings.ReplaceAll(encoded, "+", "%20")
			b.WriteString(encoded)
		}
	}
	return b.String()
}

func Encode256(message string) string {
	sum := sha256.Sum256([]byte(message))
	return hex.EncodeToString(sum[:])
}
