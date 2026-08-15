package walmart

import (
	"errors"
	"testing"
)

func TestIsPXSolverAuthError(t *testing.T) {
	for _, message := range []string{
		"No valid Auth token provided!",
		"invalid API key",
		"request unauthorized",
	} {
		if !isPXSolverAuthError(errors.New(message)) {
			t.Fatalf("expected solver credential error for %q", message)
		}
	}
	if isPXSolverAuthError(errors.New("temporary upstream timeout")) {
		t.Fatal("temporary solver failure was classified as a credential error")
	}
	if isPXSolverAuthError(nil) {
		t.Fatal("nil was classified as a credential error")
	}
}
