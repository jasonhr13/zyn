package walmart

import (
	"log"

	"zynbot.app/engine/bot-base/task"
	monitorhub "zynbot.app/engine/monitor-hub"
	"zynbot.app/engine/sites"
)

func init() {
	monitorhub.Register("Walmart", startMonitorWorker)
}

func startMonitorWorker(in monitorhub.StartInput) {
	items := make([]sites.Item, 0, len(in.Items))
	for _, it := range in.Items {
		items = append(items, sites.Item{
			MonitorInput: it.MonitorInput,
			Quantity:     it.Quantity,
			MaxPrice:     it.MaxPrice,
		})
	}
	StartMonitorTask(sites.TaskInput{
		Id:           in.ID,
		Site:         in.Site,
		Mode:         "Monitor",
		Proxy:        in.ProxyGroup,
		MonitorDelay: in.MonitorDelay,
		Items:        items,
	})
}

func NewMonitorTask(t sites.TaskInput) (*WalmartMonitorTask, bool) {
	items := t.Items
	if len(items) == 0 {
		items = t.MonitorItems
	}
	pid := ""
	maxPrice := t.MaxPrice
	if len(items) > 0 {
		pid = parsePidFromInput(items[0].MonitorInput)
		if maxPrice <= 0 {
			maxPrice = items[0].MaxPrice
		}
	}
	if pid == "" {
		log.Printf("walmart monitor task %s: no valid pid in monitor input", t.Id)
		return nil, false
	}

	delay := t.MonitorDelay
	if delay <= 0 {
		delay = 3000
	}

	newTask := &WalmartMonitorTask{
		BaseTask: &task.BaseTask{
			Site:         t.Site,
			Mode:         t.Mode,
			Running:      true,
			ProxyGroup:   t.Proxy,
			ID:           t.Id,
			MonitorDelay: delay,
			GroupID:      t.TaskGroup,
			ErrorDelay:   t.RetryDelay,
			MinPrice:     t.MinPrice,
			MaxPrice:     maxPrice,
		},
		Pid: pid,
	}

	task.UserTasks.Set(newTask.BaseTask.ID, newTask, newTask.BaseTask)
	if !monitorhub.InitMonitorTask(newTask.BaseTask, "Walmart") {
		return nil, false
	}
	newTask.NextStep = "get-stock"
	return newTask, true
}

func StartMonitorTask(t sites.TaskInput) {
	newTask, ok := NewMonitorTask(t)
	if !ok {
		return
	}
	newTask.Monitor()
}
