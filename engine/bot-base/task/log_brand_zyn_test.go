//go:build zyn

package task

import "testing"

func TestZynTaskLogCipherKey(t *testing.T) {
	if logCipherKey != "Zyn-Task-Log-v1" {
		t.Fatalf("task log cipher key = %q", logCipherKey)
	}
}
