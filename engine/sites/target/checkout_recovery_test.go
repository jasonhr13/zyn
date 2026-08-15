package target

import (
	"errors"
	"testing"
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

func TestDcoRateLimitSleepMs(t *testing.T) {
	for i := 0; i < 200; i++ {
		got := dcoRateLimitSleepMs()
		if got < dcoRateLimitSleepMinMs || got > dcoRateLimitSleepMinMs+dcoRateLimitSleepSpanMs-1 {
			t.Fatalf("dcoRateLimitSleepMs() = %d, want %d-%d", got, dcoRateLimitSleepMinMs, dcoRateLimitSleepMinMs+dcoRateLimitSleepSpanMs-1)
		}
	}
}
