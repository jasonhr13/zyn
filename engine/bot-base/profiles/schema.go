package profiles

type Profile struct {
	Id                string `json:"id"`
	ProfileGroup      string `json:"profileGroup"`
	ProfileName       string `json:"profileName"`
	Email             string `json:"email"`
	ShippingAddress1  string `json:"shippingAddress1"`
	ShippingAddress2  string `json:"shippingAddress2"`
	ShippingCity      string `json:"shippingCity"`
	ShippingState     string `json:"shippingState"`
	ShippingZip       string `json:"shippingZip"`
	ShippingCountry   string `json:"shippingCountry"`
	ShippingFirstName string `json:"shippingFirstName"`
	ShippingLastName  string `json:"shippingLastName"`
	BillingAddress1   string `json:"billingAddress1"`
	BillingAddress2   string `json:"billingAddress2"`
	BillingCity       string `json:"billingCity"`
	BillingState      string `json:"billingState"`
	BillingZip        string `json:"billingZip"`
	BillingCountry    string `json:"billingCountry"`
	BillingFirstName  string `json:"billingFirstName"`
	BillingLastName   string `json:"billingLastName"`
	CardName          string `json:"cardName"`
	CardNumber        string `json:"cardNumber"`
	CardExpiryMonth   string `json:"cardExpiryMonth"`
	CardExpiryYear    string `json:"cardExpiryYear"`
	CardCvv           string `json:"cardCvv"`
	Account           string `json:"account"`
	Phone             string `json:"phone"`
}
