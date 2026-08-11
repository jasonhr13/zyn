package target

import (
	"testing"

	"zynbot.app/engine/bot-base/task"
	"zynbot.app/engine/sites"
)

func TestApplyRuntimeEditReplacesWatchListWithoutChangingActiveCheckout(t *testing.T) {
	targetTask := &TargetTask{
		Inputs:       []sites.Input{{Input: "11111111", Quantity: 2}},
		MonitorItems: []sites.Input{{Input: "11111111", Quantity: 2}},
		RestockTCIN:  "11111111",
		RestockQty:   2,
	}

	targetTask.applyRuntimeEdit(task.RuntimeEditPayload{
		Input: sites.TaskInput{
			Items: []sites.Item{
				{MonitorInput: "22222222", Quantity: 4},
				{MonitorInput: "33333333", Quantity: 4},
			},
		},
		MonitorItems: []sites.Item{
			{MonitorInput: "22222222", Quantity: 4},
			{MonitorInput: "33333333", Quantity: 4},
		},
	})

	if len(targetTask.Inputs) != 2 || targetTask.Inputs[0].Input != "22222222" || targetTask.Inputs[1].Input != "33333333" {
		t.Fatalf("checkout inputs were not replaced: %#v", targetTask.Inputs)
	}
	if targetTask.Inputs[0].Quantity != 4 || len(targetTask.MonitorItems) != 2 || targetTask.MonitorItems[0].Quantity != 4 {
		t.Fatalf("edited quantity was not applied: inputs=%#v monitor=%#v", targetTask.Inputs, targetTask.MonitorItems)
	}
	if targetTask.RestockTCIN != "11111111" || targetTask.RestockQty != 2 {
		t.Fatalf("an in-progress checkout selection changed: tcin=%q qty=%d", targetTask.RestockTCIN, targetTask.RestockQty)
	}
}

func TestApplyRuntimeEditCanClearRestockWatchList(t *testing.T) {
	targetTask := &TargetTask{
		Inputs:       []sites.Input{{Input: "11111111", Quantity: 2}},
		MonitorItems: []sites.Input{{Input: "11111111", Quantity: 2}},
	}

	targetTask.applyRuntimeEdit(task.RuntimeEditPayload{Input: sites.TaskInput{}})

	if len(targetTask.Inputs) != 0 || len(targetTask.MonitorItems) != 0 {
		t.Fatalf("empty runtime edit retained the old watch list: inputs=%#v monitor=%#v", targetTask.Inputs, targetTask.MonitorItems)
	}
}
