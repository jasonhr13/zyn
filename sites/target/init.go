package target

import (
	"log"
	"time"

	"zynbot.app/engine/bot-base/accounts"
	"zynbot.app/engine/bot-base/profiles"
	"zynbot.app/engine/bot-base/task"
	"zynbot.app/engine/sites"
)

func StartTask(t sites.TaskInput) {
	if t.Mode == "Monitor" {
		StartMonitorTask(t)
		return
	}

	newInputs := make([]sites.Input, 0, len(t.Items))
	for a := 0; a < len(t.Items); a++ {
		newInputs = append(newInputs, sites.Input{
			Input:        t.Items[a].MonitorInput,
			Quantity:     t.Items[a].Quantity,
			Priority:     t.Items[a].Priority,
			ProductFound: false,
		})
	}

	monitorInputs := make([]sites.Input, 0, len(t.MonitorItems))
	for _, item := range t.MonitorItems {
		monitorInputs = append(monitorInputs, sites.Input{
			Input:    item.MonitorInput,
			Quantity: item.Quantity,
			MaxPrice: item.MaxPrice,
			Priority: item.Priority,
		})
	}

	// Create the task struct
	newTask := &TargetTask{
		BaseTask: &task.BaseTask{
			Site:          t.Site,
			Mode:          t.Mode,
			Running:       true,
			ProxyGroup:    t.Proxy,
			ProfileId:     t.ProfileId,
			ID:            t.Id,
			MonitorDelay:  t.MonitorDelay,
			GroupID:       t.TaskGroup,
			ErrorDelay:    t.RetryDelay,
			MaxPrice:      t.MaxPrice,
			MinPrice:      t.MinPrice,
			LoopCheckout:  t.LoopCheckout,
			AllInstock:    t.AllInstock,
			Endless:       t.Endless,
			UseFillerItem: t.UseFillerItem,
			UseOtpLogin:   t.UseOtpLogin,
		},
		Inputs:         newInputs,
		MonitorItems:   monitorInputs,
		IgnoreLowStock: t.IgnoreLowStock,
	}

	if t.ProfileId == "" {
		log.Printf("Target task %s: missing profileId", t.Id)
		return
	}
	p, ok := profiles.GetProfile(t.ProfileId)
	if !ok {
		log.Printf("Target task %s: unknown profileId %q (send send-configs first)", t.Id, t.ProfileId)
		return
	}

	account, ok := accounts.GetAccount(t.AccountID)
	newTask.Account = account
	newTask.Profile = task.ProfileFromStore(p)

	task.UserTasks.Set(newTask.BaseTask.ID, newTask, newTask.BaseTask)

	if !newTask.BaseTask.InitTask("Target") {
		return
	}
	newTask.taskStartedAt = time.Now()

	switch newTask.Mode {
	case "Default", "Checkout":
		newTask.NextStep = "get-session"
		newTask.HandleTask()
	default:
		log.Print("Mode Not Found!")
	}
}
