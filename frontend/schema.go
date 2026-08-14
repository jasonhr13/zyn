package frontend

import "encoding/json"

type MessageEnvelope struct {
	Type     string            `json:"type"`
	Messages []json.RawMessage `json:"messages"`
}

type TaskItemMessage struct {
	Id           string   `json:"id"`
	MonitorInput string   `json:"monitorInput"`
	Quantity     string   `json:"quantity"`
	MaxPrice     string   `json:"maxPrice,omitempty"`
	Color        string   `json:"color"`
	Sizes        []string `json:"sizes"`
	Priority     bool     `json:"priority,omitempty"`
}

type StartTaskMessage struct {
	Id           string            `json:"id"`
	Type         string            `json:"type"`
	TaskGroup    string            `json:"taskGroup"`
	MonitorDelay string            `json:"monitorDelay"`
	RetryDelay   string            `json:"retryDelay"`
	ProxyGroup    string            `json:"proxyGroup"`
	ProxySources  []string          `json:"proxySources,omitempty"`
	ProfileId    string            `json:"profileId"`
	ProfileGroup string            `json:"profileGroup"`
	AccountId    string            `json:"accountId"`
	Site         string            `json:"site"`
	Item         []TaskItemMessage `json:"item"`
	MonitorItems []TaskItemMessage `json:"monitorItems"`
	Status       string            `json:"status"`
	Mode         string            `json:"mode"`
	MinPrice     string            `json:"minPrice"`
	MaxPrice     string            `json:"maxPrice"`
	StatusColor  string            `json:"statusColor"`
	Running      bool              `json:"running"`
	Carted       bool              `json:"carted"`
	Failed       bool              `json:"failed"`
	Successful   bool              `json:"successful"`

	LoopCheckout    bool   `json:"loopCheckout"`
	WaitForQueue    bool   `json:"waitForQueue"`
	QueueEntryDelay string `json:"QueueEntryDelay"`
	AllInstock      bool   `json:"allInstock"`
	Endless         bool   `json:"endless"`
	UseFillerItem   bool   `json:"useFillerItem"`
	UseOtpLogin     bool   `json:"useOtpLogin"`

	StartSchedule string `json:"startSchedule"`
	StopSchedule  string `json:"stopSchedule"`

	IgnoreLowStock bool `json:"ignoreLowStock"`
}

type StopTaskMessage struct {
	Id string `json:"id"`
}

type MonitorItemMessage struct {
	MonitorInput string `json:"monitorInput"`
	Quantity     string `json:"quantity"`
	MaxPrice     string `json:"maxPrice"`
}

// StartMonitorMessage starts a global monitor worker (not a checkout task).
type StartMonitorMessage struct {
	Id             string               `json:"id"`
	Site           string               `json:"site"`
	ProxyGroup     string               `json:"proxyGroup"`
	MonitorDelay   string               `json:"monitorDelay"`
	IgnoreLowStock bool                 `json:"ignoreLowStock"`
	ProxySources   []string             `json:"proxySources,omitempty"`
	Items          []MonitorItemMessage `json:"items"`
}

type SentMessage struct {
	Type     string `json:"type"`
	Messages []any  `json:"messages"`
}

type ConfigsStruct struct {
	Settings     string `json:"settings"`
	ProfileList  string `json:"profileList"`
	ProxyListRaw string `json:"proxyList"`
	AccountList  string `json:"accountList"`
}

type WebhooksStruct struct {
	Checkout       string `json:"checkout"`
	Decline        string `json:"decline"`
	PublicCheckout string `json:"publicCheckout"`
	PublicDecline  string `json:"publicDecline"`
	Misc           string `json:"misc"`
}

type SettingsPayload struct {
	Webhooks              WebhooksStruct `json:"webhooks"`
	LucaApiKey            string         `json:"lucaApiKey"`
	ShapeMethod           string         `json:"shapeMethod"`
	ThrottleFallbackGroup string         `json:"throttleFallbackGroup"`
}

type StockPingMessage struct {
	Site       string  `json:"site"`
	ProductKey string  `json:"productKey"`
	Name       string  `json:"name"`
	Image      string  `json:"image"`
	Price      float64 `json:"price"`
	StockLevel int     `json:"stockLevel"`
	InStock    bool    `json:"inStock"`
	From       string  `json:"from"`
}

type SetTaskProxyMessage struct {
	ID           string   `json:"id"`
	ProxyGroup   string   `json:"proxyGroup"`
	ProxySources []string `json:"proxySources,omitempty"`
}

type CaptchaSolvePayload struct {
	TaskId string `json:"taskId"`
	Token  string `json:"token"`
}

type HyperResponseMessage struct {
	RequestID string `json:"requestId"`
	TaskID    string `json:"taskId"`
	Site      string `json:"site"`
	OK        bool   `json:"ok"`
	Status    int    `json:"status"`
	Body      string `json:"body"`
	Error     string `json:"error"`
}

type ImapCodeResponse struct {
	Email string `json:"email"`
	Code  string `json:"code"`
	Site  string `json:"site"`
}
