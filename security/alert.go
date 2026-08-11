package security

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"zynbot.app/engine/bot-base/siteconfig"
)

var crackerWebhookURL string

func SetAlertWebhookURL(value string) {
	crackerWebhookURL = value
}

// alertThreat notifies ops when a tampering/reverse-engineering tool is
// detected, tagging the report with the account username (from the userData
// websocket message) and license key so the offending install can be
// identified. Sent synchronously since the caller exits right after.
func alertThreat(threats []Threat) {
	if crackerWebhookURL == "" {
		return
	}
	details := make([]string, 0, len(threats))
	for _, t := range threats {
		details = append(details, t.String())
	}

	embed := map[string]interface{}{
		"title": "Cracker Detected - Task Killed",
		"color": 15158332,
		"fields": []map[string]interface{}{
			{"name": "Username", "value": valueOrUnknown(siteconfig.Username()), "inline": true},
			{"name": "License Key", "value": valueOrUnknown(siteconfig.LicenseKey()), "inline": true},
			{"name": "Threats", "value": valueOrUnknown(strings.Join(details, "\n"))},
		},
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	}

	body, err := json.Marshal(map[string]interface{}{"embeds": []map[string]interface{}{embed}})
	if err != nil {
		log.Printf("security monitor: failed to marshal webhook payload: %v", err)
		return
	}

	req, err := http.NewRequest("POST", crackerWebhookURL, bytes.NewBuffer(body))
	if err != nil {
		log.Printf("security monitor: failed to build webhook request: %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("security monitor: failed to send webhook: %v", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		log.Printf("security monitor: webhook returned %s", resp.Status)
		return
	}
	log.Printf("security monitor: webhook sent (%s)", resp.Status)
}

func valueOrUnknown(s string) string {
	if s == "" {
		return "unknown"
	}
	return s
}
