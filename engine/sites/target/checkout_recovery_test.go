package target

import (
	"errors"
	"testing"
	"time"
)

func TestIsCardPaymentExistsError(t *testing.T) {
	if !isCardPaymentExistsError(errors.New("submit-payment (CARD_PAYMENT_EXISTS)")) {
		t.Fatal("expected CARD_PAYMENT_EXISTS error to be recognized")
	}
	if isCardPaymentExistsError(errors.New("submit-payment (400)")) {
		t.Fatal("did not expect generic payment error to be recognized")
	}
}

func TestPaymentInstructionID(t *testing.T) {
	instructions := []PaymentInstructionsBlock{
		{PaymentInstId: ""},
		{PaymentInstId: " payment-123 "},
	}
	if got := paymentInstructionID(instructions); got != "payment-123" {
		t.Fatalf("paymentInstructionID() = %q, want %q", got, "payment-123")
	}
}

func TestThrottleFallbackLease(t *testing.T) {
	var lease throttleFallbackLease
	now := time.Unix(1_700_000_000, 0)

	if !lease.claim("task-a", now) {
		t.Fatal("expected first task to claim local fallback")
	}
	if lease.claim("task-b", now.Add(localThrottleFallbackLeaseDuration-time.Second)) {
		t.Fatal("expected a different task to be blocked during the lease")
	}
	if !lease.claim("task-a", now.Add(time.Second)) {
		t.Fatal("expected the lease owner to be allowed to reclaim")
	}
	if !lease.claim("task-b", now.Add(localThrottleFallbackLeaseDuration+2*time.Second)) {
		t.Fatal("expected a different task to claim after the lease expires")
	}
}
