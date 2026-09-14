package queueit

import (
	"log"
	"strings"

	"zynbot.app/engine/bot-base/safego"
	"zynbot.app/engine/bot-base/task"
	"zynbot.app/engine/bot-base/task/constants"
	"zynbot.app/engine/sites"
)

func IsQueueMode(mode string) bool {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "", "normal", "new", "queue", "queue runner", "queue monitor", "queueit", "queue-it":
		return true
	default:
		return false
	}
}

func startURLFromInput(t sites.TaskInput) string {
	for _, item := range t.Items {
		if s := strings.TrimSpace(item.MonitorInput); s != "" {
			return s
		}
	}
	for _, item := range t.MonitorItems {
		if s := strings.TrimSpace(item.MonitorInput); s != "" {
			return s
		}
	}
	return ""
}

func StartTask(input sites.TaskInput) {
	url := startURLFromInput(input)
	newTask := &QueueItTask{
		BaseTask: &task.BaseTask{
			Site:         input.Site,
			Mode:         input.Mode,
			Running:      true,
			ProxyGroup:   input.Proxy,
			ProxySources: append([]string(nil), input.ProxySources...),
			ID:           input.Id,
			MonitorDelay: input.MonitorDelay,
			GroupID:      input.TaskGroup,
			ErrorDelay:   input.RetryDelay,
		},
		StartURL: url,
	}
	if parsed, err := ParseStartURL(url); err == nil {
		newTask.Config = parsed
		if newTask.Config.CustomerID == "" {
			newTask.Config.CustomerID = customerFromHost(parsed.Host)
		}
		if newTask.Config.TargetURL == "" {
			newTask.Config.TargetURL = url
		}
	}

	task.UserTasks.Set(newTask.BaseTask.ID, newTask, newTask.BaseTask)
	if !newTask.BaseTask.InitTask(newTask.Site) {
		return
	}
	if url == "" {
		newTask.StopTask("Missing Queue URL", constants.Colors.RED)
		return
	}
	newTask.NextStep = "land"
	safego.Go(newTask.HandleTask)
}

func StartOrReject(input sites.TaskInput) {
	if !IsQueueMode(input.Mode) {
		log.Printf("%s task %s: mode %q is not a queue farm mode", input.Site, input.Id, input.Mode)
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
			dummy.StopTask("Mode Not Supported", constants.Colors.RED)
		}
		return
	}
	StartTask(input)
}
