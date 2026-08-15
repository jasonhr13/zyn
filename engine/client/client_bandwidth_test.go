package client

import (
	"testing"

	"github.com/bogdanfinn/tls-client/bandwidth"
)

func TestBandwidthTrackerIsEnabledOnlyForMonitorClients(t *testing.T) {
	regular, err := CreateNewTLSClient("")
	if err != nil {
		t.Fatalf("CreateNewTLSClient: %v", err)
	}
	if _, ok := regular.GetBandwidthTracker().(*bandwidth.NopeTracker); !ok {
		t.Fatalf("regular tracker = %T, want *bandwidth.NopeTracker", regular.GetBandwidthTracker())
	}

	monitor, err := CreateNewMonitorTLSClient("")
	if err != nil {
		t.Fatalf("CreateNewMonitorTLSClient: %v", err)
	}
	if _, ok := monitor.GetBandwidthTracker().(*bandwidth.Tracker); !ok {
		t.Fatalf("monitor tracker = %T, want *bandwidth.Tracker", monitor.GetBandwidthTracker())
	}
}
