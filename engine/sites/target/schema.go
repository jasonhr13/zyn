package target

import (
	"time"

	"zynbot.app/engine/bot-base/imapcode"
	"zynbot.app/engine/bot-base/task"
	monitorhub "zynbot.app/engine/monitor-hub"
	"zynbot.app/engine/sites"
)

type TargetTask struct {
	*task.BaseTask

	Inputs                 []sites.Input
	MonitorItems           []sites.Input
	ShapeHeaders           ShapeHeaders
	ShapeProxy             string
	ShapeMethod            string
	StepAfterSolve         string
	RedirectLocation       string
	CartID                 string
	PaymentInstId          string
	CartedItems            []CartItem
	TwoFACode              string
	NewPassword            string
	PasswordResetAttempted bool
	SessionRefreshAttempts int
	NeedsPasswordReset     bool
	AccountAddresses       []AddressBlock
	ShippingAddressID      string
	AccountPaymentCards    []PaymentCardBlock
	GuestProfileID         string
	CartData               ATCResponse
	PrepCheckoutData       PrepareCheckoutResponse

	CheckoutData OrderBlock
	FraudStatus  string
	OrderNumber  string
	Products     []Product

	StockPing      monitorhub.StockPing
	RestockTCIN    string
	RestockQty     int
	stockWaitAfter time.Time
	taskStartedAt  time.Time

	ShapeBlockCount int
	CartToalPrice   float64

	IgnoreLowStock         bool
	PreCartShapeBlockCount int
	UsedAlternateCartFlow  bool
	FillerOrders           []*FillerOrderState
	NeedCancelFiller       bool
	CanceledFillerItem     bool
	PassedCartErrors       int
	emailCodeWaiter        *imapcode.Waiter
	tmxStartedForCheckout  bool
}

type FillerOrderState struct {
	ReferenceId  string
	ItemQty      int
	OrderLineId  string
	OrderLineKey string
	Canceled     bool
}

type TargetMonitorTask struct {
	*task.BaseTask
	IgnoreLowStock bool
	MonitorInputs  []MonitorInput
	ProductStock   []ProductSummary
	lastInStock    map[string]bool
	missingTcins   map[string]struct{}
}
type MonitorInput struct {
	Tcin     string
	Qty      int
	MaxPrice float64
}

type Product struct {
	ProductName  string
	ProductImage string
	ProductPrice float64
	ProductLink  string
	ProductSize  string
	Quantity     int
}
