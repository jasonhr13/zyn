//go:build zyn

package target

import "testing"

func TestZynTargetShapeEnvironmentName(t *testing.T) {
	if targetShapeURLEnv != "ZYN_TARGET_SHAPE_URL" {
		t.Fatalf("target shape environment name = %q", targetShapeURLEnv)
	}
}
