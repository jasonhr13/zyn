package target

import (
	"strings"
	"time"

	"zynbot.app/engine/bot-base/task"
	"zynbot.app/engine/bot-base/task/constants"
	monitorhub "zynbot.app/engine/monitor-hub"
	"zynbot.app/engine/sites"
)

func (t *TargetTask) matchKeys() []string {
	src := t.monitorItemsSrc()
	type keyed struct {
		tcin     string
		priority bool
	}
	ordered := make([]keyed, 0, len(src))
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
		ordered = append(ordered, keyed{tcin: tcin, priority: in.Priority})
	}
	keys := make([]string, 0, len(ordered))
	for _, item := range ordered {
		if item.priority {
			keys = append(keys, item.tcin)
		}
	}
	for _, item := range ordered {
		if !item.priority {
			keys = append(keys, item.tcin)
		}
	}
	return keys
}

func (t *TargetTask) priorityKeys() []string {
	keys := make([]string, 0)
	seen := make(map[string]struct{})
	for _, in := range t.monitorItemsSrc() {
		if !in.Priority {
			continue
		}
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

func (t *TargetTask) watchesTCIN(tcin string) bool {
	if tcin == "" {
		return false
	}
	for _, key := range t.matchKeys() {
		if key == tcin {
			return true
		}
	}
	return false
}

func (t *TargetTask) monitorPriorityForTCIN(tcin string) bool {
	if tcin == "" {
		return false
	}
	for _, in := range t.monitorItemsSrc() {
		if parseTcinFromInput(in.Input) == tcin {
			return in.Priority
		}
	}
	return false
}

func (t *TargetTask) checkoutCommitted() bool {
	if t == nil || t.BaseTask == nil {
		return false
	}
	if t.Checkout || t.TaskState == constants.StatusSteps.CheckedOut {
		return true
	}
	switch t.NextStep {
	case "submit-order", "oos-check-cart", "remove-payment", "wait-to-check", "check-order", "cancel-filler", "checkout", "decline", "stop":
		return true
	default:
		return false
	}
}

func (t *TargetTask) shouldAbandonSelected() (string, bool) {
	if t == nil || t.checkoutCommitted() || t.RestockTCIN == "" {
		return "", false
	}
	if t.watchesTCIN(t.RestockTCIN) {
		return "", false
	}
	return "SKU removed from watch list", true
}

func (t *TargetTask) shouldPivotToPriority() (string, bool) {
	if t == nil || t.checkoutCommitted() || t.RestockTCIN == "" {
		return "", false
	}
	if t.monitorPriorityForTCIN(t.RestockTCIN) {
		return "", false
	}
	for _, key := range t.priorityKeys() {
		ping, ok := monitorhub.Default.Match("Target", []string{key}, time.Time{})
		if !ok || !t.acceptsTargetPing(ping, []string{key}, time.Time{}) {
			continue
		}
		return "Switching to priority SKU", true
	}
	return "", false
}

func (t *TargetTask) applyWatchListSelectionChange() bool {
	if reason, ok := t.shouldAbandonSelected(); ok {
		t.abandonSelectedProduct(reason)
		return true
	}
	if reason, ok := t.shouldPivotToPriority(); ok {
		t.abandonSelectedProduct(reason)
		return true
	}
	return false
}

func (t *TargetTask) abandonSelectedProduct(reason string) {
	if t == nil || t.checkoutCommitted() {
		return
	}
	if reason != "" && t.BaseTask != nil {
		t.UpdateStatus(reason, constants.Colors.YELLOW)
		t.AddLog(reason)
	}
	hadProductCart := t.BaseTask != nil && t.TaskState == constants.StatusSteps.Carted
	t.bailToRestockKeepSignal()
	t.RestockTCIN = ""
	t.RestockQty = 0
	t.StockPing = monitorhub.StockPing{}
	if hadProductCart {
		t.NextStep = "clear-cart"
	}
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
	fallback := 0.0
	if t != nil && t.BaseTask != nil {
		fallback = t.MaxPrice
	}
	if tcin == "" {
		return fallback
	}
	for _, in := range t.monitorItemsSrc() {
		if parseTcinFromInput(in.Input) == tcin {
			if in.MaxPrice > 0 {
				return in.MaxPrice
			}
			break
		}
	}
	return fallback
}

func targetPingMeetsControls(ping monitorhub.StockPing, maxPrice float64, confirmedStock bool) bool {
	if confirmedStock && ping.StockLevel < monitorhub.FullStockLevel {
		return false
	}
	if maxPrice > 0 && (ping.Price <= 0 || ping.Price > maxPrice) {
		return false
	}
	return true
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
	if !targetPingMeetsControls(ping, maxPrice, t.IgnoreLowStock) {
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
