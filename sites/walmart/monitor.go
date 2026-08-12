package walmart

import (
	"zynbot.app/engine/bot-base/proxy"
	"zynbot.app/engine/bot-base/task"
	"zynbot.app/engine/bot-base/task/constants"
	monitorhub "zynbot.app/engine/monitor-hub"
)

func (t *WalmartMonitorTask) applyRuntimeEdit(p task.RuntimeEditPayload) {
	if p.Input.MonitorDelay > 0 {
		t.MonitorDelay = p.Input.MonitorDelay
	}
	if p.Input.MinPrice > 0 {
		t.MinPrice = p.Input.MinPrice
	}
	if p.Input.MaxPrice > 0 {
		t.MaxPrice = p.Input.MaxPrice
	}
	if p.Input.RetryDelay > 0 {
		t.ErrorDelay = p.Input.RetryDelay
	}
	if p.Input.Proxy != "" {
		if p.Input.Proxy != t.ProxyGroup {
			proxy.ReleaseProxy(t.ProxyGroup, t.ID)
		}
		t.ProxyGroup = p.Input.Proxy
	}

	items := p.MonitorItems
	if len(items) == 0 {
		items = p.Input.MonitorItems
	}
	if len(items) == 0 {
		items = p.Input.Items
	}
	if len(items) > 0 {
		pid := parsePidFromInput(items[0].MonitorInput)
		if pid != "" {
			t.Pid = pid
		}
		if items[0].MaxPrice > 0 {
			t.MaxPrice = items[0].MaxPrice
		}
	}
}

func (t *WalmartMonitorTask) Monitor() {
	defer CatchMonitorError(t)
	defer t.FinishMonitorBandwidth()
	for {
		select {
		case <-t.TaskContext.CTX.Done():
			return
		default:
			t.Error = nil
			t.DrainPendingRuntimeEdits(func(p task.RuntimeEditPayload) {
				t.applyRuntimeEdit(p)
			})
			switch t.NextStep {
			case "stop":
				t.StopTask("Idle", constants.Colors.DEFAULT)

			case "get-stock":
				if err := t.BaseTask.EnsureTLSClient(true); err != nil {
					t.UpdateStatus("Error Building Client", constants.Colors.RED)
					t.SleepTask(t.ErrorDelay)
					break
				}
				_ = t.BaseTask.SwapProxy("Walmart")
				t.UpdateStatus("Getting Product(s)", constants.Colors.BLUE)
				t.GetProductGraphql()
				t.ObserveMonitorBandwidthPoll(t.Error != nil)
				if t.HandleMonitorErrors("get-stock") {
					break
				}

				isQueue := t.MonitorProduct.InStock == "QUEUE"
				inStock := t.MonitorProduct.InStock == "IN_STOCK" || isQueue
				price := t.MonitorProduct.CurrentPrice
				if inStock && t.MinPrice > 0 && (price <= 0 || price < t.MinPrice) {
					inStock = false
				}
				if inStock && t.MaxPrice > 0 && !monitorhub.PingWithinMaxPrice(monitorhub.StockPing{Price: price}, t.MaxPrice) {
					inStock = false
				}

				ping := monitorhub.StockPing{}
				if inStock {
					ping.Site = "Walmart"
					ping.ProductKey = t.MonitorProduct.ItemID
					ping.OfferId = t.MonitorProduct.OfferId
					ping.Name = t.MonitorProduct.Name
					ping.Image = t.MonitorProduct.ImageURL
					ping.Price = price
					ping.QueueId = t.MonitorProduct.QueueID
					ping.Quantity = t.MonitorProduct.MaxQty
					ping.From = "local"
					ping.InStock = true
				}
				if inStock {
					monitorhub.SendToServer(ping)
				}
				if inStock && ping.ProductKey != "" {
					monitorhub.Default.Publish(ping)
					t.MonitorProduct = MonitorProduct{}
				}
				if t.PxBlocked {
					t.UpdateStatus("PX Blocked", constants.Colors.RED)
					t.PxBlocked = false
				} else if inStock && isQueue {
					t.UpdateStatus("Found Queue", constants.Colors.GREEN)
				} else if inStock {
					t.UpdateStatus("In Stock", constants.Colors.GREEN)
				} else {
					t.UpdateStatus("Out of Stock", constants.Colors.RED)
				}
				t.SleepTask(t.MonitorDelay)
			}
		}
	}
}
