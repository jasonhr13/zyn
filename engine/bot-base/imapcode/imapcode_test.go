package imapcode

import (
	"context"
	"sync/atomic"
	"testing"
)

func TestWaiterArmRequestsOnce(t *testing.T) {
	var requests atomic.Int32
	SetCodeRequester(func(email string) {
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
