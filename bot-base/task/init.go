package task

import (
	"context"
	"crypto/rand"
	"fmt"

	"zynbot.app/engine/bot-base/task/constants"
	"zynbot.app/engine/client"
)

func newRunID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func (t *BaseTask) InitTask(taskType string) bool {
	if !reserveSiteSlot(t.Site) {
		t.StopTask("Task Limit Reached", constants.Colors.RED)
		return false
	}
	t.siteSlotReserved = true

	t.RunID = newRunID()
	// Initiate the tls client for the task
	t.Requests = new(BaseRequestsInfo)
	t.Requests.UserAgent = ChooseUseragent()
	t.Requests.Extras = make(map[string]interface{})
	t.TaskContext = new(BaseContext)
	t.Status = new(BaseStatus)

	// Initiate the task contexts to be able to stop the task
	t.TaskContext.CTX = context.Background()
	t.TaskContext.CTX, t.TaskContext.Cancel = context.WithCancel(t.TaskContext.CTX)

	// Starting task status
	t.TaskState = constants.StatusSteps.Running
	t.UpdateStatus("Starting Task", constants.Colors.YELLOW)

	// Create the task's client
	var err error
	t.Requests.ServerClient, err = client.CreateNewTLSClient("")
	if err != nil {
		t.StopTask("Error Building Client", constants.Colors.RED)
		return false
	}

	//Create request client
	t.Requests.Client, err = client.CreateNewTLSClient("")
	if err != nil {
		t.StopTask("Error Building Client", constants.Colors.RED)
		return false
	}

	// Change proxy as necessary
	if err := t.SwapProxy(taskType); err != nil {
		t.StopTask("Error Assigning Proxy", constants.Colors.RED)
		return false
	}

	// change status to task started
	t.InitRuntimeEditChannel()
	t.UpdateStatus("Completed Task Initilization", constants.Colors.YELLOW)
	return true
}
