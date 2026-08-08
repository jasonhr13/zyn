package pokemoncenter

import (
	"log"
	"strings"

	"github.com/PolarAIO/Polar-AIO/backend/bot-base/profiles"
	"github.com/PolarAIO/Polar-AIO/backend/bot-base/task"
	"github.com/PolarAIO/Polar-AIO/backend/sites"
)

func StartTask(t sites.TaskInput) {
	newInputs := []sites.Input{}
	for a := 0; a < len(t.Items); a++ {
		if strings.Contains(t.Items[a].MonitorInput, "/product/") {
			parts := strings.SplitN(t.Items[a].MonitorInput, "/product/", 2)
			if len(parts) == 2 {
				t.Items[a].MonitorInput = strings.SplitN(parts[1], "/", 2)[0]
			}
		}
		newInputs = append(newInputs, sites.Input{
			Input:        t.Items[a].MonitorInput,
			Sizes:        t.Items[a].Size,
			Quantity:     t.Items[a].Quantity,
			ProductLink:  sites.IsValidURL(t.Items[a].MonitorInput),
			ProductFound: false,
		})
	}

	siteName := t.Site
	if siteName == "" {
		siteName = t.SiteName
	}
	siteName = normalizeSiteName(siteName)

	// Create the task struct
	newTask := &PokemonCenterTask{
		BaseTask: &task.BaseTask{
			Site:            siteName,
			Mode:            t.Mode,
			Running:         true,
			ProxyGroup:      t.Proxy,
			ProfileId:       t.ProfileId,
			ID:              t.Id,
			MonitorDelay:    t.MonitorDelay,
			GroupID:         t.TaskGroup,
			ErrorDelay:      t.RetryDelay,
			MinPrice:        t.MinPrice,
			MaxPrice:        t.MaxPrice,
			LoopCheckout:    t.LoopCheckout,
			AllInstock:      t.AllInstock,
			WaitForQueue:    t.WaitForQueue,
			QueueEntryDelay: t.QueueEntryDelay,
		},
		storeCfg: storeConfigForSite(siteName),
		Inputs:   newInputs,
	}

	if t.ProfileId == "" {
		log.Printf("%s task %s: missing profileId", siteName, t.Id)
		return
	}
	p, ok := profiles.GetProfile(t.ProfileId)
	if !ok {
		log.Printf("%s task %s: unknown profileId %q (send send-configs first)", siteName, t.Id, t.ProfileId)
		return
	}
	newTask.Profile = task.ProfileFromStore(p)

	task.UserTasks.Set(newTask.BaseTask.ID, newTask, newTask.BaseTask)

	if !newTask.BaseTask.InitTask("PokemonCenter") {
		return
	}

	ua := newTask.Requests.UserAgent
	newTask.DatadomeHeaders = DatadomeHeaders{
		SecMem:             "8",
		SecMobile:          "?0",
		SecArh:             ua.Arch,
		SecPlatform:        ua.Platform,
		SecModel:           "\"\"",
		SecFullVersionList: ua.VersionList,
	}

	switch newTask.Mode {
	case "Default":
		newTask.NextStep = "check-status"
		newTask.HandleTask()
	default:
		log.Print("Mode Not Found!")
	}
}
