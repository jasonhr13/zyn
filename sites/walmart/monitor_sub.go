package walmart

import (
	"strings"
	"time"

	"github.com/PolarAIO/Polar-AIO/backend/bot-base/task"
	monitorhub "github.com/PolarAIO/Polar-AIO/backend/monitor-hub"
)

func (t *WalmartTask) matchKeys() []string {
	var keys []string
	if t.InputPid != "" {
		keys = append(keys, t.InputPid)
	}
	if t.UsItemID != "" && t.UsItemID != t.InputPid {
		keys = append(keys, t.UsItemID)
	}
	return keys
}

func (t *WalmartTask) waitForStockPing() (monitorhub.StockPing, bool) {
	since := time.Now()
	sub := monitorhub.Default.Subscribe()
	defer sub.Close()
	poll := time.NewTicker(2 * time.Second)
	defer poll.Stop()

	for {
		t.DrainPendingRuntimeEdits(func(p task.RuntimeEditPayload) {
			t.applyRuntimeEdit(p)
		})
		keys := t.matchKeys()
		if len(keys) == 0 {
			return monitorhub.StockPing{}, false
		}
		if ping, ok := monitorhub.Default.Match("Walmart", keys, since); ok && acceptsWalmartPing(ping, keys, since) {
			return ping, true
		}
		select {
		case ping := <-sub.C:
			if acceptsWalmartPing(ping, keys, since) {
				return ping, true
			}
		case <-poll.C:
		case <-t.TaskContext.CTX.Done():
			return monitorhub.StockPing{}, false
		}
	}
}

func acceptsWalmartPing(ping monitorhub.StockPing, keys []string, since time.Time) bool {
	if !strings.EqualFold(ping.Site, "Walmart") || !ping.At.After(since) || ping.ProductKey == "" {
		return false
	}
	for _, key := range keys {
		if key == ping.ProductKey {
			return true
		}
	}
	return false
}
