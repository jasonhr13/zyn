package walmart

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"strconv"
	"strings"
	"time"

	jsoniter "github.com/json-iterator/go"
	"zynbot.app/engine/bot-base/task/constants"
	"zynbot.app/engine/client"
	"zynbot.app/engine/sites/walmart/pie"
)

func (t *WalmartTask) GetHomePage() {
	t.loadAccountCookies()

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "GET",
			URL:    "https://www.walmart.com/",
		},
		Headers: map[string][]string{
			"sec-ch-ua":                 {t.Requests.UserAgent.Sec_ua},
			"sec-ch-ua-mobile":          {"?0"},
			"sec-ch-ua-platform":        {t.Requests.UserAgent.Platform},
			"upgrade-insecure-requests": {"1"},
			"user-agent":                {t.Requests.UserAgent.Useragent},
			"accept":                    {"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"},
			"sec-fetch-site":            {"none"},
			"sec-fetch-mode":            {"navigate"},
			"sec-fetch-user":            {"?1"},
			"sec-fetch-dest":            {"document"},
			"accept-encoding":           {"gzip, deflate, br, zstd"},
			"accept-language":           {"en-US,en;q=0.9"},
			"priority":                  {"u=0, i"},
			"header-order":              {"sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "upgrade-insecure-requests", "user-agent", "accept", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-user", "sec-fetch-dest", "accept-encoding", "accept-language", "priority"},
		},
	}
	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[gethomepage] ERROR: %s", err)
		t.handleProxyRequestError(err)
		return
	}
	switch response.StatusCode {
	case 200:
		const marker = `"adSessionId":"`
		if idx := strings.Index(body, marker); idx >= 0 {
			rest := body[idx+len(marker):]
			if end := strings.Index(rest, `"`); end >= 0 {
				t.Requests.AddCookie("_astc", rest[:end], ".walmart.com")
			}
		}
		t.Requests.AddCookie("adblocked", "false", ".walmart.com")
	case 412:
		if t.handlePX412(body) {
			return
		}
	case 302:
		if strings.Contains(strings.ToLower(response.Header.Get("Location")), "/blocked") {
			t.Error = fmt.Errorf("px blocked")
			return
		}
	case 307:
		t.Error = fmt.Errorf("proxy blocked")
	case 444:
		t.Error = fmt.Errorf("proxy block")
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		log.Printf("[gethomepage] Unexpected status code: %d", response.StatusCode)
		t.Error = fmt.Errorf("get-session (%d)", response.StatusCode)
	}
}

func (t *WalmartTask) MakeInSyncRequest(reqUrl string) {
	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "GET",
			URL:    reqUrl,
		},
		Headers: map[string][]string{
			"sec-ch-ua":                 {t.Requests.UserAgent.Sec_ua},
			"sec-ch-ua-mobile":          {"?0"},
			"sec-ch-ua-platform":        {t.Requests.UserAgent.Platform},
			"upgrade-insecure-requests": {"1"},
			"user-agent":                {t.Requests.UserAgent.Useragent},
			"accept":                    {"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"},
			"sec-fetch-site":            {"same-origin"},
			"sec-fetch-mode":            {"navigate"},
			"sec-fetch-user":            {"?1"},
			"sec-fetch-dest":            {"document"},
			"accept-encoding":           {"gzip, deflate, br, zstd"},
			"accept-language":           {"en-US,en;q=0.9"},
			"priority":                  {"u=0, i"},
			"header-order":              {"sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "upgrade-insecure-requests", "user-agent", "accept", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-user", "sec-fetch-dest", "accept-encoding", "accept-language", "priority"},
		},
	}

	if _, _, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID); err != nil {
		log.Printf("[makeinsync] ERROR: %s", err)
	}
}

func (t *WalmartTask) GetSignInPage() {

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "GET",
			URL:    "https://www.walmart.com/?action=SignIn&rm=true",
		},
		Headers: map[string][]string{
			"sec-ch-ua":                 {t.Requests.UserAgent.Sec_ua},
			"sec-ch-ua-mobile":          {"?0"},
			"sec-ch-ua-platform":        {t.Requests.UserAgent.Platform},
			"upgrade-insecure-requests": {"1"},
			"user-agent":                {t.Requests.UserAgent.Useragent},
			"accept":                    {"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"},
			"sec-fetch-site":            {"none"},
			"sec-fetch-mode":            {"navigate"},
			"sec-fetch-user":            {"?1"},
			"sec-fetch-dest":            {"document"},
			"accept-encoding":           {"gzip, deflate, br, zstd"},
			"accept-language":           {"en-US,en;q=0.9"},
			"priority":                  {"u=0, i"},
			"header-order":              {"sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "upgrade-insecure-requests", "user-agent", "accept", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-user", "sec-fetch-dest", "accept-encoding", "accept-language", "priority"},
		},
	}
	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[gethomepage] ERROR: %s", err)
		t.handleProxyRequestError(err)
		return
	}
	switch response.StatusCode {
	case 200:
	case 412:
		if t.handlePX412(body) {
			return
		}
	case 302:
		if strings.Contains(strings.ToLower(response.Header.Get("Location")), "/blocked") {
			t.Error = fmt.Errorf("px blocked")
			return
		}
	case 444:
		t.Error = fmt.Errorf("proxy block")
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		log.Printf("[getsigninpage] Unexpected status code: %d", response.StatusCode)
		t.Error = fmt.Errorf("get-signin-page (%d)", response.StatusCode)
	}
}

func (t *WalmartTask) GetLoginPage() {
	codeVerifier, codeChallenge, err := GeneratePKCE()
	if err != nil {
		t.Error = err
		return
	}
	t.ChallengeVerifier = codeVerifier
	t.ChallengeCode = codeChallenge

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "GET",
			URL:    fmt.Sprintf("https://identity.walmart.com/account/login?client_id=5f3fb121-076a-45f6-9587-249f0bc160ff&redirect_uri=https%%3A%%2F%%2Fwww.walmart.com%%2Faccount%%2FverifyToken&scope=openid+email+offline_access&tenant_id=elh9ie&state=%%2F&code_challenge=%s", t.ChallengeCode),
		},
		Headers: map[string][]string{
			"sec-ch-ua":                 {t.Requests.UserAgent.Sec_ua},
			"sec-ch-ua-mobile":          {"?0"},
			"sec-ch-ua-platform":        {t.Requests.UserAgent.Platform},
			"upgrade-insecure-requests": {"1"},
			"user-agent":                {t.Requests.UserAgent.Useragent},
			"accept":                    {"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"},
			"sec-fetch-site":            {"none"},
			"sec-fetch-mode":            {"navigate"},
			"sec-fetch-user":            {"?1"},
			"sec-fetch-dest":            {"document"},
			"accept-encoding":           {"gzip, deflate, br, zstd"},
			"accept-language":           {"en-US,en;q=0.9"},
			"priority":                  {"u=0, i"},
			"header-order":              {"sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "upgrade-insecure-requests", "user-agent", "accept", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-user", "sec-fetch-dest", "accept-encoding", "accept-language", "priority"},
		},
	}
	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[getloginpage] ERROR: %s", err)
		t.handleProxyRequestError(err)
		return
	}
	switch response.StatusCode {
	case 200:
	case 412:
		if t.handlePX412(body) {
			return
		}
	case 302:
		if strings.Contains(strings.ToLower(response.Header.Get("Location")), "/blocked") {
			t.Error = fmt.Errorf("px blocked")
			return
		}
	case 444:
		t.Error = fmt.Errorf("proxy block")
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		log.Printf("[getloginpage] Unexpected status code: %d", response.StatusCode)
		t.Error = fmt.Errorf("get-session (%d)", response.StatusCode)
	}
}

func (t *WalmartTask) SubmitEmail() {
	data := map[string]interface{}{
		"query": "query GetLoginOptions($input:UserOptionsInput!){getLoginOptions(input:$input){loginOptions{...LoginOptionsFragment}canUseEmailOTP phoneCollectionRequired consentCollectionRequired authCode errors{...LoginOptionsErrorFragment}}}fragment LoginOptionsFragment on LoginOptions{loginId loginIdType emailId phoneNumber{number countryCode isoCountryCode}canUsePassword canUsePhoneOTP canUseEmailOTP loginPhoneLastFour maskedPhoneNumberDetails{loginPhoneLastFour countryCode isoCountryCode}loginMaskedEmailId signInPreference loginPreference lastLoginPreference hasRemainingFactors secondFactor isPhoneConnected otherAccountsWithPhone hasPasskeyOnProfile accountDomain residencyRegion{residencyCountryCode residencyRegionCode}isIdentityMergeRequired consentRequired requiresTokenBasedPasswordSetup supportedOtpChannels}fragment LoginOptionsErrorFragment on IdentityLoginOptionsError{code message version}",
		"variables": map[string]interface{}{
			"input": map[string]interface{}{
				"loginId":     t.Account.Username,
				"loginIdType": "EMAIL",
				"ssoOptions": map[string]interface{}{
					"wasConsentCaptured": true,
					"callbackUrl":        "https://www.walmart.com/account/verifyToken",
					"clientId":           "5f3fb121-076a-45f6-9587-249f0bc160ff",
					"scope":              "openid email offline_access",
					"state":              "/",
					"challenge":          t.ChallengeCode,
				},
			},
		},
	}

	payloadBytes, err := json.Marshal(data)
	if err != nil {
		t.Error = err
		return
	}

	correlationBytes := make([]byte, 24)
	rand.Read(correlationBytes)
	correlationID := base64.RawURLEncoding.EncodeToString(correlationBytes)
	traceID := make([]byte, 16)
	spanID := make([]byte, 8)
	rand.Read(traceID)
	rand.Read(spanID)
	traceparent := fmt.Sprintf("00-%s-%s-00", hex.EncodeToString(traceID), hex.EncodeToString(spanID))
	baggage := fmt.Sprintf("requestTs=%d,tpid=%s", time.Now().UnixMilli(), traceparent)
	referer := fmt.Sprintf("https://identity.walmart.com/account/signin/otponly?scope=openid%%20email%%20offline_access&redirect_uri=https%%3A%%2F%%2Fwww.walmart.com%%2Faccount%%2FverifyToken&client_id=5f3fb121-076a-45f6-9587-249f0bc160ff&tenant_id=elh9ie&code_challenge=%s&state=%%2F", t.ChallengeCode)

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    "https://identity.walmart.com/orchestra/idp/graphql",
			Data:   string(payloadBytes),
		},
		Headers: map[string][]string{
			"x-o-mart":                {"B2C"},
			"x-o-gql-query":           {"query GetLoginOptions"},
			"sec-ch-ua-platform":      {t.Requests.UserAgent.Platform},
			"x-o-segment":             {"oaoh"},
			"device_profile_ref_id":   {t.TMXDeviceID},
			"sec-ch-ua":               {t.Requests.UserAgent.Sec_ua},
			"x-enable-server-timing":  {"1"},
			"sec-ch-ua-mobile":        {"?0"},
			"baggage":                 {baggage},
			"x-latency-trace":         {"1"},
			"traceparent":             {traceparent},
			"wm_mp":                   {"true"},
			"accept":                  {"application/json"},
			"content-type":            {"application/json"},
			"x-apollo-operation-name": {"GetLoginOptions"},
			"tenant-id":               {"elh9ie"},
			"downlink":                {"10"},
			"wm_qos.correlation_id":   {correlationID},
			"x-o-platform":            {"rweb"},
			"x-o-platform-version":    {"usweb-1.277.0-de1f77bbfc9cf424763e6ae92d532df595b7f092-6250347r"},
			"accept-language":         {"en-US"},
			"x-o-ccm":                 {"server"},
			"x-o-bu":                  {"WALMART-US"},
			"dpr":                     {"1"},
			"user-agent":              {t.Requests.UserAgent.Useragent},
			"wm_page_url":             {referer},
			"x-o-correlation-id":      {correlationID},
			"origin":                  {"https://identity.walmart.com"},
			"sec-fetch-site":          {"same-origin"},
			"sec-fetch-mode":          {"cors"},
			"sec-fetch-dest":          {"empty"},
			"referer":                 {referer},
			"accept-encoding":         {"gzip, deflate, br, zstd"},
			"priority":                {"u=1, i"},
			"header-order":            {"content-length", "x-o-mart", "x-o-gql-query", "sec-ch-ua-platform", "x-o-segment", "device_profile_ref_id", "sec-ch-ua", "x-enable-server-timing", "sec-ch-ua-mobile", "baggage", "x-latency-trace", "traceparent", "wm_mp", "accept", "content-type", "x-apollo-operation-name", "tenant-id", "downlink", "wm_qos.correlation_id", "x-o-platform", "x-o-platform-version", "accept-language", "x-o-ccm", "x-o-bu", "dpr", "user-agent", "wm_page_url", "x-o-correlation-id", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "priority"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[submitEmail] ERROR: %s", err)
		t.handleProxyRequestError(err)
		return
	}
	switch response.StatusCode {
	case 200:
		if challengeErr := identityChallengeError(body); challengeErr != nil {
			t.Error = challengeErr
		}
	case 412:
		if t.handlePX412(body) {
			return
		}
	case 302:
		if strings.Contains(strings.ToLower(response.Header.Get("Location")), "/blocked") {
			t.Error = fmt.Errorf("px blocked")
			return
		}
	case 444:
		t.Error = fmt.Errorf("proxy block")
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.Error = fmt.Errorf("submit-email (%d)", response.StatusCode)
		return
	}
}

func (t *WalmartTask) GetSigninOptions() {
	data := map[string]interface{}{
		"query": "query getSignInWithOTPChoiceModule( $pageType:String! $tempo:JSON $tenant:String! ){contentLayout(channel:\"WWW\" pageType:$pageType tenant:$tenant){modules(tempo:$tempo){name type version status schedule{start end priority expEnabled}triggers{pageType pageId zone inheritable}targeting configs{__typename...on TempoWM_GLASSWWWSignInWithOTPChoiceConfigs{logo{alt assetId assetName clickThrough{type value rawValue tag}height src title width size contentType}headerText emailAddressText phoneNumberText EmailOnlyLabelText changeEmailAddressLinkAsButton{changeEmailAddressButtonLabel ariaLabel}infoText infoTextV2 verificationText verificationTextPhone verificationTextEmail messageChargeText mobileAlertText links{link{linkText title clickThrough{type value rawValue}}}requestButton{requestButtonLabel ariaLabel}requestButtonV2{requestButtonLabel ariaLabel}inputFields{passwordInputPlaceholder passwordInputFieldLabel emptyPasswordInputFieldError}forgotPasswordLinkAsButton{forgotPasswordButtonLabel ariaLabel}checkboxes{checboxLabel checkboxValue checkboxDescription checkboxInfo{info}}signInButton{signInButtonLabel ariaLabel}}}publishedDate moduleId module_id matchedTrigger{pageType pageId zone inheritable}}layouts{id layout}}}",
		"variables": map[string]interface{}{
			"pageType": "SignInWithOTPChoicePage",
			"tenant":   "WM_GLASS",
			"tempo":    map[string]interface{}{"targeting": "%7B%22identityClientTarget%22%3A%225f3fb121-076a-45f6-9587-249f0bc160ff%22%7D"},
		},
	}

	payloadBytes, err := json.Marshal(data)
	if err != nil {
		t.Error = err
		return
	}

	correlationBytes := make([]byte, 24)
	rand.Read(correlationBytes)
	correlationID := base64.RawURLEncoding.EncodeToString(correlationBytes)
	traceID := make([]byte, 16)
	spanID := make([]byte, 8)
	rand.Read(traceID)
	rand.Read(spanID)
	traceparent := fmt.Sprintf("00-%s-%s-00", hex.EncodeToString(traceID), hex.EncodeToString(spanID))
	baggage := fmt.Sprintf("requestTs=%d,tpid=%s", time.Now().UnixMilli(), traceparent)
	referer := fmt.Sprintf("https://identity.walmart.com/account/signin/otponly?scope=openid%%20email%%20offline_access&redirect_uri=https%%3A%%2F%%2Fwww.walmart.com%%2Faccount%%2FverifyToken&client_id=5f3fb121-076a-45f6-9587-249f0bc160ff&tenant_id=elh9ie&code_challenge=%s&state=%%2F", t.ChallengeCode)

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    "https://identity.walmart.com/orchestra/idp/graphql",
			Data:   string(payloadBytes),
		},
		Headers: map[string][]string{
			"x-o-mart":                {"SPARK"},
			"x-o-gql-query":           {"query getSignInWithOTPChoiceModule"},
			"sec-ch-ua-platform":      {t.Requests.UserAgent.Platform},
			"x-o-segment":             {"oaoh"},
			"device_profile_ref_id":   {t.TMXDeviceID},
			"sec-ch-ua":               {t.Requests.UserAgent.Sec_ua},
			"x-enable-server-timing":  {"1"},
			"sec-ch-ua-mobile":        {"?0"},
			"baggage":                 {baggage},
			"x-latency-trace":         {"1"},
			"traceparent":             {traceparent},
			"wm_mp":                   {"true"},
			"accept":                  {"application/json"},
			"content-type":            {"application/json"},
			"x-apollo-operation-name": {"getSignInWithOTPChoiceModule"},
			"tenant-id":               {"elh9ie"},
			"downlink":                {"10"},
			"wm_qos.correlation_id":   {correlationID},
			"x-o-platform":            {"rweb"},
			"x-o-platform-version":    {"usweb-1.277.0-de1f77bbfc9cf424763e6ae92d532df595b7f092-6250347r"},
			"accept-language":         {"en-US"},
			"x-o-ccm":                 {"server"},
			"x-o-bu":                  {"WALMART-US"},
			"dpr":                     {"1"},
			"user-agent":              {t.Requests.UserAgent.Useragent},
			"wm_page_url":             {referer},
			"x-o-correlation-id":      {correlationID},
			"origin":                  {"https://identity.walmart.com"},
			"sec-fetch-site":          {"same-origin"},
			"sec-fetch-mode":          {"cors"},
			"sec-fetch-dest":          {"empty"},
			"referer":                 {referer},
			"accept-encoding":         {"gzip, deflate, br, zstd"},
			"priority":                {"u=1, i"},
			"header-order":            {"content-length", "x-o-mart", "x-o-gql-query", "sec-ch-ua-platform", "x-o-segment", "device_profile_ref_id", "sec-ch-ua", "x-enable-server-timing", "sec-ch-ua-mobile", "baggage", "x-latency-trace", "traceparent", "wm_mp", "accept", "content-type", "x-apollo-operation-name", "tenant-id", "downlink", "wm_qos.correlation_id", "x-o-platform", "x-o-platform-version", "accept-language", "x-o-ccm", "x-o-bu", "dpr", "user-agent", "wm_page_url", "x-o-correlation-id", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "priority"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[getSigninOptions] ERROR: %s", err)
		t.handleProxyRequestError(err)
		return
	}
	switch response.StatusCode {
	case 200:
		if challengeErr := identityChallengeError(body); challengeErr != nil {
			t.Error = challengeErr
		}
	case 412:
		if t.handlePX412(body) {
			return
		}
	case 302:
		if strings.Contains(strings.ToLower(response.Header.Get("Location")), "/blocked") {
			t.Error = fmt.Errorf("px blocked")
			return
		}
	case 444:
		t.Error = fmt.Errorf("proxy block")
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.Error = fmt.Errorf("get-options (%d)", response.StatusCode)
		return
	}
}

func (t *WalmartTask) GetSignInOTPModule() {
	data := map[string]interface{}{
		"query": "query getSignInWithOTPModule( $pageType:String! $tenant:String! $tempo:JSON ){contentLayout(channel:\"WWW\" pageType:$pageType tenant:$tenant){modules(tempo:$tempo){name type version status schedule{start end priority expEnabled}triggers{pageType pageId zone inheritable}targeting configs{__typename...on TempoWM_GLASSWWWSignInWithOTPOnlyConfigs{logo{alt assetId assetName clickThrough{type value rawValue tag}height src title width size contentType}headerText emailAddressText phoneNumberText emailOnlyLabelText phoneNumberLabelText sixCellEmailText sixCellTotpText hideCustomerCarePopover sixPhoneNumberText changeEmailAddressLinkAsButton{changeEmailAddressButtonLabel ariaLabel}phoneNumberText inputFields{verificationCodeInputHeadingText verificationCodeInputFieldPlaceholder emptyVerificationCodeInputFieldError invalidVerificationCodeInputFieldError resendButton{resendButtonLabel ariaLabel}}signInButton{signInButtonLabel ariaLabel}verifyTotpButton{verifyTotpButtonLabel ariaLabel}useYourPasswordLinkAsButton{useYourPasswordLinkAsButtonLabel ariaLabel}checkboxes{checboxLabel checkboxValue checkboxDescription checkboxInfo{info}}}}publishedDate moduleId module_id matchedTrigger{pageType pageId zone inheritable}}layouts{id layout}}}",
		"variables": map[string]interface{}{
			"pageType": "SignInWithOTPOnlyPage",
			"tenant":   "WM_GLASS",
			"tempo":    map[string]interface{}{"targeting": "%7B%22identityClientTarget%22%3A%225f3fb121-076a-45f6-9587-249f0bc160ff%22%7D"},
		},
	}

	payloadBytes, err := json.Marshal(data)
	if err != nil {
		t.Error = err
		return
	}

	correlationBytes := make([]byte, 24)
	rand.Read(correlationBytes)
	correlationID := base64.RawURLEncoding.EncodeToString(correlationBytes)
	traceID := make([]byte, 16)
	spanID := make([]byte, 8)
	rand.Read(traceID)
	rand.Read(spanID)
	traceparent := fmt.Sprintf("00-%s-%s-00", hex.EncodeToString(traceID), hex.EncodeToString(spanID))
	baggage := fmt.Sprintf("requestTs=%d,tpid=%s", time.Now().UnixMilli(), traceparent)
	referer := "https://identity.walmart.com/account/signin/otponly?scope=openid%20email%20offline_access&redirect_uri=https%3A%2F%2Fwww.walmart.com%2Faccount%2FverifyToken&client_id=5f3fb121-076a-45f6-9587-249f0bc160ff&tenant_id=elh9ie&code_challenge=" + t.ChallengeCode + "&state=%2Fip%2F20-Huffy-Rock-It-Kids-Bicycle-for-Kids-Ages-5-Child-Blue%2F665534685%3FathAsset%3DeyJhdGhjcGlkIjoiNjY1NTM0Njg1IiwiYXRoc3RpZCI6IkNTMDIwIiwiZ3JwSWQiOiJjZjQ1OWUwYy1mYTYxLTRkYTMtYTNmYS0wMmE5NjViNjJiMzQiLCJhdGhhbmNpZCI6IlByaXNtU2Nyb2xsYWJsZUl0ZW1HcmlkIiwiYXRocmsiOjAuMH0%3D%26athena%3Dtrue%26athbdg%3DL1300"

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    "https://identity.walmart.com/orchestra/idp/graphql",
			Data:   string(payloadBytes),
		},
		Headers: map[string][]string{
			"x-o-mart":                {"B2C"},
			"x-o-gql-query":           {"query getSignInWithOTPModule"},
			"sec-ch-ua-platform":      {t.Requests.UserAgent.Platform},
			"x-o-segment":             {"oaoh"},
			"device_profile_ref_id":   {t.TMXDeviceID},
			"sec-ch-ua":               {t.Requests.UserAgent.Sec_ua},
			"x-enable-server-timing":  {"1"},
			"sec-ch-ua-mobile":        {"?0"},
			"baggage":                 {baggage},
			"x-latency-trace":         {"1"},
			"traceparent":             {traceparent},
			"wm_mp":                   {"true"},
			"accept":                  {"application/json"},
			"content-type":            {"application/json"},
			"x-apollo-operation-name": {"getSignInWithOTPModule"},
			"tenant-id":               {"elh9ie"},
			"downlink":                {"10"},
			"wm_qos.correlation_id":   {correlationID},
			"x-o-platform":            {"rweb"},
			"x-o-platform-version":    {"usweb-1.277.0-de1f77bbfc9cf424763e6ae92d532df595b7f092-6250347r"},
			"accept-language":         {"en-US"},
			"x-o-ccm":                 {"server"},
			"x-o-bu":                  {"WALMART-US"},
			"dpr":                     {"1"},
			"user-agent":              {t.Requests.UserAgent.Useragent},
			"wm_page_url":             {referer},
			"x-o-correlation-id":      {correlationID},
			"origin":                  {"https://identity.walmart.com"},
			"sec-fetch-site":          {"same-origin"},
			"sec-fetch-mode":          {"cors"},
			"sec-fetch-dest":          {"empty"},
			"referer":                 {referer},
			"accept-encoding":         {"gzip, deflate, br, zstd"},
			"priority":                {"u=1, i"},
			"header-order":            {"content-length", "x-o-mart", "x-o-gql-query", "sec-ch-ua-platform", "x-o-segment", "device_profile_ref_id", "sec-ch-ua", "x-enable-server-timing", "sec-ch-ua-mobile", "baggage", "x-latency-trace", "traceparent", "wm_mp", "accept", "content-type", "x-apollo-operation-name", "tenant-id", "downlink", "wm_qos.correlation_id", "x-o-platform", "x-o-platform-version", "accept-language", "x-o-ccm", "x-o-bu", "dpr", "user-agent", "wm_page_url", "x-o-correlation-id", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "priority"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[getSigninOTP] ERROR: %s", err)
		t.handleProxyRequestError(err)
		return
	}
	switch response.StatusCode {
	case 200:
		if challengeErr := identityChallengeError(body); challengeErr != nil {
			t.Error = challengeErr
		}
	case 412:
		if t.handlePX412(body) {
			return
		}
	case 302:
		if strings.Contains(strings.ToLower(response.Header.Get("Location")), "/blocked") {
			t.Error = fmt.Errorf("px blocked")
			return
		}
	case 444:
		t.Error = fmt.Errorf("proxy block")
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.Error = fmt.Errorf("get-otp-module (%d)", response.StatusCode)
		return
	}
}

func (t *WalmartTask) SubmitPassword() {
	data := map[string]interface{}{
		"query": "mutation signInV2( $input:SignInV2Input! $includeSuggestedPhoneNumbers:Boolean = false ){signInV2(input:$input){canUseEmailOTP authCode{authCode cid}auth{...AuthResultFragment}multiFactorInfo{...MultiFactorInfoFragment}loginOptions{...LoginOptionsFragment}phoneInfo{...PhoneInfoFragment suggestedPhoneNumbers @include(if:$includeSuggestedPhoneNumbers){phoneNumber countryCode isoCountryCode}}otpConsentInfo{...OtpConsentInfoFragment}isMandatory2FASetupRequired twoFALoginOptions{...TwoFALoginOptionsFragment}errors{...SignInErrorFragment}}}fragment AuthResultFragment on AuthResult{loginId loginIdType emailId phoneNumber{number countryCode isVerified isoCountryCode}cid authCode identityToken firstName lastName clientConsentRequired accessToken refreshToken}fragment MultiFactorInfoFragment on MultiFactorInfo{nextFactor ignoreFactor hasRemainingFactors phoneLastFour maskedPhoneNumberDetails{...MaskedPhoneNumberDetailsFragment}receiptId loginMaskedEmailId hasPasskeyOnProfile}fragment LoginOptionsFragment on LoginOptions{loginId loginIdType loginMaskedEmailId emailId loginPhoneLastFour isPhoneConnected otherAccountsWithPhone phoneNumber{countryCode isoCountryCode isVerified number}maskedPhoneNumberDetails{...MaskedPhoneNumberDetailsFragment}canUsePassword canUseEmailOTP canUsePhoneOTP hasRemainingFactors hasPasskeyOnProfile requiresTokenBasedPasswordSetup loginPreference lastLoginPreference supportedOtpChannels}fragment PhoneInfoFragment on PhoneInfo{phoneLastFour shouldCollectPhone isEmailSessionTrusted loginId isPhoneSessionTrusted isFirstSession isEmailValidated isPhoneCollMandatory}fragment OtpConsentInfoFragment on OtpConsentInfo{showEmailOtpConsent showPhoneOtpConsent}fragment SignInErrorFragment on IdentitySignInError{code message version}fragment MaskedPhoneNumberDetailsFragment on MaskedPhoneNumberDetails{loginPhoneLastFour countryCode isoCountryCode formattedMaskedPhoneNumber}fragment TwoFALoginOptionsFragment on TwoFALoginOptions{twoFALoginMethods{method isConfigured precedence identity{phoneNumber{number countryCode isoCountryCode}formattedMaskedPhoneNumber emailId maskedEmailId}}}",
		"variables": map[string]interface{}{
			"input": map[string]interface{}{
				"loginId":    t.Account.Username,
				"password":   t.Account.Password,
				"rememberMe": true,
				"useCase":    "STEP_UP_REQUIRED",
				"ssoOptions": map[string]interface{}{
					"wasConsentCaptured": true,
					"callbackUrl":        "https://www.walmart.com/account/verifyToken",
					"clientId":           "5f3fb121-076a-45f6-9587-249f0bc160ff",
					"scope":              "openid email offline_access",
					"state":              "/",
					"challenge":          t.ChallengeCode,
				},
			},
			"includeSuggestedPhoneNumbers": false,
		},
	}

	payloadBytes, err := json.Marshal(data)
	if err != nil {
		t.Error = err
		return
	}

	correlationBytes := make([]byte, 24)
	rand.Read(correlationBytes)
	correlationID := base64.RawURLEncoding.EncodeToString(correlationBytes)
	traceID := make([]byte, 16)
	spanID := make([]byte, 8)
	rand.Read(traceID)
	rand.Read(spanID)
	traceparent := fmt.Sprintf("00-%s-%s-00", hex.EncodeToString(traceID), hex.EncodeToString(spanID))
	baggage := fmt.Sprintf("requestTs=%d,tpid=%s", time.Now().UnixMilli(), traceparent)
	referer := fmt.Sprintf("https://identity.walmart.com/account/signin/withotpchoice?scope=openid%%20email%%20offline_access&redirect_uri=https%%3A%%2F%%2Fwww.walmart.com%%2Faccount%%2FverifyToken&client_id=5f3fb121-076a-45f6-9587-249f0bc160ff&tenant_id=elh9ie&code_challenge=%s&state=%%2F", t.ChallengeCode)

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    "https://identity.walmart.com/orchestra/idp/graphql",
			Data:   string(payloadBytes),
		},
		Headers: map[string][]string{
			"x-o-mart":                {"B2C"},
			"x-o-gql-query":           {"mutation signInV2"},
			"sec-ch-ua-platform":      {t.Requests.UserAgent.Platform},
			"x-o-segment":             {"oaoh"},
			"device_profile_ref_id":   {t.TMXDeviceID},
			"sec-ch-ua":               {t.Requests.UserAgent.Sec_ua},
			"x-enable-server-timing":  {"1"},
			"sec-ch-ua-mobile":        {"?0"},
			"baggage":                 {baggage},
			"x-latency-trace":         {"1"},
			"traceparent":             {traceparent},
			"wm_mp":                   {"true"},
			"accept":                  {"application/json"},
			"content-type":            {"application/json"},
			"x-apollo-operation-name": {"signInV2"},
			"tenant-id":               {"elh9ie"},
			"downlink":                {"10"},
			"wm_qos.correlation_id":   {correlationID},
			"x-o-platform":            {"rweb"},
			"x-o-platform-version":    {"usweb-1.277.0-de1f77bbfc9cf424763e6ae92d532df595b7f092-6250347r"},
			"accept-language":         {"en-US"},
			"x-o-ccm":                 {"server"},
			"x-o-bu":                  {"WALMART-US"},
			"dpr":                     {"1"},
			"user-agent":              {t.Requests.UserAgent.Useragent},
			"wm_page_url":             {referer},
			"x-o-correlation-id":      {correlationID},
			"origin":                  {"https://identity.walmart.com"},
			"sec-fetch-site":          {"same-origin"},
			"sec-fetch-mode":          {"cors"},
			"sec-fetch-dest":          {"empty"},
			"referer":                 {referer},
			"accept-encoding":         {"gzip, deflate, br, zstd"},
			"priority":                {"u=1, i"},
			"header-order":            {"content-length", "x-o-mart", "x-o-gql-query", "sec-ch-ua-platform", "x-o-segment", "device_profile_ref_id", "sec-ch-ua", "x-enable-server-timing", "sec-ch-ua-mobile", "baggage", "x-latency-trace", "traceparent", "wm_mp", "accept", "content-type", "x-apollo-operation-name", "tenant-id", "downlink", "wm_qos.correlation_id", "x-o-platform", "x-o-platform-version", "accept-language", "x-o-ccm", "x-o-bu", "dpr", "user-agent", "wm_page_url", "x-o-correlation-id", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "priority"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[submitPassword] ERROR: %s", err)
		t.handleProxyRequestError(err)
		return
	}
	switch response.StatusCode {
	case 200:
		var parsed signInV2Response
		if err := json.Unmarshal([]byte(body), &parsed); err != nil {
			t.Error = err
			return
		}
		result := parsed.Data.SignInV2
		if len(result.Errors) > 0 {
			errCode := result.Errors[0].Code
			msg := result.Errors[0].Message
			if msg == "" {
				msg = errCode
			}
			if identityPasswordFailed(errCode, msg) {
				t.Error = fmt.Errorf("password invaild")
				return
			}
			if identityChallengeFailed(msg) {
				t.Error = fmt.Errorf("challenge failed")
			} else {
				t.Error = fmt.Errorf("%s", msg)
			}
			return
		}
		authCode := result.AuthCode.AuthCode
		if authCode == "" {
			authCode = result.Auth.AuthCode
		}
		if authCode != "" {
			t.AuthCode = authCode
			return
		}
		if signInNeedsEmailOTP(result.LoginOptions, result.CanUseEmailOTP) {
			t.NeedsEmailOTP = true
			return
		}
		if identityPhoneOnlyOTP(result.LoginOptions.SupportedOtpChannels) {
			t.Error = fmt.Errorf("phone 2fa required")
			return
		}
		t.Error = fmt.Errorf("invalid email/password")
	case 412:
		if t.handlePX412(body) {
			return
		}
	case 302:
		if strings.Contains(strings.ToLower(response.Header.Get("Location")), "/blocked") {
			t.Error = fmt.Errorf("px blocked")
			return
		}
	case 444:
		t.Error = fmt.Errorf("proxy block")
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.Error = fmt.Errorf("submit-password (%d)", response.StatusCode)
		return
	}
}

func (t *WalmartTask) ResetPassword() {
	password := RandomPassword(12)
	data := map[string]interface{}{
		"query": "mutation resetPassword( $input:ResetPasswordInput! $includePhoneInfo:Boolean = false ){resetPassword(input:$input){auth{...ResetPasswordAuthFragment}phoneInfo @include(if:$includePhoneInfo){...ResetPasswordPhoneInfoFragment}errors{...ResetPasswordErrorFragment}authCode{authCode cid}isMandatory2FASetupRequired twoFALoginOptions{...TwoFALoginOptionsFragment}}}fragment ResetPasswordErrorFragment on IdentityResetPasswordError{code message}fragment ResetPasswordAuthFragment on AuthResult{loginId cid authCode identityToken}fragment ResetPasswordPhoneInfoFragment on PhoneInfo{phoneLastFour shouldCollectPhone isEmailSessionTrusted isPhoneSessionTrusted}fragment TwoFALoginOptionsFragment on TwoFALoginOptions{twoFALoginMethods{method isConfigured precedence identity{phoneNumber{number countryCode isoCountryCode}formattedMaskedPhoneNumber emailId maskedEmailId}}}",
		"variables": map[string]interface{}{
			"input": map[string]interface{}{
				"loginId":      t.Account.Username,
				"loginIdType":  "EMAIL",
				"password":     password,
				"otpOperation": "OTP_EMAIL_RESET",
				"ssoOptions": map[string]interface{}{
					"wasConsentCaptured": true,
					"callbackUrl":        "https://www.walmart.com/account/verifyToken",
					"clientId":           "5f3fb121-076a-45f6-9587-249f0bc160ff",
					"scope":              "openid email offline_access",
					"state":              "/",
					"challenge":          t.ChallengeCode,
				},
			},
			"includePhoneInfo": true,
		},
	}

	payloadBytes, err := json.Marshal(data)
	if err != nil {
		t.Error = err
		return
	}

	correlationBytes := make([]byte, 24)
	rand.Read(correlationBytes)
	correlationID := base64.RawURLEncoding.EncodeToString(correlationBytes)
	traceID := make([]byte, 16)
	spanID := make([]byte, 8)
	rand.Read(traceID)
	rand.Read(spanID)
	traceparent := fmt.Sprintf("00-%s-%s-00", hex.EncodeToString(traceID), hex.EncodeToString(spanID))
	baggage := fmt.Sprintf("requestTs=%d,tpid=%s", time.Now().UnixMilli(), traceparent)
	referer := fmt.Sprintf("https://identity.walmart.com/account/skipresetpassword?cope=openid%%20email%%20offline_access&redirect_uri=https%%3A%%2F%%2Fwww.walmart.com%%2Faccount%%2FverifyToken&client_id=5f3fb121-076a-45f6-9587-249f0bc160ff&tenant_id=elh9ie&code_challenge=%s&state=%%2F", t.ChallengeCode)

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    "https://identity.walmart.com/orchestra/idp/graphql",
			Data:   string(payloadBytes),
		},
		Headers: map[string][]string{
			"x-o-mart":                {"SPARK"},
			"x-o-gql-query":           {"mutation GenerateOtp"},
			"sec-ch-ua-platform":      {t.Requests.UserAgent.Platform},
			"x-o-segment":             {"oaoh"},
			"device_profile_ref_id":   {t.TMXDeviceID},
			"sec-ch-ua":               {t.Requests.UserAgent.Sec_ua},
			"x-enable-server-timing":  {"1"},
			"sec-ch-ua-mobile":        {"?0"},
			"baggage":                 {baggage},
			"x-latency-trace":         {"1"},
			"traceparent":             {traceparent},
			"wm_mp":                   {"true"},
			"accept":                  {"application/json"},
			"content-type":            {"application/json"},
			"x-apollo-operation-name": {"GenerateOtp"},
			"tenant-id":               {"elh9ie"},
			"downlink":                {"10"},
			"wm_qos.correlation_id":   {correlationID},
			"x-o-platform":            {"rweb"},
			"x-o-platform-version":    {"usweb-1.277.0-de1f77bbfc9cf424763e6ae92d532df595b7f092-6250347r"},
			"accept-language":         {"en-US"},
			"x-o-ccm":                 {"server"},
			"x-o-bu":                  {"WALMART-US"},
			"dpr":                     {"1"},
			"user-agent":              {t.Requests.UserAgent.Useragent},
			"wm_page_url":             {referer},
			"x-o-correlation-id":      {correlationID},
			"origin":                  {"https://identity.walmart.com"},
			"sec-fetch-site":          {"same-origin"},
			"sec-fetch-mode":          {"cors"},
			"sec-fetch-dest":          {"empty"},
			"referer":                 {referer},
			"accept-encoding":         {"gzip, deflate, br, zstd"},
			"priority":                {"u=1, i"},
			"header-order":            {"content-length", "x-o-mart", "x-o-gql-query", "sec-ch-ua-platform", "x-o-segment", "device_profile_ref_id", "sec-ch-ua", "x-enable-server-timing", "sec-ch-ua-mobile", "baggage", "x-latency-trace", "traceparent", "wm_mp", "accept", "content-type", "x-apollo-operation-name", "tenant-id", "downlink", "wm_qos.correlation_id", "x-o-platform", "x-o-platform-version", "accept-language", "x-o-ccm", "x-o-bu", "dpr", "user-agent", "wm_page_url", "x-o-correlation-id", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "priority"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[resetPassword] ERROR: %s", err)
		t.handleProxyRequestError(err)
		return
	}
	switch response.StatusCode {
	case 200:
		if challengeErr := identityChallengeError(body); challengeErr != nil {
			t.Error = challengeErr
			return
		}
		t.Account.Password = password
		t.UpdatePassword(password, t.Account.Id)
	case 412:
		if t.handlePX412(body) {
			return
		}
	case 302:
		if strings.Contains(strings.ToLower(response.Header.Get("Location")), "/blocked") {
			t.Error = fmt.Errorf("px blocked")
			return
		}
	case 444:
		t.Error = fmt.Errorf("proxy block")
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.Error = fmt.Errorf("reset-password (%d)", response.StatusCode)
		return
	}
}

func (t *WalmartTask) RequestCode(operation string) {
	data := map[string]interface{}{
		"query": "mutation GenerateOtp($input:GenerateOTPInput!){generateOTP(input:$input){errors{...GenerateOtpErrorFragment}otpResult{...GenerateOtpResultFragment}}}fragment GenerateOtpErrorFragment on IdentityGenerateOTPError{code message}fragment GenerateOtpResultFragment on GenerateOTPResult{receiptId otpOperation otpType otherAccountsWithPhone action{alternateOption currentOption}supportedOtpChannels}",
		"variables": map[string]interface{}{
			"input": map[string]interface{}{
				"loginId":      t.Account.Username,
				"loginIdType":  "EMAIL",
				"otpOperation": operation,
				"ssoOptions": map[string]interface{}{
					"wasConsentCaptured": true,
					"callbackUrl":        "https://www.walmart.com/account/verifyToken",
					"clientId":           "5f3fb121-076a-45f6-9587-249f0bc160ff",
					"scope":              "openid email offline_access",
					"state":              "/",
					"challenge":          t.ChallengeCode,
				},
			},
		},
	}

	payloadBytes, err := json.Marshal(data)
	if err != nil {
		t.Error = err
		return
	}

	correlationBytes := make([]byte, 24)
	rand.Read(correlationBytes)
	correlationID := base64.RawURLEncoding.EncodeToString(correlationBytes)
	traceID := make([]byte, 16)
	spanID := make([]byte, 8)
	rand.Read(traceID)
	rand.Read(spanID)
	traceparent := fmt.Sprintf("00-%s-%s-00", hex.EncodeToString(traceID), hex.EncodeToString(spanID))
	baggage := fmt.Sprintf("requestTs=%d,tpid=%s", time.Now().UnixMilli(), traceparent)
	referer := fmt.Sprintf("https://identity.walmart.com/account/signin/otponly?scope=openid%%20email%%20offline_access&redirect_uri=https%%3A%%2F%%2Fwww.walmart.com%%2Faccount%%2FverifyToken&client_id=5f3fb121-076a-45f6-9587-249f0bc160ff&tenant_id=elh9ie&code_challenge=%s&state=%%2F", t.ChallengeCode)

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    "https://identity.walmart.com/orchestra/idp/graphql",
			Data:   string(payloadBytes),
		},
		Headers: map[string][]string{
			"x-o-mart":                {"SPARK"},
			"x-o-gql-query":           {"mutation GenerateOtp"},
			"sec-ch-ua-platform":      {t.Requests.UserAgent.Platform},
			"x-o-segment":             {"oaoh"},
			"device_profile_ref_id":   {t.TMXDeviceID},
			"sec-ch-ua":               {t.Requests.UserAgent.Sec_ua},
			"x-enable-server-timing":  {"1"},
			"sec-ch-ua-mobile":        {"?0"},
			"baggage":                 {baggage},
			"x-latency-trace":         {"1"},
			"traceparent":             {traceparent},
			"wm_mp":                   {"true"},
			"accept":                  {"application/json"},
			"content-type":            {"application/json"},
			"x-apollo-operation-name": {"GenerateOtp"},
			"tenant-id":               {"elh9ie"},
			"downlink":                {"10"},
			"wm_qos.correlation_id":   {correlationID},
			"x-o-platform":            {"rweb"},
			"x-o-platform-version":    {"usweb-1.277.0-de1f77bbfc9cf424763e6ae92d532df595b7f092-6250347r"},
			"accept-language":         {"en-US"},
			"x-o-ccm":                 {"server"},
			"x-o-bu":                  {"WALMART-US"},
			"dpr":                     {"1"},
			"user-agent":              {t.Requests.UserAgent.Useragent},
			"wm_page_url":             {referer},
			"x-o-correlation-id":      {correlationID},
			"origin":                  {"https://identity.walmart.com"},
			"sec-fetch-site":          {"same-origin"},
			"sec-fetch-mode":          {"cors"},
			"sec-fetch-dest":          {"empty"},
			"referer":                 {referer},
			"accept-encoding":         {"gzip, deflate, br, zstd"},
			"priority":                {"u=1, i"},
			"header-order":            {"content-length", "x-o-mart", "x-o-gql-query", "sec-ch-ua-platform", "x-o-segment", "device_profile_ref_id", "sec-ch-ua", "x-enable-server-timing", "sec-ch-ua-mobile", "baggage", "x-latency-trace", "traceparent", "wm_mp", "accept", "content-type", "x-apollo-operation-name", "tenant-id", "downlink", "wm_qos.correlation_id", "x-o-platform", "x-o-platform-version", "accept-language", "x-o-ccm", "x-o-bu", "dpr", "user-agent", "wm_page_url", "x-o-correlation-id", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "priority"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[requestCode] ERROR: %s", err)
		t.handleProxyRequestError(err)
		return
	}
	switch response.StatusCode {
	case 200:
		if challengeErr := identityChallengeError(body); challengeErr != nil {
			t.Error = challengeErr
		}
	case 412:
		if t.handlePX412(body) {
			return
		}
	case 302:
		if strings.Contains(strings.ToLower(response.Header.Get("Location")), "/blocked") {
			t.Error = fmt.Errorf("px blocked")
			return
		}
	case 444:
		t.Error = fmt.Errorf("proxy block")
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.Error = fmt.Errorf("request-code (%d)", response.StatusCode)
		return
	}
}

func (t *WalmartTask) SubmitCode(operation string) {
	data := map[string]interface{}{
		"query": "mutation SignInWithOTP( $input:SignInWithOTPInput! $includePhoneInfo:Boolean = false ){signInWithOTP(input:$input){auth{...SignInOtpAuthFragment}authCode{authCode cid}phoneInfo @include(if:$includePhoneInfo){...SignInOtpPhoneInfoFragment}multiFactorInfo{ignoreFactor}errors{...SignInOtpErrorFragment}}}fragment SignInOtpAuthFragment on AuthResult{loginId cid authCode identityToken}fragment SignInOtpPhoneInfoFragment on PhoneInfo{phoneLastFour shouldCollectPhone isEmailSessionTrusted loginId isPhoneSessionTrusted isFirstSession isEmailValidated}fragment SignInOtpErrorFragment on IdentitySignInWithOTPError{code message}",
		"variables": map[string]interface{}{
			"includePhoneInfo": true,
			"input": map[string]interface{}{
				"loginId":      t.Account.Username,
				"loginIdType":  "EMAIL",
				"otpCode":      t.TwoFACode,
				"otpOperation": operation,
				"rememberMe":   true,
				"ssoOptions": map[string]interface{}{
					"wasConsentCaptured": true,
					"callbackUrl":        "https://www.walmart.com/account/verifyToken",
					"clientId":           "5f3fb121-076a-45f6-9587-249f0bc160ff",
					"scope":              "openid email offline_access",
					"state":              "/",
					"challenge":          t.ChallengeCode,
				},
			},
		},
	}

	payloadBytes, err := json.Marshal(data)
	if err != nil {
		t.Error = err
		return
	}

	correlationBytes := make([]byte, 24)
	rand.Read(correlationBytes)
	correlationID := base64.RawURLEncoding.EncodeToString(correlationBytes)
	traceID := make([]byte, 16)
	spanID := make([]byte, 8)
	rand.Read(traceID)
	rand.Read(spanID)
	traceparent := fmt.Sprintf("00-%s-%s-00", hex.EncodeToString(traceID), hex.EncodeToString(spanID))
	baggage := fmt.Sprintf("requestTs=%d,tpid=%s", time.Now().UnixMilli(), traceparent)
	referer := fmt.Sprintf("https://identity.walmart.com/account/signin/otponly?scope=openid%%20email%%20offline_access&redirect_uri=https%%3A%%2F%%2Fwww.walmart.com%%2Faccount%%2FverifyToken&client_id=5f3fb121-076a-45f6-9587-249f0bc160ff&tenant_id=elh9ie&code_challenge=%s&state=%%2F", t.ChallengeCode)

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    "https://identity.walmart.com/orchestra/idp/graphql",
			Data:   string(payloadBytes),
		},
		Headers: map[string][]string{
			"x-o-mart":                {"SPARK"},
			"x-o-gql-query":           {"mutation SignInWithOTP"},
			"sec-ch-ua-platform":      {t.Requests.UserAgent.Platform},
			"x-o-segment":             {"oaoh"},
			"device_profile_ref_id":   {t.TMXDeviceID},
			"sec-ch-ua":               {t.Requests.UserAgent.Sec_ua},
			"x-enable-server-timing":  {"1"},
			"sec-ch-ua-mobile":        {"?0"},
			"baggage":                 {baggage},
			"x-latency-trace":         {"1"},
			"traceparent":             {traceparent},
			"wm_mp":                   {"true"},
			"accept":                  {"application/json"},
			"content-type":            {"application/json"},
			"x-apollo-operation-name": {"SignInWithOTP"},
			"tenant-id":               {"elh9ie"},
			"downlink":                {"10"},
			"wm_qos.correlation_id":   {correlationID},
			"x-o-platform":            {"rweb"},
			"x-o-platform-version":    {"usweb-1.277.0-de1f77bbfc9cf424763e6ae92d532df595b7f092-6250347r"},
			"accept-language":         {"en-US"},
			"x-o-ccm":                 {"server"},
			"x-o-bu":                  {"WALMART-US"},
			"dpr":                     {"1"},
			"user-agent":              {t.Requests.UserAgent.Useragent},
			"wm_page_url":             {referer},
			"x-o-correlation-id":      {correlationID},
			"origin":                  {"https://identity.walmart.com"},
			"sec-fetch-site":          {"same-origin"},
			"sec-fetch-mode":          {"cors"},
			"sec-fetch-dest":          {"empty"},
			"referer":                 {referer},
			"accept-encoding":         {"gzip, deflate, br, zstd"},
			"priority":                {"u=1, i"},
			"header-order":            {"content-length", "x-o-mart", "x-o-gql-query", "sec-ch-ua-platform", "x-o-segment", "device_profile_ref_id", "sec-ch-ua", "x-enable-server-timing", "sec-ch-ua-mobile", "baggage", "x-latency-trace", "traceparent", "wm_mp", "accept", "content-type", "x-apollo-operation-name", "tenant-id", "downlink", "wm_qos.correlation_id", "x-o-platform", "x-o-platform-version", "accept-language", "x-o-ccm", "x-o-bu", "dpr", "user-agent", "wm_page_url", "x-o-correlation-id", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "priority"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[submitCode] ERROR: %s", err)
		t.handleProxyRequestError(err)
		return
	}
	switch response.StatusCode {
	case 200:
		if strings.Contains(body, "OTP_INVALID") {
			t.Error = fmt.Errorf("invaild code")
			return
		}
		if strings.Contains(body, "OTP_TOO_MANY_ATTEMPTS") {
			t.Error = fmt.Errorf("otp timeout")
			return
		}
		var parsed signInWithOTPResponse
		if err := json.Unmarshal([]byte(body), &parsed); err != nil {
			t.Error = err
			return
		}
		if len(parsed.Data.SignInWithOTP.Errors) > 0 {
			msg := parsed.Data.SignInWithOTP.Errors[0].Code
			switch msg {
			case "STEP_UP_REQUIRED":
				t.NeedsStepUp = true
			default:
				t.Error = fmt.Errorf("%s", msg)
			}
			return
		}
		if parsed.Data.SignInWithOTP.AuthCode.AuthCode == "" {
			t.Error = fmt.Errorf("submit-code failed")
			return
		}
		if parsed.Data.SignInWithOTP.PhoneInfo.ShouldCollectPhone {
			t.NoSMSLinked = true
		}
		t.AuthCode = parsed.Data.SignInWithOTP.AuthCode.AuthCode
		//remove login cookies that are normally removed
		t.Requests.AddCookie("tmx_guid", "deleted", ".walmart.com")
		t.Requests.AddCookie("thx_guid", "deleted", ".walmart.com")
		t.Requests.AddCookie("id_ctx", "deleted", ".walmart.com")
		t.Requests.AddCookie("slToken", "deleted", ".walmart.com")
	case 412:
		if t.handlePX412(body) {
			return
		}
	case 302:
		if strings.Contains(strings.ToLower(response.Header.Get("Location")), "/blocked") {
			t.Error = fmt.Errorf("px blocked")
			return
		}
	case 444:
		t.Error = fmt.Errorf("proxy block")
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.Error = fmt.Errorf("submit-code (%d)", response.StatusCode)
		return
	}
}

func (t *WalmartTask) VerifyToken() {
	t.Requests.AddCookie("_auth", "deleted", ".walmart.com")
	t.Requests.AddCookie("hasAuth", "deleted", ".walmart.com")
	t.Requests.AddCookie("walmart-identity-web-code-verifier", t.ChallengeVerifier, "www.walmart.com")

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "GET",
			URL:    fmt.Sprintf("https://www.walmart.com/account/verifyToken?state=%%2F&client_id=5f3fb121-076a-45f6-9587-249f0bc160ff&redirect_uri=https%%3A%%2F%%2Fwww.walmart.com%%2Faccount%%2FverifyToken&scope=openid+email+offline_access&code=%s&action=SignIn&rm=true", t.AuthCode),
		},
		Headers: map[string][]string{
			"sec-ch-ua":                 {t.Requests.UserAgent.Sec_ua},
			"sec-ch-ua-mobile":          {"?0"},
			"sec-ch-ua-platform":        {t.Requests.UserAgent.Platform},
			"upgrade-insecure-requests": {"1"},
			"user-agent":                {t.Requests.UserAgent.Useragent},
			"accept":                    {"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"},
			"sec-fetch-site":            {"same-site"},
			"sec-fetch-mode":            {"navigate"},
			"sec-fetch-user":            {"?1"},
			"sec-fetch-dest":            {"document"},
			"referer":                   {"https://identity.walmart.com/"},
			"accept-encoding":           {"gzip, deflate, br, zstd"},
			"accept-language":           {"en-US,en;q=0.9"},
			"priority":                  {"u=0, i"},
			"header-order":              {"sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "upgrade-insecure-requests", "user-agent", "accept", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-user", "sec-fetch-dest", "referer", "accept-encoding", "accept-language", "priority"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[verifyToken] ERROR: %s", err)
		t.handleProxyRequestError(err)
		return
	}
	switch response.StatusCode {
	case 200, 307, 520:
		if !t.hasSessionCookie("auth", "_auth") {
			t.Error = fmt.Errorf("verify-token failed")
		}
	case 412:
		if t.handlePX412(body) {
			return
		}
	case 302:
		if strings.Contains(strings.ToLower(response.Header.Get("Location")), "/blocked") {
			t.Error = fmt.Errorf("px blocked")
			return
		}
	case 444:
		t.Error = fmt.Errorf("proxy block")
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.Error = fmt.Errorf("verify-token (%d)", response.StatusCode)
	}
}

func (t *WalmartTask) GetCart() {

	data := map[string]interface{}{
		"variables": map[string]interface{}{
			"input": map[string]interface{}{
				"cartId":                 nil,
				"strategy":               "MERGE",
				"enableLiquorBox":        true,
				"enableCartSplitClarity": false,
				"features": []string{
					"lmpdel",
					"mlrx",
					"vsrx",
					"maappl",
					"accfournudge",
					"potp",
					"byod",
					"vptires",
					"pdr",
					"gepmss",
					"dd",
					"qsr",
					"qsr_qty",
					"cbs",
					"tfd",
					"wfss",
				},
			},
			"detailed":                                 false,
			"includePartialFulfillmentSwitching":       false,
			"enableAEBadge":                            false,
			"includeExpressSla":                        true,
			"includeQueueing":                          false,
			"enableCartBookslotShortcut":               false,
			"enableACCScheduling":                      true,
			"enableWalmartPlusFreeDiscountedExpress":   true,
			"enableDiscountedOrHolidayExpress":         true,
			"enableBenefitSavings":                     false,
			"enableUnifiedBadges":                      false,
			"enableCartLevelMSI":                       false,
			"enablePickupNotAvailable":                 false,
			"enableReturnsLabel":                       false,
			"enableStarRatings":                        false,
			"enableMsiMci":                             true,
			"enableTaxBreakdown":                       false,
			"enableI18nWave1":                          true,
			"enableWplusPetBenefit":                    false,
			"enableCartLevelPromotions":                true,
			"enableOrderCutOffTime":                    true,
			"enableHotCartFeature":                     false,
			"enableMOQ":                                false,
			"enableMOQVariants":                        false,
			"enableItemLevelAttributes":                false,
			"enablePetRxManualRefill":                  true,
			"enableItemLevelCheckout":                  false,
			"enableSuggestedSlotAvailability":          true,
			"enablePFS":                                true,
			"enableSubscriptionsInTransaction":         true,
			"enableSubscribeToSaveNudge":               false,
			"enableE2EPickupEnhancement":               true,
			"enableExpressPickup":                      false,
			"enableB2BCategoryRestriction":             false,
			"enableSubscriptionDiscounts":              false,
			"enablePromoDiscount":                      true,
			"enableWplusACCPayForServiceOnline":        false,
			"includeItemPackaging":                     false,
			"enableMultiStorePickup":                   false,
			"enableShopAllNode":                        false,
			"enableWFSGlobal":                          false,
			"includeFulfillmentSwitchOptions":          false,
			"enableMaxItemAllowedForRegularSlot":       false,
			"enableAvailableFinancingOptions":          false,
			"enableFreeDeliveryThreshold":              false,
			"enableShippingOptions":                    true,
			"enableShippingFeeClarity":                 true,
			"getPriceInfoDetails":                      true,
			"enableAccQuantityNudge":                   true,
			"enableFeeThresholdBar":                    false,
			"enableWic":                                true,
			"enableColdChainExpansion":                 true,
			"enableGEP":                                true,
			"enableIsEligibleForFreeTrialV1":           true,
			"enableMaximumThreshold":                   false,
			"enableSellerFeeBreakdown":                 true,
			"enableLatLonForAddress":                   false,
			"enablePaymentMethodPromotion":             false,
			"enablePreferredStore":                     true,
			"enable3pEGiftCardPersonalization":         true,
			"enableAppleCareFreeTrials":                true,
			"enableUnscheduledPickup":                  false,
			"enableUnscheduledShippingOptions":         false,
			"enableItemDeliveryPrice":                  false,
			"enableShowSavingsGrandTotal":              false,
			"enableSparkStore":                         false,
			"enableVolumePricing":                      false,
			"enableStreamlinedBadges":                  true,
			"enableFIGCartFulfillmentOption":           false,
			"enableExpressReservationEndTime":          false,
			"subscriptionInTransactionAndDetailed":     true,
			"enablePriceDetailsSavings":                false,
			"enableItemTypeAttributes":                 false,
			"includeFitment":                           false,
			"enablePromotionalMetaData":                false,
			"enableEligibleCareplans":                  false,
			"enableShowACCSchedulingInCart":            false,
			"enableAOSLineItemId":                      false,
			"enableSubscriptionsInTransactionDiscount": false,
			"enableDestinationTax":                     true,
			"enableStaticMessageType":                  false,
			"enableEachWeightItem":                     false,
			"enableOptimisticWeightUpdate":             false,
			"enableAOSPriceChangeExp":                  false,
			"enableAOSWplusPriceChange":                false,
			"enableCheckoutableErrorAttributes":        false,
			"enableFlowerDelivery":                     false,
			"enableOutOfCountry":                       false,
			"enableExpressStoreBadge":                  false,
			"enableAllowItemQtyEditable":               false,
			"enableAllowItemRemoval":                   false,
			"enableAllowSaveForLaterForItem":           false,
			"enableVPForACCItems":                      true,
			"enableSpecialOrderMultiline":              false,
			"enableIntentControl":                      false,
			"enableLocalizedStringForReservation":      true,
			"includeProductPriceInfoUnitPrice":         true,
			"enableAOSWplusDiscount":                   false,
			"enableGepGeoPreciseLocation":              true,
			"enableDynamicExpressSlotType":             false,
			"enableWcpEligibility":                     false,
			"enableBadges":                             false,
			"enablePayForSpeed":                        false,
			"enableDroneDelivery":                      true,
			"enableCCAFlow":                            false,
			"enableRxpd":                               true,
			"enableRxpdLunchHours":                     false,
			"enableIsTobaccoField":                     false,
			"enableCustomizableItemsPhase1":            true,
			"enableQsr4w":                              false,
			"enableSavingsBreakup":                     false,
			"enableWplusSubscribeAndSave":              false,
			"enableTheFarmersDog":                      true,
			"enableExpressAvailability":                false,
			"enableAlcoholRestrictions":                false,
			"enableWeightedItems":                      false,
			"includeOtherDetailed":                     true,
			"includeGrandAndSavedSubtotal":             false,
			"includeWeeklyReservation":                 false,
			"includeClipRewards":                       false,
			"enableCartIdForAnonymousUser":             false,
			"enableCartLight":                          false,
			"enableLiquorBox":                          true,
			"enablePersistedCartId":                    true,
			"enableCPCIdOnCidMismatch":                 true,
			"enableFloatingAddToOrder":                 true,
			"enableMergeCartOptimization":              true,
			"includeExtras":                            false,
			"includeGepShippingThresholdData":          true,
			"fetchAddOnServices":                       false,
		},
	}

	correlationBytes := make([]byte, 24)
	rand.Read(correlationBytes)
	correlationID := base64.RawURLEncoding.EncodeToString(correlationBytes)
	traceID := make([]byte, 16)
	spanID := make([]byte, 8)
	rand.Read(traceID)
	rand.Read(spanID)
	traceparent := fmt.Sprintf("00-%s-%s-00", hex.EncodeToString(traceID), hex.EncodeToString(spanID))
	baggage := fmt.Sprintf("requestTs=%d,tpid=%s", time.Now().UnixMilli(), traceparent)

	payloadBytes, err := json.Marshal(data)
	if err != nil {
		t.Error = err
		return
	}

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    "https://www.walmart.com/orchestra/cartxo/graphql/MergeAndGetCart/df6d336b38ba3ac90a6613640547fff4405b38f13f2e428be7f3ce847147986d",
			Data:   string(payloadBytes),
		},
		Headers: map[string][]string{
			"x-o-mart":                {"B2C"},
			"x-o-gql-query":           {"mutation MergeAndGetCart"},
			"sec-ch-ua-platform":      {t.Requests.UserAgent.Platform},
			"x-o-segment":             {"oaoh"},
			"device-memory":           {"16"},
			"sec-ch-ua":               {t.Requests.UserAgent.Sec_ua},
			"sec-ch-dpr":              {"1"},
			"x-enable-server-timing":  {"1"},
			"sec-ch-ua-mobile":        {"?0"},
			"baggage":                 {baggage},
			"x-latency-trace":         {"1"},
			"traceparent":             {traceparent},
			"wm_mp":                   {"true"},
			"accept":                  {"application/json"},
			"content-type":            {"application/json"},
			"x-apollo-operation-name": {"MergeAndGetCart"},
			"tenant-id":               {"elh9ie"},
			"downlink":                {"10"},
			"wm_qos.correlation_id":   {correlationID},
			"x-o-platform":            {"rweb"},
			"x-o-platform-version":    {"usweb-1.283.0-eed13b637d40c47252116beaf0395aeb756e949d-7081858r"},
			"accept-language":         {"en-US"},
			"x-o-ccm":                 {"server"},
			"x-o-bu":                  {"WALMART-US"},
			"wm-client-traceid":       {"18c2010d233cbc5bd08077b7b51c3329"},
			"sec-ch-device-memory":    {"16"},
			"dpr":                     {"1"},
			"user-agent":              {t.Requests.UserAgent.Useragent},
			"wm_page_url":             {"https://www.walmart.com/"},
			"x-o-correlation-id":      {correlationID},
			"origin":                  {"https://www.walmart.com"},
			"sec-fetch-site":          {"same-origin"},
			"sec-fetch-mode":          {"cors"},
			"sec-fetch-dest":          {"empty"},
			"referer":                 {"https://www.walmart.com/"},
			"accept-encoding":         {"gzip, deflate, br, zstd"},
			"priority":                {"u=1, i"},
			"header-order":            {"content-length", "x-o-mart", "x-o-gql-query", "sec-ch-ua-platform", "x-o-segment", "device-memory", "sec-ch-ua", "sec-ch-dpr", "x-enable-server-timing", "sec-ch-ua-mobile", "baggage", "x-latency-trace", "traceparent", "wm_mp", "accept", "content-type", "x-apollo-operation-name", "tenant-id", "downlink", "wm_qos.correlation_id", "x-o-platform", "x-o-platform-version", "accept-language", "x-o-ccm", "x-o-bu", "wm-client-traceid", "sec-ch-device-memory", "dpr", "user-agent", "wm_page_url", "x-o-correlation-id", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "priority"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[verifyToken] ERROR: %s", err)
		t.handleProxyRequestError(err)
		return
	}
	switch response.StatusCode {
	case 200:
		var responseBody getCartAPIResponse

		if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
			log.Printf("Error parsing JSON response: %v", err)
			t.Error = err
			return
		}

		t.CartData = responseBody.Data.Cart
		t.LoggedIn = !t.CartData.Customer.IsGuest
	case 412:
		if t.handlePX412(body) {
			return
		}
	case 302:
		if strings.Contains(strings.ToLower(response.Header.Get("Location")), "/blocked") {
			t.Error = fmt.Errorf("px blocked")
			return
		}
	case 444:
		t.Error = fmt.Errorf("proxy block")
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.Error = fmt.Errorf("get-cart (%d)", response.StatusCode)
	}
}

func (t *WalmartTask) GetCartPage() {

	correlationBytes := make([]byte, 24)
	rand.Read(correlationBytes)
	correlationID := base64.RawURLEncoding.EncodeToString(correlationBytes)
	traceID := make([]byte, 16)
	spanID := make([]byte, 8)
	rand.Read(traceID)
	rand.Read(spanID)
	traceparent := fmt.Sprintf("00-%s-%s-00", hex.EncodeToString(traceID), hex.EncodeToString(spanID))
	baggage := fmt.Sprintf("requestTs=%d,tpid=%s", time.Now().UnixMilli(), traceparent)

	variables := map[string]interface{}{
		"cartInput": map[string]interface{}{
			"cartId":                 t.CartData.Id,
			"enableLiquorBox":        true,
			"enableCartSplitClarity": false,
			"features": []string{
				"lmpdel", "mlrx", "vsrx", "maappl", "accfournudge", "potp", "byod",
				"vptires", "pdr", "gepmss", "dd", "qsr", "qsr_qty", "cbs", "tfd", "wfss",
			},
		},
		"includePartialFulfillmentSwitching":       false,
		"enableAEBadge":                            true,
		"includeExpressSla":                        true,
		"includeQueueing":                          true,
		"enableWeeklyReservationCartBookslot":      false,
		"enableCartBookslotShortcut":               true,
		"enableACCScheduling":                      true,
		"enableWalmartPlusFreeDiscountedExpress":   true,
		"enableDiscountedOrHolidayExpress":         true,
		"enableBenefitSavings":                     true,
		"enableUnifiedBadges":                      true,
		"enableCartLevelMSI":                       false,
		"enablePickupNotAvailable":                 false,
		"enableReturnsLabel":                       true,
		"enableStarRatings":                        false,
		"enableSpendLimit":                         false,
		"enableMsiMci":                             true,
		"enableClipRewards":                        true,
		"enableTaxBreakdown":                       false,
		"enableI18nWave1":                          true,
		"enableWplusPetBenefit":                    false,
		"enableCartLevelPromotions":                true,
		"enableOrderCutOffTime":                    true,
		"enableHotCartFeature":                     false,
		"enableMOQ":                                false,
		"enableMOQVariants":                        false,
		"enableItemLevelAttributes":                false,
		"enablePetRxManualRefill":                  true,
		"enableItemLevelCheckout":                  false,
		"enableSuggestedSlotAvailability":          true,
		"enablePFS":                                true,
		"enableSubscriptionsInTransaction":         true,
		"enableSubscribeToSaveNudge":               false,
		"enableE2EPickupEnhancement":               true,
		"enableExpressPickup":                      false,
		"enableB2BCategoryRestriction":             false,
		"enableSubscriptionDiscounts":              false,
		"enablePromoDiscount":                      true,
		"enableWplusACCPayForServiceOnline":        true,
		"includeItemPackaging":                     true,
		"enableMultiStorePickup":                   true,
		"enableShopAllNode":                        false,
		"enableWFSGlobal":                          false,
		"includeFulfillmentSwitchOptions":          false,
		"enableMaxItemAllowedForRegularSlot":       false,
		"enableAvailableFinancingOptions":          false,
		"enableFreeDeliveryThreshold":              false,
		"enableShippingOptions":                    true,
		"enableShippingFeeClarity":                 true,
		"getPriceInfoDetails":                      true,
		"enableAccQuantityNudge":                   true,
		"enableFeeThresholdBar":                    false,
		"enableWic":                                true,
		"enableColdChainExpansion":                 true,
		"enableGEP":                                true,
		"enableIsEligibleForFreeTrialV1":           true,
		"enableMaximumThreshold":                   false,
		"enableSellerFeeBreakdown":                 true,
		"enableLatLonForAddress":                   false,
		"enablePaymentMethodPromotion":             false,
		"enablePreferredStore":                     true,
		"enable3pEGiftCardPersonalization":         true,
		"enableAppleCareFreeTrials":                true,
		"enableUnscheduledPickup":                  false,
		"enableUnscheduledShippingOptions":         false,
		"enableItemDeliveryPrice":                  false,
		"enableShowSavingsGrandTotal":              false,
		"enableSparkStore":                         true,
		"enableVolumePricing":                      false,
		"enableStreamlinedBadges":                  true,
		"enableRemoveAvailabilityStatus":           false,
		"enableFIGCartFulfillmentOption":           false,
		"enableExpressReservationEndTime":          false,
		"subscriptionInTransactionAndDetailed":     true,
		"enablePriceDetailsSavings":                false,
		"enableItemTypeAttributes":                 false,
		"includeFitment":                           false,
		"enablePromotionalMetaData":                false,
		"enableEligibleCareplans":                  false,
		"enableShowACCSchedulingInCart":            false,
		"enableAOSLineItemId":                      false,
		"enableSubscriptionsInTransactionDiscount": false,
		"enableDestinationTax":                     true,
		"enableStaticMessageType":                  false,
		"enableEachWeightItem":                     false,
		"enableOptimisticWeightUpdate":             false,
		"enableAOSPriceChangeExp":                  true,
		"enableAOSWplusPriceChange":                true,
		"enableCheckoutableErrorAttributes":        false,
		"enableFlowerDelivery":                     false,
		"enableOutOfCountry":                       false,
		"enableExpressStoreBadge":                  false,
		"enableAllowItemQtyEditable":               false,
		"enableAllowItemRemoval":                   false,
		"enableAllowSaveForLaterForItem":           false,
		"enableVPForACCItems":                      true,
		"enableSpecialOrderMultiline":              false,
		"enableIntentControl":                      true,
		"enableAOSModuleAttribute":                 true,
		"enableLocalizedStringForReservation":      true,
		"includeProductPriceInfoUnitPrice":         true,
		"enableAOSRearchitect":                     false,
		"enableAOSWplusDiscount":                   false,
		"enableGepGeoPreciseLocation":              true,
		"enableDynamicExpressSlotType":             false,
		"enableWcpEligibility":                     false,
		"enableBadges":                             true,
		"enablePayForSpeed":                        true,
		"enableDroneDelivery":                      true,
		"enableCCAFlow":                            false,
		"enableRxpd":                               true,
		"enableRxpdLunchHours":                     true,
		"enableIsTobaccoField":                     false,
		"enableCustomizableItemsPhase1":            true,
		"enableQsr4w":                              false,
		"enableSavingsBreakup":                     true,
		"enableWplusSubscribeAndSave":              false,
		"enableTheFarmersDog":                      true,
		"enableExpressAvailability":                false,
		"enableAlcoholRestrictions":                false,
		"enableFamilyCart":                         false,
		"enableWPlusAutoOptIn":                     false,
	}

	variablesBytes, err := json.Marshal(variables)
	if err != nil {
		t.Error = err
		return
	}

	reqUrl := fmt.Sprintf(
		"https://www.walmart.com/orchestra/home/graphql/getCart/fde2efae83b3264da593d7f8978370b953e217fc0d3af908dab3be79450651d8?variables=%s",
		url.QueryEscape(string(variablesBytes)),
	)

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "GET",
			URL:    reqUrl,
		},
		Headers: map[string][]string{
			"x-o-mart":                {"B2C"},
			"x-o-gql-query":           {"query getCart"},
			"sec-ch-ua-platform":      {t.Requests.UserAgent.Platform},
			"x-o-segment":             {"oaoh"},
			"device-memory":           {"16"},
			"sec-ch-ua":               {t.Requests.UserAgent.Sec_ua},
			"sec-ch-dpr":              {"1"},
			"x-enable-server-timing":  {"1"},
			"sec-ch-ua-mobile":        {"?0"},
			"baggage":                 {baggage},
			"x-latency-trace":         {"1"},
			"traceparent":             {traceparent},
			"wm_mp":                   {"true"},
			"accept":                  {"application/json"},
			"x-apollo-operation-name": {"getCart"},
			"tenant-id":               {"elh9ie"},
			"downlink":                {"10"},
			"wm_qos.correlation_id":   {correlationID},
			"x-o-platform":            {"rweb"},
			"x-o-platform-version":    {"usweb-1.283.0-eed13b637d40c47252116beaf0395aeb756e949d-7081858r"},
			"accept-language":         {"en-US"},
			"x-o-ccm":                 {"server"},
			"x-o-bu":                  {"WALMART-US"},
			"wm-client-traceid":       {"18c2010d233cbc5bd08077b7b51c3329"},
			"sec-ch-device-memory":    {"16"},
			"dpr":                     {"1"},
			"user-agent":              {t.Requests.UserAgent.Useragent},
			"wm_page_url":             {"https://www.walmart.com/"},
			"x-o-correlation-id":      {correlationID},
			"sec-fetch-site":          {"same-origin"},
			"sec-fetch-mode":          {"cors"},
			"sec-fetch-dest":          {"empty"},
			"referer":                 {"https://www.walmart.com/"},
			"accept-encoding":         {"gzip, deflate, br, zstd"},
			"priority":                {"u=1, i"},
			"header-order":            {"x-o-mart", "x-o-gql-query", "sec-ch-ua-platform", "x-o-segment", "device-memory", "sec-ch-ua", "sec-ch-dpr", "x-enable-server-timing", "sec-ch-ua-mobile", "baggage", "x-latency-trace", "traceparent", "wm_mp", "accept", "x-apollo-operation-name", "tenant-id", "downlink", "wm_qos.correlation_id", "x-o-platform", "x-o-platform-version", "accept-language", "x-o-ccm", "x-o-bu", "wm-client-traceid", "sec-ch-device-memory", "dpr", "user-agent", "wm_page_url", "x-o-correlation-id", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "priority"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[getCartPage] ERROR: %s", err)
		t.handleProxyRequestError(err)
		return
	}
	switch response.StatusCode {
	case 200:
		var responseBody getCartQueryAPIResponse

		if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
			log.Printf("Error parsing JSON response: %v", err)
			t.Error = err
			return
		}

		t.CartData = responseBody.Data.Cart
		t.LoggedIn = !t.CartData.Customer.IsGuest
	case 412:
		if t.handlePX412(body) {
			return
		}
	case 302:
		if strings.Contains(strings.ToLower(response.Header.Get("Location")), "/blocked") {
			t.Error = fmt.Errorf("px blocked")
			return
		}
	case 444:
		t.Error = fmt.Errorf("proxy block")
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.Error = fmt.Errorf("get-cart-page (%d)", response.StatusCode)
	}
}

func (t *WalmartTask) ClearCart() {
	items := make([]map[string]interface{}, 0, len(t.CartData.LineItems))
	for _, lineItem := range t.CartData.LineItems {
		items = append(items, map[string]interface{}{
			"offerId":                lineItem.Product.OfferId,
			"quantity":               0,
			"usItemId":               lineItem.Product.UsItemId,
			"name":                   lineItem.Product.Name,
			"isPharmacyPrescription": lineItem.IsPharmacyPrescription,
		})
	}

	data := map[string]interface{}{
		"variables": map[string]interface{}{
			"getDetailedAccesspoint": true,
			"input": map[string]interface{}{
				"enableLiquorBox":        true,
				"cartId":                 t.CartData.Id,
				"items":                  items,
				"cartLeanMode":           false,
				"enableCartSplitClarity": false,
				"features":               []string{"lmpdel", "mlrx", "vsrx", "maappl", "accfournudge", "potp", "byod", "vptires", "pdr", "gepmss", "dd", "qsr", "qsr_qty", "cbs", "tfd", "wfss"},
			},
			"includePartialFulfillmentSwitching":       true,
			"enableAEBadge":                            true,
			"includeExpressSla":                        true,
			"includeQueueing":                          true,
			"enableCartBookslotShortcut":               true,
			"enableACCScheduling":                      true,
			"enableWalmartPlusFreeDiscountedExpress":   true,
			"enableDiscountedOrHolidayExpress":         true,
			"enableBenefitSavings":                     true,
			"enableUnifiedBadges":                      true,
			"enableCartLevelMSI":                       false,
			"enablePickupNotAvailable":                 false,
			"enableReturnsLabel":                       true,
			"enableStarRatings":                        false,
			"enableSpendLimit":                         false,
			"enableMsiMci":                             true,
			"enableTaxBreakdown":                       false,
			"enableI18nWave1":                          true,
			"enableWplusPetBenefit":                    false,
			"enableCartLevelPromotions":                true,
			"enableOrderCutOffTime":                    true,
			"enableHotCartFeature":                     true,
			"enableMOQ":                                false,
			"enableMOQVariants":                        false,
			"enablePetRxManualRefill":                  true,
			"enableItemLevelCheckout":                  false,
			"enableSuggestedSlotAvailability":          true,
			"enablePFS":                                true,
			"enableSubscriptionsInTransaction":         true,
			"enableSubscribeToSaveNudge":               false,
			"enableE2EPickupEnhancement":               true,
			"enableExpressPickup":                      false,
			"enableB2BCategoryRestriction":             false,
			"enableSubscriptionDiscounts":              false,
			"enablePromoDiscount":                      true,
			"enableWplusACCPayForServiceOnline":        true,
			"includeItemPackaging":                     true,
			"enableMultiStorePickup":                   true,
			"enableShopAllNode":                        false,
			"enableWFSGlobal":                          false,
			"includeFulfillmentSwitchOptions":          false,
			"enableMaxItemAllowedForRegularSlot":       false,
			"enableAvailableFinancingOptions":          false,
			"enableFreeDeliveryThreshold":              false,
			"enableShippingOptions":                    true,
			"enableShippingFeeClarity":                 true,
			"getPriceInfoDetails":                      true,
			"enableAccQuantityNudge":                   true,
			"enableFeeThresholdBar":                    false,
			"enableWic":                                true,
			"enableColdChainExpansion":                 true,
			"enableGEP":                                true,
			"enableIsEligibleForFreeTrialV1":           true,
			"enableMaximumThreshold":                   false,
			"enableSellerFeeBreakdown":                 true,
			"enableLatLonForAddress":                   false,
			"enablePaymentMethodPromotion":             false,
			"enablePreferredStore":                     true,
			"enable3pEGiftCardPersonalization":         true,
			"enableAppleCareFreeTrials":                true,
			"enableUnscheduledPickup":                  false,
			"enableUnscheduledShippingOptions":         false,
			"enableItemDeliveryPrice":                  false,
			"enableShowSavingsGrandTotal":              false,
			"enableSparkStore":                         true,
			"enableVolumePricing":                      false,
			"enableStreamlinedBadges":                  true,
			"enableFIGCartFulfillmentOption":           false,
			"enableExpressReservationEndTime":          false,
			"subscriptionInTransactionAndDetailed":     true,
			"enablePriceDetailsSavings":                false,
			"enableItemTypeAttributes":                 false,
			"includeFitment":                           false,
			"enablePromotionalMetaData":                false,
			"enableEligibleCareplans":                  false,
			"enableShowACCSchedulingInCart":            false,
			"enableAOSLineItemId":                      false,
			"enableSubscriptionsInTransactionDiscount": false,
			"enableDestinationTax":                     true,
			"enableStaticMessageType":                  false,
			"enableEachWeightItem":                     false,
			"enableOptimisticWeightUpdate":             false,
			"enableAOSPriceChangeExp":                  true,
			"enableAOSWplusPriceChange":                true,
			"enableCheckoutableErrorAttributes":        false,
			"enableFlowerDelivery":                     false,
			"enableOutOfCountry":                       false,
			"enableExpressStoreBadge":                  false,
			"enableAllowItemQtyEditable":               false,
			"enableAllowItemRemoval":                   false,
			"enableAllowSaveForLaterForItem":           false,
			"enableVPForACCItems":                      true,
			"enableSpecialOrderMultiline":              false,
			"enableIntentControl":                      true,
			"enableAOSModuleAttribute":                 true,
			"enableLocalizedStringForReservation":      true,
			"enableAOSRearchitect":                     false,
			"enableDynamicExpressSlotType":             false,
			"enableWcpEligibility":                     false,
			"enableBadges":                             true,
			"enablePayForSpeed":                        true,
			"enableDroneDelivery":                      true,
			"enableCCAFlow":                            false,
			"enableRxpd":                               true,
			"enableRxpdLunchHours":                     true,
			"enableIsTobaccoField":                     false,
			"enableCustomizableItemsPhase1":            true,
			"enableQsr4w":                              false,
			"enableWplusSubscribeAndSave":              false,
			"enableTheFarmersDog":                      true,
			"enableExpressAvailability":                true,
			"detailed":                                 true,
			"includeExtras":                            true,
			"includeMpGroup":                           false,
			"includeClipRewards":                       true,
			"enableWeightedItems":                      false,
			"enableDetailedBeacon":                     true,
			"enableOrderLimit":                         true,
			"includeGrandAndSavedSubtotal":             true,
			"enableQSRImplicitReservation":             false,
			"includeGepShippingThresholdData":          true,
			"enableGicEngagement":                      true,
			"enableUpstreamErrorCode":                  false,
			"includeFulfillmentBadge":                  true,
			"includeFulfillmentItemGroups":             true,
			"includeOtherDetailed":                     true,
			"includeWeeklyReservation":                 false,
			"enableSavingsBreakup":                     true,
			"fetchAddOnServices":                       true,
		},
	}

	payloadBytes, err := json.Marshal(data)
	if err != nil {
		t.Error = err
		return
	}

	correlationBytes := make([]byte, 24)
	rand.Read(correlationBytes)
	correlationID := base64.RawURLEncoding.EncodeToString(correlationBytes)
	traceID := make([]byte, 16)
	spanID := make([]byte, 8)
	rand.Read(traceID)
	rand.Read(spanID)
	traceparent := fmt.Sprintf("00-%s-%s-00", hex.EncodeToString(traceID), hex.EncodeToString(spanID))
	baggage := fmt.Sprintf("requestTs=%d,tpid=%s", time.Now().UnixMilli(), traceparent)

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    "https://www.walmart.com/orchestra/cartxo/graphql/updateItems/e13f26d6974c490dcc0885f17cf137a93a141f3b7c959bdb77522c185b93a0ab",
			Data:   string(payloadBytes),
		},
		Headers: map[string][]string{
			"x-o-mart":                {"B2C"},
			"x-o-gql-query":           {"mutation updateItems"},
			"sec-ch-ua-platform":      {t.Requests.UserAgent.Platform},
			"x-o-segment":             {"oaoh"},
			"device_profile_ref_id":   {t.TMXDeviceID},
			"device-memory":           {"16"},
			"sec-ch-dpr":              {"2"},
			"x-enable-server-timing":  {"1"},
			"sec-ch-ua-mobile":        {"?0"},
			"baggage":                 {baggage},
			"x-latency-trace":         {"1"},
			"traceparent":             {traceparent},
			"sec-ch-ua":               {t.Requests.UserAgent.Sec_ua},
			"wm_mp":                   {"true"},
			"accept":                  {"application/json"},
			"content-type":            {"application/json"},
			"x-apollo-operation-name": {"updateItems"},
			"tenant-id":               {"elh9ie"},
			"downlink":                {"10"},
			"wm_qos.correlation_id":   {"20C0Xr0bFxr_Bp1HfDgdw4BZyww5GZk_h5dK"},
			"x-o-platform":            {"rweb"},
			"x-o-platform-version":    {"usweb-1.277.0-de1f77bbfc9cf424763e6ae92d532df595b7f092-6250347r"},
			"accept-language":         {"en-US"},
			"x-o-ccm":                 {"server"},
			"x-o-bu":                  {"WALMART-US"},
			"wm-client-traceid":       {correlationID},
			"sec-ch-device-memory":    {"16"},
			"dpr":                     {"2"},
			"user-agent":              {t.Requests.UserAgent.Useragent},
			"wm_page_url":             {"https://www.walmart.com/cart"},
			"x-o-correlation-id":      {correlationID},
			"origin":                  {"https://www.walmart.com"},
			"sec-fetch-site":          {"same-origin"},
			"sec-fetch-mode":          {"cors"},
			"sec-fetch-dest":          {"empty"},
			"referer":                 {"https://www.walmart.com/cart"},
			"accept-encoding":         {"gzip, deflate, br, zstd"},
			"priority":                {"u=1, i"},
			"header-order":            {"content-length", "x-o-mart", "x-o-gql-query", "sec-ch-ua-platform", "x-o-segment", "device_profile_ref_id", "device-memory", "sec-ch-dpr", "x-enable-server-timing", "sec-ch-ua-mobile", "baggage", "x-latency-trace", "traceparent", "sec-ch-ua", "wm_mp", "accept", "content-type", "x-apollo-operation-name", "tenant-id", "downlink", "wm_qos.correlation_id", "x-o-platform", "x-o-platform-version", "accept-language", "x-o-ccm", "x-o-bu", "wm-client-traceid", "sec-ch-device-memory", "dpr", "user-agent", "wm_page_url", "x-o-correlation-id", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "priority"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[clearCart] ERROR: %s", err)
		t.handleProxyRequestError(err)
		return
	}
	switch response.StatusCode {
	case 200:
		var responseBody updateItemsAPIResponse
		if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
			log.Printf("Error parsing JSON response: %v", err)
			t.Error = err
			return
		}
		t.CartData = responseBody.Data.UpdateItems
	case 412:
		if t.handlePX412(body) {
			return
		}
	case 302:
		if strings.Contains(strings.ToLower(response.Header.Get("Location")), "/blocked") {
			t.Error = fmt.Errorf("px blocked")
			return
		}
	case 444:
		t.Error = fmt.Errorf("proxy block")
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.Error = fmt.Errorf("clear-cart (%d)", response.StatusCode)
	}
}

func (t *WalmartTask) GetAddresses() {
	correlationBytes := make([]byte, 24)
	rand.Read(correlationBytes)
	correlationID := base64.RawURLEncoding.EncodeToString(correlationBytes)
	traceID := make([]byte, 16)
	spanID := make([]byte, 8)
	rand.Read(traceID)
	rand.Read(spanID)
	traceparent := fmt.Sprintf("00-%s-%s-00", hex.EncodeToString(traceID), hex.EncodeToString(spanID))
	baggage := fmt.Sprintf("requestTs=%d,tpid=%s", time.Now().UnixMilli(), traceparent)

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "GET",
			URL:    "https://www.walmart.com/orchestra/home/graphql/GetAddresses/c3d982ed2eeaec81015f0a83a41371b22053656c89f41da5e88ca061d38f5439?variables=%7B%22fetchBusinessNameField%22%3Afalse%2C%22enableGEPKYC%22%3Atrue%7D",
		},
		Headers: map[string][]string{
			"x-o-mart":                {"B2C"},
			"x-o-gql-query":           {"query GetAddresses"},
			"sec-ch-ua-platform":      {t.Requests.UserAgent.Platform},
			"x-o-segment":             {"oaoh"},
			"device_profile_ref_id":   {t.TMXDeviceID},
			"device-memory":           {"16"},
			"sec-ch-dpr":              {"2"},
			"x-enable-server-timing":  {"1"},
			"sec-ch-ua-mobile":        {"?0"},
			"baggage":                 {baggage},
			"x-latency-trace":         {"1"},
			"traceparent":             {traceparent},
			"sec-ch-ua":               {t.Requests.UserAgent.Sec_ua},
			"wm_mp":                   {"true"},
			"accept":                  {"application/json"},
			"content-type":            {"application/json"},
			"x-apollo-operation-name": {"GetAddresses"},
			"tenant-id":               {"elh9ie"},
			"downlink":                {"10"},
			"wm_qos.correlation_id":   {correlationID},
			"x-o-platform":            {"rweb"},
			"x-o-platform-version":    {"usweb-1.277.0-de1f77bbfc9cf424763e6ae92d532df595b7f092-6250347r"},
			"accept-language":         {"en-US"},
			"x-o-ccm":                 {"server"},
			"x-o-bu":                  {"WALMART-US"},
			"wm-client-traceid":       {correlationID},
			"sec-ch-device-memory":    {"16"},
			"dpr":                     {"2"},
			"user-agent":              {t.Requests.UserAgent.Useragent},
			"wm_page_url":             {"https://www.walmart.com/account/delivery-addresses"},
			"x-o-correlation-id":      {correlationID},
			"sec-fetch-site":          {"same-origin"},
			"sec-fetch-mode":          {"cors"},
			"sec-fetch-dest":          {"empty"},
			"referer":                 {"https://www.walmart.com/account/delivery-addresses"},
			"accept-encoding":         {"gzip, deflate, br, zstd"},
			"priority":                {"u=1, i"},
			"header-order":            {"x-o-mart", "x-o-gql-query", "sec-ch-ua-platform", "x-o-segment", "device_profile_ref_id", "device-memory", "sec-ch-dpr", "x-enable-server-timing", "sec-ch-ua-mobile", "baggage", "x-latency-trace", "traceparent", "sec-ch-ua", "wm_mp", "accept", "content-type", "x-apollo-operation-name", "tenant-id", "downlink", "wm_qos.correlation_id", "x-o-platform", "x-o-platform-version", "accept-language", "x-o-ccm", "x-o-bu", "wm-client-traceid", "sec-ch-device-memory", "dpr", "user-agent", "wm_page_url", "x-o-correlation-id", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "priority"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[getAddresses] ERROR: %s", err)
		t.handleProxyRequestError(err)
		return
	}
	switch response.StatusCode {
	case 200:
		var responseBody GetAddressesResponse
		if err := json.Unmarshal([]byte(body), &responseBody); err != nil {
			t.Error = err
			return
		}
		t.SetAddresses = responseBody.Data.DeliveryAddresses

	case 412:
		if t.handlePX412(body) {
			return
		}
	case 302:
		if strings.Contains(strings.ToLower(response.Header.Get("Location")), "/blocked") {
			t.Error = fmt.Errorf("px blocked")
			return
		}
	case 444:
		t.Error = fmt.Errorf("proxy block")
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.Error = fmt.Errorf("get-shipping (%d)", response.StatusCode)
	}
}

func (t *WalmartTask) SetAddress() {
	data := map[string]interface{}{
		"variables": map[string]interface{}{
			"input": map[string]interface{}{
				"address": map[string]interface{}{
					"addressLineOne":         t.Profile.ShippingAddress1,
					"addressLineTwo":         t.Profile.ShippingAddress2,
					"city":                   t.Profile.ShippingCity,
					"postalCode":             t.Profile.ShippingZip,
					"state":                  constants.NormalizeStateCode(t.Profile.ShippingState),
					"addressType":            nil,
					"isApoFpo":               nil,
					"isLoadingDockAvailable": nil,
					"isPoBox":                nil,
					"latitude":               nil,
					"longitude":              nil,
					"country":                constants.NormalizeCountryCodeISO3(t.Profile.ShippingCountry),
					"phoneCountry":           constants.NormalizeCountryCodeISO3(t.Profile.ShippingCountry),
				},
				"firstName":            t.Profile.ShippingFirstName,
				"lastName":             t.Profile.ShippingLastName,
				"deliveryInstructions": nil,
				"deliveryInstructionsList": []map[string]interface{}{
					{
						"deliveryInstructionType":         "REGULAR",
						"deliveryInstruction":             "",
						"accessCode":                      nil,
						"dropOffLocation":                 nil,
						"deliveryInstructionsAddressType": nil,
						"addressTypeSource":               nil,
					},
				},
				"displayLabel": nil,
				"isDefault":    true,
				"phone":        t.Profile.Phone,
				"overrideAvs":  true,
			},
			"fetchMXFields":          false,
			"fetchBusinessNameField": false,
			"enableGEPKYC":           true,
		},
	}

	payloadBytes, err := json.Marshal(data)
	if err != nil {
		t.Error = err
		return
	}

	correlationBytes := make([]byte, 24)
	rand.Read(correlationBytes)
	correlationID := base64.RawURLEncoding.EncodeToString(correlationBytes)
	traceID := make([]byte, 16)
	spanID := make([]byte, 8)
	rand.Read(traceID)
	rand.Read(spanID)
	traceparent := fmt.Sprintf("00-%s-%s-00", hex.EncodeToString(traceID), hex.EncodeToString(spanID))
	baggage := fmt.Sprintf("requestTs=%d,tpid=%s", time.Now().UnixMilli(), traceparent)

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    "https://www.walmart.com/orchestra/home/graphql/CreateDeliveryAddress/b82930f1ca8150710428c331d9759ce2286e182adcb00526c3eac9a4030b8e62",
			Data:   string(payloadBytes),
		},
		Headers: map[string][]string{
			"x-o-mart":                {"B2C"},
			"x-o-gql-query":           {"mutation CreateDeliveryAddress"},
			"sec-ch-ua-platform":      {t.Requests.UserAgent.Platform},
			"x-o-segment":             {"oaoh"},
			"device_profile_ref_id":   {t.TMXDeviceID},
			"device-memory":           {"16"},
			"sec-ch-dpr":              {"2"},
			"x-enable-server-timing":  {"1"},
			"sec-ch-ua-mobile":        {"?0"},
			"baggage":                 {baggage},
			"x-latency-trace":         {"1"},
			"traceparent":             {traceparent},
			"sec-ch-ua":               {t.Requests.UserAgent.Sec_ua},
			"wm_mp":                   {"true"},
			"accept":                  {"application/json"},
			"content-type":            {"application/json"},
			"x-apollo-operation-name": {"CreateDeliveryAddress"},
			"tenant-id":               {"elh9ie"},
			"downlink":                {"10"},
			"wm_qos.correlation_id":   {correlationID},
			"x-o-platform":            {"rweb"},
			"x-o-platform-version":    {"usweb-1.277.0-de1f77bbfc9cf424763e6ae92d532df595b7f092-6250347r"},
			"accept-language":         {"en-US"},
			"x-o-ccm":                 {"server"},
			"x-o-bu":                  {"WALMART-US"},
			"wm-client-traceid":       {correlationID},
			"sec-ch-device-memory":    {"16"},
			"dpr":                     {"2"},
			"user-agent":              {t.Requests.UserAgent.Useragent},
			"wm_page_url":             {"https://www.walmart.com/account/delivery-addresses"},
			"x-o-correlation-id":      {correlationID},
			"origin":                  {"https://www.walmart.com"},
			"sec-fetch-site":          {"same-origin"},
			"sec-fetch-mode":          {"cors"},
			"sec-fetch-dest":          {"empty"},
			"referer":                 {"https://www.walmart.com/account/delivery-addresses"},
			"accept-encoding":         {"gzip, deflate, br, zstd"},
			"priority":                {"u=1, i"},
			"header-order":            {"content-length", "x-o-mart", "x-o-gql-query", "sec-ch-ua-platform", "x-o-segment", "device_profile_ref_id", "device-memory", "sec-ch-dpr", "x-enable-server-timing", "sec-ch-ua-mobile", "baggage", "x-latency-trace", "traceparent", "sec-ch-ua", "wm_mp", "accept", "content-type", "x-apollo-operation-name", "tenant-id", "downlink", "wm_qos.correlation_id", "x-o-platform", "x-o-platform-version", "accept-language", "x-o-ccm", "x-o-bu", "wm-client-traceid", "sec-ch-device-memory", "dpr", "user-agent", "wm_page_url", "x-o-correlation-id", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "priority"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[setAddress] ERROR: %s", err)
		t.handleProxyRequestError(err)
		return
	}
	switch response.StatusCode {
	case 200:
		var responseBody createAccountAddressAPIResponse
		if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
			log.Printf("Error parsing JSON response: %v", err)
			t.Error = err
			return
		}
		if len(responseBody.Errors) > 0 {
			t.Error = fmt.Errorf("Set Address Failed - %s", responseBody.Errors[0].Message)
			return
		}
		result := responseBody.Data.CreateAccountAddress
		if len(result.Errors) > 0 {
			t.Error = fmt.Errorf("Set Address Failed - %s", result.Errors[0].Message)
			return
		}
		if result.NewAddress.Id == "" {
			t.Error = fmt.Errorf("Set Address Failed - missing address id")
			return
		}
		t.ShippingAddressID = result.NewAddress.Id
	case 401:
		t.Error = fmt.Errorf("unauthorized")
	case 412:
		if t.handlePX412(body) {
			return
		}
	case 302:
		if strings.Contains(strings.ToLower(response.Header.Get("Location")), "/blocked") {
			t.Error = fmt.Errorf("px blocked")
			return
		}
	case 444:
		t.Error = fmt.Errorf("proxy block")
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.Error = fmt.Errorf("set-address (%d)", response.StatusCode)
	}
}

func (t *WalmartTask) GetPaymentMethods() {
	correlationBytes := make([]byte, 24)
	rand.Read(correlationBytes)
	correlationID := base64.RawURLEncoding.EncodeToString(correlationBytes)
	traceID := make([]byte, 16)
	spanID := make([]byte, 8)
	rand.Read(traceID)
	rand.Read(spanID)
	traceparent := fmt.Sprintf("00-%s-%s-00", hex.EncodeToString(traceID), hex.EncodeToString(spanID))
	baggage := fmt.Sprintf("requestTs=%d,tpid=%s", time.Now().UnixMilli(), traceparent)

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "GET",
			URL:    "https://www.walmart.com/orchestra/home/graphql/GetWalletPayments/5e6247bc0d36d4426d990e339e28ce182ab2124136cf630017ef184cd1567379?variables=%7B%22enableSkyNewProgramLink%22%3Atrue%2C%22enableOneCreditCard%22%3Atrue%2C%22enablePayWithPoints%22%3Afalse%2C%22enablePaymentPreference%22%3Afalse%2C%22enableGeminiSource%22%3Afalse%7D",
		},
		Headers: map[string][]string{
			"x-o-mart":                {"B2C"},
			"x-o-gql-query":           {"query GetWalletPayments"},
			"sec-ch-ua-platform":      {t.Requests.UserAgent.Platform},
			"x-o-segment":             {"oaoh"},
			"device_profile_ref_id":   {t.TMXDeviceID},
			"device-memory":           {"16"},
			"sec-ch-dpr":              {"2"},
			"x-enable-server-timing":  {"1"},
			"sec-ch-ua-mobile":        {"?0"},
			"baggage":                 {baggage},
			"x-latency-trace":         {"1"},
			"traceparent":             {traceparent},
			"sec-ch-ua":               {t.Requests.UserAgent.Sec_ua},
			"wm_mp":                   {"true"},
			"accept":                  {"application/json"},
			"content-type":            {"application/json"},
			"x-apollo-operation-name": {"GetWalletPayments"},
			"tenant-id":               {"elh9ie"},
			"downlink":                {"10"},
			"wm_qos.correlation_id":   {correlationID},
			"x-o-platform":            {"rweb"},
			"x-o-platform-version":    {"usweb-1.277.0-de1f77bbfc9cf424763e6ae92d532df595b7f092-6250347r"},
			"accept-language":         {"en-US"},
			"x-o-ccm":                 {"server"},
			"x-o-bu":                  {"WALMART-US"},
			"wm-client-traceid":       {correlationID},
			"sec-ch-device-memory":    {"16"},
			"dpr":                     {"2"},
			"user-agent":              {t.Requests.UserAgent.Useragent},
			"wm_page_url":             {"https://www.walmart.com/wallet?wv=single_add_payment_form_wallet"},
			"x-o-correlation-id":      {correlationID},
			"sec-fetch-site":          {"same-origin"},
			"sec-fetch-mode":          {"cors"},
			"sec-fetch-dest":          {"empty"},
			"referer":                 {"https://www.walmart.com/wallet?wv=single_add_payment_form_wallet"},
			"accept-encoding":         {"gzip, deflate, br, zstd"},
			"priority":                {"u=1, i"},
			"header-order":            {"x-o-mart", "x-o-gql-query", "sec-ch-ua-platform", "x-o-segment", "device_profile_ref_id", "device-memory", "sec-ch-dpr", "x-enable-server-timing", "sec-ch-ua-mobile", "baggage", "x-latency-trace", "traceparent", "sec-ch-ua", "wm_mp", "accept", "content-type", "x-apollo-operation-name", "tenant-id", "downlink", "wm_qos.correlation_id", "x-o-platform", "x-o-platform-version", "accept-language", "x-o-ccm", "x-o-bu", "wm-client-traceid", "sec-ch-device-memory", "dpr", "user-agent", "wm_page_url", "x-o-correlation-id", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "priority"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[getPaymentMethods] ERROR: %s", err)
		t.handleProxyRequestError(err)
		return
	}
	switch response.StatusCode {
	case 200:
		var responseBody getWalletPaymentsAPIResponse
		if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
			log.Printf("Error parsing JSON response: %v", err)
			t.Error = err
			return
		}
		t.PaymentCards = creditCardsFromWallet(responseBody.Data.Wallet)
	case 412:
		if t.handlePX412(body) {
			return
		}
	case 302:
		if strings.Contains(strings.ToLower(response.Header.Get("Location")), "/blocked") {
			t.Error = fmt.Errorf("px blocked")
			return
		}
	case 444:
		t.Error = fmt.Errorf("proxy block")
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.Error = fmt.Errorf("get-payments (%d)", response.StatusCode)
	}
}

func (t *WalmartTask) GetPieKeys() {
	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "GET",
			URL:    fmt.Sprintf("https://securedataweb.walmart.com/pie/v1/wmcom_us_vtg_pie/getkey.js?bust=%d", time.Now().UnixNano()),
		},
		Headers: map[string][]string{
			"sec-ch-ua-platform": {t.Requests.UserAgent.Platform},
			"user-agent":         {t.Requests.UserAgent.Useragent},
			"sec-ch-ua":          {t.Requests.UserAgent.Sec_ua},
			"sec-ch-ua-mobile":   {"?0"},
			"accept":             {"*/*"},
			"sec-fetch-site":     {"same-site"},
			"sec-fetch-mode":     {"no-cors"},
			"sec-fetch-dest":     {"script"},
			"referer":            {"https://www.walmart.com/"},
			"accept-encoding":    {"gzip, deflate, br, zstd"},
			"accept-language":    {"en-US,en;q=0.9"},
			"header-order":       {"sec-ch-ua-platform", "user-agent", "sec-ch-ua", "sec-ch-ua-mobile", "accept", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[getPieKeys] ERROR: %s", err)
		t.handleProxyRequestError(err)
		return
	}
	switch response.StatusCode {
	case 200:
		keys, err := pie.ParseKeys(body)
		if err != nil {
			t.Error = err
			return
		}
		t.PieKeys = keys
	case 412:
		if t.handlePX412(body) {
			return
		}
	case 302:
		if strings.Contains(strings.ToLower(response.Header.Get("Location")), "/blocked") {
			t.Error = fmt.Errorf("px blocked")
			return
		}
	case 444:
		t.Error = fmt.Errorf("proxy block")
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.Error = fmt.Errorf("fetch-pie-keys (%d)", response.StatusCode)
	}
}

func (t *WalmartTask) SetPaymentMethod() {
	pan := cardDigits(t.Profile.CardNumber)
	cvv := cardDigits(t.Profile.CardCvv)
	if pan == "" || cvv == "" {
		t.Error = fmt.Errorf("set-payment: invalid card input")
		return
	}

	encrypted, err := pie.EncryptCard(pan, cvv, t.PieKeys)
	if err != nil {
		t.Error = err
		return
	}

	expiryMonth, err := strconv.Atoi(strings.TrimSpace(t.Profile.CardExpiryMonth))
	if err != nil {
		t.Error = fmt.Errorf("set-payment: invalid expiry month")
		return
	}
	expiryYear, err := parseCardExpiryYear(t.Profile.CardExpiryYear)
	if err != nil {
		t.Error = fmt.Errorf("set-payment: %v", err)
		return
	}
	data := map[string]interface{}{
		"variables": map[string]interface{}{
			"input": map[string]interface{}{
				"firstName":   t.Profile.BillingFirstName,
				"lastName":    t.Profile.BillingLastName,
				"expiryMonth": expiryMonth,
				"expiryYear":  expiryYear,
				"isDefault":   true,
				"phone":       t.Profile.Phone,
				"address": map[string]interface{}{
					"addressLineOne":         t.Profile.BillingAddress1,
					"addressLineTwo":         t.Profile.BillingAddress2,
					"postalCode":             t.Profile.BillingZip,
					"city":                   t.Profile.BillingCity,
					"state":                  constants.NormalizeStateCode(t.Profile.BillingState),
					"country":                constants.NormalizeCountryCode(t.Profile.BillingCountry),
					"isApoFpo":               nil,
					"isLoadingDockAvailable": nil,
					"isPoBox":                nil,
					"businessName":           nil,
					"addressType":            nil,
					"sealedAddress":          nil,
					"phoneCountry":           constants.NormalizeCountryCode(t.Profile.BillingCountry),
				},
				"cardType":          walmartCardType(pan),
				"integrityCheck":    encrypted.IntegrityCheck,
				"keyId":             encrypted.KeyID,
				"phase":             encrypted.Phase,
				"encryptedPan":      encrypted.EncryptedPan,
				"encryptedCVV":      encrypted.EncryptedCVV,
				"sourceFeature":     "ACCOUNT_PAGE",
				"cartId":            "",
				"checkoutSessionId": nil,
				"source":            "WMT_PERM_CARD",
			},
			"fetchWalletCreditCardFragment":    true,
			"enableHSAFSA":                     true,
			"enableGEPCountryOfResidenceNudge": true,
			"enableUpstreamCodeErrorMessage":   false,
		},
	}

	payloadBytes, err := json.Marshal(data)
	if err != nil {
		t.Error = err
		return
	}

	correlationBytes := make([]byte, 24)
	rand.Read(correlationBytes)
	correlationID := base64.RawURLEncoding.EncodeToString(correlationBytes)
	traceID := make([]byte, 16)
	spanID := make([]byte, 8)
	rand.Read(traceID)
	rand.Read(spanID)
	traceparent := fmt.Sprintf("00-%s-%s-00", hex.EncodeToString(traceID), hex.EncodeToString(spanID))
	baggage := fmt.Sprintf("requestTs=%d,tpid=%s", time.Now().UnixMilli(), traceparent)
	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    "https://www.walmart.com/orchestra/home/graphql/CreateAccountCreditCard/8b5bd48af61ba1b831e195d2d5fdb25eabd9c8c34b56da965f0c8d1047abdc74",
			Data:   string(payloadBytes),
		},
		Headers: map[string][]string{
			"x-o-mart":                {"B2C"},
			"x-o-gql-query":           {"mutation CreateAccountCreditCard"},
			"sec-ch-ua-platform":      {t.Requests.UserAgent.Platform},
			"x-o-segment":             {"oaoh"},
			"device_profile_ref_id":   {t.TMXDeviceID},
			"device-memory":           {"16"},
			"sec-ch-dpr":              {"2"},
			"x-enable-server-timing":  {"1"},
			"sec-ch-ua-mobile":        {"?0"},
			"baggage":                 {baggage},
			"x-latency-trace":         {"1"},
			"traceparent":             {traceparent},
			"sec-ch-ua":               {t.Requests.UserAgent.Sec_ua},
			"wm_mp":                   {"true"},
			"accept":                  {"application/json"},
			"content-type":            {"application/json"},
			"x-apollo-operation-name": {"CreateAccountCreditCard"},
			"tenant-id":               {"elh9ie"},
			"downlink":                {"10"},
			"wm_qos.correlation_id":   {correlationID},
			"x-o-platform":            {"rweb"},
			"x-o-platform-version":    {"usweb-1.277.0-de1f77bbfc9cf424763e6ae92d532df595b7f092-6250347r"},
			"accept-language":         {"en-US"},
			"x-o-ccm":                 {"server"},
			"x-o-bu":                  {"WALMART-US"},
			"sec-ch-device-memory":    {"16"},
			"dpr":                     {"2"},
			"user-agent":              {t.Requests.UserAgent.Useragent},
			"x-o-correlation-id":      {correlationID},
			"origin":                  {"https://www.walmart.com"},
			"sec-fetch-site":          {"same-origin"},
			"sec-fetch-mode":          {"cors"},
			"sec-fetch-dest":          {"empty"},
			"referer":                 {"https://www.walmart.com/wallet?wv=single_add_payment_form_wallet"},
			"accept-encoding":         {"gzip, deflate, br, zstd"},
			"priority":                {"u=1, i"},
			"header-order":            {"content-length", "x-o-mart", "x-o-gql-query", "sec-ch-ua-platform", "x-o-segment", "device_profile_ref_id", "device-memory", "sec-ch-dpr", "x-enable-server-timing", "sec-ch-ua-mobile", "baggage", "x-latency-trace", "traceparent", "sec-ch-ua", "wm_mp", "accept", "content-type", "x-apollo-operation-name", "tenant-id", "downlink", "wm_qos.correlation_id", "x-o-platform", "x-o-platform-version", "accept-language", "x-o-ccm", "x-o-bu", "sec-ch-device-memory", "dpr", "user-agent", "x-o-correlation-id", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "priority"},
		},
	}
	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[setPaymentMethod] ERROR: %s", err)
		t.handleProxyRequestError(err)
		return
	}
	switch response.StatusCode {
	case 200:
		var responseBody createAccountCreditCardAPIResponse
		if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
			t.Error = err
			return
		}
		result := responseBody.Data.CreateAccountCreditCard
		if len(result.Errors) > 0 {
			if result.Errors[0].Code == "ERROR_CC_POLICY_REJECTED" {
				t.Error = fmt.Errorf("invalid card details")
				return
			}
			msg := result.Errors[0].Message
			if msg == "" {
				msg = result.Errors[0].Code
			}
			t.Error = fmt.Errorf("set-payment: %s", msg)
			return
		}
		if result.CreditCard.Id == "" {
			t.Error = fmt.Errorf("set-payment: missing card id")
			return
		}
		t.PaymentID = result.CreditCard.Id
		t.EncryptedCard = encrypted
	case 412:
		if t.handlePX412(body) {
			return
		}
	case 302:
		if strings.Contains(strings.ToLower(response.Header.Get("Location")), "/blocked") {
			t.Error = fmt.Errorf("px blocked")
			return
		}
	case 444:
		t.Error = fmt.Errorf("proxy block")
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.Error = fmt.Errorf("set-payment (%d)", response.StatusCode)
	}
}

func (t *WalmartTask) AddToCart() {
	qty := t.Quantity
	if qty <= 0 {
		qty = 1
	}
	if t.OfferID == "" {
		t.Error = fmt.Errorf("add-to-cart: missing offer id")
		return
	}

	item := map[string]interface{}{
		"quantity": qty,
	}
	if t.OfferID != "" {
		item["offerId"] = t.OfferID
	}
	if t.UsItemID != "" {
		item["usItemId"] = t.UsItemID
	}
	items := []map[string]interface{}{item}

	data := map[string]interface{}{
		"variables": map[string]interface{}{
			"getDetailedAccesspoint": false,
			"input": map[string]interface{}{
				"enableLiquorBox":        true,
				"cartId":                 t.CartData.Id,
				"items":                  items,
				"enableCartSplitClarity": false,
				"features": []string{
					"lmpdel", "mlrx", "vsrx", "maappl", "accfournudge", "potp", "byod",
					"vptires", "pdr", "gepmss", "dd", "qsr", "qsr_qty", "cbs", "tfd", "wfss",
				},
			},
			"includePartialFulfillmentSwitching":       false,
			"enableAEBadge":                            false,
			"includeExpressSla":                        true,
			"includeQueueing":                          false,
			"enableCartBookslotShortcut":               false,
			"enableACCScheduling":                      true,
			"enableWalmartPlusFreeDiscountedExpress":   true,
			"enableDiscountedOrHolidayExpress":         true,
			"enableBenefitSavings":                     false,
			"enableUnifiedBadges":                      false,
			"enableCartLevelMSI":                       false,
			"enablePickupNotAvailable":                 false,
			"enableReturnsLabel":                       false,
			"enableStarRatings":                        false,
			"enableSpendLimit":                         false,
			"enableMsiMci":                             true,
			"enableTaxBreakdown":                       false,
			"enableI18nWave1":                          true,
			"enableWplusPetBenefit":                    false,
			"enableCartLevelPromotions":                true,
			"enableOrderCutOffTime":                    true,
			"enableHotCartFeature":                     false,
			"enableMOQ":                                false,
			"enableMOQVariants":                        false,
			"enablePetRxManualRefill":                  true,
			"enableItemLevelCheckout":                  false,
			"enableSuggestedSlotAvailability":          true,
			"enablePFS":                                true,
			"enableSubscriptionsInTransaction":         true,
			"enableSubscribeToSaveNudge":               false,
			"enableE2EPickupEnhancement":               true,
			"enableExpressPickup":                      false,
			"enableB2BCategoryRestriction":             false,
			"enableSubscriptionDiscounts":              false,
			"enablePromoDiscount":                      true,
			"enableWplusACCPayForServiceOnline":        true,
			"includeItemPackaging":                     false,
			"enableMultiStorePickup":                   true,
			"enableShopAllNode":                        false,
			"enableWFSGlobal":                          false,
			"includeFulfillmentSwitchOptions":          false,
			"enableMaxItemAllowedForRegularSlot":       false,
			"enableAvailableFinancingOptions":          false,
			"enableFreeDeliveryThreshold":              false,
			"enableShippingOptions":                    true,
			"enableShippingFeeClarity":                 true,
			"getPriceInfoDetails":                      true,
			"enableAccQuantityNudge":                   true,
			"enableFeeThresholdBar":                    false,
			"enableWic":                                false,
			"enableColdChainExpansion":                 true,
			"enableGEP":                                true,
			"enableIsEligibleForFreeTrialV1":           true,
			"enableMaximumThreshold":                   false,
			"enableSellerFeeBreakdown":                 true,
			"enableLatLonForAddress":                   false,
			"enablePaymentMethodPromotion":             false,
			"enablePreferredStore":                     true,
			"enable3pEGiftCardPersonalization":         true,
			"enableAppleCareFreeTrials":                true,
			"enableUnscheduledPickup":                  false,
			"enableUnscheduledShippingOptions":         false,
			"enableItemDeliveryPrice":                  false,
			"enableShowSavingsGrandTotal":              false,
			"enableSparkStore":                         false,
			"enableVolumePricing":                      false,
			"enableStreamlinedBadges":                  true,
			"enableFIGCartFulfillmentOption":           false,
			"enableExpressReservationEndTime":          false,
			"subscriptionInTransactionAndDetailed":     false,
			"enablePriceDetailsSavings":                false,
			"enableItemTypeAttributes":                 false,
			"includeFitment":                           false,
			"enablePromotionalMetaData":                false,
			"enableEligibleCareplans":                  false,
			"enableShowACCSchedulingInCart":            false,
			"enableAOSLineItemId":                      false,
			"enableSubscriptionsInTransactionDiscount": false,
			"enableDestinationTax":                     true,
			"enableStaticMessageType":                  false,
			"enableEachWeightItem":                     false,
			"enableOptimisticWeightUpdate":             false,
			"enableAOSPriceChangeExp":                  false,
			"enableAOSWplusPriceChange":                false,
			"enableCheckoutableErrorAttributes":        false,
			"enableFlowerDelivery":                     false,
			"enableOutOfCountry":                       false,
			"enableExpressStoreBadge":                  false,
			"enableAllowItemQtyEditable":               false,
			"enableAllowItemRemoval":                   false,
			"enableAllowSaveForLaterForItem":           false,
			"enableVPForACCItems":                      true,
			"enableSpecialOrderMultiline":              false,
			"enableIntentControl":                      false,
			"enableAOSModuleAttribute":                 true,
			"enableLocalizedStringForReservation":      true,
			"enableAOSRearchitect":                     false,
			"enableDynamicExpressSlotType":             false,
			"enableWcpEligibility":                     false,
			"enableBadges":                             false,
			"enablePayForSpeed":                        false,
			"enableDroneDelivery":                      true,
			"enableCCAFlow":                            false,
			"enableRxpd":                               true,
			"enableRxpdLunchHours":                     false,
			"enableIsTobaccoField":                     false,
			"enableCustomizableItemsPhase1":            true,
			"enableQsr4w":                              false,
			"enableWplusSubscribeAndSave":              false,
			"enableTheFarmersDog":                      true,
			"enableExpressAvailability":                false,
			"detailed":                                 false,
			"includeExtras":                            true,
			"includeMpGroup":                           true,
			"includeClipRewards":                       false,
			"enableWeightedItems":                      false,
			"enableDetailedBeacon":                     false,
			"enableOrderLimit":                         false,
			"includeGrandAndSavedSubtotal":             false,
			"enableQSRImplicitReservation":             true,
			"includeGepShippingThresholdData":          true,
			"enableGicEngagement":                      true,
			"enableUpstreamErrorCode":                  false,
			"includeFulfillmentBadge":                  true,
			"includeFulfillmentItemGroups":             true,
			"includeOtherDetailed":                     true,
			"includeWeeklyReservation":                 false,
			"enableSavingsBreakup":                     false,
			"fetchAddOnServices":                       true,
		},
	}

	payloadBytes, err := json.Marshal(data)
	if err != nil {
		t.Error = err
		return
	}

	correlationBytes := make([]byte, 24)
	rand.Read(correlationBytes)
	correlationID := base64.RawURLEncoding.EncodeToString(correlationBytes)
	traceID := make([]byte, 16)
	spanID := make([]byte, 8)
	rand.Read(traceID)
	rand.Read(spanID)
	traceparent := fmt.Sprintf("00-%s-%s-00", hex.EncodeToString(traceID), hex.EncodeToString(spanID))
	baggage := fmt.Sprintf("requestTs=%d,tpid=%s", time.Now().UnixMilli(), traceparent)

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    "https://www.walmart.com/orchestra/home/graphql/updateItems/e13f26d6974c490dcc0885f17cf137a93a141f3b7c959bdb77522c185b93a0ab",
			Data:   string(payloadBytes),
		},
		Headers: map[string][]string{
			"x-o-mart":                {"B2C"},
			"x-o-gql-query":           {"mutation updateItems"},
			"sec-ch-ua-platform":      {t.Requests.UserAgent.Platform},
			"x-o-segment":             {"oaoh"},
			"device_profile_ref_id":   {t.TMXDeviceID},
			"device-memory":           {"16"},
			"sec-ch-dpr":              {"2"},
			"x-enable-server-timing":  {"1"},
			"sec-ch-ua-mobile":        {"?0"},
			"baggage":                 {baggage},
			"x-latency-trace":         {"1"},
			"traceparent":             {traceparent},
			"sec-ch-ua":               {t.Requests.UserAgent.Sec_ua},
			"wm_mp":                   {"true"},
			"accept":                  {"application/json"},
			"content-type":            {"application/json"},
			"x-apollo-operation-name": {"updateItems"},
			"tenant-id":               {"elh9ie"},
			"downlink":                {"10"},
			"wm_qos.correlation_id":   {correlationID},
			"x-o-platform":            {"rweb"},
			"x-o-platform-version":    {"usweb-1.277.0-de1f77bbfc9cf424763e6ae92d532df595b7f092-6250347r"},
			"accept-language":         {"en-US"},
			"x-o-ccm":                 {"server"},
			"x-o-bu":                  {"WALMART-US"},
			"wm-client-traceid":       {correlationID},
			"sec-ch-device-memory":    {"16"},
			"dpr":                     {"2"},
			"user-agent":              {t.Requests.UserAgent.Useragent},
			"wm_page_url":             {"https://www.walmart.com/cart"},
			"x-o-correlation-id":      {correlationID},
			"origin":                  {"https://www.walmart.com"},
			"sec-fetch-site":          {"same-origin"},
			"sec-fetch-mode":          {"cors"},
			"sec-fetch-dest":          {"empty"},
			"referer":                 {"https://www.walmart.com/cart"},
			"accept-encoding":         {"gzip, deflate, br, zstd"},
			"priority":                {"u=1, i"},
			"header-order":            {"content-length", "x-o-mart", "x-o-gql-query", "sec-ch-ua-platform", "x-o-segment", "device_profile_ref_id", "device-memory", "sec-ch-dpr", "x-enable-server-timing", "sec-ch-ua-mobile", "baggage", "x-latency-trace", "traceparent", "sec-ch-ua", "wm_mp", "accept", "content-type", "x-apollo-operation-name", "tenant-id", "downlink", "wm_qos.correlation_id", "x-o-platform", "x-o-platform-version", "accept-language", "x-o-ccm", "x-o-bu", "wm-client-traceid", "sec-ch-device-memory", "dpr", "user-agent", "wm_page_url", "x-o-correlation-id", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "priority"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[addToCart] ERROR: %s", err)
		t.handleProxyRequestError(err)
		return
	}
	switch response.StatusCode {
	case 200:
		if strings.Contains(body, "item_reservation_expired") {
			t.Error = fmt.Errorf("queue found at cart")
		}
		var responseBody updateItemsAPIResponse
		if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
			t.Error = err
			return
		}
		if len(responseBody.Data.UpdateItems.OperationalErrors) > 0 {
			t.Error = fmt.Errorf("%s", responseBody.Data.UpdateItems.OperationalErrors[0].Code)
			return
		}
		t.CartData = responseBody.Data.UpdateItems
		if len(t.CartData.LineItems) > 0 {
			item := t.CartData.LineItems[0]
			t.UsItemID = item.Product.UsItemId
			t.OfferID = item.Product.OfferId
			t.Product.Name = item.Product.Name
			t.Product.Price = item.PriceInfo.ItemPrice.Value
			t.Product.Size = "Default"
			t.Product.ProductLink = walmartProductPageURL(item.Product.UsItemId)
			t.Product.Sku = item.Product.UsItemId
			if item.Product.ImageInfo != nil {
				t.Product.ProductImage = item.Product.ImageInfo.ThumbnailUrl
			}
			if t.CartData.PriceDetails != nil {
				t.GrandTotal = t.CartData.PriceDetails.SubTotal.Value
			}
		} else {
			t.Error = fmt.Errorf("empty cart")
			return
		}
	case 412:
		if t.handlePX412(body) {
			return
		}
	case 302:
		if strings.Contains(strings.ToLower(response.Header.Get("Location")), "/blocked") {
			t.Error = fmt.Errorf("px blocked")
			return
		}
	case 444:
		t.Error = fmt.Errorf("proxy block")
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		switch {
		case strings.Contains(body, "Guest ATC not allowed"):
			t.Error = fmt.Errorf("atc relogin required")
		case strings.Contains(body, "out_of_stock"):
			t.Error = fmt.Errorf("product oos")
		case strings.Contains(body, "item_unavailable"):
			t.Error = fmt.Errorf("item unavailable")
		default:
			t.Error = fmt.Errorf("add-to-cart (%d)", response.StatusCode)
		}
	}
}

func (t *WalmartTask) CreateContract() {
	data := map[string]interface{}{
		"variables": map[string]interface{}{
			"createContractInput": map[string]interface{}{
				"cartId": t.CartData.Id,
				"consumerContext": map[string]interface{}{
					"supportedPayments": []string{
						"AFFIRM",
						"CREDITCARD",
						"DIRECTED_SPEND",
						"EBT",
						"GIFTCARD",
						"INCOMM",
						"ONE_BNPL",
						"PAP_EBT",
						"PAYPAL_1X",
						"PAYPAL_BA",
						"SOLUTRAN",
						"CARECREDIT",
						"WMT_REWARDS",
						"WMTPC",
						"PAYBYBANK",
						"HSA_FSA",
						"WMT_CREDIT",
						"WIC",
						"ONEPAY_CREDITCARD",
						"NATIONS",
					},
				},
				"isClarityInSignupEnabled": true,
				"features": []string{
					"lmpdel",
					"mlrx",
					"vsrx",
					"sit",
					"sitprx",
					"sitsc",
					"sitsd",
					"cfsebt",
					"acctpref",
					"maappl",
					"wday",
					"mbc",
					"tipwat",
					"adjustmentchargeclarity",
					"policyvtwo",
					"eoap",
					"byod",
					"ebtbmf",
					"multipromo",
				},
			},
			"promosEnable":                             true,
			"wplusEnabled":                             true,
			"isACCEnabled":                             true,
			"charityOfChoiceEnabled":                   true,
			"enablePhotoMigration":                     true,
			"wplusSplashSignupEnabled":                 true,
			"enableTYPinDrop":                          true,
			"enablePaidSignupBanner":                   true,
			"enableAccessPoint":                        false,
			"enableMsiMci":                             true,
			"enableCartLevelMSI":                       false,
			"enableTaxBreakdown":                       false,
			"enableCashiCashback":                      false,
			"enableRewardsBanner":                      true,
			"enableInvoicing":                          false,
			"enableWholeDollarDonation":                true,
			"orgContextEnabled":                        false,
			"enableSpendLimit":                         false,
			"enableI18n":                               true,
			"enablePFS":                                true,
			"enableAOSBuyNow":                          true,
			"allowSuggestedSlotsACC":                   true,
			"enableWFSGlobal":                          false,
			"enableGEP":                                true,
			"enablePhoneCountryIso":                    true,
			"enableCountryCode":                        true,
			"enableIsEligibleForFreeTrialV1":           true,
			"enableUpstreamErrorCode":                  false,
			"enableGEPForPilot":                        true,
			"enablePaymentMethodPromotion":             false,
			"enable3pEGiftCardPersonalization":         true,
			"enableAOSRearchitect":                     false,
			"enableUnscheduledSlaGroups":               false,
			"enableCCAFlow":                            false,
			"enableAppleCareFreeTrials":                true,
			"enableAOSModuleAttribute":                 true,
			"includeFitment":                           false,
			"enableFFGroupPickupPerson":                false,
			"enableCustomIncludedOffer":                false,
			"enablePostPayTobacco":                     false,
			"enableDestinationTax":                     true,
			"enableItemTypeAttributes":                 false,
			"enablePrescriptionDetails":                false,
			"enableSubscriptionsInTransactionDiscount": false,
			"enableTEEnhancement":                      false,
			"enableItemLevelTE":                        false,
			"enablePayWithPoints":                      true,
			"enablePayWithPointsRedemptionCheck":       false,
			"enableDsClarity":                          true,
			"enableLoyaltyRedeemPoints":                false,
			"enableOutOfCountry":                       false,
			"enableE2EPickupEnhancement":               true,
			"enableCheckoutNonConfigBundles":           false,
			"enableFisPayments":                        false,
			"enableExpressSlot2":                       false,
			"enablePriceClarity":                       false,
			"enableSavingsBreakup":                     true,
			"enableSubUnsupportedPayments":             false,
			"enableWplusSubscribeAndSave":              false,
			"enableResilientDependencies":              false,
			"enableCXOExpressPickupPhase1":             false,
			"enableTheFarmersDog":                      true,
			"enableMOQVariants":                        false,
			"enableOnePayLaterAppleTradeUp2":           true,
			"enableScheduledShipping":                  false,
		},
	}

	payloadBytes, err := json.Marshal(data)
	if err != nil {
		t.Error = err
		return
	}

	correlationBytes := make([]byte, 24)
	rand.Read(correlationBytes)
	correlationID := base64.RawURLEncoding.EncodeToString(correlationBytes)
	traceID := make([]byte, 16)
	spanID := make([]byte, 8)
	rand.Read(traceID)
	rand.Read(spanID)
	traceparent := fmt.Sprintf("00-%s-%s-00", hex.EncodeToString(traceID), hex.EncodeToString(spanID))
	baggage := fmt.Sprintf("requestTs=%d,tpid=%s", time.Now().UnixMilli(), traceparent)

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    "https://www.walmart.com/orchestra/cartxo/graphql/CreateContract/9163c7fe2636705aa759dc877062de3c913df36804a50d06c08bcf192d3a2176",
			Data:   string(payloadBytes),
		},
		Headers: map[string][]string{
			"x-o-mart":                {"B2C"},
			"x-o-gql-query":           {"mutation CreateContract"},
			"sec-ch-ua-platform":      {"\"Windows\""},
			"x-o-segment":             {"oaoh"},
			"device_profile_ref_id":   {t.TMXDeviceID},
			"device-memory":           {"16"},
			"sec-ch-dpr":              {"1"},
			"x-enable-server-timing":  {"1"},
			"sec-ch-ua-mobile":        {"?0"},
			"baggage":                 {baggage},
			"x-latency-trace":         {"1"},
			"traceparent":             {traceparent},
			"sec-ch-ua":               {t.Requests.UserAgent.Sec_ua},
			"wm_mp":                   {"true"},
			"accept":                  {"application/json"},
			"content-type":            {"application/json"},
			"tenant-id":               {"elh9ie"},
			"x-apollo-operation-name": {"CreateContract"},
			"downlink":                {"10"},
			"wm_qos.correlation_id":   {correlationID},
			"x-o-platform":            {"rweb"},
			"x-o-platform-version":    {"usweb-1.277.0-de1f77bbfc9cf424763e6ae92d532df595b7f092-6250347r"},
			"accept-language":         {"en-US"},
			"x-o-ccm":                 {"server"},
			"x-o-bu":                  {"WALMART-US"},
			"sec-ch-device-memory":    {"16"},
			"dpr":                     {"1"},
			"user-agent":              {t.Requests.UserAgent.Useragent},
			"x-o-correlation-id":      {correlationID},
			"x-o-tp-phase":            {"tp6"},
			"responsegroups":          {"substitution,chargeforsubs,cfsprepaid"},
			"origin":                  {"https://www.walmart.com"},
			"sec-fetch-site":          {"same-origin"},
			"sec-fetch-mode":          {"cors"},
			"sec-fetch-dest":          {"empty"},
			"referer":                 {fmt.Sprintf("https://www.walmart.com/checkout/review-order?cartId=%s", t.CartData.Id)},
			"accept-encoding":         {"gzip, deflate, br, zstd"},
			"priority":                {"u=1, i"},
			"header-order":            {"content-length", "x-o-mart", "x-o-gql-query", "sec-ch-ua-platform", "x-o-segment", "device_profile_ref_id", "device-memory", "sec-ch-dpr", "x-enable-server-timing", "sec-ch-ua-mobile", "baggage", "x-latency-trace", "traceparent", "sec-ch-ua", "wm_mp", "accept", "content-type", "tenant-id", "x-apollo-operation-name", "downlink", "wm_qos.correlation_id", "x-o-platform", "x-o-platform-version", "accept-language", "x-o-ccm", "x-o-bu", "sec-ch-device-memory", "dpr", "user-agent", "x-o-correlation-id", "x-o-tp-phase", "responsegroups", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "priority"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[createContract] ERROR: %s", err)
		t.handleProxyRequestError(err)
		return
	}
	switch response.StatusCode {
	case 200:
		if strings.Contains(body, "SESSION_SMS_ELEVATION_REQUIRED") {
			t.Error = fmt.Errorf("sms verification required")
			return
		}
		if strings.Contains(body, "out_of_stock") {
			t.Error = fmt.Errorf("create contract oos")
			return
		}
		var responseBody createContractAPIResponse
		if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
			t.Error = err
			return
		}
		if responseBody.Data.CreatePurchaseContract.Id == "" {
			t.Error = fmt.Errorf("create-contract parse failed")
			return
		}
		t.ContractID = responseBody.Data.CreatePurchaseContract.Id
	case 412:
		if t.handlePX412(body) {
			return
		}
	case 302:
		if strings.Contains(strings.ToLower(response.Header.Get("Location")), "/blocked") {
			t.Error = fmt.Errorf("px blocked")
			return
		}
	case 444:
		t.Error = fmt.Errorf("proxy block")
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.Error = fmt.Errorf("create-contract (%d)", response.StatusCode)
	}
}

func (t *WalmartTask) SetContractAddress() {
	data := map[string]interface{}{
		"variables": map[string]interface{}{
			"input": map[string]interface{}{
				"contractId":    t.ContractID,
				"addressId":     t.ShippingAddressID,
				"cartId":        t.CartData.Id,
				"capabilities":  []string{},
				"isGiftAddress": true,
				"features": []string{
					"lmpdel",
					"ebtbmf",
					"mlrx",
					"vsrx",
					"sit",
					"sitprx",
					"sitsc",
					"sitsd",
					"gepmss",
					"maappl",
					"byod",
					"getitnow",
					"multipromo",
					"pdr",
				},
			},
			"promosEnable":                       true,
			"wplusEnabled":                       true,
			"isACCEnabled":                       true,
			"charityOfChoiceEnabled":             true,
			"wplusSplashSignupEnabled":           true,
			"enablePaidSignupBanner":             true,
			"enableWholeDollarDonation":          true,
			"orgContextEnabled":                  false,
			"enablePFS":                          true,
			"enableI18n":                         true,
			"enableMsiMci":                       true,
			"enableGEP":                          true,
			"enablePhoneCountryIso":              true,
			"enableCountryCode":                  true,
			"enableGEPForPilot":                  true,
			"enableIsEligibleForFreeTrialV1":     true,
			"enablePaymentMethodPromotion":       false,
			"enableWFSGlobal":                    false,
			"enableAppleCareFreeTrials":          true,
			"enableAOSModuleAttribute":           true,
			"enableAOSRearchitect":               false,
			"enableAOSBuyNow":                    true,
			"enableOutOfCountry":                 false,
			"enableDestinationTax":               true,
			"enableSavingsBreakup":               true,
			"enablePayWithPoints":                true,
			"enablePayWithPointsRedemptionCheck": false,
			"enableDsClarity":                    true,
			"enableFisPayments":                  false,
			"enableLoyaltyRedeemPoints":          false,
			"enableE2EPickupEnhancement":         true,
			"enableExpressSlot2":                 false,
			"enablePriceClarity":                 false,
			"enableGEPMultiSpeedShipping":        true,
			"enableInvoicing":                    false,
			"enableItemLevelTE":                  false,
			"enableTEEnhancement":                false,
			"enableSubUnsupportedPayments":       true,
			"enableResilientDependencies":        false,
			"enableCXOExpressPickupPhase1":       false,
			"enableTheFarmersDog":                true,
			"enableMOQVariants":                  false,
			"enableCXOFulfillmentCVP":            false,
		},
	}

	payloadBytes, err := json.Marshal(data)
	if err != nil {
		t.Error = err
		return
	}

	correlationBytes := make([]byte, 24)
	rand.Read(correlationBytes)
	correlationID := base64.RawURLEncoding.EncodeToString(correlationBytes)
	traceID := make([]byte, 16)
	spanID := make([]byte, 8)
	rand.Read(traceID)
	rand.Read(spanID)
	traceparent := fmt.Sprintf("00-%s-%s-00", hex.EncodeToString(traceID), hex.EncodeToString(spanID))
	baggage := fmt.Sprintf("requestTs=%d,tpid=%s", time.Now().UnixMilli(), traceparent)

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    "https://www.walmart.com/orchestra/cartxo/graphql/setShippingAddress/8c85fce1920673dba7a6087c3807314f4db47cfe0c6a17425e104c08ffc9dc3a",
			Data:   string(payloadBytes),
		},
		Headers: map[string][]string{
			"x-o-mart":                {"B2C"},
			"x-o-gql-query":           {"mutation setShippingAddress"},
			"sec-ch-ua-platform":      {"\"Windows\""},
			"x-o-segment":             {"oaoh"},
			"device_profile_ref_id":   {t.TMXDeviceID},
			"device-memory":           {"16"},
			"sec-ch-dpr":              {"1"},
			"x-enable-server-timing":  {"1"},
			"sec-ch-ua-mobile":        {"?0"},
			"baggage":                 {baggage},
			"x-latency-trace":         {"1"},
			"traceparent":             {traceparent},
			"sec-ch-ua":               {t.Requests.UserAgent.Sec_ua},
			"wm_mp":                   {"true"},
			"accept":                  {"application/json"},
			"content-type":            {"application/json"},
			"tenant-id":               {"elh9ie"},
			"x-apollo-operation-name": {"setShippingAddress"},
			"downlink":                {"10"},
			"wm_qos.correlation_id":   {correlationID},
			"x-o-platform":            {"rweb"},
			"x-o-platform-version":    {"usweb-1.277.0-de1f77bbfc9cf424763e6ae92d532df595b7f092-6250347r"},
			"accept-language":         {"en-US"},
			"x-o-ccm":                 {"server"},
			"x-o-bu":                  {"WALMART-US"},
			"sec-ch-device-memory":    {"16"},
			"dpr":                     {"1"},
			"user-agent":              {t.Requests.UserAgent.Useragent},
			"x-o-correlation-id":      {correlationID},
			"x-o-tp-phase":            {"tp6"},
			"responsegroups":          {"substitution,chargeforsubs"},
			"origin":                  {"https://www.walmart.com"},
			"sec-fetch-site":          {"same-origin"},
			"sec-fetch-mode":          {"cors"},
			"sec-fetch-dest":          {"empty"},
			"referer":                 {fmt.Sprintf("https://www.walmart.com/checkout/review-order?cartId=%s", t.CartData.Id)},
			"accept-encoding":         {"gzip, deflate, br, zstd"},
			"priority":                {"u=1, i"},
			"header-order":            {"content-length", "x-o-mart", "x-o-gql-query", "sec-ch-ua-platform", "x-o-segment", "device_profile_ref_id", "device-memory", "sec-ch-dpr", "x-enable-server-timing", "sec-ch-ua-mobile", "baggage", "x-latency-trace", "traceparent", "sec-ch-ua", "wm_mp", "accept", "content-type", "tenant-id", "x-apollo-operation-name", "downlink", "wm_qos.correlation_id", "x-o-platform", "x-o-platform-version", "accept-language", "x-o-ccm", "x-o-bu", "sec-ch-device-memory", "dpr", "user-agent", "x-o-correlation-id", "x-o-tp-phase", "responsegroups", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "priority"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[submitaddress] ERROR: %s", err)
		t.handleProxyRequestError(err)
		return
	}
	switch response.StatusCode {
	case 200:
	case 412:
		if t.handlePX412(body) {
			return
		}
	case 302:
		if strings.Contains(strings.ToLower(response.Header.Get("Location")), "/blocked") {
			t.Error = fmt.Errorf("px blocked")
			return
		}
	case 444:
		t.Error = fmt.Errorf("proxy block")
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.Error = fmt.Errorf("submit-address (%d)", response.StatusCode)
	}
}

func (t *WalmartTask) SubmitOrder() {
	pan := cardDigits(t.Profile.CardNumber)
	cvv := cardDigits(t.Profile.CardCvv)
	if pan == "" || cvv == "" {
		t.Error = fmt.Errorf("submit-order: invalid card input")
		return
	}
	if t.PaymentID == "" {
		t.Error = fmt.Errorf("submit-order: missing payment id")
		return
	}
	if t.PieKeys.KeyID == "" || t.PieKeys.K == "" {
		t.Error = fmt.Errorf("submit-order: missing pie keys")
		return
	}

	encrypted, err := pie.EncryptCard(pan, cvv, t.PieKeys)
	if err != nil {
		t.Error = err
		return
	}

	data := map[string]interface{}{
		"variables": map[string]interface{}{
			"placeOrderInput": map[string]interface{}{
				"contractId":                    t.ContractID,
				"acceptBagFee":                  nil,
				"acceptAlcoholDisclosure":       nil,
				"acceptAgeTwentyOneDisclosure":  nil,
				"ageEighteenDisclosureAccepted": nil,
				"acceptSMSOptInDisclosure":      false,
				"acceptTobaccoDisclosure":       false,
				"marketingEmailPref":            nil,
				"bagPreferenceSaved":            false,
				"mobileNumber":                  t.Profile.Phone,
				"mobileNumberIsoCountryCode":    constants.NormalizeCountryCode(t.Profile.ShippingCountry),
				"mobileNumberCountryPhoneCode":  "+1",
				"paymentCvvInfos": []map[string]interface{}{
					{
						"preferenceId":   t.PaymentID,
						"paymentType":    "CREDITCARD",
						"encryptedPan":   encrypted.EncryptedPan,
						"encryptedCvv":   encrypted.EncryptedCVV,
						"integrityCheck": encrypted.IntegrityCheck,
						"keyId":          encrypted.KeyID,
						"phase":          encrypted.Phase,
					},
				},
				"paymentPinInfos":       nil,
				"paymentHandle":         nil,
				"acceptDonation":        false,
				"emailAddress":          t.Account.Username,
				"fulfillmentOptions":    nil,
				"acceptedAgreements":    []string{},
				"guidedDeliveryDetails": map[string]interface{}{},
				"enforceItemPolicy":     true,
				"deviceInfo": map[string]interface{}{
					"organizationId": "hgy2n0ks",
				},
				"smsAccountPreferenceSaved": false,
				"smsConsentAttributes": map[string]interface{}{
					"moduleId":       "1b641721-870d-4064-b1d8-08968437ad68",
					"versionId":      "4",
					"languageCode":   "en",
					"tempoFieldName": "optInDisclaimer",
				},
			},
			"promosEnable":                             true,
			"wplusEnabled":                             true,
			"isACCEnabled":                             true,
			"onlyFetchCheckoutErrors":                  true,
			"enableWalmartPlusFreeDiscountedExpress":   true,
			"charityOfChoiceEnabled":                   true,
			"enablePhotoMigration":                     true,
			"enablePaidSignupBanner":                   true,
			"enableWholeDollarDonation":                true,
			"enableMsiMci":                             true,
			"enableInvoicing":                          false,
			"enableCartLevelMSI":                       false,
			"enableI18n":                               true,
			"enablePFS":                                true,
			"enableAOSBuyNow":                          true,
			"allowSuggestedSlotsACC":                   true,
			"enableWFSGlobal":                          false,
			"enableGEP":                                true,
			"enablePhoneCountryIso":                    true,
			"enableCountryCode":                        true,
			"enableIsEligibleForFreeTrialV1":           true,
			"enableGEPForPilot":                        true,
			"enableAccessPoint":                        false,
			"enablePaymentMethodPromotion":             false,
			"enableUnscheduledSlaGroups":               false,
			"enableCashiCashback":                      false,
			"enableCustomIncludedOffer":                false,
			"enableDestinationTax":                     true,
			"enableSubscriptionsInTransactionDiscount": false,
			"enablePayWithPoints":                      true,
			"enablePayWithPointsRedemptionCheck":       false,
			"enableDsClarity":                          true,
			"enableE2EPickupEnhancement":               true,
			"enableFisPayments":                        false,
			"enableExpressSlot2":                       false,
			"enablePriceClarity":                       false,
			"enableSavingsBreakup":                     true,
			"enableSubUnsupportedPayments":             false,
			"enableTwoFactorAuthentication":            false,
			"enableResilientDependencies":              false,
			"enableCXOExpressPickupPhase1":             false,
			"enableTheFarmersDog":                      true,
			"enableMOQVariants":                        false,
			"enableOnePayLaterAppleTradeUp2":           true,
		},
	}

	payloadBytes, err := json.Marshal(data)
	if err != nil {
		t.Error = err
		return
	}

	correlationBytes := make([]byte, 24)
	rand.Read(correlationBytes)
	correlationID := base64.RawURLEncoding.EncodeToString(correlationBytes)
	traceID := make([]byte, 16)
	spanID := make([]byte, 8)
	rand.Read(traceID)
	rand.Read(spanID)
	traceparent := fmt.Sprintf("00-%s-%s-00", hex.EncodeToString(traceID), hex.EncodeToString(spanID))
	baggage := fmt.Sprintf("requestTs=%d,tpid=%s", time.Now().UnixMilli(), traceparent)

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    "https://www.walmart.com/orchestra/cartxo/graphql/PlaceOrder/3b3cc6982af75593a2a870c78e6d050e338b1b254384437482d5dfe6e381d266",
			Data:   string(payloadBytes),
		},
		Headers: map[string][]string{
			"x-o-mart":                {"B2C"},
			"x-o-gql-query":           {"mutation PlaceOrder"},
			"sec-ch-ua-platform":      {"\"Windows\""},
			"x-o-segment":             {"oaoh"},
			"device_profile_ref_id":   {t.TMXDeviceID},
			"device-memory":           {"16"},
			"sec-ch-dpr":              {"1"},
			"x-enable-server-timing":  {"1"},
			"sec-ch-ua-mobile":        {"?0"},
			"baggage":                 {baggage},
			"x-latency-trace":         {"1"},
			"traceparent":             {traceparent},
			"sec-ch-ua":               {t.Requests.UserAgent.Sec_ua},
			"wm_mp":                   {"true"},
			"accept":                  {"application/json"},
			"content-type":            {"application/json"},
			"tenant-id":               {"elh9ie"},
			"x-apollo-operation-name": {"PlaceOrder"},
			"downlink":                {"10"},
			"wm_qos.correlation_id":   {correlationID},
			"x-o-platform":            {"rweb"},
			"x-o-platform-version":    {"usweb-1.277.0-de1f77bbfc9cf424763e6ae92d532df595b7f092-6250347r"},
			"accept-language":         {"en-US"},
			"x-o-ccm":                 {"server"},
			"x-o-bu":                  {"WALMART-US"},
			"sec-ch-device-memory":    {"16"},
			"dpr":                     {"1"},
			"user-agent":              {t.Requests.UserAgent.Useragent},
			"x-o-correlation-id":      {correlationID},
			"x-o-tp-phase":            {"tp6"},
			"responsegroups":          {"substitution,chargeforsubs"},
			"origin":                  {"https://www.walmart.com"},
			"sec-fetch-site":          {"same-origin"},
			"sec-fetch-mode":          {"cors"},
			"sec-fetch-dest":          {"empty"},
			"referer":                 {fmt.Sprintf("https://www.walmart.com/checkout/review-order?cartId=%s", t.CartData.Id)},
			"accept-encoding":         {"gzip, deflate, br, zstd"},
			"priority":                {"u=1, i"},
			"header-order":            {"content-length", "x-o-mart", "x-o-gql-query", "sec-ch-ua-platform", "x-o-segment", "device_profile_ref_id", "device-memory", "sec-ch-dpr", "x-enable-server-timing", "sec-ch-ua-mobile", "baggage", "x-latency-trace", "traceparent", "sec-ch-ua", "wm_mp", "accept", "content-type", "tenant-id", "x-apollo-operation-name", "downlink", "wm_qos.correlation_id", "x-o-platform", "x-o-platform-version", "accept-language", "x-o-ccm", "x-o-bu", "sec-ch-device-memory", "dpr", "user-agent", "x-o-correlation-id", "x-o-tp-phase", "responsegroups", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "priority"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[submitOrder] ERROR: %s", err)
		t.handleProxyRequestError(err)
		return
	}
	switch response.StatusCode {
	case 200:
		if strings.Contains(body, "Checkout has already been completed for this contract") {
			t.Checkout = true
			return
		}
		if strings.Contains(body, "payment_service_auth_decline") || strings.Contains(body, "payment_service_authorization_decline") {
			t.Decline = true
			return
		}
		if strings.Contains(body, "payment_credential_mismatch") {
			t.Error = fmt.Errorf("invaild cvv")
			return
		}
		if strings.Contains(body, "out_of_stock") {
			t.Error = fmt.Errorf("Out Of Stock")
			return
		}
		var responseBody placeOrderAPIResponse
		if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
			t.Error = err
			return
		}
		if responseBody.Data.PlaceOrder.Order.Id == "" {
			if strings.Contains(body, `checkoutError":[]`) {
				t.Checkout = true
				return
			}
			t.Error = fmt.Errorf("submit-order parse failed")
			return
		}
		t.OrderNumber = responseBody.Data.PlaceOrder.Order.Id
		t.Checkout = true
	case 412:
		if t.handlePX412(body) {
			return
		}
	case 302:
		if strings.Contains(strings.ToLower(response.Header.Get("Location")), "/blocked") {
			t.Error = fmt.Errorf("px blocked")
			return
		}
	case 444:
		t.Error = fmt.Errorf("proxy block")
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.Error = fmt.Errorf("submit-order (%d)", response.StatusCode)
	}
}

func (t *WalmartTask) GetQueue() {
	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			URL:    fmt.Sprintf("https://www.walmart.com/ip/-/%s", t.UsItemID),
			Method: "GET",
		},
		Headers: map[string][]string{
			"host":                      {"www.walmart.com"},
			"connection":                {"keep-alive"},
			"cache-control":             {"max-age=0"},
			"dpr":                       {"2"},
			"downlink":                  {"8.25"},
			"sec-ch-ua":                 {t.Requests.UserAgent.Sec_ua},
			"sec-ch-ua-mobile":          {"?0"},
			"sec-ch-ua-platform":        {"\"macOS\""},
			"upgrade-insecure-requests": {"1"},
			"user-agent":                {t.Requests.UserAgent.Useragent},
			"accept":                    {"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"},
			"sec-fetch-site":            {"same-origin"},
			"sec-fetch-mode":            {"navigate"},
			"sec-fetch-user":            {"?1"},
			"sec-fetch-dest":            {"document"},
			"accept-encoding":           {"gzip, deflate, br, zstd"},
			"accept-language":           {"en-US,en;q=0.9"},
			"header-order":              {"host", "connection", "cache-control", "dpr", "downlink", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "upgrade-insecure-requests", "user-agent", "accept", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-user", "sec-fetch-dest", "accept-encoding", "accept-language"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)

	if err != nil {
		log.Printf("Failed Getting Product page for Queue - %s", err)
		t.handleProxyRequestError(err)
		return
	}

	switch response.StatusCode {
	case 307:
		location := response.Header.Get("Location")
		if strings.Contains(location, "qp?qpdata=") {
			queryString := strings.Split(location, "qp?qpdata=")[1]
			decodedData, err := url.QueryUnescape(queryString)
			if err != nil {
				t.Error = fmt.Errorf("Failed Finding Queue (%d)", response.StatusCode)
				return
			}
			var queueData ProductQueueResponse
			err = json.Unmarshal([]byte(decodedData), &queueData)
			if err != nil {
				t.Error = fmt.Errorf("Failed Finding Queue (%d)", response.StatusCode)
				return
			}

			t.UsItemID = queueData.CustomMetadata.Item.ItemID
			t.Product.Name = queueData.CustomMetadata.Item.Name
			t.Product.ProductImage = queueData.CustomMetadata.Item.ImageURL
			t.Product.Sku = queueData.CustomMetadata.Item.ItemID
			t.Product.ProductLink = walmartProductPageURL(queueData.CustomMetadata.Item.ItemID)
			t.QueueID = queueData.Queue
		}

	case 444:
		t.Error = fmt.Errorf("proxy block")
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.Error = fmt.Errorf("Failed Finding Queue (%d)", response.StatusCode)
	}
}

func (t *WalmartTask) IssueTicket() {
	correlationBytes := make([]byte, 24)
	rand.Read(correlationBytes)
	correlationID := base64.RawURLEncoding.EncodeToString(correlationBytes)
	traceID := make([]byte, 16)
	spanID := make([]byte, 8)
	rand.Read(traceID)
	rand.Read(spanID)
	traceparent := fmt.Sprintf("00-%s-%s-00", hex.EncodeToString(traceID), hex.EncodeToString(spanID))
	baggage := fmt.Sprintf("requestTs=%d,tpid=%s", time.Now().UnixMilli(), traceparent)
	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "GET",
			URL:    fmt.Sprintf("https://q-api.www.walmart.com/issueTicket?queue=%s", t.QueueID),
		},
		Headers: map[string][]string{
			"host":                   {"q-api.www.walmart.com"},
			"connection":             {"keep-alive"},
			"x-o-mart":               {"B2C"},
			"sec-ch-ua-platform":     {t.Requests.UserAgent.Platform},
			"x-o-segment":            {"oaoh"},
			"device_profile_ref_id":  {t.TMXDeviceID},
			"sec-ch-ua":              {"\"Chromium\";v=\"142\", \"Google Chrome\";v=\"142\", \"Not_A Brand\";v=\"99\""},
			"x-enable-server-timing": {"1"},
			"sec-ch-ua-mobile":       {"?0"},
			"baggage":                {baggage},
			"x-latency-trace":        {"1"},
			"traceparent":            {traceparent},
			"wm_mp":                  {"true"},
			"accept":                 {"application/json"},
			"content-type":           {"application/json"},
			"tenant-id":              {"elh9ie"},
			"wm_qos.correlation_id":  {correlationID},
			"x-o-platform":           {"rweb"},
			"x-o-platform-version":   {"usweb-1.231.2-4cddbcbf364b7c8fbd7f42fb4ecc5d7b0271661c-O32010r"},
			"accept-language":        {"en-US"},
			"x-o-bu":                 {"WALMART-US"},
			"wm-client-traceid":      {"18754865509e915bc2fa21a326eaea90"},
			"user-agent":             {"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"},
			"x-o-correlation-id":     {correlationID},
			"origin":                 {"https://www.walmart.com"},
			"sec-fetch-site":         {"same-site"},
			"sec-fetch-mode":         {"cors"},
			"sec-fetch-dest":         {"empty"},
			"referer":                {"https://www.walmart.com/"},
			"accept-encoding":        {"gzip, deflate, br, zstd"},
			"header-order":           {"host", "connection", "x-o-mart", "sec-ch-ua-platform", "x-o-segment", "device_profile_ref_id", "sec-ch-ua", "x-enable-server-timing", "sec-ch-ua-mobile", "baggage", "x-latency-trace", "traceparent", "wm_mp", "accept", "content-type", "tenant-id", "wm_qos.correlation_id", "x-o-platform", "x-o-platform-version", "accept-language", "x-o-bu", "wm-client-traceid", "user-agent", "x-o-correlation-id", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[issueTicket] ERROR: %s", err)
		t.handleProxyRequestError(err)
		return
	}

	switch response.StatusCode {
	case 200:
		var responseBody QueueResponse
		if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
			t.Error = err
			return
		}
	case 444:
		t.Error = fmt.Errorf("proxy block")
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.Error = fmt.Errorf("issue-ticket (%d)", response.StatusCode)
	}

}

func (t *WalmartTask) ValidateTicket() {
	correlationBytes := make([]byte, 24)
	rand.Read(correlationBytes)
	correlationID := base64.RawURLEncoding.EncodeToString(correlationBytes)
	traceID := make([]byte, 16)
	spanID := make([]byte, 8)
	rand.Read(traceID)
	rand.Read(spanID)
	traceparent := fmt.Sprintf("00-%s-%s-00", hex.EncodeToString(traceID), hex.EncodeToString(spanID))
	baggage := fmt.Sprintf("requestTs=%d,tpid=%s", time.Now().UnixMilli(), traceparent)

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "GET",
			URL:    "https://q-api.www.walmart.com/validateTickets",
		},
		Headers: map[string][]string{
			"host":                   {"q-api.www.walmart.com"},
			"connection":             {"keep-alive"},
			"x-o-mart":               {"B2C"},
			"sec-ch-ua-platform":     {t.Requests.UserAgent.Platform},
			"x-o-segment":            {"oaoh"},
			"device_profile_ref_id":  {t.TMXDeviceID},
			"sec-ch-ua":              {"\"Chromium\";v=\"142\", \"Google Chrome\";v=\"142\", \"Not_A Brand\";v=\"99\""},
			"x-enable-server-timing": {"1"},
			"sec-ch-ua-mobile":       {"?0"},
			"baggage":                {baggage},
			"x-latency-trace":        {"1"},
			"traceparent":            {traceparent},
			"wm_mp":                  {"true"},
			"accept":                 {"application/json"},
			"content-type":           {"application/json"},
			"tenant-id":              {"elh9ie"},
			"wm_qos.correlation_id":  {correlationID},
			"x-o-platform":           {"rweb"},
			"x-o-platform-version":   {"usweb-1.231.2-4cddbcbf364b7c8fbd7f42fb4ecc5d7b0271661c-O32010r"},
			"accept-language":        {"en-US"},
			"x-o-bu":                 {"WALMART-US"},
			"wm-client-traceid":      {"18754865509e915bc2fa21a326eaea90"},
			"user-agent":             {"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"},
			"x-o-correlation-id":     {correlationID},
			"origin":                 {"https://www.walmart.com"},
			"sec-fetch-site":         {"same-site"},
			"sec-fetch-mode":         {"cors"},
			"sec-fetch-dest":         {"empty"},
			"referer":                {"https://www.walmart.com/"},
			"accept-encoding":        {"gzip, deflate, br, zstd"},
			"header-order":           {"host", "connection", "x-o-mart", "sec-ch-ua-platform", "x-o-segment", "device_profile_ref_id", "sec-ch-ua", "x-enable-server-timing", "sec-ch-ua-mobile", "baggage", "x-latency-trace", "traceparent", "wm_mp", "accept", "content-type", "tenant-id", "wm_qos.correlation_id", "x-o-platform", "x-o-platform-version", "accept-language", "x-o-bu", "wm-client-traceid", "user-agent", "x-o-correlation-id", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[issueTicket] ERROR: %s", err)
		t.handleProxyRequestError(err)
		return
	}

	switch response.StatusCode {
	case 200:
		var responseBody []QueueResponse
		if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
			t.Error = err
			return
		}
		if len(responseBody) == 0 {
			t.Error = fmt.Errorf("Out Of Stock")
			return
		}

		ticket := responseBody[0]
		if t.QueueID != "" {
			for _, q := range responseBody {
				if strings.EqualFold(q.Queue, t.QueueID) {
					ticket = q
					break
				}
			}
		}
		t.UsItemID = responseBody[0].ItemID
		t.OfferID = responseBody[0].OfferID
		t.QueuePassed = strings.EqualFold(ticket.State, "valid")
		if ticket.ExpectedTurnTimeUnixTimestamp > 0 {
			t.ExpectedQueueTime = int(ticket.ExpectedTurnTimeUnixTimestamp / 1000)
		}
		if ticket.NextRefreshRelativeTime > 0 {
			t.NextQueuePoll = int(ticket.NextRefreshRelativeTime)
		} else if ticket.NextRefreshUnixTimestamp > 0 {
			t.NextQueuePoll = int(time.Until(time.UnixMilli(ticket.NextRefreshUnixTimestamp)).Milliseconds())
			if t.NextQueuePoll < 0 {
				t.NextQueuePoll = 0
			}
		}
	case 444:
		t.Error = fmt.Errorf("proxy block")
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.Error = fmt.Errorf("validate-ticket (%d)", response.StatusCode)
	}

}

// monitor
func (t *WalmartMonitorTask) GetProductGraphql() {
	url := fmt.Sprintf("https://www.walmart.com/orchestra/pdp/graphql/GetProduct/5cf2019f93f89e9aa8e4973be69d9cfaef4ff1d4aa6dd05260caed84785cd83e/ip/%s?%s", t.Pid, buildProductQuery(t.Pid, t.Pid))
	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			URL:    url,
			Method: "GET",
		},
		Headers: map[string][]string{
			"host":                    {"www.walmart.com"},
			"x-o-platform-version":    {"26.24.1"},
			"tenant-id":               {"elh9ie"},
			"device_profile_ref_id":   {randReqId(true)},
			"x-enable-server-timing":  {"1"},
			"x-px-os":                 {"iOS"},
			"x-wm-sid":                {randReqId(true)},
			"x-o-fuzzy-install-date":  {"1750800000000"},
			"accept":                  {"*/*"},
			"accept-encoding":         {"gzip, deflate, br"},
			"user-agent":              {"WMT1H/26.24.1 iOS/26.2.1"},
			"x-o-mart":                {"B2C"},
			"x-o-segment":             {"oaoh"},
			"x-px-mobile-sdk-version": {"3.2.6"},
			"x-px-device-fp":          {randReqId(true)},
			"x-wm-vid":                {randReqId(true)},
			"x-o-bu":                  {"WALMART-US"},
			"x-latency-trace":         {"1"},
			"accept-language":         {"en-US"},
			"x-px-vid":                {randReqId(false)},
			"wm_mp":                   {"true"},
			"x-apollo-operation-name": {"GetProduct"},
			"x-o-platform":            {"ios"},
			"x-px-uuid":               {randReqId(false)},
			"x-px-os-version":         {"26.2.1"},
			"connection":              {"keep-alive"},
			"traceparent":             {"00-18be541a461580523df30601134c6f2e-ebda635344ae6f26-00"},
			"content-type":            {"application/json"},
			"x-px-device-model":       {"iPhone18,2"},
			"x-o-device":              {"iPhone18,2"},
			"x-wm-client-name":        {"glass"},
			"cyomv2enabled":           {"true"},
			"x-o-tp-phase":            {"tp5"},
			"x-apollo-operation-id":   {"5cf2019f93f89e9aa8e4973be69d9cfaef4ff1d4aa6dd05260caed84785cd83e"},
			"x-o-device-id":           {randReqId(true)},
			"baggage":                 {"deviceType=ios,pageName=productPage,pageViewId=76BBC019-C65F-4434-9373-E428476D104B,renderViewId=BBDC4972-02F0-42A4-95BD-F7EDD23294B1,requestTs=1782954974310,tpid=00-18be541a461580523df30601134c6f2e-ebda635344ae6f26-00,trafficType=release"},
			"pragma":                  {"no-cache"},
			"cache-control":           {"no-cache"},
			"header-order":            {"host", "x-o-platform-version", "tenant-id", "device_profile_ref_id", "x-enable-server-timing", "x-px-os", "x-wm-sid", "x-o-fuzzy-install-date", "accept", "accept-encoding", "user-agent", "x-o-mart", "x-o-segment", "x-px-hello", "x-px-mobile-sdk-version", "x-px-device-fp", "x-wm-vid", "x-o-bu", "x-latency-trace", "accept-language", "x-px-authorization", "x-px-vid", "wm_mp", "x-apollo-operation-name", "x-o-platform", "x-px-uuid", "x-px-os-version", "connection", "traceparent", "content-type", "x-px-device-model", "x-o-device", "x-wm-client-name", "cyomv2enabled", "x-o-tp-phase", "x-apollo-operation-id", "x-o-device-id", "baggage", "pragma", "cache-control"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)

	if err != nil {
		log.Printf("[GetStock] ERROR: %s", err)
		t.Error = err
		t.SwapProxy("Walmart")
		return
	}
	switch response.StatusCode {
	case 200:
		var responseBody ProductResponse
		if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
			log.Printf("Error parsing JSON response: %v", err)
			t.Error = err
			return
		}

		price := strings.TrimPrefix(responseBody.Data.Product.PriceInfo.CurrentPrice.PriceString, "$")

		priceFloat, _ := strconv.ParseFloat(price, 64)
		p := responseBody.Data.Product
		maxQty := 0
		for _, opt := range p.FulfillmentOptions {
			if opt.Type != "SHIPPING" {
				continue
			}
			maxQty = opt.MaxOrderQuantity
			if opt.OrderLimit > 0 && (maxQty == 0 || opt.OrderLimit < maxQty) {
				maxQty = opt.OrderLimit
			}
			break
		}
		if p.OrderLimit > 0 && (maxQty == 0 || p.OrderLimit < maxQty) {
			maxQty = p.OrderLimit
		}
		if len(p.ImageInfo.AllImages) > 0 {
			t.MonitorProduct = MonitorProduct{
				CurrentPrice: priceFloat,
				ImageURL:     p.ImageInfo.AllImages[0].Url,
				ItemID:       p.UsItemId,
				Name:         p.Name,
				OfferId:      p.OfferId,
				InStock:      p.ItemPageAvailabilityStatus,
				MaxQty:       maxQty,
			}
		} else {
			t.Error = fmt.Errorf("get-stock (%d)", response.StatusCode)
		}
	case 412:
		t.PxBlocked = true
	case 442:
		var responseBody ProductQueueResponse
		if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
			log.Printf("Error parsing JSON response: %v", err)
			t.Error = err
			return
		}

		price := strings.TrimPrefix(responseBody.CustomMetadata.Item.CurrentPrice, "$")

		priceFloat, _ := strconv.ParseFloat(price, 64)
		t.MonitorProduct = MonitorProduct{
			QueueID:      responseBody.Queue,
			CurrentPrice: priceFloat,
			ImageURL:     responseBody.CustomMetadata.Item.ImageURL,
			ItemID:       responseBody.CustomMetadata.Item.ItemID,
			Name:         responseBody.CustomMetadata.Item.Name,
			InStock:      "QUEUE",
		}
	case 444:
		t.Error = fmt.Errorf("proxy block")
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.Error = fmt.Errorf("get-stock (%d)", response.StatusCode)
	}
}
