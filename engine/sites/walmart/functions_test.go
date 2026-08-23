package walmart

import (
	"testing"

	"zynbot.app/engine/bot-base/task"
	"zynbot.app/engine/sites"
)

func TestPlaceholderWatchItemsWaitForInput(t *testing.T) {
	wt := &WalmartTask{BaseTask: &task.BaseTask{}}
	applyWatchItems(wt, []sites.Item{{MonitorInput: "placeholder", Quantity: 1}})
	if len(wt.WatchItems) != 1 || !wt.WatchItems[0].Placeholder {
		t.Fatalf("placeholder was not kept as a watch item: %+v", wt.WatchItems)
	}
	if parsePidFromInput("placeholder") != "" {
		t.Fatal("placeholder must not be treated as an item ID")
	}
	if wt.hasDirectOfferInput() {
		t.Fatal("placeholder must not ATC immediately")
	}
	if !wt.waitingForInput() {
		t.Fatal("placeholder task should wait for a real SKU")
	}

	applyWatchItems(wt, []sites.Item{{MonitorInput: "123456789", Quantity: 1}})
	if wt.waitingForInput() {
		t.Fatal("item ID should leave waiting-for-input")
	}
	if wt.hasDirectOfferInput() {
		t.Fatal("item ID should wait for restock, not ATC immediately")
	}

	applyWatchItems(wt, []sites.Item{{MonitorInput: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Quantity: 1}})
	if !wt.hasDirectOfferInput() {
		t.Fatal("offer ID should ATC immediately")
	}
	if wt.waitingForInput() {
		t.Fatal("offer ID should not wait for input")
	}
}
