package frontend

import (
	"context"
	"testing"
	"time"
)

func TestNormalizeStockPing(t *testing.T) {
	ping, ok := normalizeStockPing(StockPingMessage{
		Site:       "target",
		ProductKey: " 12345 ",
		Name:       "Product",
		Price:      12.99,
		StockLevel: 4,
		InStock:    true,
		From:       "discord-monitor",
	})
	if !ok {
		t.Fatal("valid ping rejected")
	}
	if ping.Site != "Target" || ping.ProductKey != "12345" || !ping.InStock || ping.At.IsZero() {
		t.Fatalf("normalized ping = %#v", ping)
	}
	if _, ok := normalizeStockPing(StockPingMessage{Site: "Target"}); ok {
		t.Fatal("ping without product key accepted")
	}
}

func TestRequestHyperRejectsUnknownOperation(t *testing.T) {
	if _, err := RequestHyper(context.Background(), "pc-1", "arbitrary", map[string]any{}); err == nil {
		t.Fatal("unknown Hyper operation accepted")
	}
}

func TestDeliverHyperResponseRequiresMatchingTaskAndSite(t *testing.T) {
	ch := make(chan HyperResponseMessage, 1)
	hyperPendingMu.Lock()
	hyperPending = map[string]hyperWaiter{"request-1": {taskID: "pc-1", ch: ch}}
	hyperPendingMu.Unlock()
	t.Cleanup(func() {
		hyperPendingMu.Lock()
		hyperPending = map[string]hyperWaiter{}
		hyperPendingMu.Unlock()
	})

	deliverHyperResponse(HyperResponseMessage{
		RequestID: "request-1", TaskID: "target-1", Site: "Pokemon Center US", Status: 200,
	})
	deliverHyperResponse(HyperResponseMessage{
		RequestID: "request-1", TaskID: "pc-1", Site: "Target", Status: 200,
	})
	select {
	case <-ch:
		t.Fatal("mismatched Hyper response was delivered")
	default:
	}

	want := HyperResponseMessage{
		RequestID: "request-1", TaskID: "pc-1", Site: "Pokemon Center US", Status: 201, Body: "{}",
	}
	deliverHyperResponse(want)
	select {
	case got := <-ch:
		if got != want {
			t.Fatalf("delivered response = %#v, want %#v", got, want)
		}
	case <-time.After(time.Second):
		t.Fatal("matching Hyper response was not delivered")
	}
}

func TestFailPendingHyperReleasesEveryWaiter(t *testing.T) {
	first := make(chan HyperResponseMessage, 1)
	second := make(chan HyperResponseMessage, 1)
	hyperPendingMu.Lock()
	hyperPending = map[string]hyperWaiter{
		"request-1": {taskID: "pc-1", ch: first},
		"request-2": {taskID: "pc-2", ch: second},
	}
	hyperPendingMu.Unlock()
	failPendingHyper("disconnected")

	for name, ch := range map[string]chan HyperResponseMessage{"request-1": first, "request-2": second} {
		select {
		case got := <-ch:
			if got.RequestID != name || got.Error != "disconnected" || got.Status != 0 {
				t.Fatalf("%s failure = %#v", name, got)
			}
		case <-time.After(time.Second):
			t.Fatalf("%s waiter was not released", name)
		}
	}
}
