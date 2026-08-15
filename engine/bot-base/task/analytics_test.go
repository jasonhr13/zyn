package task

import "testing"

func TestSendProductWebhookEmitsOneNormalizedAnalyticsEvent(t *testing.T) {
	var sent statusMessage
	SetMessageSender(func(value any) error {
		sent = value.(statusMessage)
		return nil
	})
	t.Cleanup(func() { SetMessageSender(nil) })

	SendProductWebhook(ProductWebhookData{
		Success:      true,
		Site:         "PokemonCenterUS",
		TaskID:       "run-1",
		ClientTaskID: "task-1",
		RunID:        "run-1",
		OrderNumber:  "order-1",
		CheckoutProducts: []ProductWebhookItem{
			{SKU: "sku-1", Name: "One", Price: 10.25, Quantity: 2},
			{SKU: "sku-2", Name: "Two", Price: 4.5, Quantity: 1},
		},
	})

	if sent.Type != "analytics-event" {
		t.Fatalf("type = %q", sent.Type)
	}
	messages, ok := sent.Messages.([]AnalyticsEventMessage)
	if !ok || len(messages) != 1 {
		t.Fatalf("messages = %#v", sent.Messages)
	}
	event := messages[0]
	if event.EventID == "" || event.EventType != "checkout" || event.TaskID != "task-1" || event.RunID != "run-1" || event.TotalCents != 2500 {
		t.Fatalf("event = %#v", event)
	}
	if len(event.Items) != 2 || event.Items[0].SKU != "sku-1" || event.Items[0].Quantity != 2 || event.Items[0].UnitPriceCents != 1025 {
		t.Fatalf("items = %#v", event.Items)
	}
}

func TestSendCartedAnalyticsUsesProvidedGrandTotal(t *testing.T) {
	var sent statusMessage
	SetMessageSender(func(value any) error {
		sent = value.(statusMessage)
		return nil
	})
	t.Cleanup(func() { SetMessageSender(nil) })

	SendCartedAnalytics(ProductWebhookData{
		Site: "Target", TaskID: "run-2", ClientTaskID: "task-2", RunID: "run-2", GrandTotal: 19.99,
		CheckoutProducts: []ProductWebhookItem{{SKU: "123", Price: 9.99, Quantity: 2}},
	})

	messages := sent.Messages.([]AnalyticsEventMessage)
	if messages[0].EventType != "carted" || messages[0].TotalCents != 1999 {
		t.Fatalf("event = %#v", messages[0])
	}
}
