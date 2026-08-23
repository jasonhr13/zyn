package siteconfig

import (
	"encoding/json"
	"strings"
	"sync"
	"time"
)

type Config struct {
	HyperApiKey string `json:"hyperApiKey"`
	LucaApiKey  string `json:"lucaApiKey"`
	ShapeMethod string `json:"shapeMethod"`
	Sites       []Site `json:"sites"`
}

func (c *Config) UnmarshalJSON(data []byte) error {
	type alias Config
	var parsed alias
	if err := json.Unmarshal(data, &parsed); err != nil {
		return err
	}
	*c = Config(parsed)
	if strings.TrimSpace(c.LucaApiKey) != "" {
		return nil
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil
	}
	for _, key := range []string{"lucaApiKey", "luca_api_key", "lucaKey", "luca"} {
		value, ok := raw[key]
		if !ok {
			continue
		}
		var text string
		if json.Unmarshal(value, &text) == nil && strings.TrimSpace(text) != "" {
			c.LucaApiKey = strings.TrimSpace(text)
			break
		}
	}
	return nil
}

type Site struct {
	Name   string `json:"name"`
	Locked bool   `json:"locked"`
}

var (
	mu         sync.RWMutex
	cfg        Config
	licenseKey string
	username   string
)

func SetLicenseKey(key string) {
	mu.Lock()
	defer mu.Unlock()
	licenseKey = key
}

func LicenseKey() string {
	mu.RLock()
	defer mu.RUnlock()
	return licenseKey
}

func SetUsername(name string) {
	mu.Lock()
	defer mu.Unlock()
	username = strings.TrimSpace(name)
}

func Username() string {
	mu.RLock()
	defer mu.RUnlock()
	return username
}

func Set(c Config) {
	mu.Lock()
	defer mu.Unlock()
	if strings.TrimSpace(c.LucaApiKey) == "" {
		c.LucaApiKey = cfg.LucaApiKey
	}
	if strings.TrimSpace(c.HyperApiKey) == "" {
		c.HyperApiKey = cfg.HyperApiKey
	}
	cfg = c
}

func HyperAPIKey() string {
	mu.RLock()
	defer mu.RUnlock()
	return cfg.HyperApiKey
}

func LucaAPIKey() string {
	mu.RLock()
	defer mu.RUnlock()
	return cfg.LucaApiKey
}

// WaitForLucaAPIKey returns the solver key once it lands, or empty if timeout
// elapses. Zyn delivers it through send-configs after Cloudflare captures Polar
// siteConfigs; the engine does not dial Polar.
func WaitForLucaAPIKey(timeout time.Duration) string {
	if key := LucaAPIKey(); key != "" || timeout <= 0 {
		return key
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		time.Sleep(200 * time.Millisecond)
		if key := LucaAPIKey(); key != "" {
			return key
		}
	}
	return LucaAPIKey()
}

func SetLucaAPIKey(key string) {
	trimmed := strings.TrimSpace(key)
	if trimmed == "" {
		return
	}
	mu.Lock()
	defer mu.Unlock()
	cfg.LucaApiKey = trimmed
}

func SetShapeMethod(method string) {
	mu.Lock()
	defer mu.Unlock()
	cfg.ShapeMethod = strings.TrimSpace(method)
}

func ShapeMethod() string {
	mu.RLock()
	defer mu.RUnlock()
	return strings.TrimSpace(cfg.ShapeMethod)
}

func IsLocked(site string) bool {
	mu.RLock()
	defer mu.RUnlock()
	for _, s := range cfg.Sites {
		if strings.EqualFold(s.Name, site) {
			return s.Locked
		}
	}
	return false
}
