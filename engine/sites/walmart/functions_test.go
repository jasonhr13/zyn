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
	if parsePidFromInput("https://www.walmart.com/ip/-/19536452232") != "19536452232" {
		t.Fatal("short product URL should yield the item ID")
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

func TestRaffleModeUsesItemIDNotOffer(t *testing.T) {
	if !isRaffleMode("Raffle Entry") || !isRaffleMode("raffle") || !isRaffleMode("draw") {
		t.Fatal("raffle mode aliases should match")
	}
	if isRaffleMode("Checkout") || isRaffleMode("Monitor") || isRaffleMode("") {
		t.Fatal("checkout/monitor/empty are not raffle")
	}

	wt := &WalmartTask{BaseTask: &task.BaseTask{Mode: raffleEntryMode}}
	applyWatchItems(wt, []sites.Item{{MonitorInput: "placeholder", Quantity: 5}})
	if !wt.waitingForDrawInput() {
		t.Fatal("placeholder raffle should wait for an item ID")
	}
	if wt.nextStepAfterPayment() != "wait-for-draw" {
		t.Fatalf("raffle after payment should wait for draw, got %s", wt.nextStepAfterPayment())
	}

	applyWatchItems(wt, []sites.Item{{MonitorInput: "19536452232", Quantity: 5}})
	if wt.drawItemID() != "19536452232" {
		t.Fatalf("item ID: %s", wt.drawItemID())
	}
	if wt.drawQuantity() != 5 {
		t.Fatalf("qty: %d", wt.drawQuantity())
	}
	if wt.waitingForDrawInput() {
		t.Fatal("numeric SKU should be enough to enter")
	}

	applyWatchItems(wt, []sites.Item{{MonitorInput: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Quantity: 2}})
	if wt.drawItemID() != "" {
		t.Fatal("offer ID is not a draw item ID")
	}

	wt.DrawMaxQty = 2
	applyWatchItems(wt, []sites.Item{{MonitorInput: "https://www.walmart.com/ip/Foo/19624258216", Quantity: 5}})
	if wt.drawItemID() != "19624258216" {
		t.Fatalf("url pid: %s", wt.drawItemID())
	}
	if wt.drawQuantity() != 2 {
		t.Fatalf("qty should clamp to max: %d", wt.drawQuantity())
	}
}

func TestDecodeDrawResponse(t *testing.T) {
	nested := decodeDrawResponse(`{"data":{"entrySubmitted":true,"maxQty":3}}`)
	if nested.EntrySubmitted == nil || !*nested.EntrySubmitted {
		t.Fatal("nested entrySubmitted")
	}
	if nested.maxQty() != 3 {
		t.Fatalf("maxQty %d", nested.maxQty())
	}

	already := decodeDrawResponse(`{"alreadyEntered":true}`)
	if !already.alreadyEntered() {
		t.Fatal("alreadyEntered")
	}

	closed := decodeDrawResponse(`{"status":"CLOSED","eligible":false}`)
	if !closed.notOpen() {
		t.Fatal("closed draw should be not open")
	}

	open := decodeDrawResponse(`{"eligible":true,"maxQuantity":4}`)
	if open.notOpen() || open.alreadyEntered() || open.maxQty() != 4 {
		t.Fatalf("open draw parse: %+v", open)
	}

	empty := decodeDrawResponse(`{}`)
	if empty.EntrySubmitted != nil && *empty.EntrySubmitted {
		t.Fatal("empty body must not count as submitted")
	}
}
