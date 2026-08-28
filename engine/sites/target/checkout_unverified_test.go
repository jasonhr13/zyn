package target

import (
	"errors"
	"testing"

	"zynbot.app/engine/bot-base/task"
)

func submittedTask(err error) *TargetTask {
	t := cancelledTargetTask("check-order", err)
	t.CheckoutData = OrderBlock{ReferenceId: "ref-1", OrderID: "ord-1"}
	return t
}

func TestShouldAssumeCheckoutAfterRetries(t *testing.T) {
	task := submittedTask(errors.New("check-order (503)"))
	for i := 1; i < checkOrderVerifyRetries; i++ {
		if task.shouldAssumeCheckout(task.Error) {
			t.Fatalf("attempt %d should still retry", i)
		}
	}
	if !task.shouldAssumeCheckout(task.Error) {
		t.Fatal("expected unverified success after the verify retry cap")
	}
}

func TestShouldAssumeCheckoutRequiresSubmittedOrder(t *testing.T) {
	task := cancelledTargetTask("check-order", errors.New("check-order (503)"))
	if task.shouldAssumeCheckout(task.Error) {
		t.Fatal("must not assume success without a submit-order reference")
	}
}

func TestShouldAssumeCheckoutIgnoresConfirmedDecline(t *testing.T) {
	task := submittedTask(errors.New("check-order (503)"))
	task.Decline = true
	task.FraudStatus = "DECLINED"
	task.CheckOrderAttempts = checkOrderVerifyRetries
	if task.shouldAssumeCheckout(task.Error) {
		t.Fatal("must not override a confirmed post_orders decline")
	}
}

func TestAssumeCheckoutUsesSubmitOrderId(t *testing.T) {
	task := submittedTask(errors.New("status not found"))
	task.assumeCheckout()
	if !task.Checkout || task.Decline {
		t.Fatalf("Checkout=%v Decline=%v", task.Checkout, task.Decline)
	}
	if task.FraudStatus != "UNVERIFIED" {
		t.Fatalf("FraudStatus = %q, want UNVERIFIED", task.FraudStatus)
	}
	if task.OrderNumber != "ord-1" {
		t.Fatalf("OrderNumber = %q, want submit-order id", task.OrderNumber)
	}
	if task.Error != nil {
		t.Fatalf("Error = %v, want nil", task.Error)
	}
}

func TestHandleErrorsCheckOrder401RetriesWhenSubmitted(t *testing.T) {
	task := submittedTask(errors.New("out of stock (check)"))
	if !task.HandleErrors("check-order") {
		t.Fatal("expected HandleErrors to report an error")
	}
	if task.NextStep != "check-order" {
		t.Fatalf("NextStep = %q, want check-order retry", task.NextStep)
	}
}

func TestHandleErrorsCheckOrder401RestocksWithoutSubmit(t *testing.T) {
	task := cancelledTargetTask("check-order", errors.New("out of stock (check)"))
	if !task.HandleErrors("check-order") {
		t.Fatal("expected HandleErrors to report an error")
	}
	if task.NextStep == "check-order" {
		t.Fatal("401 without a submitted order should leave check-order")
	}
}

func TestIsCheckOrderVerifyFailure(t *testing.T) {
	if !isCheckOrderVerifyFailure(errors.New("check-order (502)")) {
		t.Fatal("502 should be a verify failure")
	}
	if !isCheckOrderVerifyFailure(errors.New("status not found")) {
		t.Fatal("empty fraud status should be a verify failure")
	}
	if !isCheckOrderVerifyFailure(errors.New("Proxy Failed")) {
		t.Fatal("proxy failure should be a verify failure")
	}
	if isCheckOrderVerifyFailure(nil) {
		t.Fatal("nil is not a verify failure")
	}
}

func TestResetCheckoutStateClearsCheckOrderAttempts(t *testing.T) {
	task := &TargetTask{
		BaseTask:           &task.BaseTask{},
		CheckOrderAttempts: 6,
		CheckoutData:       OrderBlock{ReferenceId: "ref-1"},
	}
	task.resetCheckoutState()
	if task.CheckOrderAttempts != 0 {
		t.Fatalf("CheckOrderAttempts = %d, want 0", task.CheckOrderAttempts)
	}
}
