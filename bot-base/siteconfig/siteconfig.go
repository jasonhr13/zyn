package siteconfig

import (
	"strings"
	"sync"
)

type Config struct {
	HyperApiKey string `json:"hyperApiKey"`
	LucaApiKey  string `json:"lucaApiKey"`
	Sites       []Site `json:"sites"`
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
