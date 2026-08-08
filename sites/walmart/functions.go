package walmart

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"net/url"
	"strings"
	"time"

	"github.com/PolarAIO/Polar-AIO/backend/bot-base/task"
	"github.com/PolarAIO/Polar-AIO/backend/bot-base/task/constants"
	monitorhub "github.com/PolarAIO/Polar-AIO/backend/monitor-hub"
	"github.com/PolarAIO/Polar-AIO/backend/sites/walmart/pie"
	http "github.com/bogdanfinn/fhttp"
)

func walmartProductPageURL(usItemID string) string {
	return fmt.Sprintf("https://www.walmart.com/ip/%s", usItemID)
}

func (t *WalmartTask) resetSessionState() {
	t.ChallengeCode = ""
	t.ChallengeVerifier = ""
	t.TwoFACode = ""
	t.AuthCode = ""
	t.NeedsEmailOTP = false
	t.LoggedIn = false
	t.DeviceProfileRefID = ""
	t.PxData = ""
	t.PxGenerated = false
	t.HoldCaptchaFailCount = 0
	t.TMXDeviceID = GenerateDeviceProfileRefID(36)
	t.CartData = Cart{}
	t.SetAddresses = nil
	t.ShippingAddressID = ""
	t.PaymentCards = nil
	t.PaymentID = ""
	t.PieKeys = pie.Keys{}
	t.EncryptedCard = pie.EncryptedCard{}
	t.ContractID = ""
	t.OrderNumber = ""
	t.GrandTotal = 0
	t.UsItemID = ""
	t.QueueID = ""
	t.ExpectedQueueTime = 0
	t.NextQueuePoll = 0
	t.QueuePassed = false
	t.StepAfterSolve = ""
	t.Error = nil
}

func (t *WalmartTask) restartTask() {
	t.TaskState = constants.StatusSteps.Running
	if err := t.BaseTask.EnsureTLSClient(true); err != nil {
		t.Error = fmt.Errorf("error building client")
		t.UpdateStatus("Error Building Client", constants.Colors.RED)
		t.SleepTask(t.ErrorDelay)
		return
	}
	_ = t.BaseTask.SwapProxy("Walmart")
	t.resetSessionState()
	t.NextStep = "get-session"
}

func parsePidFromInput(input string) string {
	input = strings.TrimSpace(input)
	if input == "" || isOfferIDInput(input) {
		return ""
	}
	lower := strings.ToLower(input)
	if idx := strings.Index(lower, "/ip/"); idx >= 0 {
		rest := input[idx+4:]
		if slash := strings.Index(rest, "/"); slash >= 0 {
			rest = rest[:slash]
		}
		if q := strings.Index(rest, "?"); q >= 0 {
			rest = rest[:q]
		}
		return strings.TrimSpace(rest)
	}
	return input
}

func isOfferIDInput(input string) bool {
	return len(strings.TrimSpace(input)) == 32
}

func (t *WalmartTask) hasDirectOfferInput() bool {
	return t.OfferID != "" && t.InputPid == ""
}

func (t *WalmartTask) pingWithinPriceRange(ping monitorhub.StockPing) bool {
	if t.MaxPrice > 0 && !monitorhub.PingWithinMaxPrice(ping, t.MaxPrice) {
		return false
	}
	if t.MinPrice > 0 && (ping.Price <= 0 || ping.Price < t.MinPrice) {
		return false
	}
	return true
}

var walmartCookieHosts = []string{
	"https://www.walmart.com",
	"https://identity.walmart.com",
}

func (t *WalmartTask) addWalmartCookie(name, value string) {
	if value == "" || t.Requests == nil || t.Requests.Client == nil {
		return
	}
	jar := t.Requests.Client.GetCookieJar()
	if jar == nil {
		return
	}
	cookie := &http.Cookie{
		Name:   name,
		Value:  value,
		Path:   "/",
		Domain: ".walmart.com",
	}
	for _, host := range walmartCookieHosts {
		u, _ := url.Parse(host)
		jar.SetCookies(u, []*http.Cookie{cookie})
	}
}

func (t *WalmartTask) AddCookiesToQueue() {
	if t.Requests == nil || t.Requests.Client == nil {
		return
	}
	u, _ := url.Parse("https://www.walmart.com")
	cookies := t.Requests.Client.GetCookies(u)
	for _, cookie := range cookies {
		t.Requests.AddCookie(cookie.Name, cookie.Value, "q-api.www.walmart.com")
	}
}

func (t *WalmartTask) loadAccountCookies() {
	if t.Account.Cookie == "" {
		return
	}
	for _, part := range strings.Split(t.Account.Cookie, "; ") {
		kv := strings.SplitN(strings.TrimSpace(part), "=", 2)
		if len(kv) != 2 {
			continue
		}
		if kv[0] == "_px3" {
			t.SkipPx = true
		}
		t.addWalmartCookie(kv[0], kv[1])
	}
}

func (t *WalmartTask) hasSessionCookie(names ...string) bool {
	if t.Requests == nil || t.Requests.Client == nil {
		return false
	}
	jar := t.Requests.Client.GetCookieJar()
	if jar == nil {
		return false
	}
	for _, host := range walmartCookieHosts {
		u, _ := url.Parse(host)
		for _, c := range jar.Cookies(u) {
			if c.Value == "" {
				continue
			}
			for _, name := range names {
				if c.Name == name {
					return true
				}
			}
		}
	}
	return false
}

func (t *WalmartTask) handleProxyRequestError(err error) {
	if t.BaseTask.MaybeRotateProxy("Walmart", err) {
		t.Error = fmt.Errorf("Proxy Failed")
		return
	}
	t.Error = fmt.Errorf("failed to respond")
}

func identityChallengeFailed(message string) bool {
	return strings.Contains(strings.ToLower(message), "something went wrong with your request")
}

func identityPasswordFailed(code, message string) bool {
	if code == "USER_AUTH_FAIL" {
		return true
	}
	lower := strings.ToLower(message)
	return strings.Contains(lower, "password") &&
		(strings.Contains(lower, "do not match") || strings.Contains(lower, "incorrect"))
}

func identityEmailOTPAvailable(channels []string) bool {
	for _, ch := range channels {
		upper := strings.ToUpper(ch)
		if strings.Contains(upper, "EMAIL") {
			return true
		}
	}
	return false
}

func identityPhoneOnlyOTP(channels []string) bool {
	if len(channels) == 0 {
		return false
	}
	for _, ch := range channels {
		upper := strings.ToUpper(ch)
		if upper != "PHONE_TEXT" && upper != "PHONE_VOICE" {
			return false
		}
	}
	return true
}

func signInNeedsEmailOTP(loginOpts signInV2LoginOptions, topLevel *bool) bool {
	if len(loginOpts.SupportedOtpChannels) > 0 {
		if identityPhoneOnlyOTP(loginOpts.SupportedOtpChannels) {
			return false
		}
		return identityEmailOTPAvailable(loginOpts.SupportedOtpChannels)
	}
	return loginOpts.CanUseEmailOTP || (topLevel != nil && *topLevel)
}

func identityChallengeError(body string) error {
	if identityChallengeFailed(body) {
		return fmt.Errorf("challenge failed")
	}

	var resp struct {
		Errors []identityError `json:"errors"`
		Data   struct {
			GetLoginOptions struct {
				Errors []identityError `json:"errors"`
			} `json:"getLoginOptions"`
			GenerateOTP struct {
				Errors []identityError `json:"errors"`
			} `json:"generateOTP"`
		} `json:"data"`
	}
	if json.Unmarshal([]byte(body), &resp) != nil {
		return nil
	}

	for _, errs := range [][]identityError{
		resp.Errors,
		resp.Data.GetLoginOptions.Errors,
		resp.Data.GenerateOTP.Errors,
	} {
		for _, e := range errs {
			if identityChallengeFailed(e.Message) {
				return fmt.Errorf("challenge failed")
			}
		}
	}
	return nil
}

func GeneratePKCE() (codeVerifier string, codeChallenge string, err error) {
	b := make([]byte, 32)
	if _, err = rand.Read(b); err != nil {
		return
	}

	codeVerifier = base64.RawURLEncoding.EncodeToString(b)
	h := sha256.Sum256([]byte(codeVerifier))
	codeChallenge = base64.RawURLEncoding.EncodeToString(h[:])

	return
}

func (t *WalmartTask) SaveSessionCookies() {
	if t.Requests == nil || t.Requests.Client == nil {
		return
	}
	cookieJar := t.Requests.Client.GetCookieJar()
	if cookieJar == nil {
		return
	}
	saved := make(map[string]string)
	for _, host := range walmartCookieHosts {
		u, _ := url.Parse(host)
		for _, c := range cookieJar.Cookies(u) {
			saved[c.Name] = c.Value
		}
	}
	if len(saved) == 0 {
		return
	}

	var jar strings.Builder
	for name, value := range saved {
		if jar.Len() > 0 {
			jar.WriteString("; ")
		}
		jar.WriteString(name)
		jar.WriteByte('=')
		jar.WriteString(value)
	}

	cookieStr := jar.String()
	t.Account.Cookie = cookieStr
	t.UpdateCookie(cookieStr, t.Account.Id)
}

func GenerateDeviceProfileRefID(length int) string {
	result := make([]byte, length)
	random := make([]byte, length)

	if _, err := rand.Read(random); err != nil {
		panic(err)
	}

	const lower = "0123456789abcdefghijklmnopqrstuvwxyz"
	const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

	for i := length - 1; i >= 0; i-- {
		a := random[i] & 63

		switch {
		case a < 36:
			result[length-1-i] = lower[a]
		case a < 62:
			result[length-1-i] = upper[a-36]
		case a == 62:
			result[length-1-i] = '_'
		default:
			result[length-1-i] = '-'
		}
	}

	return string(result)
}

func creditCardsFromWallet(wallet Wallet) []WalletPayment {
	var cards []WalletPayment
	for _, group := range wallet.PaymentGroups {
		if group.Type != "CREDIT_CARD" {
			continue
		}
		cards = append(cards, group.Payments...)
	}
	return cards
}

func cardLastFour(cardNumber string) string {
	var digits strings.Builder
	for _, r := range cardNumber {
		if r >= '0' && r <= '9' {
			digits.WriteRune(r)
		}
	}
	s := digits.String()
	if len(s) < 4 {
		return s
	}
	return s[len(s)-4:]
}

func (t *WalmartTask) BuildProductWebhookItems() []task.ProductWebhookItem {
	if t.Product.Name == "" {
		return nil
	}
	qty := t.Quantity
	if qty <= 0 {
		qty = 1
	}
	return []task.ProductWebhookItem{{
		Quantity:    qty,
		Image:       t.Product.ProductImage,
		Name:        t.Product.Name,
		Price:       t.Product.Price,
		ProductLink: t.Product.ProductLink,
		Size:        t.Product.Size,
	}}
}

func queueStatusWithETA(expectedUnixSec int) (string, string) {
	if expectedUnixSec <= 0 {
		return "In Queue", constants.Colors.BLUE
	}
	secs := int(time.Until(time.Unix(int64(expectedUnixSec), 0)).Seconds())
	if secs <= 0 {
		return "In Queue", constants.Colors.BLUE
	}
	if secs < 60 {
		return fmt.Sprintf("In Queue (%ds)", secs), constants.Colors.YELLOW
	}
	return fmt.Sprintf("In Queue (%dm)", secs/60), constants.Colors.YELLOW
}

func randomID() string {
	b := make([]byte, 32)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func randReqId(upper bool) string {
	b := make([]byte, 16)

	_, err := rand.Read(b)
	if err != nil {
		panic(err)
	}
	s := hex.EncodeToString(b)
	if upper {
		s = strings.ToUpper(hex.EncodeToString(b))
	}

	return fmt.Sprintf("%s-%s-%s-%s-%s",
		s[0:8],
		s[8:12],
		s[12:16],
		s[16:20],
		s[20:32],
	)
}

func buildProductQuery(itId, pageId string) string {
	if pageId == "" {
		pageId = itId
	}
	reqId := randReqId(true)
	productQ := map[string]interface{}{
		"conditionType":                          "NEW",
		"contentLayout":                          "mobile-item",
		"contentLayoutVersion":                   "v2",
		"count":                                  1,
		"enableClickTracking":                    false,
		"enableMergeProductIdml":                 false,
		"enablePrismEventBanner":                 false,
		"enableSecondaryOffers":                  true,
		"filterCriteria":                         map[string]interface{}{},
		"filters":                                []string{},
		"includeFlowerDeliveryInfo":              false,
		"includeItemServiceProperties":           false,
		"includeProductDisclaimers":              false,
		"includeSpecialCtaType":                  false,
		"includeUpstreamErrorCode":               false,
		"is3pEGiftCardVariableLoad":              true,
		"isBlitzRedesignBannerCCMEnabled":        true,
		"isBlitzRedesignTimerBannerCCMEnabled":   true,
		"isBrandShopHyperLinkEnabled":            true,
		"isBTF":                                  false,
		"isBTFOrUseCachedReview":                 false,
		"isBuyBoxVideoEnabled":                   false,
		"isBuyBoxVideoOrSponsoredPromptsEnabled": false,
		"isChannelLevelPriceInfoEnabled":         false,
		"isHistogramRevampedEnabled":             true,
		"isInStoreExperience":                    true,
		"isNutritionInfoEnabled":                 false,
		"isPromoEligibleItemEnabled":             false,
		"isPromotionMessagesEnabled":             false,
		"isReviewIncentiveEnabled":               true,
		"isSeeSimilarEnabled":                    false,
		"isShippingCostMessageEnabled":           false,
		"isSpecialQuantityOrderEnabled":          false,
		"isSponsoredPromptEnabled":               false,
		"isSubscriptionFrequencyListEnabled":     true,
		"isUserImagesReviewEnabled":              true,
		"isViewOnlyItemEnabled":                  false,
		"isVisionYouthLensesEnabled":             true,
		"isWPlusFulfillmentBottomSheet":          false,
		"itId":                                   itId,

		"p13": map[string]interface{}{
			"modules": []map[string]interface{}{
				{
					"moduleId":   "234-sdfsfvns-sdfdskvl",
					"moduleType": "PersonalizedLabels",
				},
			},
			"pageId": pageId,
			"reqId":  reqId,
			"userClientInfo": map[string]interface{}{
				"callType":   "CLIENT",
				"deviceType": "IOS",
			},
			"userReqInfo": map[string]interface{}{
				"bstc":    "test_sid",
				"cid":     nil,
				"pageUrl": fmt.Sprintf("/ip/moonitor/%s", pageId),
				"refererContext": map[string]interface{}{
					"catId":       nil,
					"facet":       nil,
					"query":       nil,
					"source":      "itempage",
					"sourceId":    "",
					"wmlspartner": "",
				},
			},
		},

		"pCls": map[string]interface{}{
			"pageId":       pageId,
			"reqId":        reqId,
			"skipPtcFetch": true,
			"userClientInfo": map[string]interface{}{
				"callType":     "CLIENT",
				"deviceType":   "IOS",
				"isZipLocated": true,
			},
			"userReqInfo": map[string]interface{}{
				"bstc":                     "test_sid",
				"enableSlaBadgeV2":         true,
				"isMoreOptionsTileEnabled": true,
				"refererContext": map[string]interface{}{
					"itemSwitchContext": map[string]interface{}{
						"sizeReferers": []string{},
					},
					"sourceId":      "",
					"variantSwitch": false,
					"wmlspartner":   "",
				},
			},
		},

		"postProcessingVersion": 2,

		"productFeatures": []map[string]interface{}{
			{
				"feature": "eGiftCardVariableLoadAvailable",
				"values": []string{
					"true",
				},
			},
		},
		"sel":          true,
		"skipRootIdml": false,
		"startAt":      1,
		"tempo": map[string]interface{}{
			"targeting": "{\"deviceType\":\"ios\",\"deviceVersion\":\"26.24.1\",\"membershipStatus\":\"NON_MEMBER\",\"storeTransactability\":\"nonTransactable\",\"userState\":\"loggedOut\"}",
		},
		"ten":   "WM_GLASS",
		"vCrit": true,
		"vitPa": map[string]interface{}{
			"imageOptions": map[string]interface{}{
				"background": "26",
			},
			"isByomActive":                false,
			"isByomActiveMen":             false,
			"isCYOMImageReductionEnabled": true,
			"isCYOMManActive":             true,
			"isFollowMeActive":            true,
		},
	}

	jsonBytes, err := json.Marshal(productQ)
	if err != nil {
		panic(err)
	}
	encodedVariables := url.QueryEscape(string(jsonBytes))

	return fmt.Sprintf("id=%s&variables=%s", randomID(), encodedVariables)
}

func RandomPassword(length int) string {
	const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*"
	const lower = "abcdefghijklmnopqrstuvwxyz"
	const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
	const numSpecial = "0123456789!@#$%^&*"

	password := []byte{
		randomChar(lower),
		randomChar(upper),
		randomChar(numSpecial),
	}

	for len(password) < length {
		password = append(password, randomChar(chars))
	}

	// Shuffle
	for i := range password {
		j, _ := rand.Int(rand.Reader, big.NewInt(int64(len(password))))
		password[i], password[j.Int64()] = password[j.Int64()], password[i]
	}

	return string(password)
}

func randomChar(chars string) byte {
	n, _ := rand.Int(rand.Reader, big.NewInt(int64(len(chars))))
	return chars[n.Int64()]
}
