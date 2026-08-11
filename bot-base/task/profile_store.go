package task

import "zynbot.app/engine/bot-base/profiles"

func ProfileFromStore(p profiles.Profile) ProfileStruct {
	BillingShippingEqual := false

	if p.ShippingAddress1 == p.BillingAddress1 && p.ShippingAddress2 == p.BillingAddress2 && p.BillingCity == p.ShippingCity && p.BillingState == p.ShippingState && p.BillingFirstName == p.ShippingFirstName && p.BillingLastName == p.ShippingLastName && p.ShippingZip == p.BillingZip {
		BillingShippingEqual = true
	}
	return ProfileStruct{
		Id:                   p.Id,
		ProfileGroup:         p.ProfileGroup,
		ProfileName:          p.ProfileName,
		Email:                p.Email,
		ShippingAddress1:     p.ShippingAddress1,
		ShippingAddress2:     p.ShippingAddress2,
		ShippingCity:         p.ShippingCity,
		ShippingState:        p.ShippingState,
		ShippingZip:          p.ShippingZip,
		ShippingCountry:      p.ShippingCountry,
		ShippingFirstName:    p.ShippingFirstName,
		ShippingLastName:     p.ShippingLastName,
		BillingAddress1:      p.BillingAddress1,
		BillingAddress2:      p.BillingAddress2,
		BillingCity:          p.BillingCity,
		BillingState:         p.BillingState,
		BillingZip:           p.BillingZip,
		BillingCountry:       p.BillingCountry,
		BillingFirstName:     p.BillingFirstName,
		BillingLastName:      p.BillingLastName,
		CardName:             p.CardName,
		CardNumber:           p.CardNumber,
		CardExpiryMonth:      p.CardExpiryMonth,
		CardExpiryYear:       p.CardExpiryYear,
		CardCvv:              p.CardCvv,
		Account:              p.Account,
		Phone:                p.Phone,
		BillingShippingEqual: BillingShippingEqual,
	}
}
