package monitorhub

import (
	"sync"
	"time"
)

type StockPing struct {
	Site       string
	ProductKey string
	OfferId    string
	Name       string
	Image      string
	Price      float64
	Quantity   int
	StockLevel int
	QueueId    string
	InStock    bool
	At         time.Time
	From       string
	Raw        string
}

type Hub struct {
	mu          sync.RWMutex
	pings       map[string]StockPing
	subscribers map[*subscriber]struct{}
}

type subscriber struct {
	ch chan StockPing
}

type Subscription struct {
	C   <-chan StockPing
	hub *Hub
	sub *subscriber
}

type CloudPing struct {
	Site string `json:"site"`
	Type string `json:"type"`
}

type TargetPing struct {
	Name       string  `json:"title"`
	Image      string  `json:"image"`
	Tcin       string  `json:"tcin"`
	TotalStock string  `json:"totalstock"`
	CartLimit  string  `json:"cartlimit"`
	Price      float64 `json:"price"`
	InStock    *bool   `json:"instock"` // nil = in stock (Discord)
}

type WalmartPing struct {
	Image   string  `json:"image"`
	InStock *bool   `json:"instock"` // nil = in stock (Discord)
	Price   float64 `json:"price"`
	QueueId string  `json:"queueid"`
	Tcin    string  `json:"tcin"`
	Title   string  `json:"title"`
	OfferId string  `json:"offerId"`
}

type ZephyrPing struct {
	WebsiteName string `json:"websiteName"`
	Type        string `json:"type"`
}

type TargetZephyrPing struct {
	Name       string `json:"title"`
	Image      string `json:"imageUrl"`
	Tcin       string `json:"id"`
	TotalStock int    `json:"stockQuantity"`
	CartLimit  int    `json:"cartLimit"`
	Price      string `json:"price"`
	InStock    *bool  `json:"stock"` // nil = in stock (Discord)
}

type WalmartZephyrQueuePing struct {
	Title    string `json:"title"`
	QueueId  string `json:"queueId"`
	Price    string `json:"price"`
	ImageUrl string `json:"imageUrl"`
	Id       string `json:"id"`
	Stock    bool   `json:"stock"`
}

type WalmartProductPing struct {
	Title     string `json:"title"`
	Id        int    `json:"id"`
	OfferId   string `json:"offerId"`
	Price     string `json:"price"`
	ImageUrl  string `json:"imageUrl"`
	CartLimit int    `json:"cartLimit"`
	Stock     bool   `json:"stock"`
}
