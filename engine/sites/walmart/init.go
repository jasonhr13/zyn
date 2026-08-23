package walmart

import (
	"log"

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

	newTask := &WalmartTask{
		BaseTask: &task.BaseTask{
			Site:         t.Site,
			Mode:         t.Mode,
			Running:      true,
			ProxyGroup:   t.Proxy,
			ProfileId:    t.ProfileId,
			ID:           t.Id,
			MonitorDelay: t.MonitorDelay,
			GroupID:      t.TaskGroup,
			ErrorDelay:   t.RetryDelay,
			MaxPrice:     t.MaxPrice,
			MinPrice:     t.MinPrice,
			LoopCheckout: t.LoopCheckout,
			Endless:      t.Endless,
		},
	}

	if t.ProfileId == "" {
		log.Printf("walmart task %s: missing profileId", t.Id)
		return
	}
	p, ok := profiles.GetProfile(t.ProfileId)
	if !ok {
		log.Printf("walmart task %s: unknown profileId %q (send send-configs first)", t.Id, t.ProfileId)
		return
	}

	account, _ := accounts.GetAccount(t.AccountID)
	newTask.Account = account
	newTask.Profile = task.ProfileFromStore(p)

	items := t.Items
	if len(items) == 0 {
		items = t.MonitorItems
	}
	applyWatchItems(newTask, items)

	task.UserTasks.Set(newTask.BaseTask.ID, newTask, newTask.BaseTask)
	if !newTask.BaseTask.InitTask("Walmart") {
		return
	}
	newTask.TMXDeviceID = GenerateDeviceProfileRefID(36)

	switch newTask.Mode {
	case "Default", "Checkout":
		newTask.NextStep = "get-session"
		newTask.HandleTask()
	default:
		log.Print("Mode Not Found!")
	}
}
