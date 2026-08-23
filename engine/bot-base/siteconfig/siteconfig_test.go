package siteconfig

import (
	"encoding/json"
	"testing"
)

func TestFrontendTargetSettingsDoNotReplaceOtherConfig(t *testing.T) {
	mu.RLock()
	original := cfg
	mu.RUnlock()
	t.Cleanup(func() { Set(original) })

	Set(Config{HyperApiKey: "hyper", LucaApiKey: "luca"})
	SetShapeMethod(" Harvester ")

	if got := ShapeMethod(); got != "Harvester" {
		t.Fatalf("ShapeMethod() = %q", got)
	}
	if HyperAPIKey() != "hyper" || LucaAPIKey() != "luca" {
		t.Fatal("setting frontend Target options replaced API key config")
	}

	SetLucaAPIKey("  replacement  ")
	if LucaAPIKey() != "replacement" {
		t.Fatal("Luca API key setter did not normalize the replacement")
	}

	SetLucaAPIKey("")
	SetLucaAPIKey("   ")
	if LucaAPIKey() != "replacement" {
		t.Fatal("empty frontend send-configs wiped the Polar Luca API key")
	}

	Set(Config{Sites: []Site{{Name: "Walmart"}}})
	if LucaAPIKey() != "replacement" {
		t.Fatal("Polar siteConfigs without lucaApiKey wiped the existing key")
	}
}

func TestLucaApiKeyJSONAliases(t *testing.T) {
	var cfg Config
	if err := json.Unmarshal([]byte(`{"luca_api_key":" aliased "}`), &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.LucaApiKey != "aliased" {
		t.Fatalf("LucaApiKey = %q", cfg.LucaApiKey)
	}
}
