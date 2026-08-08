package monitorhub

import (
	"strings"
	"time"
)

var Default = NewHub()

const FullStockLevel = 10

const subscriberBuffer = 64

func isFreshInStock(ping StockPing) bool {
	return ping.InStock
}

func NewHub() *Hub {
	return &Hub{
		pings:       make(map[string]StockPing),
		subscribers: make(map[*subscriber]struct{}),
	}
}

func (h *Hub) Subscribe() *Subscription {
	s := &subscriber{ch: make(chan StockPing, subscriberBuffer)}
	h.mu.Lock()
	if h.subscribers == nil {
		h.subscribers = make(map[*subscriber]struct{})
	}
	h.subscribers[s] = struct{}{}
	h.mu.Unlock()
	return &Subscription{C: s.ch, hub: h, sub: s}
}

func (s *Subscription) Close() {
	if s == nil || s.hub == nil {
		return
	}
	s.hub.mu.Lock()
	delete(s.hub.subscribers, s.sub)
	s.hub.mu.Unlock()
}

func pingKey(site, productKey string) string {
	return site + ":" + productKey
}

func IsFullStock(stockLevel int) bool {
	return stockLevel <= 0 || stockLevel >= FullStockLevel
}

func PingWithinMaxPrice(ping StockPing, maxPrice float64) bool {
	if maxPrice <= 0 {
		return true
	}
	// Unknown/missing prices (common on cloud pings) should not reject —
	// only enforce MaxPrice when we actually have a price.
	if ping.Price <= 0 {
		return true
	}
	return ping.Price <= maxPrice
}

func (h *Hub) Publish(ping StockPing) {
	if h == nil || ping.Site == "" || ping.ProductKey == "" {
		return
	}
	if ping.At.IsZero() {
		ping.At = time.Now()
	}
	h.mu.Lock()
	h.pings[pingKey(ping.Site, ping.ProductKey)] = ping
	var subs []chan StockPing
	if ping.InStock {
		subs = make([]chan StockPing, 0, len(h.subscribers))
		for s := range h.subscribers {
			subs = append(subs, s.ch)
		}
	}
	h.mu.Unlock()

	// Non-blocking deliver to every subscriber. Dropped channel sends are fine:
	// waiters also poll Match() against the stored ping, so stock is not lost.
	for _, ch := range subs {
		deliver(ch, ping)
	}
}

func MarkOutOfStock(site, productKey string) {
	if productKey == "" {
		return
	}
	Default.Publish(StockPing{
		Site:       site,
		ProductKey: productKey,
		InStock:    false,
		At:         time.Now(),
	})
}

func IsInStock(site, productKey string) bool {
	if productKey == "" {
		return false
	}
	Default.mu.RLock()
	defer Default.mu.RUnlock()
	ping, ok := Default.pings[pingKey(site, productKey)]
	return ok && isFreshInStock(ping)
}

func deliver(ch chan StockPing, ping StockPing) {
	select {
	case ch <- ping:
	default:
	}
}

func (h *Hub) Match(site string, productKeys []string, since time.Time) (StockPing, bool) {
	return h.match(strings.TrimSpace(site), productKeys, since)
}

func (h *Hub) match(site string, productKeys []string, since time.Time) (StockPing, bool) {
	if len(productKeys) == 0 {
		return StockPing{}, false
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	for _, key := range productKeys {
		if key == "" {
			continue
		}

		ping, ok := h.pings[pingKey(site, key)]
		if !ok {
			continue
		}

		if !isFreshInStock(ping) {
			continue
		}

		// since zero => accept any current in-stock ping (first wait / catch-up).
		// since set => require a strictly newer At so a task doesn't rematch the
		// same signal it already consumed after a failed ATC.
		if since.IsZero() {
			if ping.At.IsZero() {
				continue
			}
		} else if !ping.At.After(since) {
			continue
		}

		return ping, true
	}
	return StockPing{}, false
}
