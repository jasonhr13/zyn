package pokemoncenter

import (
	"zynbot.app/engine/bot-base/profiles"
	"zynbot.app/engine/bot-base/task"
	"zynbot.app/engine/bot-base/task/constants"
	"zynbot.app/engine/sites"
)

func (t *PokemonCenterTask) applyRuntimeEdit(p task.RuntimeEditPayload) {
	input := p.Input
	newInputs := make([]sites.Input, 0, len(input.Items))
	for a := 0; a < len(input.Items); a++ {
		newInputs = append(newInputs, sites.Input{
			Input:        input.Items[a].MonitorInput,
			Sizes:        input.Items[a].Size,
			Quantity:     input.Items[a].Quantity,
			ProductLink:  sites.IsValidURL(input.Items[a].MonitorInput),
			ProductFound: false,
		})
	}
	t.Inputs = newInputs
	t.MonitorDelay = input.MonitorDelay
	t.ErrorDelay = input.RetryDelay
	t.ProxyGroup = input.Proxy
	t.ProfileId = input.ProfileId
	if input.ProfileId != "" {
		if loaded, ok := profiles.GetProfile(input.ProfileId); ok {
			t.Profile = task.ProfileFromStore(loaded)
		}
	}
	t.Mode = input.Mode
	t.GroupID = input.TaskGroup
	t.LoopCheckout = input.LoopCheckout
	t.AllInstock = input.AllInstock
	t.WaitForQueue = input.WaitForQueue
	if input.Site != "" {
		t.Site = normalizeSiteName(input.Site)
		t.storeCfg = storeConfigForSite(t.Site)
	} else if input.SiteName != "" {
		t.Site = normalizeSiteName(input.SiteName)
		t.storeCfg = storeConfigForSite(t.Site)
	}
	if len(t.Inputs) > 0 {
		size := "Default"
		if len(t.Inputs[0].Sizes) > 0 {
			size = t.Inputs[0].Sizes[0]
		}
		t.UpdateInputValue(t.Inputs[0].Input, size)
	}
	t.resetForInputEdit()
}

func (t *PokemonCenterTask) resetForInputEdit() {
	if t.TaskState >= constants.StatusSteps.Carted {
		return
	}
	switch t.NextStep {
	case "get-product", "get-availability", "add-to-cart":
		t.NextStep = "get-product"
		t.Products = []Product{}
		for i := range t.Inputs {
			t.Inputs[i].Found = false
		}
	}
}
