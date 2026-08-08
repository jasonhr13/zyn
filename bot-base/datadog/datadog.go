package datadog

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/PolarAIO/Polar-AIO/backend/bot-base/safego"
	"github.com/PolarAIO/Polar-AIO/backend/bot-base/siteconfig"
)

var (
	clientToken string
	site        string
)

var httpClient = &http.Client{Timeout: 10 * time.Second}

func Init(token, ddSite string) {
	clientToken = token
	site = ddSite
}

func Info(message string, attrs map[string]interface{}) {
	safego.Go(func() { send("info", message, attrs) })
}

func send(status, message string, attrs map[string]interface{}) {
	if clientToken == "" || site == "" {
		return
	}

	payload := map[string]interface{}{
		"message":  message,
		"ddsource": "go",
		"service":  "polar-backend",
		"status":   status,
		"userkey":  siteconfig.LicenseKey(),
	}
	for k, v := range attrs {
		payload[k] = v
	}

	body, err := json.Marshal(payload)
	if err != nil {
		log.Printf("datadog: marshal error: %v", err)
		return
	}

	url := "https://http-intake.logs." + site + "/api/v2/logs"
	req, err := http.NewRequest("POST", url, bytes.NewBuffer(body))
	if err != nil {
		log.Printf("datadog: new request error: %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("DD-API-KEY", clientToken)

	resp, err := httpClient.Do(req)
	if err != nil {
		log.Printf("datadog: request failed: %v", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		log.Printf("datadog: unexpected status %s", resp.Status)
	}
}
