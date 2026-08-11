package monitorhub

import (
	"context"

	"zynbot.app/engine/bot-base/task"
	"zynbot.app/engine/bot-base/task/constants"
)

func InitMonitorTask(t *task.BaseTask, taskType string) bool {
	if t == nil {
		return false
	}

	t.Requests = new(task.BaseRequestsInfo)
	t.Requests.Extras = make(map[string]interface{})
	t.TaskContext = new(task.BaseContext)
	t.Status = new(task.BaseStatus)

	t.TaskContext.CTX = context.Background()
	t.TaskContext.CTX, t.TaskContext.Cancel = context.WithCancel(t.TaskContext.CTX)

	t.TaskState = constants.StatusSteps.Running
	t.UpdateStatus("Starting Monitor", constants.Colors.YELLOW)

	if err := t.EnsureTLSClient(true); err != nil {
		t.StopTask("Error Building Client", constants.Colors.RED)
		return false
	}

	if err := t.SwapProxy(taskType); err != nil {
		t.StopTask("Error Assigning Proxy", constants.Colors.RED)
		return false
	}

	t.InitRuntimeEditChannel()
	t.UpdateStatus("Completed Monitor Initilization", constants.Colors.YELLOW)
	return true
}
