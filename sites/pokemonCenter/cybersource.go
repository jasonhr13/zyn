package pokemoncenter

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/PolarAIO/Polar-AIO/backend/client"
	"github.com/golang-jwt/jwt/v5"
)

type cyberSourceCard struct {
	Number          string
	SecurityCode    string
	Type            string
	ExpirationMonth string
	ExpirationYear  string
}

type captureContext struct {
	raw     string
	tokenURL string
	jwk     jwk
	exp     int64
}

type jwk struct {
	Kty string `json:"kty"`
	Kid string `json:"kid"`
	N   string `json:"n"`
	E   string `json:"e"`
}

func tokenizeCyberSourceCard(ctx context.Context, httpClient client.HttpClient, captureContextJWT string, card cyberSourceCard) (string, error) {
	capCtx, err := parseCaptureContext(captureContextJWT)
	if err != nil {
		return "", err
	}
	if time.Now().Unix() > capCtx.exp {
		return "", fmt.Errorf("capture context has expired")
	}

	jwe, err := createCardJWE(capCtx, card)
	if err != nil {
		return "", err
	}

	req := client.RequestStruct{
		CTX: ctx,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    capCtx.tokenURL,
			Data:   jwe,
		},
		Headers: map[string][]string{
			"content-type": {"application/jwt; charset=utf-8"},
		},
	}

	resp, body, err := client.MakeRequest(req, httpClient, nil)
	if err != nil {
		return "", fmt.Errorf("token request failed: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 400 {
		return "", fmt.Errorf("token creation failed with status %d: %s", resp.StatusCode, body)
	}

	return parsePaymentToken(body)
}

func parseCaptureContext(jwtStr string) (*captureContext, error) {
	parts := strings.Split(jwtStr, ".")
	if len(parts) != 3 {
		return nil, fmt.Errorf("invalid capture context jwt")
	}

	payloadBytes, err := base64URLDecode(parts[1])
	if err != nil {
		return nil, err
	}

	var payload struct {
		Flx struct {
			Path   string `json:"path"`
			Origin string `json:"origin"`
			JWK    jwk    `json:"jwk"`
		} `json:"flx"`
		Exp int64 `json:"exp"`
	}
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		return nil, err
	}

	return &captureContext{
		raw:      jwtStr,
		tokenURL: payload.Flx.Origin + payload.Flx.Path,
		jwk:      payload.Flx.JWK,
		exp:      payload.Exp,
	}, nil
}

func createCardJWE(capCtx *captureContext, card cyberSourceCard) (string, error) {
	plaintext, err := json.Marshal(map[string]interface{}{
		"data": map[string]interface{}{
			"CARD": map[string]string{
				"number":          card.Number,
				"securityCode":    card.SecurityCode,
				"type":            card.Type,
				"expirationMonth": card.ExpirationMonth,
				"expirationYear":  card.ExpirationYear,
			},
		},
		"context": capCtx.raw,
		"index":   0,
	})
	if err != nil {
		return "", err
	}

	header := map[string]string{
		"kid": capCtx.jwk.Kid,
		"alg": "RSA-OAEP",
		"enc": "A256GCM",
	}
	headerBytes, _ := json.Marshal(header)
	headerB64 := base64URLEncode(headerBytes)

	cek := make([]byte, 32)
	iv := make([]byte, 12)
	if _, err := rand.Read(cek); err != nil {
		return "", err
	}
	if _, err := rand.Read(iv); err != nil {
		return "", err
	}

	pubKey, err := jwkToRSAPublicKey(capCtx.jwk)
	if err != nil {
		return "", err
	}

	encryptedKey, err := rsa.EncryptOAEP(sha1.New(), rand.Reader, pubKey, cek, nil)
	if err != nil {
		return "", err
	}

	block, err := aes.NewCipher(cek)
	if err != nil {
		return "", err
	}
	aesGCM, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}

	ciphertextWithTag := aesGCM.Seal(nil, iv, plaintext, []byte(headerB64))
	tagSize := 16
	ciphertext := ciphertextWithTag[:len(ciphertextWithTag)-tagSize]
	tag := ciphertextWithTag[len(ciphertextWithTag)-tagSize:]

	return fmt.Sprintf("%s.%s.%s.%s.%s",
		headerB64,
		base64URLEncode(encryptedKey),
		base64URLEncode(iv),
		base64URLEncode(ciphertext),
		base64URLEncode(tag),
	), nil
}

func jwkToRSAPublicKey(key jwk) (*rsa.PublicKey, error) {
	if key.Kty != "RSA" {
		return nil, fmt.Errorf("unsupported key type: %s", key.Kty)
	}

	nBytes, err := base64URLDecode(key.N)
	if err != nil {
		return nil, err
	}
	eBytes, err := base64URLDecode(key.E)
	if err != nil {
		return nil, err
	}

	n := new(big.Int).SetBytes(nBytes)
	e := 0
	for _, b := range eBytes {
		e = e<<8 + int(b)
	}
	return &rsa.PublicKey{N: n, E: e}, nil
}

func base64URLEncode(data []byte) string {
	return strings.TrimRight(base64.URLEncoding.EncodeToString(data), "=")
}

func base64URLDecode(s string) ([]byte, error) {
	switch len(s) % 4 {
	case 2:
		s += "=="
	case 3:
		s += "="
	}
	return base64.URLEncoding.DecodeString(s)
}

func detectCardType(number string) string {
	if number == "" {
		return ""
	}
	switch {
	case strings.HasPrefix(number, "4"):
		return "001"
	case len(number) >= 2 && number[:2] >= "51" && number[:2] <= "55":
		return "002"
	case len(number) >= 4 && number[:4] >= "2221" && number[:4] <= "2720":
		return "002"
	case len(number) >= 2 && (number[:2] == "34" || number[:2] == "37"):
		return "003"
	case strings.HasPrefix(number, "6011") || strings.HasPrefix(number, "65") ||
		(len(number) >= 6 && number[:6] >= "622126" && number[:6] <= "622925"):
		return "004"
	case strings.HasPrefix(number, "35"):
		return "007"
	case len(number) >= 2 && (number[:2] == "36" || number[:2] == "38" || number[:2] == "39"):
		return "005"
	case strings.HasPrefix(number, "6304") || strings.HasPrefix(number, "6759") ||
		strings.HasPrefix(number, "676770") || strings.HasPrefix(number, "676774"):
		return "042"
	case strings.HasPrefix(number, "62"):
		return "062"
	default:
		return ""
	}
}

func cardTypeName(code string) string {
	switch code {
	case "001":
		return "Visa"
	case "002":
		return "Mastercard"
	case "003":
		return "Amex"
	case "004":
		return "Discover"
	case "005":
		return "Diners Club"
	case "007":
		return "JCB"
	case "042":
		return "Maestro"
	case "062":
		return "UnionPay"
	default:
		return "Card"
	}
}

func parsePaymentToken(encoded string) (string, error) {
	token, _, err := jwt.NewParser().ParseUnverified(encoded, jwt.MapClaims{})
	if err != nil {
		return "", err
	}
	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return "", fmt.Errorf("invalid payment token claims")
	}
	jti, ok := claims["jti"].(string)
	if !ok || jti == "" {
		return "", fmt.Errorf("payment token not found")
	}
	return jti, nil
}