package walmart

import "strings"

type signInWithOTPResponse struct {
	Data signInWithOTPData `json:"data"`
}

type signInWithOTPData struct {
	SignInWithOTP signInWithOTPResult `json:"signInWithOTP"`
}

type signInWithOTPResult struct {
	AuthCode  signInWithOTPAuthCode `json:"authCode"`
	PhoneInfo PhoneInfo             `json:"phoneInfo"`
	Errors    []signInWithOTPError  `json:"errors"`
}

type PhoneInfo struct {
	ShouldCollectPhone bool `json:"shouldCollectPhone"`
}

type signInWithOTPAuthCode struct {
	AuthCode string `json:"authCode"`
}

type signInWithOTPError = identityError

type identityError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type signInV2Response struct {
	Data signInV2Data `json:"data"`
}

type signInV2Data struct {
	SignInV2 signInV2Result `json:"signInV2"`
}

type signInV2Result struct {
	AuthCode       signInV2AuthCode     `json:"authCode"`
	Auth           signInV2Auth         `json:"auth"`
	CanUseEmailOTP *bool                `json:"canUseEmailOTP"`
	LoginOptions   signInV2LoginOptions `json:"loginOptions"`
	Errors         []identityError      `json:"errors"`
}

type signInV2LoginOptions struct {
	CanUseEmailOTP       bool     `json:"canUseEmailOTP"`
	SupportedOtpChannels []string `json:"supportedOtpChannels"`
}

type signInV2AuthCode struct {
	AuthCode string `json:"authCode"`
	Cid      string `json:"cid"`
}

type signInV2Auth struct {
	AuthCode string `json:"authCode"`
}

type pxBlockResponse struct {
	RedirectURL       string `json:"redirectUrl"`
	AppID             string `json:"appId"`
	JsClientSrc       string `json:"jsClientSrc"`
	FirstPartyEnabled bool   `json:"firstPartyEnabled"`
	VID               string `json:"vid"`
	UUID              string `json:"uuid"`
	HostURL           string `json:"hostUrl"`
	BlockScript       string `json:"blockScript"`
}

func (p pxBlockResponse) isPerimeterXBlock() bool {
	if p.AppID == "" {
		return false
	}
	lowerRedirect := strings.ToLower(p.RedirectURL)
	lowerJs := strings.ToLower(p.JsClientSrc)
	lowerHost := strings.ToLower(p.HostURL)
	return p.BlockScript != "" ||
		p.UUID != "" ||
		p.VID != "" ||
		strings.Contains(lowerRedirect, "/blocked") ||
		strings.Contains(lowerJs, "/px/") ||
		strings.Contains(lowerHost, "/px/")
}

type getCartAPIResponse struct {
	Data getCartData `json:"data"`
}

type getCartData struct {
	Cart Cart `json:"mergeAndGetCart"`
}

type getCartQueryAPIResponse struct {
	Data getCartQueryData `json:"data"`
}

type getCartQueryData struct {
	Cart Cart `json:"cart"`
}

type updateItemsAPIResponse struct {
	Data updateItemsData `json:"data"`
}

type updateItemsData struct {
	UpdateItems Cart `json:"updateItems"`
}

type Cart struct {
	Id                string              `json:"id"`
	LineItems         []LineItem          `json:"lineItems"`
	PriceDetails      *CartPriceDetails   `json:"priceDetails"`
	OperationalErrors []OperationalErrors `json:"operationalErrors"`
	Customer          CartCustomer        `json:"customer"`
}

type CartCustomer struct {
	Id      string `json:"id"`
	IsGuest bool   `json:"isGuest"`
}

type CartPriceDetails struct {
	SubTotal lineItemPrice `json:"subTotal"`
}

type LineItem struct {
	Id                     string            `json:"id"`
	Quantity               int               `json:"quantity"`
	IsPharmacyPrescription bool              `json:"isPharmacyPrescription"`
	Product                lineItemProduct   `json:"product"`
	PriceInfo              lineItemPriceInfo `json:"priceInfo"`
}

type lineItemPriceInfo struct {
	ItemPrice lineItemPrice `json:"itemPrice"`
}

type lineItemPrice struct {
	Value float64 `json:"value"`
}

type lineItemProduct struct {
	OfferId   string                `json:"offerId"`
	UsItemId  string                `json:"usItemId"`
	Name      string                `json:"name"`
	Type      string                `json:"type"`
	ImageInfo *lineItemProductImage `json:"imageInfo"`
}

type lineItemProductImage struct {
	ThumbnailUrl string `json:"thumbnailUrl"`
}

type OperationalErrors struct {
	Code string `json:"code"`
}

type GetAddressesResponse struct {
	Data DeliveryAddressesData `json:"data"`
}

type DeliveryAddressesData struct {
	DeliveryAddresses []DeliveryAddress `json:"deliveryAddresses"`
}

type DeliveryAddress struct {
	Id             string `json:"id"`
	AddressLineOne string `json:"addressLineOne"`
	AddressLineTwo string `json:"addressLineTwo"`
	City           string `json:"city"`
	State          string `json:"state"`
	PostalCode     string `json:"postalCode"`
	Country        string `json:"country"`
	FirstName      string `json:"firstName"`
	LastName       string `json:"lastName"`
	Phone          string `json:"phone"`
	IsDefault      bool   `json:"isDefault"`
}

type createAccountAddressAPIResponse struct {
	Data   createAccountAddressData `json:"data"`
	Errors []identityError          `json:"errors"`
}

type createAccountAddressData struct {
	CreateAccountAddress createAccountAddressResult `json:"createAccountAddress"`
}

type createAccountAddressResult struct {
	Errors     []createAccountAddressError `json:"errors"`
	NewAddress DeliveryAddress             `json:"newAddress"`
}

type createAccountAddressError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type getWalletPaymentsAPIResponse struct {
	Data getWalletPaymentsData `json:"data"`
}

type getWalletPaymentsData struct {
	Wallet Wallet `json:"wallet"`
}

type Wallet struct {
	PaymentGroups []PaymentGroup `json:"paymentGroups"`
}

type PaymentGroup struct {
	Type     string          `json:"type"`
	Payments []WalletPayment `json:"payments"`
}

type WalletPayment struct {
	Id             string `json:"id"`
	FirstName      string `json:"firstName"`
	LastName       string `json:"lastName"`
	NameOnCard     string `json:"nameOnCard"`
	AddressLineOne string `json:"addressLineOne"`
	City           string `json:"city"`
	LastFour       string `json:"lastFour"`
	CardType       string `json:"cardType"`
	ExpiryYear     int    `json:"expiryYear"`
	ExpiryMonth    int    `json:"expiryMonth"`
	IsDefault      bool   `json:"isDefault"`
	IsExpired      bool   `json:"isExpired"`
	NeedVerifyCVV  bool   `json:"needVerifyCVV"`
}

type createAccountCreditCardAPIResponse struct {
	Data createAccountCreditCardData `json:"data"`
}

type createAccountCreditCardData struct {
	CreateAccountCreditCard createAccountCreditCardResult `json:"createAccountCreditCard"`
}

type createAccountCreditCardResult struct {
	Errors     []createAccountCreditCardError `json:"errors"`
	CreditCard WalletPayment                  `json:"creditCard"`
}

type createAccountCreditCardError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type createContractAPIResponse struct {
	Data createContractData `json:"data"`
}

type createContractData struct {
	CreatePurchaseContract createPurchaseContractResult `json:"createPurchaseContract"`
}

type createPurchaseContractResult struct {
	Id string `json:"id"`
}

type placeOrderAPIResponse struct {
	Data placeOrderData `json:"data"`
}

type placeOrderData struct {
	PlaceOrder placeOrderResult `json:"placeOrder"`
}

type placeOrderResult struct {
	Order placeOrderOrder `json:"order"`
}

type placeOrderOrder struct {
	Id string `json:"id"`
}

type QueueResponse struct {
	Site                          string         `json:"site"`
	Queue                         string         `json:"queue"`
	Shard                         int            `json:"shard"`
	Ticket                        int            `json:"ticket"`
	State                         string         `json:"state"`
	Expires                       int64          `json:"expires"`
	Signature                     string         `json:"signature"`
	ItemID                        string         `json:"itemId"`
	OfferID                       string         `json:"offerId"`
	CID                           string         `json:"cid"`
	NextRefreshUnixTimestamp      int64          `json:"nextRefreshUnixTimestamp"`
	NextRefreshRelativeTime       int64          `json:"nextRefreshRelativeTime"`
	ExpectedTurnTimeUnixTimestamp int64          `json:"expectedTurnTimeUnixTimestamp"`
	CustomMetadata                CustomMetadata `json:"customMetadata"`
}

type CustomMetadata struct {
	Title               string      `json:"title"`
	ViewItemCTALabel    ViewItemCTA `json:"viewItemCtaLabel"`
	Body                string      `json:"body"`
	AdmissionLikelihood string      `json:"admissionLikelihood"`
	CTALabel            string      `json:"ctaLabel"`
	Item                QueueItem   `json:"item"`
}

type ViewItemCTA struct {
	Pending string `json:"pending"`
	Valid   string `json:"valid"`
}

type QueueItem struct {
	CurrentPrice string `json:"currentPrice"`
	ImageURL     string `json:"imageURL"`
	ItemID       string `json:"itemID"`
	ItemURL      string `json:"itemURL"`
	Name         string `json:"name"`
}

type ProductQueueResponse struct {
	Queued         bool                  `json:"queued"`
	Queue          string                `json:"queue"`
	URL            string                `json:"url"`
	CustomMetadata ProductCustomMetadata `json:"customMetadata"`
}

type ProductCustomMetadata struct {
	Item Item `json:"item"`
}

type Item struct {
	CurrentPrice string `json:"currentPrice"`
	ImageURL     string `json:"imageURL"`
	ItemID       string `json:"itemID"`
	ItemURL      string `json:"itemURL"`
	Name         string `json:"name"`
}

type ProductResponse struct {
	Data ProductData `json:"data"`
}

type ProductData struct {
	Product Product `json:"product"`
}

type Product struct {
	UsItemId                   string              `json:"usItemId"`
	Name                       string              `json:"name"`
	ItemPageAvailabilityStatus string              `json:"itemPageAvailabilityStatus"`
	OfferId                    string              `json:"offerId"`
	OrderLimit                 int                 `json:"orderLimit"`
	PriceInfo                  PriceInfo           `json:"priceInfo"`
	ImageInfo                  ImageInfo           `json:"imageInfo"`
	FulfillmentOptions         []FulfillmentOption `json:"fulfillmentOptions"`
}

type FulfillmentOption struct {
	Type             string `json:"type"`
	MaxOrderQuantity int    `json:"maxOrderQuantity"`
	OrderLimit       int    `json:"orderLimit"`
}

type PriceInfo struct {
	CurrentPrice CurrentPrice `json:"currentPrice"`
}

type CurrentPrice struct {
	PriceString string `json:"priceString"`
}

type ImageInfo struct {
	AllImages []ImageData `json:"allImages"`
}

type ImageData struct {
	Url string `json:"url"`
}
