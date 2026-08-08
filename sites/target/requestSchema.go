package target

type ShapeAPIResponse struct {
	OK     bool   `json:"ok"`
	Cookie Cookie `json:"cookie"`
}

type Cookie struct {
	Headers   ShapeHeaders `json:"headers"`
	Proxy     string       `json:"proxy"`
	Expiry    int64        `json:"expiry"`
	CreatedAt int64        `json:"createdAt"`
	Source    string       `json:"source"`
}

type TargetErrorResponse struct {
	Errors []TargetError `json:"errors"`
}

type TargetError struct {
	ErrorKey      string `json:"error_key"`
	ErrorMessage  string `json:"error_message"`
	ErrorMessage2 string `json:"errorMessage"`
}

type SecureCodeVerificationResponse struct {
	Actions []string `json:"actions"`
}

type TokenV3Response struct {
	TransactionId string `json:"transaction_id"`
	AccessTokenId string `json:"access_token_id"`
	AccessToken   string `json:"access_token"`
}

type targetCartResponse struct {
	CartID              string                     `json:"cart_id"`
	CartItems           []CartItem                 `json:"cart_items"`
	PaymentInstructions []PaymentInstructionsBlock `json:"payment_instructions"`
}

type CartItem struct {
	CartItemId     string     `json:"cart_item_id"`
	Tcin           string     `json:"tcin"`
	Skip           bool       `json:"skip"`
	Quantity       int        `json:"quantity"`
	ChildCartItem  *CartItem  `json:"child_cart_item,omitempty"`
	ChildCartItems []CartItem `json:"child_cart_items,omitempty"`
}

type AddressesResponse struct {
	Addresses []AddressWrapper `json:"addresses"`
}

type AddressWrapper struct {
	Address AddressBlock `json:"address"`
}

type AddressBlock struct {
	AddressID      string `json:"address_id"`
	FirstName      string `json:"first_name"`
	LastName       string `json:"last_name"`
	Address1       string `json:"address_line1"`
	City           string `json:"city"`
	State          string `json:"state"`
	Zipcode        string `json:"zip_code"`
	Country        string `json:"country"`
	DefaultAddress bool   `json:"default_address"`
	PhoneNumber    string `json:"phone_number"`
}

type SetAddressResponse struct {
	Address AddressBlock `json:"address"`
}

type PaymentCardsResponse struct {
	Cards []PaymentCardBlock `json:"cards"`
}

type PaymentCardBlock struct {
	CardID         string `json:"card_id"`
	DefaultPayment bool   `json:"default_payment"`
}

type ATCResponse struct {
	CartId        string             `json:"cart_id"`
	Attributes    AttributesBlock    `json:"item_attributes"`
	ItemSummary   ItemSummaryBlock   `json:"item_summary"`
	InventoryInfo inventoryInfoBlock `json:"inventory_info"`
	Tcin          string             `json:"tcin"`
	Quantity      int                `json:"quantity"`
}

type AttributesBlock struct {
	Description string `json:"description"`
	Image       string `json:"image_path"`
}

type ItemSummaryBlock struct {
	Price float64 `json:"price"`
}

type inventoryInfoBlock struct {
	AvailabilityStatus string `json:"availability_status"`
}

type PrepareCheckoutResponse struct {
	ReferanceID         string                     `json:"reference_id"`
	PaymentInstructions []PaymentInstructionsBlock `json:"payment_instructions"`
	CartItems           []CartItem                 `json:"cart_items"`
}

type PaymentInstructionsBlock struct {
	Amount        float64 `json:"amount"`
	PaymentInstId string  `json:"payment_instruction_id"`
}

type SubmitOrderSuccess struct {
	Orders []OrderBlock `json:"orders"`
}
type OrderBlock struct {
	ReferenceId string       `json:"reference_id"`
	OrderID     string       `json:"order_id"`
	CartState   string       `json:"cart_state"`
	Summary     SummaryBlock `json:"summary"`
	CartItems   []CartItem   `json:"cart_items"`
}

type SummaryBlock struct {
	GrandTotal float64 `json:"grand_total"`
}

type SubmitOrderFailed struct {
	Message string `json:"message"`
	Code    string `json:"code"`
}

type OrderCheckResponse struct {
	OrderNumber string         `json:"order_number"`
	FraudStatus string         `json:"fraud_status"`
	OrderLines  []OrderLine    `json:"order_lines"`
	Packages    []OrderPackage `json:"packages"`
}

type OrderPackage struct {
	GroupingMetadata GroupingMetadata `json:"grouping_metadata"`
	OrderLines       []OrderLine      `json:"order_lines"`
}

type GroupingMetadata struct {
	Cancellation Cancellation `json:"cancellation"`
}

type OrderLine struct {
	OrderLineId  string       `json:"order_line_id"`
	OrderLineKey string       `json:"order_line_key"`
	Item         OrderItem    `json:"item"`
	Cancellation Cancellation `json:"cancellation"`
}

type OrderItem struct {
	Tcin     string  `json:"tcin"`
	Quantity float64 `json:"quantity"`
}

type Cancellation struct {
	CancelReasonText string `json:"cancel_reason_text"`
}

type ProductStockResponse struct {
	Data   Data                `json:"data"`
	Errors []ProductStockError `json:"errors"`
}

type ProductStockError struct {
	Message string `json:"message"`
}

type Data struct {
	ProductSummaries []ProductSummary `json:"product_summaries"`
}

type ProductSummary struct {
	Tcin        string      `json:"tcin"`
	Item        Item        `json:"item"`
	Fulfillment Fulfillment `json:"fulfillment"`
	Price       Price       `json:"price"`
}

type Item struct {
	Enrichment         Enrichment         `json:"enrichment"`
	ProductDescription ProductDescription `json:"product_description"`
}

type Enrichment struct {
	Images struct {
		PrimaryImageURL string `json:"primary_image_url"`
	} `json:"images"`
}

type ProductDescription struct {
	Title string `json:"title"`
}

type Fulfillment struct {
	ShippingOptions ShippingOptions `json:"shipping_options"`
}

type ShippingOptions struct {
	AvailabilityStatus         string  `json:"availability_status"`
	AvailableToPromiseQuantity float64 `json:"available_to_promise_quantity"`
}

type Price struct {
	CurrentRetail float32 `json:"current_retail"`
}

type SubmitPayment400 struct {
	Message string `json:"message"`
	Code    string `json:"code"`
}

type SubmitPaymentResponse struct {
	PaymentInstructionId string `json:"payment_instruction_id"`
}
