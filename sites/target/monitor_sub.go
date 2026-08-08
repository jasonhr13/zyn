package target

import (
	"strings"
	"time"

	"github.com/PolarAIO/Polar-AIO/backend/bot-base/task"
	monitorhub "github.com/PolarAIO/Polar-AIO/backend/monitor-hub"
	"github.com/PolarAIO/Polar-AIO/backend/sites"
)

func (t *TargetTask) matchKeys() []string {
	src := t.MonitorItems
	if len(src) == 0 {
		src = t.Inputs
	}
	keys := make([]string, 0, len(src))
	seen := make(map[string]struct{}, len(src))
	for _, in := range src {
		tcin := parseTcinFromInput(in.Input)
		if tcin == "" {
			continue
		}
		if _, dup := seen[tcin]; dup {
			continue
		}
		seen[tcin] = struct{}{}
		keys = append(keys, tcin)
	}
	return keys
}

func (t *TargetTask) monitorItemsSrc() []sites.Input {
	if len(t.MonitorItems) > 0 {
		return t.MonitorItems
	}
	return t.Inputs
}

func (t *TargetTask) monitorQtyForTCIN(tcin string) int {
	if tcin == "" {
		return 0
	}
	for _, in := range t.monitorItemsSrc() {
		if parseTcinFromInput(in.Input) == tcin {
			return in.Quantity
		}
	}
	return 0
}

func (t *TargetTask) monitorMaxPriceForTCIN(tcin string) float64 {
	if tcin == "" {
		return t.MaxPrice
	}
	for _, in := range t.monitorItemsSrc() {
		if parseTcinFromInput(in.Input) == tcin {
			if in.MaxPrice > 0 {
				return in.MaxPrice
			}
			break
		}
	}
	return t.MaxPrice
}

func (t *TargetTask) waitForStockPing() (monitorhub.StockPing, bool) {
	since := t.stockWaitAfter
	sub := monitorhub.Default.Subscribe()
	defer sub.Close()

	refresh := time.NewTimer(1 * time.Hour)
	defer refresh.Stop()
	poll := time.NewTicker(500 * time.Millisecond)
	defer poll.Stop()
	for {
		t.DrainPendingRuntimeEdits(func(p task.RuntimeEditPayload) {
			t.applyRuntimeEdit(p)
		})
		keys := t.matchKeys()
		if len(keys) == 0 {
			return monitorhub.StockPing{}, false
		}
		if ping, ok := t.matchStock(keys, since); ok {
			return ping, true
		}
		select {
		case ping := <-sub.C:
			if t.acceptsTargetPing(ping, keys, since) {
				return ping, true
			}
		case <-poll.C:
		case <-refresh.C:
			t.taskStartedAt = time.Now()
			t.StepAfterSolve = "wait-for-restock"
			t.NextStep = "refresh-login"
			return monitorhub.StockPing{}, false
		case <-t.TaskContext.CTX.Done():
			return monitorhub.StockPing{}, false
		}
	}
}

func (t *TargetTask) matchStock(keys []string, since time.Time) (monitorhub.StockPing, bool) {
	for _, key := range keys {
		ping, ok := monitorhub.Default.Match("Target", []string{key}, since)
		if !ok || !t.acceptsTargetPing(ping, []string{key}, since) {
			continue
		}
		return ping, true
	}
	return monitorhub.StockPing{}, false
}

func (t *TargetTask) acceptsTargetPing(ping monitorhub.StockPing, keys []string, since time.Time) bool {
	if !ping.InStock {
		return false
	}
	if !strings.EqualFold(ping.Site, "Target") {
		return false
	}
	if since.IsZero() {
		if ping.At.IsZero() {
			return false
		}
	} else if !ping.At.After(since) {
		return false
	}
	matched := false
	for _, key := range keys {
		if key == ping.ProductKey {
			matched = true
			break
		}
	}
	if !matched {
		return false
	}
	maxPrice := t.monitorMaxPriceForTCIN(ping.ProductKey)
	if maxPrice > 0 && !monitorhub.PingWithinMaxPrice(ping, maxPrice) {
		return false
	}
	return true
}

func (t *TargetTask) bailToRestock() {
	t.bailToRestockRequireFresh(true)
}

func (t *TargetTask) bailToRestockKeepSignal() {
	t.bailToRestockRequireFresh(false)
}

func (t *TargetTask) bailToRestockRequireFresh(requireFresh bool) {
	if requireFresh {
		// Shared OOS: park every task mid-checkout via maybeBailRestock /
		// IsInStock. Each task still keeps its own watermark so when the
		// monitor republishes in-stock, all waiters fire again — not just one.
		if t.RestockTCIN != "" {
			monitorhub.MarkOutOfStock("Target", t.RestockTCIN)
		}
		if !t.StockPing.At.IsZero() {
			t.stockWaitAfter = t.StockPing.At
		} else {
			t.stockWaitAfter = time.Now()
		}
	}
	t.ShapeBlockCount = 0
	t.StepAfterSolve = ""
	t.ShapeHeaders = ShapeHeaders{}
	t.ShapeMethod = ""
	t.NextStep = "wait-for-restock"
	t.Error = nil
}

func (t *TargetTask) maybeBailRestock() bool {
	if t.RestockTCIN == "" || monitorhub.IsInStock("Target", t.RestockTCIN) {
		return false
	}
	// Hub was marked OOS (another task's ATC, or monitor). Join them in wait
	// without re-publishing OOS (already cleared).
	if !t.StockPing.At.IsZero() {
		t.stockWaitAfter = t.StockPing.At
	} else {
		t.stockWaitAfter = time.Now()
	}
	t.ShapeBlockCount = 0
	t.StepAfterSolve = ""
	t.ShapeHeaders = ShapeHeaders{}
	t.ShapeMethod = ""
	t.NextStep = "wait-for-restock"
	t.Error = nil
	return true
}
