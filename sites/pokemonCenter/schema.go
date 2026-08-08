package pokemoncenter

import (
	"context"
	"sync"

	"github.com/PolarAIO/Polar-AIO/backend/bot-base/task"
	"github.com/PolarAIO/Polar-AIO/backend/sites"
)

type PokemonCenterTask struct {
	*task.BaseTask
	storeCfg    StoreConfig
	Inputs      []sites.Input `json:"inputs"`
	PassedQueue bool          `json:"-"`
	QueueTime   *int          `json:"queue_time"`
	OrderNumber string

	Products           []Product
	TotalPrice         int
	PaymentKey         string
	PaymentToken       string
	ShippingAddressUri string
	PurchaseFormUri    string

	MultiCart           bool
	StepBeforeQueue     string
	QueueCompleted      bool
	QueueETA            float64
	InQueue             bool
	DynamicAdd          bool
	ReeseScript         string
	IncapScript         string
	IpInfo              IpResponse
	ReesePayload        string
	IncapPayload        string
	DynamicIncapSolving bool
	DynamicIncapSolved  bool
	InterBlockOnHome    bool
	TagsSolved          bool
	ReeseSolved         bool
	ReeseCookie         string
	RenewIncapIn        int
	StepAfterIP         string
	UtmvcParams         string
	IncapIncidentUrl    string
	HcapPostUrl         string
	HcapSiteKey         string
	HcapToken           string
	ChallengeType       string

	renewMu     sync.Mutex
	renewCancel context.CancelFunc

	DDHardBlockCount   int
	DatadomeCid        string
	DatadomeUrl        string
	DDHardBlocked      bool
	DatadomeScript     string
	DatadomeDeviceLink string
	DatadomePuzzle     string
	DatadomePiece      string
	DatadomePayload    string
	DatadomeHeaders    DatadomeHeaders
	FoundQueue         bool
	Unlocked           bool
}

type Product struct {
	ProductTag string
	Quantity   int
	Sku        string

	ProductName  string
	ProductImage string
	ProductPrice float64
	ProductLink  string
	ProductSize  string

	Available bool
	Carted    bool
}

type DatadomeHeaders struct {
	SecMem             string `json:"sec-ch-device-memory"`
	SecMobile          string `json:"sec-ch-ua-mobile"`
	SecArh             string `json:"sec-ch-ua-arch"`
	SecPlatform        string `json:"sec-ch-ua-platform"`
	SecModel           string `json:"sec-ch-ua-model"`
	SecFullVersionList string `json:"sec-ch-ua-full-version-list"`
}
