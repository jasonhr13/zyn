package monitorhub

import (
	"encoding/json"
	"strconv"
	"strings"
	"time"
)

var sendToServer func(StockPing)

func SetStockPingSender(fn func(StockPing)) {
	sendToServer = fn
}

func SendToServer(ping StockPing) {
	if sendToServer != nil {
		sendToServer(ping)
	}
}

func HandleCloudPing(data []byte) {
	if ping, ok := parseCloudPing(data); ok {
		Default.Publish(ping)
	}
}

func HandleZephyrPing(data []byte) {
	if ping, ok := parseZephyrPing(data); ok {
		Default.Publish(ping)
	}
}

func parseCloudPing(data []byte) (StockPing, bool) {
	var head CloudPing
	if err := json.Unmarshal(data, &head); err != nil {
		return StockPing{}, false
	}
	switch head.Site {
	case "Target":
		var p TargetPing
		if err := json.Unmarshal(data, &p); err != nil || strings.TrimSpace(p.Tcin) == "" {
			return StockPing{}, false
		}
		inStock := p.InStock == nil || *p.InStock
		stock, _ := strconv.Atoi(strings.TrimSpace(p.TotalStock))
		qty, _ := strconv.Atoi(strings.TrimSpace(p.CartLimit))
		return StockPing{
			Site:       "Target",
			ProductKey: strings.TrimSpace(p.Tcin),
			Name:       p.Name,
			Image:      p.Image,
			Price:      p.Price,
			Quantity:   qty,
			StockLevel: stock,
			InStock:    inStock,
			At:         time.Now(),
			From:       "Cloud",
			Raw:        string(data),
		}, true
	case "Walmart":
		var p WalmartPing
		if err := json.Unmarshal(data, &p); err != nil || strings.TrimSpace(p.Tcin) == "" {
			return StockPing{}, false
		}
		inStock := p.InStock == nil || *p.InStock
		return StockPing{
			Site:       "Walmart",
			ProductKey: strings.TrimSpace(p.Tcin),
			Name:       p.Title,
			Image:      p.Image,
			Price:      p.Price,
			QueueId:    p.QueueId,
			InStock:    inStock,
			OfferId:    p.OfferId,
			At:         time.Now(),
			From:       "Cloud",
			Raw:        string(data),
		}, true
	case "PokemonCenter":
		if head.Type == "Queue is up!" || head.Type == "Hcaptcha is up (Stage 2)" {
			return StockPing{
				Site:       "PokemonCenter",
				ProductKey: "queue",
				Name:       head.Type,
				InStock:    true,
				At:         time.Now(),
				From:       "Cloud",
				Raw:        string(data),
			}, true
		}
		return StockPing{}, false
	default:
		// log.Printf("monitor-hub: unknown cloud ping: %s", data)
		return StockPing{}, false
	}
}

func parseZephyrPing(data []byte) (StockPing, bool) {
	var head ZephyrPing
	if err := json.Unmarshal(data, &head); err != nil {
		return StockPing{}, false
	}
	switch head.Type {
	case "target":
		var p TargetZephyrPing
		if err := json.Unmarshal(data, &p); err != nil || strings.TrimSpace(p.Tcin) == "" {
			return StockPing{}, false
		}
		inStock := p.InStock == nil || *p.InStock

		priceStr := strings.TrimSpace(p.Price)
		priceStr = strings.TrimPrefix(priceStr, "$")

		price, _ := strconv.ParseFloat(priceStr, 64)
		return StockPing{
			Site:       "Target",
			ProductKey: strings.TrimSpace(p.Tcin),
			Name:       p.Name,
			Image:      p.Image,
			Price:      price,
			Quantity:   p.CartLimit,
			StockLevel: p.TotalStock,
			InStock:    inStock,
			At:         time.Now(),
			From:       "ZCloud",
			Raw:        string(data),
		}, true

	case "pokemon_center_captcha":
		return StockPing{
			Site:       "PokemonCenter",
			ProductKey: "queue",
			Name:       head.Type,
			InStock:    true,
			At:         time.Now(),
			From:       "ZCloud",
			Raw:        string(data),
		}, true

	case "pokemon_center_queue":
		return StockPing{
			Site:       "PokemonCenter",
			ProductKey: "queue",
			Name:       head.Type,
			InStock:    true,
			At:         time.Now(),
			From:       "ZCloud",
			Raw:        string(data),
		}, true

	case "walmart_queue":
		var p WalmartZephyrQueuePing
		if err := json.Unmarshal(data, &p); err != nil {
			return StockPing{}, false
		}
		priceStr := strings.TrimSpace(p.Price)
		priceStr = strings.TrimPrefix(priceStr, "$")

		price, _ := strconv.ParseFloat(priceStr, 64)
		return StockPing{
			Site:       "Walmart",
			QueueId:    p.QueueId,
			ProductKey: p.Id,
			Name:       p.Title,
			Image:      p.ImageUrl,
			Price:      price,
			InStock:    p.Stock,
			At:         time.Now(),
			From:       "ZCloud",
			Raw:        string(data),
		}, true

	case "walmart":
		var p WalmartProductPing
		if err := json.Unmarshal(data, &p); err != nil {
			return StockPing{}, false
		}
		priceStr := strings.TrimSpace(p.Price)
		priceStr = strings.TrimPrefix(priceStr, "$")

		price, _ := strconv.ParseFloat(priceStr, 64)
		if p.OfferId == "" {
			return StockPing{}, false
		}
		return StockPing{
			Site:       "Walmart",
			ProductKey: strconv.Itoa(p.Id),
			Name:       p.Title,
			Image:      p.ImageUrl,
			Price:      price,
			InStock:    p.Stock,
			OfferId:    p.OfferId,
			Quantity:   p.CartLimit,
			At:         time.Now(),
			From:       "ZCloud",
			Raw:        string(data),
		}, true

	default:
		// log.Printf("monitor-hub: unknown zephyr ping: %s", data)
		return StockPing{}, false
	}
}
