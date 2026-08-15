package analytics

import "zynbot.app/engine/bot-base/task"

func SyncTask(t *task.BaseTask) {
	_ = t
	scheduleSend()
}

func RemoveTask(taskID string) {
	_ = taskID
	scheduleSend()
}

func buildTaskPresence(t *task.BaseTask) TaskPresence {
	status := ""
	if t.Status != nil {
		status = t.Status.Status
	}

	return TaskPresence{
		TaskID:  t.ID,
		RunID:   t.RunID,
		Site:    t.Site,
		State:   t.TaskState,
		Status:  status,
		Running: true,
		Inputs:  buildInputs(t),
	}
}

func buildInputs(t *task.BaseTask) map[string]any {
	inputs := map[string]any{
		"mode":  t.Mode,
		"delay": t.MonitorDelay,
	}

	if t.InputProduct != "" {
		inputs["product"] = t.InputProduct
	}
	if t.InputSize != "" {
		inputs["size"] = t.InputSize
	}
	if t.Profile.ProfileName != "" {
		inputs["profile"] = t.Profile.ProfileName
	} else if t.ProfileId != "" {
		inputs["profile"] = t.ProfileId
	}
	if t.ProxyGroup != "" {
		inputs["proxy"] = t.ProxyGroup
	}
	if t.Product.ProductLink != "" {
		inputs["productUrl"] = t.Product.ProductLink
	}
	if t.Product.Sku != "" {
		inputs["sku"] = t.Product.Sku
	}
	if t.Product.Name != "" {
		inputs["productName"] = t.Product.Name
	}

	return inputs
}

func snapshotTasks() []TaskPresence {
	running := task.RunningTasksForPresence()
	out := make([]TaskPresence, 0, len(running))
	for _, t := range running {
		out = append(out, buildTaskPresence(t))
	}
	return out
}
