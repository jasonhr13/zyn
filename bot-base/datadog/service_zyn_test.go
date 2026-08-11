//go:build zyn

package datadog

import "testing"

func TestZynServiceName(t *testing.T) {
	if serviceName != "zyn-engine" {
		t.Fatalf("service name = %q", serviceName)
	}
}
