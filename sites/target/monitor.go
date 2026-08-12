package target

import (
	"sort"
	"time"

	"zynbot.app/engine/bot-base/proxy"
	"zynbot.app/engine/bot-base/task"
	"zynbot.app/engine/bot-base/task/constants"
	monitorhub "zynbot.app/engine/monitor-hub"
)

func (t *TargetMonitorTask) applyRuntimeEdit(p task.RuntimeEditPayload) {
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
	t.IgnoreLowStock = p.Input.IgnoreLowStock

	items := p.MonitorItems
	if len(items) == 0 {
		items = p.Input.MonitorItems
	}
	if len(items) == 0 {
		items = p.Input.Items
	}
	if len(items) > 0 {
		monitorInputs := make([]MonitorInput, 0, len(items))
		for _, item := range items {
			tcin := parseTcinFromInput(item.MonitorInput)
			if tcin == "" {
				continue
			}
			monitorInputs = append(monitorInputs, MonitorInput{
				Tcin:     tcin,
				Qty:      item.Quantity,
				MaxPrice: item.MaxPrice,
			})
		}
		if len(monitorInputs) > 0 {
			t.MonitorInputs = monitorInputs
			t.SetMonitorBandwidthWatchedItems(len(monitorInputs))
			if t.missingTcins != nil {
				keep := make(map[string]struct{})
				for _, in := range monitorInputs {
					if _, ok := t.missingTcins[in.Tcin]; ok {
						keep[in.Tcin] = struct{}{}
					}
				}
				t.missingTcins = keep
			}
		}
	}
}

func (t *TargetMonitorTask) Monitor() {
	defer CatchMonitorError(t)
	defer t.FinishMonitorBandwidth()
	if t.lastInStock == nil {
		t.lastInStock = make(map[string]bool)
	}
	if t.missingTcins == nil {
		t.missingTcins = make(map[string]struct{})
	}
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
				if err := t.BaseTask.EnsureTLSClient(false); err != nil {
					t.UpdateStatus("Error Building Client", constants.Colors.RED)
					t.SleepTask(t.ErrorDelay)
					break
				}
				_ = t.BaseTask.SwapProxy("Target")
				t.UpdateStatus("Getting Product(s)", constants.Colors.BLUE)
				t.GetStock()
				t.ObserveMonitorBandwidthPoll(t.Error != nil)
				if t.HandleMonitorErrors("get-stock") {
					break
				}

				byTcin := make(map[string]ProductSummary, len(t.ProductStock))
				for _, stock := range t.ProductStock {
					byTcin[stock.Tcin] = stock
					delete(t.missingTcins, stock.Tcin)
				}
				titles := make(map[string]string, len(byTcin))
				for tcin, stock := range byTcin {
					if title := stock.Item.ProductDescription.Title; title != "" {
						titles[tcin] = title
					}
				}
				missing := make([]string, 0, len(t.missingTcins))
				for tcin := range t.missingTcins {
					missing = append(missing, tcin)
				}
				sort.Strings(missing)
				task.SendProductTitles(titles, missing)

				anyInStock := false
				for _, input := range t.MonitorInputs {
					stock, ok := byTcin[input.Tcin]
					if !ok {
						if _, missing := t.missingTcins[input.Tcin]; !missing {
							continue
						}
						ping := monitorhub.StockPing{
							Site:       "Target",
							ProductKey: input.Tcin,
							InStock:    false,
							At:         time.Now(),
							From:       "local",
						}
						isTransition := t.shouldPublish(input.Tcin, ping.InStock)
						monitorhub.Default.Publish(ping)
						if isTransition {
							monitorhub.SendToServer(ping)
						}
						continue
					}

					inStock := stock.Fulfillment.ShippingOptions.AvailabilityStatus == "IN_STOCK" || stock.Fulfillment.ShippingOptions.AvailabilityStatus == "PRE_ORDER_SELLABLE"
					if inStock && t.IgnoreLowStock && !monitorhub.IsFullStock(int(stock.Fulfillment.ShippingOptions.AvailableToPromiseQuantity)) {
						inStock = false
					}
					price := float64(stock.Price.CurrentRetail)
					maxPrice := input.MaxPrice
					if maxPrice <= 0 {
						maxPrice = t.MaxPrice
					}
					if inStock && t.MinPrice > 0 && (price <= 0 || price < t.MinPrice) {
						inStock = false
					}
					if inStock && maxPrice > 0 && !monitorhub.PingWithinMaxPrice(monitorhub.StockPing{Price: price}, maxPrice) {
						inStock = false
					}
					if inStock {
						anyInStock = true
					}

					ping := monitorhub.StockPing{
						Site:       "Target",
						ProductKey: input.Tcin,
						InStock:    inStock,
						At:         time.Now(),
						From:       "local",
					}
					if inStock {
						ping.Name = stock.Item.ProductDescription.Title
						ping.Image = stock.Item.Enrichment.Images.PrimaryImageURL
						ping.Price = price
						ping.Quantity = input.Qty
						ping.StockLevel = int(stock.Fulfillment.ShippingOptions.AvailableToPromiseQuantity)
					}

					isTransition := t.shouldPublish(input.Tcin, ping.InStock)
					monitorhub.Default.Publish(ping)
					if isTransition {
						monitorhub.SendToServer(ping)
					}
				}

				if anyInStock {
					t.UpdateStatus("Product In Stock", constants.Colors.GREEN)
				} else {
					t.UpdateStatus("Out of Stock", constants.Colors.RED)
				}
				t.SleepTask(t.MonitorDelay)
			}
		}
	}
}

func (t *TargetMonitorTask) shouldPublish(tcin string, inStock bool) bool {
	prev, seen := t.lastInStock[tcin]
	t.lastInStock[tcin] = inStock
	if seen && prev == inStock {
		return false
	}
	if !seen && !inStock {
		return false
	}
	return true
}
