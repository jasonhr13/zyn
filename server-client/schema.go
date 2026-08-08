package serverclient

import "encoding/json"

type ServerMessage struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

type FrontendUserDataMessage struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

type ServerEventMessage struct {
	Type            string  `json:"type"`
	EventID         string  `json:"event-id,omitempty"`
	EventType       string  `json:"event-type"`
	ProductName     string  `json:"product-name"`
	ProductPrice    float64 `json:"product-price"`
	OrderNumber     string  `json:"order-number"`
	ProductQuantity int     `json:"product-quantity"`
	ProductImage    string  `json:"product-image"`
	Site            string  `json:"site"`
	Size            string  `json:"size"`
	TaskID          string  `json:"task-id"`
	Timestamp       int64   `json:"timestamp"`
	ProfileName     string  `json:"profile-name"`
	ProxyGroup      string  `json:"proxy-group"`
}
