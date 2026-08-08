package walmart

import (
	"strings"

	"github.com/PolarAIO/Polar-AIO/backend/bot-base/profiles"
	"github.com/PolarAIO/Polar-AIO/backend/bot-base/task"
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
	if len(in.Items) > 0 {
		item := in.Items[0]
		raw := strings.TrimSpace(item.MonitorInput)

		t.Quantity = item.Quantity
		if t.Quantity <= 0 {
			t.Quantity = 1
		}

		if raw != t.RawInput {
			t.RawInput = raw

			// Clear old input
			t.InputPid = ""
			t.OfferID = ""

			if isOfferIDInput(raw) {
				t.OfferID = raw
			} else {
				t.InputPid = parsePidFromInput(raw)
			}
		}
	}
}
