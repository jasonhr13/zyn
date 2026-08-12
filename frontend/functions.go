package frontend

import (
	"log"
	"strconv"
	"sync"
	"time"

	"zynbot.app/engine/bot-base/siteconfig"
	"zynbot.app/engine/bot-base/task"
	"zynbot.app/engine/bot-base/task/constants"
	"zynbot.app/engine/sites"
)

const scheduleLayout = "2006-01-02T15:04"

var pendingSchedules = struct {
	mu sync.Mutex
	m  map[string]*time.Timer
}{m: map[string]*time.Timer{}}

func setPendingSchedule(taskID string, timer *time.Timer) {
	pendingSchedules.mu.Lock()
	defer pendingSchedules.mu.Unlock()
	if old, ok := pendingSchedules.m[taskID]; ok {
		old.Stop()
	}
	pendingSchedules.m[taskID] = timer
}

func clearPendingSchedule(taskID string) {
	pendingSchedules.mu.Lock()
	defer pendingSchedules.mu.Unlock()
	if timer, ok := pendingSchedules.m[taskID]; ok {
		timer.Stop()
		delete(pendingSchedules.m, taskID)
	}
}

// parseSchedule parses a datetime-local string. ok is false if v is empty or
// unparsable.
func parseSchedule(v string) (t time.Time, ok bool) {
	if v == "" {
		return time.Time{}, false
	}
	t, err := time.ParseInLocation(scheduleLayout, v, time.Local)
	if err != nil {
		log.Printf("StartTask: invalid schedule %q: %v", v, err)
		return time.Time{}, false
	}
	return t, true
}

// scheduleStop arms an automatic stop for a task that has a future
// stopSchedule. If the stop time has already passed (or is unset/invalid),
// no automatic stop is scheduled.
func scheduleStop(TaskInfo StartTaskMessage) {
	stopAt, ok := parseSchedule(TaskInfo.StopSchedule)
	if !ok {
		return
	}
	delay := time.Until(stopAt)
	if delay <= 0 {
		return
	}
	timer := time.AfterFunc(delay, func() {
		clearPendingSchedule(TaskInfo.Id)
		StopTask(TaskInfo.Id)
	})
	setPendingSchedule(TaskInfo.Id, timer)
}

func startMessageToSiteInput(TaskInfo StartTaskMessage) sites.TaskInput {
	monitorDelay, _ := strconv.Atoi(TaskInfo.MonitorDelay)
	retryDelay, _ := strconv.Atoi(TaskInfo.RetryDelay)
	minPrice, _ := strconv.ParseFloat(TaskInfo.MinPrice, 64)
	maxPrice, _ := strconv.ParseFloat(TaskInfo.MaxPrice, 64)

	queueEntryDelay, _ := strconv.Atoi(TaskInfo.QueueEntryDelay)

	items := make([]sites.Item, 0, len(TaskInfo.Item))
	for _, it := range TaskInfo.Item {
		qty, _ := strconv.Atoi(it.Quantity)
		mp, _ := strconv.ParseFloat(it.MaxPrice, 64)
		items = append(items, sites.Item{
			MonitorInput: it.MonitorInput,
			Quantity:     qty,
			MaxPrice:     mp,
			Color:        it.Color,
			Size:         it.Sizes,
		})
	}

	monitorItems := make([]sites.Item, 0, len(TaskInfo.MonitorItems))
	for _, it := range TaskInfo.MonitorItems {
		qty, _ := strconv.Atoi(it.Quantity)
		mp, _ := strconv.ParseFloat(it.MaxPrice, 64)
		monitorItems = append(monitorItems, sites.Item{
			MonitorInput: it.MonitorInput,
			Quantity:     qty,
			MaxPrice:     mp,
			Color:        it.Color,
			Size:         it.Sizes,
		})
	}

	siteName := TaskInfo.Site
	if siteName == "" {
		siteName = TaskInfo.Type
	}
	return sites.TaskInput{
		Id:              TaskInfo.Id,
		TaskGroup:       TaskInfo.TaskGroup,
		MonitorDelay:    monitorDelay,
		RetryDelay:      retryDelay,
		MinPrice:        minPrice,
		MaxPrice:        maxPrice,
		Proxy:           TaskInfo.ProxyGroup,
		ProfileId:       TaskInfo.ProfileId,
		SiteName:        siteName,
		Site:            siteName,
		Mode:            TaskInfo.Mode,
		Items:           items,
		MonitorItems:    monitorItems,
		AccountID:       TaskInfo.AccountId,
		LoopCheckout:    TaskInfo.LoopCheckout,
		WaitForQueue:    TaskInfo.WaitForQueue,
		QueueEntryDelay: queueEntryDelay,
		AllInstock:      TaskInfo.AllInstock,
		Endless:         TaskInfo.Endless,
		UseFillerItem:   TaskInfo.UseFillerItem,
		UseOtpLogin:     TaskInfo.UseOtpLogin,
		IgnoreLowStock:  TaskInfo.IgnoreLowStock,
	}
}

func StartTask(TaskInfo StartTaskMessage) {
	_, ok := task.UserTasks.Get(TaskInfo.Id)
	if ok {
		return
	}

	if startAt, ok := parseSchedule(TaskInfo.StartSchedule); ok {
		if delay := time.Until(startAt); delay > 0 {
			_ = SendMessage(SentMessage{
				Type: "update-status",
				Messages: []any{
					map[string]any{
						"taskID":  TaskInfo.Id,
						"status":  "Waiting For Start Time",
						"color":   constants.Colors.BLUE,
						"running": true,
					},
				},
			})
			timer := time.AfterFunc(delay, func() {
				clearPendingSchedule(TaskInfo.Id)
				StartTask(TaskInfo)
			})
			setPendingSchedule(TaskInfo.Id, timer)
			return
		}
	}

	siteInput := startMessageToSiteInput(TaskInfo)
	siteName := siteInput.Site
	if siteName == "" {
		siteName = siteInput.SiteName
	}
	if siteconfig.IsLocked(siteName) {
		log.Printf("site locked: %q", siteName)
		_ = SendMessage(SentMessage{
			Type: "update-status",
			Messages: []any{
				map[string]any{
					"taskID": TaskInfo.Id,
					"status": "Module Disabled",
					"color":  constants.Colors.RED,
				},
			},
		})
		return
	}

	scheduleStop(TaskInfo)

	dispatchStartTask(siteName, siteInput)
}

func EditTask(TaskInfo StartTaskMessage) {
	siteInput := startMessageToSiteInput(TaskInfo)
	p := task.RuntimeEditPayload{
		Input:        siteInput,
		MonitorItems: siteInput.MonitorItems,
	}
	_ = task.EnqueueRuntimeEdit(TaskInfo.Id, p)
}

func StopTask(TaskID string) {
	StopTasks([]string{TaskID})
}

// StopTasks processes a stop request as one bounded batch. Active tasks queue
// their terminal status through BaseTask.StopTask; missing/scheduled tasks are
// acknowledged together in one frontend message instead of one write per ID.
func StopTasks(taskIDs []string) {
	seen := make(map[string]struct{}, len(taskIDs))
	missing := make([]any, 0)
	for _, taskID := range taskIDs {
		if taskID == "" {
			continue
		}
		if _, duplicate := seen[taskID]; duplicate {
			continue
		}
		seen[taskID] = struct{}{}
		clearPendingSchedule(taskID)
		t, ok := task.UserTasks.Get(taskID)
		if ok {
			t.StopTask("Idle", constants.Colors.DEFAULT, constants.StatusSteps.Idle)
			continue
		}
		missing = append(missing, map[string]any{
			"taskID":  taskID,
			"status":  "Idle",
			"color":   constants.Colors.DEFAULT,
			"running": false,
		})
	}
	if len(missing) > 0 {
		_ = SendMessage(SentMessage{Type: "update-status", Messages: missing})
	}
}
