package pokemoncenter

type IpResponse struct {
	Ip       string `json:"ip"`
	Country  string `json:"country"`
	Timezone string `json:"timezone"`
}

type ReeseSolveHyperResponse struct {
	Payload string `json:"payload"`
}

type ReeseResponse struct {
	Token        string `json:"token"`
	RenewInSec   int    `json:"renewInSec"`
	CookieDomain string `json:"cookieDomain"`
}

type DatadomeTagsSolveHyperResponse struct {
	Payload string `json:"payload"`
}

type DatadomeInterstitialSolveHyperResponse struct {
	Payload string          `json:"payload"`
	Headers DatadomeHeaders `json:"headers"`
}

type DatadomeInterstitialResponse struct {
	Cookie string `json:"cookie"`
	View   string `json:"view"`
	Xddb   string `json:"xddb"`
	Url    string `json:"url"`
}

type DatadomeSliderResponse struct {
	Cookie string `json:"cookie"`
}

type CortexLink struct {
	Rel  string `json:"rel"`
	Rev  string `json:"rev"`
	Type string `json:"type"`
	Uri  string `json:"uri"`
	Href string `json:"href"`
}

type CortexSelf struct {
	Type string `json:"type"`
	Uri  string `json:"uri"`
	Href string `json:"href"`
}

type CortexAvailability struct {
	Self     CortexSelf   `json:"self"`
	Messages []any        `json:"messages"`
	Links    []CortexLink `json:"links"`
	State    string       `json:"state"`
}

type CortexItemElement struct {
	Availability      []CortexAvailability     `json:"_availability"`
	AddToCartForm     []CortexAddToCartForm    `json:"_addtocartform"`
	AddToDynamicCart  []CortexAddToDynamicCart `json:"_addtodynamiccartform"`
	AddToWishlistForm []CortexFormBase         `json:"_addtowishlistform"`
	Code              []CortexCode             `json:"_code"`
	DigitalFlag       []CortexDigitalFlag      `json:"_digital-flag"`
	Price             []CortexPrice            `json:"_price"`
}

type CortexAddToCartForm struct {
	Self          CortexSelf             `json:"self"`
	Messages      []any                  `json:"messages"`
	Links         []CortexLink           `json:"links"`
	Configuration map[string]interface{} `json:"configuration"`
	Quantity      int                    `json:"quantity"`
}

type CortexAddToDynamicCart struct {
	Self          CortexSelf             `json:"self"`
	Messages      []any                  `json:"messages"`
	Links         []CortexLink           `json:"links"`
	Clobber       bool                   `json:"clobber"`
	Configuration map[string]interface{} `json:"configuration"`
	Quantity      int                    `json:"quantity"`
}

type CortexFormBase struct {
	Self     CortexSelf   `json:"self"`
	Messages []any        `json:"messages"`
	Links    []CortexLink `json:"links"`
}

type CortexCode struct {
	Self     CortexSelf   `json:"self"`
	Messages []any        `json:"messages"`
	Links    []CortexLink `json:"links"`
	Code     string       `json:"code"`
}

type CortexDigitalFlag struct {
	Self      CortexSelf   `json:"self"`
	Messages  []any        `json:"messages"`
	Links     []CortexLink `json:"links"`
	IsDigital bool         `json:"is-digital"`
}

type CortexPriceAmount struct {
	Amount   float64 `json:"amount"`
	Currency string  `json:"currency"`
	Display  string  `json:"display"`
}

type CortexPrice struct {
	Self          CortexSelf          `json:"self"`
	Messages      []any               `json:"messages"`
	Links         []CortexLink        `json:"links"`
	ListPrice     []CortexPriceAmount `json:"list-price"`
	PurchasePrice []CortexPriceAmount `json:"purchase-price"`
}

type CortexPriceRange struct {
	FromPrice []CortexPriceAmount `json:"from-price"`
	ToPrice   []CortexPriceAmount `json:"to-price"`
}

type CortexOfferPriceRange struct {
	Self               CortexSelf       `json:"self"`
	Messages           []any            `json:"messages"`
	Links              []CortexLink     `json:"links"`
	ListPriceRange     CortexPriceRange `json:"list-price-range"`
	PurchasePriceRange CortexPriceRange `json:"purchase-price-range"`
}

type CortexDefinition struct {
	Self                CortexSelf        `json:"self"`
	Messages            []any             `json:"messages"`
	Links               []CortexLink      `json:"links"`
	DisplayName         string            `json:"display-name"`
	ReportingProperties map[string]string `json:"reporting-properties"`
}

type CortexItems struct {
	Element []CortexItemElement `json:"_element"`
}

type ProductAttributes struct {
	Name               string  `json:"name"`
	ProductRelease     int64   `json:"productRelease"`
	ProductDescription string  `json:"productDescription"`
	BuyingCategory     string  `json:"buyingCategory"`
	ItemNumber         string  `json:"itemNumber"`
	QuantityLimit      int     `json:"quantityLimit"`
	RequireReCaptcha   bool    `json:"requireReCaptcha"`
	RequireInvitation  bool    `json:"requireInvitation"`
	IsPreorderItem     bool    `json:"isPreorderItem"`
	IsReleased         bool    `json:"isReleased"`
	IsNewProduct       bool    `json:"isNewProduct"`
	IsFinalSale        bool    `json:"isFinalSale"`
	IsLimitedQuantity  bool    `json:"isLimitedQuantity"`
	IsBackInStock      bool    `json:"isBackInStock"`
	IsLimitedEdition   bool    `json:"isLimitedEdition"`
	ImageMainHigh      string  `json:"imageMainHigh"`
	ImageMainThumbnail string  `json:"imageMainThumbnail"`
	Height             float64 `json:"height"`
	Weight             float64 `json:"weight"`
	Length             float64 `json:"length"`
	Width              float64 `json:"width"`
}

type ProductResponse struct {
	Self         CortexSelf              `json:"self"`
	Messages     []any                   `json:"messages"`
	Links        []CortexLink            `json:"links"`
	Availability []CortexAvailability    `json:"_availability"`
	Code         []CortexCode            `json:"_code"`
	Definition   []CortexDefinition      `json:"_definition"`
	Items        []CortexItems           `json:"_items"`
	PriceRange   []CortexOfferPriceRange `json:"_pricerange"`
	Attributes   ProductAttributes       `json:"attributes"`
}

type DatadomeTagsResponse struct {
	Status int    `json:"status"`
	Cookie string `json:"cookie"`
}

type AvailabilityItemElement struct {
	Availability []CortexAvailability `json:"_availability"`
}

type AvailabilityItems struct {
	Element []AvailabilityItemElement `json:"_element"`
}

type AvailabilityResponse struct {
	Self         CortexSelf           `json:"self"`
	Messages     []any                `json:"messages"`
	Links        []CortexLink         `json:"links"`
	Availability []CortexAvailability `json:"_availability"`
	Items        []AvailabilityItems  `json:"_items"`
}

type CartMessageData struct {
	ItemCode string `json:"item-code"`
}

type CartMessage struct {
	Type         string          `json:"type"`
	ID           string          `json:"id"`
	DebugMessage string          `json:"debug-message"`
	Data         CartMessageData `json:"data"`
}

type AddToCartResponse struct {
	Self           CortexSelf             `json:"self"`
	Messages       []CartMessage          `json:"messages"`
	Links          []CortexLink           `json:"links"`
	Configuration  map[string]interface{} `json:"configuration"`
	IsFreeGiftItem bool                   `json:"is-freegiftitem"`
	Quantity       int                    `json:"quantity"`
}

type EmailResponse struct {
	Self     CortexSelf   `json:"self"`
	Messages []any        `json:"messages"`
	Links    []CortexLink `json:"links"`
	Email    string       `json:"email"`
}

type CortexAddressName struct {
	FamilyName string `json:"family-name"`
	GivenName  string `json:"given-name"`
}

type CortexAddressDetail struct {
	CountryName     string  `json:"country-name"`
	ExtendedAddress *string `json:"extended-address"`
	Locality        string  `json:"locality"`
	PostalCode      string  `json:"postal-code"`
	Region          string  `json:"region"`
	StreetAddress   string  `json:"street-address"`
}

type CortexAddress struct {
	Self         CortexSelf          `json:"self"`
	Messages     []any               `json:"messages"`
	Links        []CortexLink        `json:"links"`
	Address      CortexAddressDetail `json:"address"`
	Name         CortexAddressName   `json:"name"`
	Organization *string             `json:"organization"`
	PhoneNumber  string              `json:"phone-number"`
}

type ShippingResponse struct {
	Billing  CortexAddress `json:"billing"`
	Shipping CortexAddress `json:"shipping"`
}

type PaymentInstrumentIdentificationAttributes struct {
	Token string `json:"token"`
}

type PaymentInstrumentLimitAmount struct {
	Amount   float64 `json:"amount"`
	Currency string  `json:"currency"`
	Display  string  `json:"display"`
}

type PaymentInstrumentLink struct {
	Rel  string `json:"rel"`
	Type string `json:"type"`
	Uri  string `json:"uri"`
	Href string `json:"href"`
}

type PaymentInstrumentResponse struct {
	Self                                      CortexSelf                                `json:"self"`
	Messages                                  []any                                     `json:"messages"`
	Links                                     []PaymentInstrumentLink                   `json:"links"`
	DefaultOnProfile                          bool                                      `json:"default-on-profile"`
	LimitAmount                               PaymentInstrumentLimitAmount              `json:"limit-amount"`
	Name                                      string                                    `json:"name"`
	PaymentInstrumentIdentificationAttributes PaymentInstrumentIdentificationAttributes `json:"payment-instrument-identification-attributes"`
	SavedOnProfile                            bool                                      `json:"saved-on-profile"`
}

type PaymentKeyResponse struct {
	KeyId string `json:"keyId"`
}

type UtmvcHyperResponse struct {
	Payload  string `json:"payload"`
	Swhanedl string `json:"swhanedl"`
}

type QueueResponse struct {
	Pending int `json:"pending"`
	Ttw     int `json:"ttw"`
	Rld     int `json:"rld"`
}

type SubmitOrderError struct {
	Messages []CartMessage `json:"messages"`
}

type OrderSuccess struct {
	MonetaryTotal  []MonetaryAmount `json:"monetary-total"`
	PurchaseNumber string           `json:"purchase-number"`
}

type MonetaryAmount struct {
	Amount   float64 `json:"amount"`
	Currency string  `json:"currency"`
	Display  string  `json:"display"`
}

type MinicartResponse struct {
	Self         MinicartSelf           `json:"self"`
	Messages     []interface{}          `json:"messages"`
	Links        []interface{}          `json:"links"`
	FeatureFlags MinicartFlags          `json:"feature-flags"`
	Totals       map[string]interface{} `json:"totals"`
}

type MinicartSelf struct {
	Type string `json:"type"`
	Uri  string `json:"uri"`
	Href string `json:"href"`
}

type MinicartFlags struct {
	AuthDoubleOptin bool `json:"auth.doubleoptin"`
	DynamicAdd      bool `json:"px.dynamicadd"`
	Modal           bool `json:"px.modal"`
	JumpToCart      bool `json:"px.jumptocart"`
}

type DeclineResponse struct {
	Messages []Message     `json:"messages"`
	Links    []interface{} `json:"links"`
}

type Message struct {
	Type         string    `json:"type"`
	ID           string    `json:"id"`
	DebugMessage string    `json:"debug-message"`
	Data         ErrorData `json:"data"`
}

type ErrorData struct {
	InternalMessage       string `json:"InternalMessage"`
	PaymentInstrumentName string `json:"payment-instrument-name"`
	ExternalMessage       string `json:"ExternalMessage"`
}

type CheckStatusResponse struct {
	QueueUp  bool `json:"queueUp"`
	Unlocked bool `json:"unlocked"`
}
