package hyperbroker

import (
	"context"
	"testing"
)

func TestRequestDelegatesWithoutCredentials(t *testing.T) {
	var gotTask, gotOperation string
	var gotPayload any
	SetRequester(func(_ context.Context, taskID, operation string, payload any) (Result, error) {
		gotTask, gotOperation, gotPayload = taskID, operation, payload
		return Result{Status: 200, Body: []byte(`{"payload":"safe"}`)}, nil
	})
	t.Cleanup(func() { SetRequester(nil) })

	payload := map[string]any{"pageUrl": "https://www.pokemoncenter.com/"}
	result, err := Request(context.Background(), "pc-1", "reese84", payload)
	if err != nil {
		t.Fatal(err)
	}
	if gotTask != "pc-1" || gotOperation != "reese84" || gotPayload == nil {
		t.Fatalf("request = task %q operation %q payload %#v", gotTask, gotOperation, gotPayload)
	}
	if result.Status != 200 || string(result.Body) != `{"payload":"safe"}` {
		t.Fatalf("result = %#v", result)
	}
}

func TestRequestFailsClosedWithoutRequester(t *testing.T) {
	SetRequester(nil)
	_, err := Request(context.Background(), "pc-1", "reese84", map[string]any{})
	if err == nil {
		t.Fatal("request without a configured bridge succeeded")
	}
}
