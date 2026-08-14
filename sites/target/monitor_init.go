package target

import (
	"log"

	"zynbot.app/engine/bot-base/task"
	monitorhub "zynbot.app/engine/monitor-hub"
	"zynbot.app/engine/sites"
)

func init() {
	monitorhub.Register("Target", startMonitorWorker)
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
		Id:             in.ID,
		Site:           in.Site,
		Mode:           "Monitor",
		Proxy:          in.ProxyGroup,
		MonitorDelay:   in.MonitorDelay,
		IgnoreLowStock: in.IgnoreLowStock,
		Items:          items,
	})
}
func NewMonitorTask(t sites.TaskInput) (*TargetMonitorTask, bool) {
	items := t.Items
	if len(items) == 0 {
		items = t.MonitorItems
	}
	monitorInputs := make([]MonitorInput, 0, len(items))
	for _, item := range items {
		tcin := parseTcinFromInput(item.MonitorInput)
		if tcin == "" {
			continue
		}
		monitorInputs = append(monitorInputs, MonitorInput{
			Tcin:     tcin,
			Qty:      item.Quantity,
			MaxPrice: item.MaxPrice,
		})
	}
	if len(monitorInputs) == 0 {
		log.Printf("Target monitor task %s: no valid tcins in monitor inputs", t.Id)
		return nil, false
	}

	newTask := &TargetMonitorTask{
		BaseTask: &task.BaseTask{
			Site:         t.Site,
			Mode:         t.Mode,
			Running:      true,
			ProxyGroup:   t.Proxy,
			ID:           t.Id,
			MonitorDelay: t.MonitorDelay,
			GroupID:      t.TaskGroup,
			ErrorDelay:   t.RetryDelay,
			AllInstock:   t.AllInstock,
			MinPrice:     t.MinPrice,
			MaxPrice:     t.MaxPrice,
		},
		MonitorInputs:  monitorInputs,
		IgnoreLowStock: t.IgnoreLowStock,
	}

	task.UserTasks.Set(newTask.BaseTask.ID, newTask, newTask.BaseTask)
	if !monitorhub.InitMonitorTask(newTask.BaseTask, "Target", len(monitorInputs)) {
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
