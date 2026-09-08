package imapcode

import (
	"context"
	"sync/atomic"
	"testing"
)

func TestWaiterArmRequestsOnce(t *testing.T) {
	var requests atomic.Int32
	SetCodeRequester(func(email, taskID string) {
		requests.Add(1)
	})
	t.Cleanup(func() { SetCodeRequester(nil) })

	waiter, err := PrepareWait("Alias@Yahoo.com")
	if err != nil {
		t.Fatal(err)
	}
	waiter.Arm()
	waiter.Arm()
	DeliverCode("alias@yahoo.com", "123456")

	code, err := waiter.Wait(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if code != "123456" {
		t.Fatalf("got code %q", code)
	}
	if requests.Load() != 1 {
		t.Fatalf("got %d requests", requests.Load())
	}
}

func TestWaiterArmForwardsTaskID(t *testing.T) {
	var gotEmail, gotTaskID string
	SetCodeRequester(func(email, taskID string) {
		gotEmail = email
		gotTaskID = taskID
	})
	t.Cleanup(func() { SetCodeRequester(nil) })

	waiter, err := PrepareWait("user@example.com", "task-99")
	if err != nil {
		t.Fatal(err)
	}
	waiter.Arm()
	if gotEmail != "user@example.com" {
		t.Fatalf("got email %q", gotEmail)
	}
	if gotTaskID != "task-99" {
		t.Fatalf("got task id %q", gotTaskID)
	}
}
