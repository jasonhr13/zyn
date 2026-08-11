package pokemoncenter

import (
	"context"
	"errors"
	"testing"

	"zynbot.app/engine/bot-base/hyperbroker"
	"zynbot.app/engine/bot-base/task"
)

func TestRequestHyperUsesCorrelatedFrontendBroker(t *testing.T) {
	var gotTask, gotOperation string
	var gotPayload any
	hyperbroker.SetRequester(func(_ context.Context, taskID, operation string, payload any) (hyperbroker.Result, error) {
		gotTask, gotOperation, gotPayload = taskID, operation, payload
		return hyperbroker.Result{Status: 200, Body: []byte(`{"payload":"sensor"}`)}, nil
	})
	t.Cleanup(func() { hyperbroker.SetRequester(nil) })

	pc := &PokemonCenterTask{BaseTask: &task.BaseTask{
		ID:          "pc-1",
		TaskContext: &task.BaseContext{CTX: context.Background()},
		Requests:    &task.BaseRequestsInfo{},
	}}
	payload := map[string]any{"script": "challenge-source"}
	status, body, err := pc.requestHyper("reese84", payload)
	if err != nil {
		t.Fatal(err)
	}
	if gotTask != "pc-1" || gotOperation != "reese84" || gotPayload == nil {
		t.Fatalf("request = task %q operation %q payload %#v", gotTask, gotOperation, gotPayload)
	}
	if status != 200 || body != `{"payload":"sensor"}` {
		t.Fatalf("response = %d %q", status, body)
	}
	if pc.Requests.Referer != hyperOperationURLs["reese84"] {
		t.Fatalf("referer = %q", pc.Requests.Referer)
	}
}

func TestSetHyperErrorRetainsRetryStep(t *testing.T) {
	pc := &PokemonCenterTask{BaseTask: &task.BaseTask{}}
	pc.setHyperError("solve-utmvc", errors.New("disconnected"))
	if pc.NextStep != "solve-utmvc" || pc.Error == nil {
		t.Fatalf("step/error = %q %v", pc.NextStep, pc.Error)
	}
}
