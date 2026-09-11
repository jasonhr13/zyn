package target

import (
	"context"
	"errors"
	"testing"

	"zynbot.app/engine/bot-base/task"
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

func TestIsDcoRateLimit(t *testing.T) {
	if !isDcoRateLimit("DCO_RATE_LIMITED") {
		t.Fatal("expected DCO_RATE_LIMITED to match")
	}
	if isDcoRateLimit("cart-429") {
		t.Fatal("generic cart-429 is not a DCO limiter")
	}
	if isDcoRateLimit("Shape Block (Cart)") {
		t.Fatal("Shape 401 is not a DCO limiter")
	}
}

func TestShouldSwapProxyOn429(t *testing.T) {
	if !shouldSwapProxyOn429("add-to-cart") {
		t.Fatal("generic ATC 429 should still rotate proxy")
	}
	if !shouldSwapProxyOn429("login") {
		t.Fatal("login 429 should still rotate proxy")
	}
	for _, step := range []string{"submit-payment", "submit-order", "get-cart", "oos-check-cart", "check-order"} {
		if shouldSwapProxyOn429(step) {
			t.Fatalf("%s 429 must not auto-swap a live cart", step)
		}
	}
}

func TestKeepShapeAfterATCError(t *testing.T) {
	dco := cancelledTargetTask("add-to-cart", errors.New("DCO_RATE_LIMITED"))
	dco.CheckoutRateLimitCount = 1
	if !keepShapeAfterATCError(dco) {
		t.Fatal("ATC DCO must keep the current Shape cookie")
	}
	dco.CheckoutRateLimitCount = checkoutRateLimitRetries
	if !keepShapeAfterATCError(dco) {
		t.Fatal("the fifth DCO retry should still keep the cookie")
	}
	dco.CheckoutRateLimitCount = checkoutRateLimitRetries + 1
	if keepShapeAfterATCError(dco) {
		t.Fatal("DCO past the cap should mint a new Shape cookie")
	}
	if keepShapeAfterATCError(cancelledTargetTask("add-to-cart", errors.New("cart-429"))) {
		t.Fatal("generic ATC 429 should still mint a new Shape cookie")
	}
	if keepShapeAfterATCError(cancelledTargetTask("add-to-cart", errors.New("Shape Block (Cart)"))) {
		t.Fatal("Shape block must still rotate the cookie")
	}
}

func cancelledTargetTask(nextStep string, err error) *TargetTask {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	return &TargetTask{
		BaseTask: &task.BaseTask{
			TaskContext: &task.BaseContext{CTX: ctx, Cancel: cancel},
			NextStep:    nextStep,
			Error:       err,
			ProxyGroup:  "Local",
		},
	}
}

func TestHandleErrorsATCDcoKeepsStep(t *testing.T) {
	task := cancelledTargetTask("add-to-cart", errors.New("DCO_RATE_LIMITED"))
	if !task.HandleErrors("add-to-cart") {
		t.Fatal("expected HandleErrors to report an error")
	}
	if task.NextStep != "add-to-cart" {
		t.Fatalf("NextStep = %q, want add-to-cart", task.NextStep)
	}
	if task.CheckoutRateLimitCount != 1 {
		t.Fatalf("CheckoutRateLimitCount = %d, want 1", task.CheckoutRateLimitCount)
	}
	if !keepShapeAfterATCError(task) {
		t.Fatal("checkout.go should skip get-shape after ATC DCO")
	}
}

func TestHandleErrorsATCDcoRotatesAfterCap(t *testing.T) {
	task := cancelledTargetTask("add-to-cart", errors.New("DCO_RATE_LIMITED"))
	for i := 0; i < checkoutRateLimitRetries; i++ {
		task.Error = errors.New("DCO_RATE_LIMITED")
		task.NextStep = "add-to-cart"
		if !task.HandleErrors("add-to-cart") {
			t.Fatal("expected HandleErrors to report an error")
		}
		if !keepShapeAfterATCError(task) {
			t.Fatalf("retry %d should keep Shape", i+1)
		}
	}
	task.Error = errors.New("DCO_RATE_LIMITED")
	task.NextStep = "add-to-cart"
	if !task.HandleErrors("add-to-cart") {
		t.Fatal("expected HandleErrors to report an error")
	}
	if keepShapeAfterATCError(task) {
		t.Fatal("retry after the cap should get a new Shape cookie")
	}
}

func TestHandleErrorsSubmitOrder429DoesNotChangeStep(t *testing.T) {
	task := cancelledTargetTask("submit-order", errors.New("submit-order (429)"))
	if !task.HandleErrors("submit-order") {
		t.Fatal("expected HandleErrors to report an error")
	}
	if task.NextStep != "submit-order" {
		t.Fatalf("NextStep = %q, want submit-order", task.NextStep)
	}
}

func TestHandleErrorsShapeBlockCartStillRotates(t *testing.T) {
	task := cancelledTargetTask("add-to-cart", errors.New("Shape Block (Cart)"))
	task.ShapeHeaders = ShapeHeaders{UserAgent: "keep"}
	task.ShapeProxy = "http://dead-sticky:8000"
	task.ShapeMethod = "extension"
	task.ShapeCreatedAt = 1
	if !task.HandleErrors("add-to-cart") {
		t.Fatal("expected HandleErrors to report an error")
	}
	if task.ShapeBlockCount != 1 {
		t.Fatalf("ShapeBlockCount = %d, want 1", task.ShapeBlockCount)
	}
	if task.NextStep != "get-shape" {
		t.Fatalf("NextStep = %q, want get-shape", task.NextStep)
	}
	if task.StepAfterSolve != "add-to-cart" {
		t.Fatalf("StepAfterSolve = %q, want add-to-cart", task.StepAfterSolve)
	}
	if task.ShapeProxy != "" || task.ShapeMethod != "" || task.ShapeCreatedAt != 0 || task.shapeOK() {
		t.Fatal("Shape block must discard the dead cookie and harvest IP")
	}
	if keepShapeAfterATCError(task) {
		t.Fatal("Shape block must not keep the dead cookie")
	}
}

func TestHandleErrorsShapeBlockCartDoesNotParkOnThird(t *testing.T) {
	task := cancelledTargetTask("add-to-cart", errors.New("Shape Block (Cart)"))
	for i := 1; i <= 3; i++ {
		task.Error = errors.New("Shape Block (Cart)")
		task.NextStep = "add-to-cart"
		task.ShapeProxy = "http://dead-sticky:8000"
		if !task.HandleErrors("add-to-cart") {
			t.Fatal("expected HandleErrors to report an error")
		}
		if task.NextStep != "get-shape" {
			t.Fatalf("retry %d NextStep = %q, want get-shape", i, task.NextStep)
		}
		if task.StepAfterSolve != "add-to-cart" {
			t.Fatalf("retry %d StepAfterSolve = %q, want add-to-cart", i, task.StepAfterSolve)
		}
		if task.ShapeProxy != "" {
			t.Fatalf("retry %d left the dead harvest IP in place", i)
		}
	}
	if task.ShapeBlockCount != 3 {
		t.Fatalf("ShapeBlockCount = %d, want 3", task.ShapeBlockCount)
	}
}

func TestHandleErrorsShapeBlockLoginRotatesImmediately(t *testing.T) {
	task := cancelledTargetTask("login", errors.New("Shape Block (Login)"))
	task.ShapeProxy = "http://dead-sticky:8000"
	if !task.HandleErrors("login") {
		t.Fatal("expected HandleErrors to report an error")
	}
	if task.NextStep != "get-shape" {
		t.Fatalf("NextStep = %q, want get-shape", task.NextStep)
	}
	if task.StepAfterSolve != "login" {
		t.Fatalf("StepAfterSolve = %q, want login", task.StepAfterSolve)
	}
	if task.ShapeProxy != "" {
		t.Fatal("login Shape block must discard the dead harvest IP")
	}
	task.Error = errors.New("Shape Block (Login)")
	task.NextStep = "login"
	task.ShapeProxy = "http://dead-sticky:8000"
	task.HandleErrors("login")
	task.Error = errors.New("Shape Block (Login)")
	task.NextStep = "login"
	if !task.HandleErrors("login") {
		t.Fatal("expected HandleErrors to report an error")
	}
	if task.NextStep != "get-shape" {
		t.Fatalf("third login block NextStep = %q, want get-shape", task.NextStep)
	}
	if task.ShapeBlockCount != 3 {
		t.Fatalf("ShapeBlockCount = %d, want 3", task.ShapeBlockCount)
	}
}
