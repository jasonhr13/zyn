package siteconfig

import "testing"

func TestThrottleFallbackGroup(t *testing.T) {
	mu.RLock()
	original := cfg
	mu.RUnlock()
	t.Cleanup(func() { Set(original) })

	Set(Config{ThrottleFallbackGroup: "  Checkout Fallback  "})
	if got := ThrottleFallbackGroup(); got != "Checkout Fallback" {
		t.Fatalf("ThrottleFallbackGroup() = %q, want %q", got, "Checkout Fallback")
	}
}

func TestFrontendTargetSettingsDoNotReplaceOtherConfig(t *testing.T) {
	mu.RLock()
	original := cfg
	mu.RUnlock()
	t.Cleanup(func() { Set(original) })

	Set(Config{HyperApiKey: "hyper", LucaApiKey: "luca"})
	SetShapeMethod(" Harvester ")
	SetThrottleFallbackGroup(" Local ")

	if got := ShapeMethod(); got != "Harvester" {
		t.Fatalf("ShapeMethod() = %q", got)
	}
	if got := ThrottleFallbackGroup(); got != "Local" {
		t.Fatalf("ThrottleFallbackGroup() = %q", got)
	}
	if HyperAPIKey() != "hyper" || LucaAPIKey() != "luca" {
		t.Fatal("setting frontend Target options replaced API key config")
	}
}
