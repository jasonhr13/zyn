package walmart

import (
	"zynbot.app/engine/bot-base/profiles"
	"zynbot.app/engine/bot-base/task"
)

func (t *WalmartTask) applyRuntimeEdit(p task.RuntimeEditPayload) {
	in := p.Input

	if in.MonitorDelay > 0 {
		t.MonitorDelay = in.MonitorDelay
	}
	if in.RetryDelay > 0 {
		t.ErrorDelay = in.RetryDelay
	}
	if in.Proxy != "" {
		t.ProxyGroup = in.Proxy
	}
	if in.MaxPrice != 0 {
		t.MaxPrice = in.MaxPrice
	}
	if in.MinPrice != 0 {
		t.MinPrice = in.MinPrice
	}
	if in.Mode != "" {
		if isRaffleMode(in.Mode) {
			t.Mode = raffleEntryMode
		} else {
			t.Mode = in.Mode
		}
	}
	if in.TaskGroup != "" {
		t.GroupID = in.TaskGroup
	}
	if in.Site != "" {
		t.Site = in.Site
	} else if in.SiteName != "" {
		t.Site = in.SiteName
	}
	if in.ProfileId != "" && in.ProfileId != t.ProfileId {
		t.ProfileId = in.ProfileId
		if loaded, ok := profiles.GetProfile(in.ProfileId); ok {
			t.Profile = task.ProfileFromStore(loaded)
		}
	}
	items := in.Items
	if len(items) == 0 {
		items = in.MonitorItems
	}
	if len(items) > 0 {
		applyWatchItems(t, items)
	}
}
