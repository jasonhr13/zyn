package target

import (
	"testing"
	"time"

	"zynbot.app/engine/bot-base/task"
	"zynbot.app/engine/bot-base/task/constants"
	monitorhub "zynbot.app/engine/monitor-hub"
	"zynbot.app/engine/sites"
)

func TestMatchKeysOrdersPriorityFirst(t *testing.T) {
	targetTask := &TargetTask{
		MonitorItems: []sites.Input{
			{Input: "11111111", Quantity: 1},
			{Input: "22222222", Quantity: 1, Priority: true},
			{Input: "33333333", Quantity: 1},
			{Input: "44444444", Quantity: 1, Priority: true},
		},
	}
	got := targetTask.matchKeys()
	want := []string{"22222222", "44444444", "11111111", "33333333"}
	if len(got) != len(want) {
		t.Fatalf("matchKeys() = %#v, want %#v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("matchKeys() = %#v, want %#v", got, want)
		}
	}
}

func TestMatchStockPrefersPriorityWhenBothInStock(t *testing.T) {
	t.Cleanup(func() {
		monitorhub.MarkOutOfStock("Target", "11111111")
		monitorhub.MarkOutOfStock("Target", "22222222")
	})
	first := time.Now().Add(-2 * time.Second)
	second := first.Add(time.Second)
	monitorhub.Default.Publish(monitorhub.StockPing{
		Site: "Target", ProductKey: "11111111", InStock: true, At: first, Name: "first",
	})
	monitorhub.Default.Publish(monitorhub.StockPing{
		Site: "Target", ProductKey: "22222222", InStock: true, At: second, Name: "priority",
	})

	targetTask := &TargetTask{
		MonitorItems: []sites.Input{
			{Input: "11111111", Quantity: 1},
			{Input: "22222222", Quantity: 1, Priority: true},
		},
	}
	ping, ok := targetTask.matchStock(targetTask.matchKeys(), time.Time{})
	if !ok || ping.ProductKey != "22222222" {
		t.Fatalf("matchStock() = %#v ok=%v, want priority TCIN 22222222", ping, ok)
	}
}

func TestShouldAbandonSelectedWhenWatchListDropsTCIN(t *testing.T) {
	targetTask := &TargetTask{
		MonitorItems: []sites.Input{{Input: "22222222", Quantity: 1}},
		RestockTCIN:  "11111111",
		RestockQty:   2,
	}
	reason, ok := targetTask.shouldAbandonSelected()
	if !ok || reason == "" {
		t.Fatalf("shouldAbandonSelected() = %q %v, want abandon", reason, ok)
	}
}

func TestShouldNotAbandonSelectedWhenTCINStillWatched(t *testing.T) {
	targetTask := &TargetTask{
		MonitorItems: []sites.Input{{Input: "11111111", Quantity: 1}, {Input: "22222222", Quantity: 1}},
		RestockTCIN:  "11111111",
	}
	if reason, ok := targetTask.shouldAbandonSelected(); ok {
		t.Fatalf("shouldAbandonSelected() = %q, want keep selection", reason)
	}
}

func TestShouldNotAbandonAfterOrderSubmit(t *testing.T) {
	targetTask := &TargetTask{
		BaseTask:     &task.BaseTask{NextStep: "submit-order"},
		MonitorItems: []sites.Input{{Input: "22222222", Quantity: 1}},
		RestockTCIN:  "11111111",
	}
	if reason, ok := targetTask.shouldAbandonSelected(); ok {
		t.Fatalf("committed checkout abandoned: %q", reason)
	}
	if reason, ok := targetTask.shouldPivotToPriority(); ok {
		t.Fatalf("committed checkout pivoted: %q", reason)
	}
}

func TestShouldPivotToPriorityWhenHigherPriorityInStock(t *testing.T) {
	t.Cleanup(func() {
		monitorhub.MarkOutOfStock("Target", "22222222")
	})
	monitorhub.Default.Publish(monitorhub.StockPing{
		Site: "Target", ProductKey: "22222222", InStock: true, At: time.Now(), Name: "priority",
	})
	targetTask := &TargetTask{
		MonitorItems: []sites.Input{
			{Input: "11111111", Quantity: 1},
			{Input: "22222222", Quantity: 1, Priority: true},
		},
		RestockTCIN: "11111111",
	}
	reason, ok := targetTask.shouldPivotToPriority()
	if !ok || reason == "" {
		t.Fatalf("shouldPivotToPriority() = %q %v, want pivot", reason, ok)
	}
}

func TestShouldNotPivotWhenAlreadyOnPriority(t *testing.T) {
	t.Cleanup(func() {
		monitorhub.MarkOutOfStock("Target", "22222222")
	})
	monitorhub.Default.Publish(monitorhub.StockPing{
		Site: "Target", ProductKey: "22222222", InStock: true, At: time.Now(), Name: "other-priority",
	})
	targetTask := &TargetTask{
		MonitorItems: []sites.Input{
			{Input: "11111111", Quantity: 1, Priority: true},
			{Input: "22222222", Quantity: 1, Priority: true},
		},
		RestockTCIN: "11111111",
	}
	if reason, ok := targetTask.shouldPivotToPriority(); ok {
		t.Fatalf("already-priority selection pivoted: %q", reason)
	}
}

func TestAbandonSelectedProductClearsTCINAndKeepsSignal(t *testing.T) {
	targetTask := &TargetTask{
		BaseTask:     &task.BaseTask{NextStep: "add-to-cart"},
		MonitorItems: []sites.Input{{Input: "22222222", Quantity: 1}},
		RestockTCIN:  "11111111",
		RestockQty:   2,
		StockPing:    monitorhub.StockPing{ProductKey: "11111111", At: time.Now()},
	}
	targetTask.abandonSelectedProduct("SKU removed from watch list")
	if targetTask.RestockTCIN != "" || targetTask.RestockQty != 0 {
		t.Fatalf("abandoned selection was not cleared: tcin=%q qty=%d", targetTask.RestockTCIN, targetTask.RestockQty)
	}
	if targetTask.NextStep != "wait-for-restock" {
		t.Fatalf("abandoned uncarted task next step = %q", targetTask.NextStep)
	}
}

func TestAbandonSelectedProductClearsCartedCheckout(t *testing.T) {
	targetTask := &TargetTask{
		BaseTask: &task.BaseTask{
			NextStep:  "submit-payment",
			TaskState: constants.StatusSteps.Carted,
		},
		MonitorItems: []sites.Input{{Input: "22222222", Quantity: 1, Priority: true}},
		RestockTCIN:  "11111111",
		RestockQty:   2,
	}
	targetTask.abandonSelectedProduct("Switching to priority SKU")
	if targetTask.RestockTCIN != "" {
		t.Fatalf("carted selection was not cleared: %q", targetTask.RestockTCIN)
	}
	if targetTask.NextStep != "clear-cart" {
		t.Fatalf("carted abandon next step = %q, want clear-cart", targetTask.NextStep)
	}
}
