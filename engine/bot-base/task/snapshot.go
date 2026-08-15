package task

import "strings"

func RunningTasksForPresence() []*BaseTask {
	UserTasks.mu.RLock()
	defer UserTasks.mu.RUnlock()

	out := make([]*BaseTask, 0, len(UserTasks.bases))
	for taskID, bt := range UserTasks.bases {
		if bt == nil || bt.ID == "" || bt.ID != taskID || !bt.Running {
			continue
		}
		if strings.EqualFold(bt.Mode, "Monitor") {
			continue
		}
		out = append(out, bt)
	}
	return out
}
