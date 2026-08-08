package walmart

import (
	"time"

	"github.com/PolarAIO/Polar-AIO/backend/bot-base/imapcode"
	"github.com/PolarAIO/Polar-AIO/backend/bot-base/task"
	"github.com/PolarAIO/Polar-AIO/backend/sites/walmart/pie"
)

type WalmartTask struct {
	*task.BaseTask

	ChallengeCode        string
	ChallengeVerifier    string
	TwoFACode            string
	AuthCode             string
	NeedsEmailOTP        bool
	LoggedIn             bool
	DeviceProfileRefID   string
	PxData               string
	PxGenerated          bool
	HoldCaptchaFailCount int

	TMXDeviceID string

	CartData          Cart
	SetAddresses      []DeliveryAddress
	ShippingAddressID string
	PaymentCards      []WalletPayment
	PaymentID         string
	PieKeys           pie.Keys
	EncryptedCard     pie.EncryptedCard
	ContractID        string
	OrderNumber       string
	GrandTotal        float64
	UsItemID          string
	OfferID           string

	QueueID           string
	ExpectedQueueTime int
	NextQueuePoll     int
	QueuePassed       bool
	pingAt            time.Time

	InputPid string
	RawInput string
	Quantity int

	NoSMSLinked     bool
	NeedsStepUp     bool
	SetCardAttempts int
	emailCodeWaiter *imapcode.Waiter
	SkipPx          bool
}

type WalmartMonitorTask struct {
	*task.BaseTask
	Pid            string
	MonitorProduct MonitorProduct
	PxBlocked      bool
}

type MonitorProduct struct {
	QueueID      string
	CurrentPrice float64
	ImageURL     string
	ItemID       string
	Name         string
	OfferId      string
	InStock      string
	MaxQty       int
}
