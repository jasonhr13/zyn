package pokemoncenter

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/PolarAIO/Polar-AIO/backend/bot-base/safego"
	"github.com/PolarAIO/Polar-AIO/backend/bot-base/task"
)

var (
	incapIncidentRegex   = regexp.MustCompile(`src="(/_Incapsula_Resource\\?[^"]*)"`)
	incapHcapkey         = regexp.MustCompile(`data-sitekey="([^"]+)"`)
	incapHcapPostUrl     = regexp.MustCompile(`xhr\.open\("POST",\s"([^"]+)"`)
	datadomeChallengeUrl = regexp.MustCompile(`"url":"([^"]+)"`)
	datadomeDdObject     = regexp.MustCompile(`var dd\s*=\s*({.*?})`)
	puzzle               = regexp.MustCompile(`captchaChallengePath:\s*['"]([^'"]+\.jpg)['"]`)
	incapDynamicPath     = regexp.MustCompile(`src\s*=\s*"(\/[^/]+\/[^?]+)\?.*"`)
	incapDynamicFullPath = regexp.MustCompile(`scriptElement\.src\s*=\s*"(.*?)"`)
)

func ParseIncapIncident(html string) (bool, string) {
	matches := incapIncidentRegex.FindStringSubmatch(html)
	if len(matches) > 1 {
		incapURL := matches[1]
		return true, incapURL
	}
	return false, "Failed to parse Incap challenge URL"
}

func ParseIncapDynamic(html string) (bool, string) {
	pathMatches := incapDynamicPath.FindStringSubmatch(html)

	if len(pathMatches) < 2 {
		return false, ""
	}

	fullMatches := incapDynamicFullPath.FindStringSubmatch(html)

	if len(fullMatches) < 2 {
		return false, ""
	}

	fullScriptPath := fullMatches[1]
	return true, fullScriptPath
}

func ParseIncapChallenge(html string) (bool, string, string, string) {
	if strings.Contains(html, "g-recaptcha-response") {
		hcaptchaKey := incapHcapkey.FindStringSubmatch(html)
		if len(hcaptchaKey) > 1 {
			hcapPostUrl := incapHcapPostUrl.FindStringSubmatch(html)
			if len(hcapPostUrl) > 1 {
				return true, "captcha", hcaptchaKey[1], hcapPostUrl[1]
			}
			return false, "captcha", hcaptchaKey[1], ""
		}
		return false, "captcha", "", ""
	} else if strings.Contains(html, "Waiting Room") {
		return true, "waiting_room", "", ""
	} else {
		return true, "utmvc", "", ""
	}
}

func (t *PokemonCenterTask) hasReese84Cookie() bool {
	u, err := url.Parse("https://www.pokemoncenter.com")
	if err != nil {
		return false
	}
	for _, c := range t.Requests.Client.GetCookieJar().Cookies(u) {
		if c.Name == "reese84" && strings.TrimSpace(c.Value) != "" {
			return true
		}
	}
	return false
}

func (t *PokemonCenterTask) resetSessionState() {
	t.stopRenew()
	t.Products = []Product{}
	t.TotalPrice = 0
	t.Product = task.Product{}
	t.PaymentKey = ""
	t.PaymentToken = ""
	t.ShippingAddressUri = ""
	t.PurchaseFormUri = ""
	t.OrderNumber = ""
	t.MultiCart = false
	t.StepBeforeQueue = ""
	t.QueueCompleted = false
	t.QueueETA = 0
	t.QueueTime = nil
	t.InQueue = false
	t.PassedQueue = false
	t.FoundQueue = false
	t.ReeseScript = ""
	t.IncapScript = ""
	t.IpInfo = IpResponse{}
	t.ReesePayload = ""
	t.IncapPayload = ""
	t.DynamicIncapSolving = false
	t.DynamicIncapSolved = false
	t.InterBlockOnHome = false
	t.TagsSolved = false
	t.ReeseSolved = false
	t.ReeseCookie = ""
	t.RenewIncapIn = 0
	t.StepAfterIP = ""
	t.UtmvcParams = ""
	t.IncapIncidentUrl = ""
	t.HcapPostUrl = ""
	t.HcapSiteKey = ""
	t.HcapToken = ""
	t.ChallengeType = ""
	t.DDHardBlockCount = 0
	t.DatadomeCid = ""
	t.DatadomeUrl = ""
	t.DDHardBlocked = false
	t.DatadomeScript = ""
	t.DatadomeDeviceLink = ""
	t.DatadomePuzzle = ""
	t.DatadomePiece = ""
	t.DatadomePayload = ""
	t.LastStep = ""
	t.StepAfterSolve = ""
	t.Checkout = false
	t.Decline = false
	t.DeclineReason = ""
	t.Requests.Referer = ""
	for i := range t.Inputs {
		t.Inputs[i].Found = false
	}
}

// requireIP routes through get-ip without clobbering StepAfterSolve (e.g. get-cart after tags).
func (t *PokemonCenterTask) requireIP(nextStep string) bool {
	if t.IpInfo.Ip != "" {
		return false
	}
	t.StepAfterIP = nextStep
	t.NextStep = "get-ip"
	return true
}
func ParseDatadomeChallenge(html string, datadomeCookie string, referer string) (bool, string, string, bool) {
	// Case 1: JSON-style URL block
	if strings.Contains(html, `{"url":`) {
		DatadomeUrl := datadomeChallengeUrl.FindStringSubmatch(html)
		if len(DatadomeUrl) > 1 {
			if strings.Contains(DatadomeUrl[1], "interstitial") {
				return true, "interstitial", DatadomeUrl[1], false
			} else if strings.Contains(DatadomeUrl[1], "captcha") {
				hardBlocked := false
				if strings.Contains(DatadomeUrl[1], "t=dv") {
					hardBlocked = true
				}
				return true, "captcha", DatadomeUrl[1], hardBlocked
			} else {
				log.Printf("Datadome block detected: %s\n", DatadomeUrl[1])
				return false, "unknown", "", false
			}
		}
	}

	// Case 2: JS var dd object
	if strings.Contains(html, "var dd=") || strings.Contains(html, "var dd =") {
		match := datadomeDdObject.FindStringSubmatch(html)
		if len(match) < 2 {
			log.Printf("[ParseDatadomeChallenge] failed to find dd object")
			return false, "unknown", "", false
		}

		// Convert JS-style object to JSON
		js := strings.ReplaceAll(match[1], "'", `"`)
		js = strings.ReplaceAll(js, "\n", "")

		var data map[string]interface{}
		if err := json.Unmarshal([]byte(js), &data); err != nil {
			log.Printf("[ParseDatadomeChallenge] json parse failed: %v", err)
			return false, "unknown", "", false
		}

		// Extract required fields safely
		rt := fmt.Sprintf("%v", data["rt"])
		cid := fmt.Sprintf("%v", data["cid"])
		hsh := fmt.Sprintf("%v", data["hsh"])
		t := fmt.Sprintf("%v", data["t"])
		s := fmt.Sprintf("%v", data["s"])
		e := fmt.Sprintf("%v", data["e"])
		cookie := fmt.Sprintf("%v", data["cookie"])

		if datadomeCookie == "" && cookie != "" {
			datadomeCookie = cookie
		}
		// Optional field 'b'
		b := ""
		if val, ok := data["b"]; ok {
			b = fmt.Sprintf("%v", val)
		}

		// Build URL based on rt type
		switch rt {
		case "i": // interstitial
			return true, "interstitial", fmt.Sprintf(
				"https://geo.captcha-delivery.com/interstitial/?initialCid=%s&hash=%s&cid=%s&referer=%s&s=%s&b=%s&dm=cd",
				cid, hsh, datadomeCookie, referer, s, b), false

		case "c": // captcha
			hardBlocked := false
			if t == "bv" {
				hardBlocked = true
			}
			return true, "captcha", fmt.Sprintf(
				"https://geo.captcha-delivery.com/captcha/?initialCid=%s&hash=%s&cid=%s&referer=%s&s=%s&e=%s&dm=cd",
				cid, hsh, datadomeCookie, referer, s, e), hardBlocked
		}
	}

	log.Printf("[ParseDatadomeChallenge] failed to extract dd fields from HTML")
	return false, "unknown", "", false
}

func ParseCaptchaId(html string) (bool, string) {
	match := puzzle.FindStringSubmatch(html)

	if len(match) > 1 {
		return true, match[1]
	} else {
		return false, ""
	}
}

func (t *PokemonCenterTask) BuildProductWebhookItems() []task.ProductWebhookItem {
	var items []task.ProductWebhookItem
	for i := range t.Products {
		if t.Products[i].Carted {
			items = append(items, task.ProductWebhookItem{
				SKU:         t.Products[i].Sku,
				Quantity:    t.Products[i].Quantity,
				Image:       t.Products[i].ProductImage,
				Name:        t.Products[i].ProductName,
				Price:       t.Products[i].ProductPrice,
				ProductLink: t.Products[i].ProductLink,
				Size:        t.Products[i].ProductSize,
			})
		}
	}
	if len(items) > 0 {
		return items
	}
	for i := range t.Products {
		items = append(items, task.ProductWebhookItem{
			SKU:         t.Products[i].Sku,
			Quantity:    t.Products[i].Quantity,
			Name:        t.Products[i].ProductName,
			Price:       t.Products[i].ProductPrice,
			ProductLink: t.Products[i].ProductLink,
			Size:        t.Products[i].ProductSize,
		})
	}
	if len(items) > 0 {
		return items
	}
	if t.Product.Name != "" {
		return []task.ProductWebhookItem{{
			SKU:         t.Product.Sku,
			Quantity:    1,
			Name:        t.Product.Name,
			Price:       t.Product.Price,
			ProductLink: t.Product.ProductLink,
			Size:        t.Product.Size,
		}}
	}
	return nil
}

func (t *PokemonCenterTask) handleProxyRequestError(step, proxyFailedLabel string, err error) {
	if !t.BaseTask.MaybeRotateProxy("PokemonCenter", err) {
		t.NextStep, t.Error = step, fmt.Errorf("failed to respond")
		return
	}
	t.NextStep, t.Error = step, fmt.Errorf("%s", proxyFailedLabel)
}

func (t *PokemonCenterTask) handleProxyError(proxyFailedLabel string, err error) {
	if !t.BaseTask.MaybeRotateProxy("PokemonCenter", err) {
		t.Error = fmt.Errorf("failed to respond")
		return
	}
	t.Error = fmt.Errorf("%s", proxyFailedLabel)
}

func (t *PokemonCenterTask) stopRenew() {
	t.renewMu.Lock()
	cancel := t.renewCancel
	t.renewCancel = nil
	t.renewMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (t *PokemonCenterTask) RenewIncapHanlder() {
	t.stopRenew()

	ctx, cancel := context.WithCancel(t.TaskContext.CTX)

	t.renewMu.Lock()
	t.renewCancel = cancel
	t.renewMu.Unlock()

	safego.Go(func() {
		defer cancel()
		for {
			t.renewMu.Lock()
			renewIn := t.RenewIncapIn
			t.renewMu.Unlock()

			wait := renewIn - 30
			if wait < 1 {
				wait = 1
			}

			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Duration(wait) * time.Second):
			}

			if err := t.renewReese(ctx); err != nil {
				select {
				case <-ctx.Done():
					return
				case <-time.After(5 * time.Second):
				}
			}
		}
	})
}
