package costco

import (
	"log"
	"strings"

	"zynbot.app/engine/bot-base/task"
	"zynbot.app/engine/bot-base/task/constants"
	"zynbot.app/engine/sites"
	"zynbot.app/engine/sites/queueit"
)

func isQueueFarmMode(mode string) bool {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "queue runner", "queue monitor", "queue", "queueit", "queue-it":
		return true
	default:
		return false
	}
}

func StartTask(input sites.TaskInput) {
	if input.Site == "" {
		input.Site = "Costco"
	}
	if !isQueueFarmMode(input.Mode) {
		log.Printf("costco task %s: checkout is not implemented; use Queue Runner", input.Id)
		dummy := &task.BaseTask{
			Site:       input.Site,
			Mode:       input.Mode,
			Running:    true,
			ID:         input.Id,
			ProxyGroup: input.Proxy,
			GroupID:    input.TaskGroup,
		}
		task.UserTasks.Set(dummy.ID, dummy, dummy)
		if dummy.InitTask(input.Site) {
			dummy.StopTask("Use Queue Runner", constants.Colors.RED)
		}
		return
	}
	queueit.StartTask(input)
}
