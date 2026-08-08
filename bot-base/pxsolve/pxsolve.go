package pxsolve

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/PolarAIO/Polar-AIO/backend/bot-base/siteconfig"
)

const checkURL = "https://polar-wss-production.up.railway.app/px-solve/check"

var httpClient = &http.Client{Timeout: 10 * time.Second}

type checkResponse struct {
	Allowed bool `json:"allowed"`
}

func CheckAndIncrement() (bool, error) {
	key := siteconfig.LicenseKey()
	if key == "" {
		return true, fmt.Errorf("no license key configured")
	}

	reqURL := fmt.Sprintf("%s?key=%s", checkURL, url.QueryEscape(key))
	resp, err := httpClient.Get(reqURL)
	if err != nil {
		return true, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized {
		return false, fmt.Errorf("px-solve check unauthorized")
	}
	var body checkResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return true, err
	}

	return body.Allowed, nil
}
