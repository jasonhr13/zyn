package task

import "testing"

func TestCheckoutNotificationIncludesHopeDetails(t *testing.T) {
	var sent statusMessage
	SetMessageSender(func(value any) error {
		sent = value.(statusMessage)
		return nil
	})
	t.Cleanup(func() { SetMessageSender(nil) })

	base := BaseTask{ID: "task-1", GroupID: "group-1"}
	base.SendCheckoutDeclineNoti("Product", "image", true, NotificationDetails{
		TaskID:      "task-1",
		SKU:         "12345",
		Price:       19.99,
		OrderNumber: "order-1",
		AccountID:   "account-1",
		Source:      "Harvester",
	})

	messages, ok := sent.Messages.([]NotificationMessage)
	if !ok || len(messages) != 1 {
		t.Fatalf("messages = %#v", sent.Messages)
	}
	message := messages[0]
	if message.Type != "checkout" || message.TaskID != "task-1" || message.SKU != "12345" || message.Price != 19.99 || message.OrderNumber != "order-1" || message.AccountID != "account-1" || message.Source != "Harvester" {
		t.Fatalf("notification = %#v", message)
	}
}
