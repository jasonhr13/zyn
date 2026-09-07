package target

import (
	"errors"
	"testing"

	"zynbot.app/engine/bot-base/task"
)

func fillerHistoryLine(tcin, status string, cancellable bool, lineID, lineKey string, qty int) OrderHistoryLine {
	return OrderHistoryLine{
		OrderLineKey:     lineKey,
		OrderLineID:      lineID,
		OriginalQuantity: qty,
		Item:             OrderHistoryItem{TCIN: tcin},
		FulfillmentSpec: OrderHistoryFulfillment{
			Status: OrderHistoryStatus{
				Key:        status,
				Operations: OrderHistoryStatusOps{IsCancellable: cancellable},
			},
		},
	}
}

func TestFindFillerOrderUsesCancellableLineFromThisCheckout(t *testing.T) {
	targetTask := &TargetTask{
		BaseTask:        &task.BaseTask{UseFillerItem: true},
		OrderNumber:     "ord-real",
		CheckoutData:    OrderBlock{ReferenceId: "ref-real"},
		FillerOrderRefs: []string{"ord-filler"},
		OrderHistory: []OrderHistoryEntry{{
			OrderNumber: "ord-filler",
			OrderLines: []OrderHistoryLine{
				fillerHistoryLine(FillerItem, "PENDING", true, "line-1", "key-1", 1),
			},
		}},
	}
	if !targetTask.FindFillerOrder() {
		t.Fatal("expected a cancellable filler line")
	}
	if !targetTask.NeedCancelFiller || len(targetTask.FillerOrders) != 1 {
		t.Fatalf("NeedCancelFiller=%v orders=%d", targetTask.NeedCancelFiller, len(targetTask.FillerOrders))
	}
	got := targetTask.FillerOrders[0]
	if got.ReferenceId != "ord-filler" || got.OrderLineId != "line-1" || got.OrderLineKey != "key-1" {
		t.Fatalf("filler order = %#v", got)
	}
}

func TestFindFillerOrderIgnoresFillerOnAnotherCheckout(t *testing.T) {
	targetTask := &TargetTask{
		BaseTask:        &task.BaseTask{UseFillerItem: true},
		OrderNumber:     "ord-real",
		FillerOrderRefs: []string{"ord-this"},
		OrderHistory: []OrderHistoryEntry{{
			OrderNumber: "ord-other",
			OrderLines: []OrderHistoryLine{
				fillerHistoryLine(FillerItem, "PENDING", true, "line-other", "key-other", 1),
			},
		}},
	}
	if targetTask.FindFillerOrder() {
		t.Fatal("must not cancel a filler line from another checkout")
	}
	if !targetTask.FillerNeedsRetry {
		t.Fatal("this checkout's filler is still pending discovery")
	}
}

func TestFindFillerOrderRetriesUntilCancellable(t *testing.T) {
	targetTask := &TargetTask{
		BaseTask:        &task.BaseTask{UseFillerItem: true},
		FillerOrderRefs: []string{"ord-filler"},
		OrderHistory: []OrderHistoryEntry{{
			OrderNumber: "ord-filler",
			OrderLines: []OrderHistoryLine{
				fillerHistoryLine(FillerItem, "PROCESSING", false, "line-1", "line-1", 1),
			},
		}},
	}
	if targetTask.FindFillerOrder() {
		t.Fatal("uncancellable filler must not go to cancel-filler yet")
	}
	if !targetTask.FillerNeedsRetry {
		t.Fatal("expected a discovery retry")
	}
}

func TestFindFillerOrderTreatsCanceledStatusAsDone(t *testing.T) {
	targetTask := &TargetTask{
		BaseTask:        &task.BaseTask{UseFillerItem: true},
		FillerOrderRefs: []string{"ord-filler"},
		OrderHistory: []OrderHistoryEntry{{
			OrderNumber: "ord-filler",
			OrderLines: []OrderHistoryLine{
				fillerHistoryLine(FillerItem, "Cancelled", false, "line-1", "key-1", 1),
			},
		}},
	}
	if targetTask.FindFillerOrder() {
		t.Fatal("already-canceled filler should not be cancelled again")
	}
	if !targetTask.CanceledFillerItem {
		t.Fatal("expected CanceledFillerItem")
	}
	if targetTask.FillerNeedsRetry {
		t.Fatal("canceled filler should not keep polling")
	}
}

func TestFindFillerOrderRetriesWhenHistoryOmitsFiller(t *testing.T) {
	targetTask := &TargetTask{
		BaseTask:        &task.BaseTask{UseFillerItem: true},
		OrderNumber:     "ord-real",
		FillerOrderRefs: []string{"ord-filler"},
		OrderHistory:    []OrderHistoryEntry{{OrderNumber: "ord-real"}},
	}
	if targetTask.FindFillerOrder() || targetTask.CanceledFillerItem {
		t.Fatal("missing filler line should stay pending")
	}
	if !targetTask.FillerNeedsRetry {
		t.Fatal("expected a discovery retry while Target finishes processing")
	}
}

func TestPendingFillerRetryCapsOutToCheckout(t *testing.T) {
	targetTask := &TargetTask{BaseTask: &task.BaseTask{NextStep: "get-orders"}}
	for i := 1; i < fillerOrderRetryLimit; i++ {
		targetTask.pendingFillerRetry()
		if targetTask.NextStep != "get-orders" {
			t.Fatalf("attempt %d NextStep = %q, want get-orders", i, targetTask.NextStep)
		}
		if targetTask.Error == nil || targetTask.Error.Error() != fillerPendingError {
			t.Fatalf("attempt %d Error = %v", i, targetTask.Error)
		}
		targetTask.Error = nil
	}
	targetTask.pendingFillerRetry()
	if targetTask.NextStep != "checkout" {
		t.Fatalf("NextStep = %q, want checkout after %d attempts", targetTask.NextStep, fillerOrderRetryLimit)
	}
	if targetTask.Error != nil {
		t.Fatalf("Error = %v, want nil after retry cap", targetTask.Error)
	}
}

func TestRemoveFillerItemEmptyLineIdIsPending(t *testing.T) {
	targetTask := &TargetTask{
		BaseTask:     &task.BaseTask{NextStep: "cancel-filler"},
		FillerOrders: []*FillerOrderState{{ReferenceId: "ord-filler"}},
	}
	targetTask.RemoveFillerItem()
	if targetTask.CanceledFillerItem {
		t.Fatal("empty line id must not count as canceled")
	}
	if targetTask.NextStep != "get-orders" {
		t.Fatalf("NextStep = %q, want get-orders", targetTask.NextStep)
	}
	if targetTask.Error == nil || targetTask.Error.Error() != fillerPendingError {
		t.Fatalf("Error = %v, want pending discovery", targetTask.Error)
	}
}

func TestHandleErrorsFillerPendingReturnsToGetOrders(t *testing.T) {
	targetTask := cancelledTargetTask("cancel-filler", errors.New(fillerPendingError))
	targetTask.UseFillerItem = true
	if !targetTask.HandleErrors("cancel-filler") {
		t.Fatal("expected HandleErrors to report an error")
	}
	if targetTask.NextStep != "get-orders" {
		t.Fatalf("NextStep = %q, want get-orders", targetTask.NextStep)
	}
}

func TestResetCheckoutStateClearsFillerPolling(t *testing.T) {
	targetTask := &TargetTask{
		BaseTask:           &task.BaseTask{},
		FillerOrderRefs:    []string{"ord-filler"},
		OrderHistory:       []OrderHistoryEntry{{OrderNumber: "ord-filler"}},
		FillerOrderRetries: 6,
		FillerNeedsRetry:   true,
		NeedCancelFiller:   true,
		CanceledFillerItem: true,
	}
	targetTask.resetCheckoutState()
	if targetTask.FillerOrderRetries != 0 || targetTask.FillerNeedsRetry || targetTask.NeedCancelFiller || targetTask.CanceledFillerItem {
		t.Fatalf("polling flags survived reset: %+v", targetTask)
	}
	if len(targetTask.FillerOrderRefs) != 0 || len(targetTask.OrderHistory) != 0 {
		t.Fatal("filler history survived reset")
	}
}
