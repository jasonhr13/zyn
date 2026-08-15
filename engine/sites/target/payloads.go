package target

type loginCredentialPayload struct {
	Username       string          `json:"username"`
	Password       string          `json:"password"`
	DeviceInfo     loginDeviceInfo `json:"device_info"`
	KeepMeSignedIn bool            `json:"keep_me_signed_in"`
}

type loginOtpCredentialPayload struct {
	DeviceInfo     loginDeviceInfo `json:"device_info"`
	EmailId        string          `json:"email_id"`
	Flow           string          `json:"flow"`
	KeepMeSignedIn bool            `json:"keep_me_signed_in"`
}

type twofaCredentialPayload struct {
	DeviceInfo     loginDeviceInfo `json:"device_info"`
	EmailId        string          `json:"email_id"`
	Flow           string          `json:"flow"`
	KeepMeSignedIn bool            `json:"keep_me_signed_in"`
}
type submitTwofaCredentialPayload struct {
	Code       string          `json:"code"`
	DeviceInfo loginDeviceInfo `json:"device_info"`
}

type resetPasswordPayload struct {
	DeviceInfo loginDeviceInfo `json:"device_info"`
	Password   string          `json:"password"`
}

type loginDeviceInfo struct {
	UserAgent               string `json:"user_agent"`
	Language                string `json:"language"`
	Canvas                  string `json:"canvas"`
	ColorDepth              string `json:"color_depth"`
	DeviceMemory            string `json:"device_memory"`
	PixelRatio              string `json:"pixel_ratio"`
	HardwareConcurrency     string `json:"hardware_concurrency"`
	Resolution              string `json:"resolution"`
	AvailableResolution     string `json:"available_resolution"`
	TimezoneOffset          string `json:"timezone_offset"`
	SessionStorage          string `json:"session_storage"`
	LocalStorage            string `json:"local_storage"`
	IndexedDB               string `json:"indexed_db"`
	AddBehavior             string `json:"add_behavior"`
	OpenDatabase            string `json:"open_database"`
	CPUClass                string `json:"cpu_class"`
	NavigatorPlatform       string `json:"navigator_platform"`
	DoNotTrack              string `json:"do_not_track"`
	RegularPlugins          string `json:"regular_plugins"`
	Adblock                 string `json:"adblock"`
	HasLiedLanguages        string `json:"has_lied_languages"`
	HasLiedResolution       string `json:"has_lied_resolution"`
	HasLiedOS               string `json:"has_lied_os"`
	HasLiedBrowser          string `json:"has_lied_browser"`
	TouchSupport            string `json:"touch_support"`
	JSFonts                 string `json:"js_fonts"`
	NavigatorVendor         string `json:"navigator_vendor"`
	NavigatorWebdriver      string `json:"navigator_webdriver"`
	NavigatorAppName        string `json:"navigator_app_name"`
	NavigatorAppCodeName    string `json:"navigator_app_code_name"`
	NavigatorAppVersion     string `json:"navigator_app_version"`
	NavigatorLanguages      string `json:"navigator_languages"`
	NavigatorCookiesEnabled string `json:"navigator_cookies_enabled"`
	NavigatorJavaEnabled    string `json:"navigator_java_enabled"`
	VisitorID               string `json:"visitor_id"`
	TealeafID               string `json:"tealeaf_id"`
	Webgl                   string `json:"webgl"`
	WebglVendor             string `json:"webgl_vendor"`
	BrowserName             string `json:"browser_name"`
	BrowserVersion          string `json:"browser_version"`
	CPUArchitecture         string `json:"cpu_architecture"`
	DeviceVendor            string `json:"device_vendor"`
	DeviceModel             string `json:"device_model"`
	DeviceType              string `json:"device_type"`
	EngineName              string `json:"engine_name"`
	EngineVersion           string `json:"engine_version"`
	OSName                  string `json:"os_name"`
	OSVersion               string `json:"os_version"`
}

type refreshLoginPayload struct {
	GrantType        string                  `json:"grant_type"`
	ClientCredential refreshClientCredential `json:"client_credential"`
	DeviceInfo       loginDeviceInfo         `json:"device_info"`
}

type refreshClientCredential struct {
	ClientID string `json:"client_id"`
}

type setAddressPayload struct {
	AddressLine1          string `json:"address_line1"`
	AddressLine2          string `json:"address_line2"`
	City                  string `json:"city"`
	ZipCode               string `json:"zip_code"`
	State                 string `json:"state"`
	Country               string `json:"country"`
	DefaultAddress        bool   `json:"default_address"`
	DeliveryInstructions  string `json:"delivery_instructions"`
	FirstName             string `json:"first_name"`
	LastName              string `json:"last_name"`
	PhoneNumber           string `json:"phone_number"`
	AddressType           string `json:"address_type"`
	DropOffLocation       string `json:"drop_off_location"`
	BuildingName          string `json:"building_name"`
	SecurityCode          string `json:"security_code"`
	CallBox               string `json:"call_box"`
	AddressCategory       string `json:"address_category"`
	SkipAddressValidation bool   `json:"skip_address_validation"`
}

type addToCartPayload struct {
	CartItem        addToCartItemPayload `json:"cart_item"`
	CartType        string               `json:"cart_type"`
	ChannelID       string               `json:"channel_id"`
	ShoppingContext string               `json:"shopping_context"`
}

type addToCartItemPayload struct {
	ItemChannelID string `json:"item_channel_id"`
	Tcin          string `json:"tcin"`
	Quantity      int    `json:"quantity"`
}

type cartChannelPayload struct {
	CartType  string `json:"cart_type"`
	ChannelID string `json:"channel_id"`
}

type submitPaymentBilling struct {
	Country      string `json:"country"`
	FirstName    string `json:"first_name"`
	LastName     string `json:"last_name"`
	AddressLine1 string `json:"address_line1"`
	AddressLine2 string `json:"address_line2"`
	ZipCode      string `json:"zip_code"`
	City         string `json:"city"`
	State        string `json:"state"`
	Phone        string `json:"phone"`
}

type submitPaymentCard struct {
	CardName    string `json:"card_name"`
	CardNumber  string `json:"card_number"`
	ExpiryYear  string `json:"expiry_year"`
	ExpiryMonth string `json:"expiry_month"`
	CVV         string `json:"cvv"`
}

type submitPaymentPayload struct {
	BillingAddress submitPaymentBilling `json:"billing_address"`
	CardDetails    submitPaymentCard    `json:"card_details"`
	CartID         string               `json:"cart_id"`
	PaymentType    string               `json:"payment_type"`
	WalletCardID   string               `json:"wallet_card_id"`
	WalletMode     string               `json:"wallet_mode"`
}
