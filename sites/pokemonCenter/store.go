package pokemoncenter

import (
	"fmt"
	"strings"
)

// StoreConfig is the per-site Pokemon Center config.
// US values match the original hardcoded request headers exactly.
type StoreConfig struct {
	SiteName       string
	StoreScope     string // x-store-scope
	StoreLocale    string // x-store-locale
	PaymentLocale  string // payment iframe ?locale=
	HomeURL        string
	PathPrefix     string // "" , "/en-ca", "/de-de"
	AcceptLanguage string
}

func storeConfigForSite(site string) StoreConfig {
	switch normalizeSiteName(site) {
	case "Pokemon Center CA":
		return StoreConfig{
			SiteName:       "Pokemon Center CA",
			StoreScope:     "pokemon-ca",
			StoreLocale:    "en-ca",
			PaymentLocale:  "en-CA",
			HomeURL:        "https://www.pokemoncenter.com/en-ca/",
			PathPrefix:     "/en-ca",
			AcceptLanguage: "en-CA,en;q=0.9",
		}
	case "Pokemon Center DE":
		return StoreConfig{
			SiteName:       "Pokemon Center DE",
			StoreScope:     "pokemon-de",
			StoreLocale:    "de-de",
			PaymentLocale:  "de-DE",
			HomeURL:        "https://www.pokemoncenter.com/de-de/",
			PathPrefix:     "/de-de",
			AcceptLanguage: "de-DE,de;q=0.9,en;q=0.8",
		}
	case "Pokemon Center UK":
		return StoreConfig{
			SiteName:       "Pokemon Center UK",
			StoreScope:     "pokemon-uk",
			StoreLocale:    "en-gb",
			PaymentLocale:  "en-GB",
			HomeURL:        "https://www.pokemoncenter.com/en-gb/",
			PathPrefix:     "/en-gb",
			AcceptLanguage: "en-GB,en;q=0.9",
		}
	default: // Pokemon Center US (+ legacy)
		return StoreConfig{
			SiteName:       "Pokemon Center US",
			StoreScope:     "pokemon",
			StoreLocale:    "en-us",
			PaymentLocale:  "en-US",
			HomeURL:        "https://www.pokemoncenter.com/",
			PathPrefix:     "",
			AcceptLanguage: "en-US,en;q=0.9",
		}
	}
}

// normalizeSiteName maps legacy / empty names onto the US site label.
func normalizeSiteName(site string) string {
	switch strings.TrimSpace(site) {
	case "", "Pokemon Center":
		return "Pokemon Center US"
	default:
		return site
	}
}

func (t *PokemonCenterTask) cfg() StoreConfig {
	if t.storeCfg.StoreScope == "" {
		t.storeCfg = storeConfigForSite(t.Site)
	}
	return t.storeCfg
}

func (t *PokemonCenterTask) storeScope() string {
	return t.cfg().StoreScope
}

func (t *PokemonCenterTask) storeLocale() string {
	return t.cfg().StoreLocale
}

func (t *PokemonCenterTask) paymentLocale() string {
	return t.cfg().PaymentLocale
}

func (t *PokemonCenterTask) offersPrefix() string {
	return "/offers/" + t.storeScope() + "/"
}

func (t *PokemonCenterTask) cartsItemsPrefix() string {
	return "/carts/items/" + t.storeScope() + "/"
}

func (t *PokemonCenterTask) purchasesOrdersForm(uri string) string {
	return fmt.Sprintf("/purchases/orders/%s/%s/form", t.storeScope(), uri)
}
