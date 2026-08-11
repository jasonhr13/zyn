package alert

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"zynbot.app/engine/bot-base/siteconfig"
)

var webhookURL string

var httpClient = &http.Client{Timeout: 10 * time.Second}

func SetWebhookURL(value string) {
	webhookURL = value
}

func Send(message string) {
	if webhookURL == "" {
		return
	}
	go func() {
		defer func() { recover() }()
		body, err := json.Marshal(map[string]interface{}{"content": message})
		if err != nil {
			return
		}
		req, err := http.NewRequest("POST", webhookURL, bytes.NewBuffer(body))
		if err != nil {
			return
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := httpClient.Do(req)
		if err != nil {
			return
		}
		resp.Body.Close()
	}()
}

func Panic(source string, r interface{}, stack []byte) {
	trimmed := stack
	if len(trimmed) > 1500 {
		trimmed = trimmed[:1500]
	}
	username := valueOrUnknown(siteconfig.Username())
	key := valueOrUnknown(siteconfig.LicenseKey())
	Send(fmt.Sprintf(":rotating_light: panic in %s (user=%s, key=%s): %v\n```%s```", source, username, key, r, string(trimmed)))
}

func valueOrUnknown(s string) string {
	if s == "" {
		return "unknown"
	}
	return s
}
