package task

import (
	"context"
	"sync"

	tls_client "github.com/bogdanfinn/tls-client"
	"zynbot.app/engine/bot-base/accounts"
)

type BaseTask struct {
	Site        string       `json:"site"`
	Mode        string       `json:"mode"`
	Running     bool         `json:"-"` // Control whether the task is running or not
	TaskState   int          `json:"-"` // curret task state
	TaskContext *BaseContext `json:"-"` // Use context to stop task utils
	Status      *BaseStatus  `json:"-"` // Information about the running task

	Checkout      bool             `json:"-"`
	Decline       bool             `json:"-"`
	DeclineReason string           `json:"declineReason"`
	ProxyGroup    string           `json:"proxyGroup"`
	Profile       ProfileStruct    `json:"profile"`
	ProfileId     string           `json:"profileId"`
	Account       accounts.Account `json:"account"`
	AccountID     string           `json:"accountId"`
	ID            string           `json:"id"`
	RunID         string           `json:"-"`
	ClientID      string           `json:"clientID"`
	MonitorDelay  int              `json:"monitorDelay"`
	GroupID       string           `json:"groupID"`

	Price    string `json:"-"`
	MinPrice float64
	MaxPrice float64

	Requests *BaseRequestsInfo `json:"-"`

	ErrorDelay          int
	Product             Product
	LastStep            string `json:"-"`
	NextStep            string `json:"-"`
	StepAfterSolve      string `json:"-"`
	Error               error  `json:"-"`
	InputProduct        string `json:"inputProduct"`
	InputSize           string `json:"inputSize"`
	LoopCheckout        bool   `json:"loopCheckout"`
	WaitForQueue        bool   `json:"waitForQueue"`
	QueueEntryDelay     int    `json:"queueEntryDelay"`
	Endless             bool   `json:"endless"`
	UseFillerItem       bool   `json:"useFillerItem"`
	UseOtpLogin         bool   `json:"useOtpLogin"`
	AllInstock          bool   `json:"allInstock"`
	pendingRuntimeEdits chan RuntimeEditPayload
	siteSlotReserved    bool
	stopOnce            sync.Once
	monitorBandwidth    *monitorBandwidthState

	IgnoreLowStock bool `json:"ignoreLowStock"`
}

type ProfileStruct struct {
	Id                   string `json:"id"`
	ProfileGroup         string `json:"profileGroup"`
	ProfileName          string `json:"profileName"`
	Email                string `json:"email"`
	ShippingAddress1     string `json:"shippingAddress1"`
	ShippingAddress2     string `json:"shippingAddress2"`
	ShippingCity         string `json:"shippingCity"`
	ShippingState        string `json:"shippingState"`
	ShippingZip          string `json:"shippingZip"`
	ShippingCountry      string `json:"shippingCountry"`
	ShippingFirstName    string `json:"shippingFirstName"`
	ShippingLastName     string `json:"shippingLastName"`
	BillingAddress1      string `json:"billingAddress1"`
	BillingAddress2      string `json:"billingAddress2"`
	BillingCity          string `json:"billingCity"`
	BillingState         string `json:"billingState"`
	BillingZip           string `json:"billingZip"`
	BillingCountry       string `json:"billingCountry"`
	BillingFirstName     string `json:"billingFirstName"`
	BillingLastName      string `json:"billingLastName"`
	CardName             string `json:"cardName"`
	CardNumber           string `json:"cardNumber"`
	CardExpiryMonth      string `json:"cardExpiryMonth"`
	CardExpiryYear       string `json:"cardExpiryYear"`
	CardCvv              string `json:"cardCvv"`
	Account              string `json:"account"`
	Phone                string `json:"phone"`
	BillingShippingEqual bool   `json:"BillingShippingEqual"`
}

type Product struct {
	Name         string  `json:"name"`
	Price        float64 `json:"price"`
	Size         string  `json:"size"`
	ProductImage string  `json:"productImage"`
	ProductLink  string  `json:"productLink"`
	Sku          string  `json:"sku"`
	MultiCart    bool    `json:"multiCart"`
}

type ProductWebhookData struct {
	Success          bool
	CheckoutProducts []ProductWebhookItem
	Email            string
	Site             string
	ProfileName      string
	Proxy            string
	ProxyGroup       string
	OrderNumber      string
	OrderLink        string
	TaskID           string
	ClientTaskID     string
	RunID            string
	GrandTotal       float64
	ExtraFeilds      map[string]string
	DeclineReason    string
}

type ServerEventData struct {
	EventType       string
	ProductName     string
	ProductPrice    float64
	OrderNumber     string
	ProductQuantity int
	ProductImage    string
	Site            string
	Size            string
	TaskID          string
	ProfileName     string
	ProxyGroup      string
}

type ProductWebhookItem struct {
	SKU         string
	Quantity    int
	Image       string
	Name        string
	Price       float64
	ProductLink string
	Size        string
}

// AnalyticsEventMessage is the local-only outcome envelope consumed by Zyn.
// Authentication and durable upload are intentionally owned by the Electron
// process so the checkout engine never receives user session credentials.
type AnalyticsEventMessage struct {
	EventID     string                 `json:"eventId"`
	EventType   string                 `json:"eventType"`
	Site        string                 `json:"site"`
	TaskID      string                 `json:"taskId,omitempty"`
	RunID       string                 `json:"runId,omitempty"`
	OrderNumber string                 `json:"orderNumber,omitempty"`
	TotalCents  int64                  `json:"totalCents"`
	Items       []AnalyticsProductItem `json:"items"`
	OccurredAt  int64                  `json:"occurredAt"`
}

type AnalyticsProductItem struct {
	SKU            string `json:"sku,omitempty"`
	Name           string `json:"name,omitempty"`
	Image          string `json:"image,omitempty"`
	ProductURL     string `json:"productUrl,omitempty"`
	Size           string `json:"size,omitempty"`
	UnitPriceCents int64  `json:"unitPriceCents"`
	Quantity       int    `json:"quantity"`
}

type BaseContext struct {
	CTX    context.Context    `json:"-"` // Use context to stop task utils
	Cancel context.CancelFunc `json:"-"`
}

type BaseStatus struct {
	Status string   `json:"-"`
	Color  string   `json:"-"`
	Step   BaseStep `json:"-"`
}

type BaseStep struct {
	Checkout bool
	Decline  bool
	Carted   bool
}

type BaseUserAgentInfo struct {
	Useragent   string
	Sec_ua      string
	Platform    string
	VersionList string
	Arch        string
}

type BaseRequestsInfo struct {
	Client       tls_client.HttpClient  `json:"-"`
	ServerClient tls_client.HttpClient  `json:"-"`
	UserAgent    *BaseUserAgentInfo     `json:"-"`
	Extras       map[string]interface{} `json:"-"`
	Referer      string                 `json:"-"`
	Redirect     string                 `json:"-"`
	Cancel       string                 `json:"-"`
	IPv4         string                 `json:"-"`
}

type taskStatus struct {
	TaskID      string `json:"taskID"`
	Status      string `json:"status"`
	Color       string `json:"color"`
	State       int    `json:"state"`
	Running     bool   `json:"running"`
	ProductSize string `json:"productSize"`
	ProductName string `json:"productName"`
}

type safeStatuses struct {
	mu    sync.RWMutex
	value []taskStatus
}

type Task interface {
	StopTask(finalStatus string, finalColor string, statusStep ...int)
}

type safeTaskChannels struct {
	mu    sync.RWMutex
	value map[string]Task
	bases map[string]*BaseTask
}

func (s *safeTaskChannels) GetAllBases() map[string]*BaseTask {
	s.mu.RLock()
	defer s.mu.RUnlock()

	out := make(map[string]*BaseTask, len(s.bases))
	for id, base := range s.bases {
		out[id] = base
	}
	return out
}

func (s *safeTaskChannels) Get(key string) (Task, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	val, ok := s.value[key]
	return val, ok
}

func (s *safeTaskChannels) Set(key string, value Task, base *BaseTask) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.value[key] = value
	if base != nil {
		if s.bases == nil {
			s.bases = make(map[string]*BaseTask)
		}
		s.bases[key] = base
	}
}

func (s *safeTaskChannels) Delete(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	delete(s.value, key)
	if s.bases != nil {
		delete(s.bases, key)
	}
}

type UserAgent struct {
	UserAgentInfo []*BaseUserAgentInfo
}

type statusMessage struct {
	Type     string `json:"type"`
	Messages any    `json:"messages"`
}

type NotificationMessage struct {
	Type         string  `json:"type"`
	ProductName  string  `json:"productName"`
	ProductImage string  `json:"productImage"`
	ProfileName  string  `json:"profileName"`
	GroupID      string  `json:"groupID"`
	TaskID       string  `json:"taskID,omitempty"`
	SKU          string  `json:"sku,omitempty"`
	Price        float64 `json:"price,omitempty"`
	OrderNumber  string  `json:"orderNumber,omitempty"`
	AccountID    string  `json:"accountId,omitempty"`
	Source       string  `json:"source,omitempty"`
}

type NotificationDetails struct {
	TaskID      string
	SKU         string
	Price       float64
	OrderNumber string
	AccountID   string
	Source      string
}

type UpdateCookieMessage struct {
	Cookie    string `json:"cookie"`
	AccountID string `json:"accountId"`
}

type UpdatePasswordMessage struct {
	Password  string `json:"password"`
	AccountID string `json:"accountId"`
}

type LogMessage struct {
	TaskID string `json:"taskID"`
	Data   string `json:"data"`
}
