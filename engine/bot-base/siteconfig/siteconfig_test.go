package siteconfig

import "testing"

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
}
