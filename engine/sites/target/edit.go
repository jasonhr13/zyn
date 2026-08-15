package target

import (
	"strings"

	"zynbot.app/engine/bot-base/profiles"
	"zynbot.app/engine/bot-base/proxy"
	"zynbot.app/engine/bot-base/task"
	"zynbot.app/engine/bot-base/task/constants"
	"zynbot.app/engine/sites"
)

func (t *TargetTask) applyRuntimeEdit(p task.RuntimeEditPayload) {
	if p.ProxyGroup != nil {
		t.applyRuntimeProxy(*p.ProxyGroup, p.ProxySources)
		return
	}
	in := p.Input

	newInputs := make([]sites.Input, 0, len(in.Items))
	for _, it := range in.Items {
		newInputs = append(newInputs, sites.Input{
			Input:        it.MonitorInput,
			Quantity:     it.Quantity,
			Priority:     it.Priority,
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
			Priority: it.Priority,
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
		t.ProxySources = append([]string(nil), in.ProxySources...)
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

func (t *TargetTask) applyRuntimeProxy(group string, sources []string) {
	group = strings.TrimSpace(group)
	if group == "" || strings.EqualFold(group, "Local") {
		group = "Local"
		sources = nil
	}
	if group == t.ProxyGroup && sameStringSlice(t.ProxySources, sources) {
		return
	}

	proxy.ReleaseProxy(t.ProxyGroup, t.ID)
	t.ProxyGroup = group
	t.ProxySources = append([]string(nil), sources...)

	var err error
	if group == "Local" {
		err = t.SetProxy("")
	} else {
		err = t.SwapProxy("Target")
	}
	if err != nil {
		t.UpdateStatus("Proxy Switch Failed", constants.Colors.RED)
		return
	}
	t.UpdateStatus("Proxy Updated", constants.Colors.BLUE)
}

func sameStringSlice(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}
