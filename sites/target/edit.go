package target

import (
	"github.com/PolarAIO/Polar-AIO/backend/bot-base/profiles"
	"github.com/PolarAIO/Polar-AIO/backend/bot-base/task"
	"github.com/PolarAIO/Polar-AIO/backend/sites"
)

func (t *TargetTask) applyRuntimeEdit(p task.RuntimeEditPayload) {
	in := p.Input

	newInputs := make([]sites.Input, 0, len(in.Items))
	for _, it := range in.Items {
		newInputs = append(newInputs, sites.Input{
			Input:        it.MonitorInput,
			Quantity:     it.Quantity,
			ProductFound: false,
		})
	}
	t.Inputs = newInputs

	monitorSrc := p.MonitorItems
	if len(monitorSrc) == 0 {
		monitorSrc = in.MonitorItems
	}
	newMonitorItems := make([]sites.Input, 0, len(monitorSrc))
	for _, it := range monitorSrc {
		newMonitorItems = append(newMonitorItems, sites.Input{
			Input:    it.MonitorInput,
			Quantity: it.Quantity,
			MaxPrice: it.MaxPrice,
		})
	}
	t.MonitorItems = newMonitorItems

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
		t.Mode = in.Mode
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

	t.IgnoreLowStock = in.IgnoreLowStock
}
