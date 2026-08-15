package pokemoncenter

import (
	"context"
	"encoding/base64"
	"fmt"
	"log"
	"net/url"
	"strings"
	"time"

	jsoniter "github.com/json-iterator/go"
	"zynbot.app/engine/client"
	"zynbot.app/engine/sites"
)

var jsonStd = jsoniter.ConfigCompatibleWithStandardLibrary

func (t *PokemonCenterTask) GetHomepage() {
	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "GET",
			URL:    "https://www.pokemoncenter.com/",
		},
		Headers: map[string][]string{
			"host":                      {"www.pokemoncenter.com"},
			"connection":                {"keep-alive"},
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
			"header-order":              {"host", "connection", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "upgrade-insecure-requests", "user-agent", "accept", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-user", "sec-fetch-dest", "accept-encoding", "accept-language"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[GetHomepage] Request error: %v", err)
		t.handleProxyRequestError("get-homepage", "Proxy Failed", err)
		return
	} else {
		log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
		t.Requests.Referer = Request.Req.URL
		switch response.StatusCode {
		case 200:
			if strings.Contains(body, "Incapsula incident ID") {
				if successful, incidentUrl := ParseIncapIncident(body); successful {
					t.IncapIncidentUrl = incidentUrl
					t.Error = fmt.Errorf("incap-challenge")
				} else {
					t.Error = fmt.Errorf("failed to parse Incap")
				}
			}
			if strings.Contains(body, "Pardon Our Interruption") {
				if successful, scriptURl := ParseIncapDynamic(body); successful {
					t.IncapIncidentUrl = scriptURl
					t.DynamicIncapSolving = true
				} else {
					t.Error = fmt.Errorf("failed to parse Incap")
				}
			}
		case 403:
			if strings.Contains(body, "captcha-delivery") {
				successful, challengeType, challengeUrl, hardBlocked := ParseDatadomeChallenge(body, t.DatadomeCid, "https://www.pokemoncenter.com/")
				if successful {
					t.DatadomeUrl = challengeUrl
					t.DDHardBlocked = hardBlocked
					if challengeType == "interstitial" {
						t.InterBlockOnHome = true
					}
					t.Error = fmt.Errorf("datadome-%s", challengeType)
				} else {
					t.NextStep, t.Error = "get-homepage", fmt.Errorf("error parsing datadome")
				}
			} else {
				t.Error = fmt.Errorf("get session (403)")
			}
		case 503:
			t.BaseTask.SwapProxy("PokemonCenter")
			t.Error = fmt.Errorf("error homepage (%d)", response.StatusCode)

		default:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.NextStep, t.Error = "get-homepage", fmt.Errorf("error homepage (%d)", response.StatusCode)
		}
	}
}

func (t *PokemonCenterTask) GetIncapScript() {
	BaseUrl := "https://www.pokemoncenter.com/vice-come-Soldenyson-it-non-Banquoh-Chare-Hart-C"
	if t.DynamicIncapSolving {
		BaseUrl = fmt.Sprintf("https://www.pokemoncenter.com%s", t.IncapIncidentUrl)
	}
	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "GET",
			URL:    BaseUrl,
		},
		Headers: map[string][]string{
			"host":               {"www.pokemoncenter.com"},
			"connection":         {"keep-alive"},
			"sec-ch-ua-platform": {t.Requests.UserAgent.Platform},
			"user-agent":         {t.Requests.UserAgent.Useragent},
			"sec-ch-ua":          {t.Requests.UserAgent.Sec_ua},
			"sec-ch-ua-mobile":   {"?0"},
			"accept":             {"*/*"},
			"sec-fetch-site":     {"same-origin"},
			"sec-fetch-mode":     {"no-cors"},
			"sec-fetch-dest":     {"script"},
			"referer":            {"https://www.pokemoncenter.com/"},
			"accept-encoding":    {"gzip, deflate, br, zstd"},
			"accept-language":    {"en-US,en;q=0.9"},
			"header-order":       {"host", "connection", "sec-ch-ua-platform", "user-agent", "sec-ch-ua", "sec-ch-ua-mobile", "accept", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		t.handleProxyRequestError("get-incap", "Proxy Failed", err)
		return
	} else {
		log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
		t.Requests.Referer = Request.Req.URL
		switch response.StatusCode {
		case 200:
			t.ReeseScript = body
		default:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.NextStep, t.Error = "get-incap", fmt.Errorf("error incap (%d)", response.StatusCode)
		}
	}
}

func (t *PokemonCenterTask) GetIpInfo() {
	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "GET",
			URL:    "https://ip.graphlabs.xyz/",
		},
		Headers: map[string][]string{},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		t.handleProxyRequestError("get-ip", "Proxy Failed", err)
		return
	} else {
		log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
		t.Requests.Referer = Request.Req.URL
		switch response.StatusCode {
		case 200:
			var responseBody IpResponse
			if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
				log.Printf("Error parsing JSON response: %v", err)
				t.Error = err
				return
			}
			t.IpInfo = responseBody
		default:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.NextStep, t.Error = "get-ip", fmt.Errorf("error ip (%d)", response.StatusCode)
		}
	}
}

func (t *PokemonCenterTask) GetIncapSensor() {
	BaseUrl := "https://www.pokemoncenter.com/vice-come-Soldenyson-it-non-Banquoh-Chare-Hart-C"
	if t.DynamicIncapSolving {
		BaseUrl = fmt.Sprintf("https://www.pokemoncenter.com%s", t.IncapIncidentUrl)
	}
	data := map[string]interface{}{
		"userAgent":      t.Requests.UserAgent.Useragent,
		"pageUrl":        "https://www.pokemoncenter.com/",
		"script":         t.ReeseScript,
		"scriptUrl":      BaseUrl,
		"ip":             t.IpInfo.Ip,
		"acceptLanguage": "en-US,en;q=0.9",
	}
	status, body, err := t.requestHyper("reese84", data)
	if err != nil {
		t.setHyperError("get-incap-sensor", err)
		return
	} else {
		switch status {
		case 200:
			var responseBody ReeseSolveHyperResponse
			if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
				log.Printf("Error parsing JSON response: %v", err)
				t.Error = err
				return
			}
			t.ReesePayload = responseBody.Payload
		default:
			t.recordUnknownHyper("reese84", status, body)
			t.NextStep, t.Error = "get-incap-sensor", fmt.Errorf("error incap (%d)", status)
		}
	}
}

func (t *PokemonCenterTask) PostReese84() {
	BaseUrl := "https://www.pokemoncenter.com/vice-come-Soldenyson-it-non-Banquoh-Chare-Hart-C?d=www.pokemoncenter.com"
	if t.DynamicIncapSolving {
		BaseUrl = fmt.Sprintf("https://www.pokemoncenter.com%s", t.IncapIncidentUrl)
	}
	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    BaseUrl,
			Data:   t.ReesePayload,
		},
		Headers: map[string][]string{
			"host":               {"www.pokemoncenter.com"},
			"connection":         {"keep-alive"},
			"sec-ch-ua-platform": {t.Requests.UserAgent.Platform},
			"user-agent":         {t.Requests.UserAgent.Useragent},
			"accept":             {"application/json; charset=utf-8"},
			"sec-ch-ua":          {t.Requests.UserAgent.Sec_ua},
			"content-type":       {"text/plain; charset=utf-8"},
			"sec-ch-ua-mobile":   {"?0"},
			"origin":             {"https://www.pokemoncenter.com"},
			"sec-fetch-site":     {"same-origin"},
			"sec-fetch-mode":     {"cors"},
			"sec-fetch-dest":     {"empty"},
			"referer":            {"https://www.pokemoncenter.com/"},
			"accept-encoding":    {"gzip, deflate, br, zstd"},
			"accept-language":    {"en-US,en;q=0.9"},
			"header-order":       {"host", "connection", "content-length", "sec-ch-ua-platform", "user-agent", "accept", "sec-ch-ua", "content-type", "sec-ch-ua-mobile", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		t.handleProxyRequestError("post-reese84", "Proxy Failed", err)
		return
	} else {
		log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
		t.Requests.Referer = Request.Req.URL
		switch response.StatusCode {
		case 200:
			var responseBody ReeseResponse
			if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
				log.Printf("Error parsing JSON response: %v", err)
				t.Error = err
				return
			}
			t.renewMu.Lock()
			t.Requests.AddCookie("reese84", responseBody.Token, "www.pokemoncenter.com")
			t.ReeseCookie = responseBody.Token
			t.RenewIncapIn = responseBody.RenewInSec
			t.renewMu.Unlock()
			t.ReeseSolved = true

		default:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.NextStep, t.Error = "post-reese84", fmt.Errorf("error sensor (%d)", response.StatusCode)
		}
	}
}

func (t *PokemonCenterTask) renewReese(ctx context.Context) error {
	t.renewMu.Lock()
	currentToken := t.ReeseCookie
	dynamic := t.DynamicIncapSolving
	incidentUrl := t.IncapIncidentUrl
	t.renewMu.Unlock()

	BaseUrl := "https://www.pokemoncenter.com/vice-come-Soldenyson-it-non-Banquoh-Chare-Hart-C?d=www.pokemoncenter.com"
	if dynamic {
		BaseUrl = fmt.Sprintf("https://www.pokemoncenter.com%s", incidentUrl)
	}
	Request := client.RequestStruct{
		CTX: ctx,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    BaseUrl,
			Data:   currentToken,
		},
		Headers: map[string][]string{
			"host":               {"www.pokemoncenter.com"},
			"connection":         {"keep-alive"},
			"sec-ch-ua-platform": {t.Requests.UserAgent.Platform},
			"user-agent":         {t.Requests.UserAgent.Useragent},
			"accept":             {"application/json; charset=utf-8"},
			"sec-ch-ua":          {t.Requests.UserAgent.Sec_ua},
			"content-type":       {"text/plain; charset=utf-8"},
			"sec-ch-ua-mobile":   {"?0"},
			"origin":             {"https://www.pokemoncenter.com"},
			"sec-fetch-site":     {"same-origin"},
			"sec-fetch-mode":     {"cors"},
			"sec-fetch-dest":     {"empty"},
			"referer":            {"https://www.pokemoncenter.com/"},
			"accept-encoding":    {"gzip, deflate, br, zstd"},
			"accept-language":    {"en-US,en;q=0.9"},
			"header-order":       {"host", "connection", "content-length", "sec-ch-ua-platform", "user-agent", "accept", "sec-ch-ua", "content-type", "sec-ch-ua-mobile", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		return err
	}

	log.Printf("[ID:'%s' | Renew Reese Status: %s]", t.ID, response.Status)

	if response.StatusCode != 200 {
		return fmt.Errorf("error renew reese (%d)", response.StatusCode)
	}

	var responseBody ReeseResponse
	if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
		log.Printf("Error parsing JSON response: %v", err)
		return err
	}

	if ctx.Err() != nil {
		return ctx.Err()
	}

	t.renewMu.Lock()
	if responseBody.Token != "" {
		t.Requests.AddCookie("reese84", responseBody.Token, "www.pokemoncenter.com")
		t.ReeseCookie = responseBody.Token
	}
	t.RenewIncapIn = responseBody.RenewInSec
	t.renewMu.Unlock()

	return nil
}

func (t *PokemonCenterTask) GetTagsSensor(payloadType string) {
	data := map[string]interface{}{
		"userAgent":      t.Requests.UserAgent.Useragent,
		"ddk":            "5B45875B653A484CC79E57036CE9FC",
		"cid":            t.DatadomeCid,
		"referer":        "https://www.pokemoncenter.com/",
		"type":           payloadType,
		"ip":             t.IpInfo.Ip,
		"acceptLanguage": "en-US,en;q=0.9",
	}
	status, body, err := t.requestHyper("datadome-tags", data)
	if err != nil {
		t.setHyperError("solve-datadome-ch", err)
		return
	} else {
		switch status {
		case 200:
			var responseBody DatadomeTagsSolveHyperResponse
			if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
				log.Printf("Error parsing JSON response: %v", err)
				t.Error = err
				return
			}
			t.DatadomePayload = responseBody.Payload
		default:
			t.recordUnknownHyper("datadome-tags", status, body)
			t.NextStep, t.Error = "solve-datadome-ch", fmt.Errorf("error datadome (%d)", status)
		}
	}
}

func (t *PokemonCenterTask) PostDatadomeTags() {
	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    "https://dd.pokemoncenter.com/js/",
			Data:   t.DatadomePayload,
		},
		Headers: map[string][]string{
			"sec-ch-ua-platform": {t.Requests.UserAgent.Platform},
			"user-agent":         {t.Requests.UserAgent.Useragent},
			"sec-ch-ua":          {t.Requests.UserAgent.Sec_ua},
			"content-type":       {"application/x-www-form-urlencoded"},
			"sec-ch-ua-mobile":   {"?0"},
			"accept":             {"*/*"},
			"origin":             {"https://www.pokemoncenter.com"},
			"sec-fetch-site":     {"same-site"},
			"sec-fetch-mode":     {"cors"},
			"sec-fetch-dest":     {"empty"},
			"accept-encoding":    {"gzip, deflate, br, zstd"},
			"accept-language":    {"en-US,en;q=0.9"},
			"priority":           {"u=1, i"},
			"header-order":       {"content-length", "sec-ch-ua-platform", "user-agent", "sec-ch-ua", "content-type", "sec-ch-ua-mobile", "accept", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "accept-encoding", "accept-language", "priority"},
		},
		DisableCookies: true,
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		t.handleProxyRequestError("solve-datadome-ch", "Proxy Failed", err)
		return
	} else {
		log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
		t.Requests.Referer = Request.Req.URL
		switch response.StatusCode {
		case 200:
			var responseBody DatadomeTagsResponse
			if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
				log.Printf("Error parsing JSON response: %v", err)
				t.Error = err
				return
			}
			t.DatadomeCid = strings.Split(strings.Split(responseBody.Cookie, "datadome=")[1], ";")[0]
			t.Requests.AddCookie("datadome", t.DatadomeCid, "www.pokemoncenter.com")

		default:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.NextStep, t.Error = "post-datadome-ch", fmt.Errorf("error datadome (%d)", response.StatusCode)
		}
	}
}

func (t *PokemonCenterTask) GetCart() {
	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "GET",
			URL:    "https://www.pokemoncenter.com/tpci-ecommweb-api/cart/data?type=mini",
		},
		Headers: map[string][]string{
			"host":               {"www.pokemoncenter.com"},
			"connection":         {"keep-alive"},
			"x-store-scope":      {t.storeScope()},
			"sec-ch-ua-platform": {t.Requests.UserAgent.Platform},
			"sec-ch-ua":          {t.Requests.UserAgent.Sec_ua},
			"sec-ch-ua-mobile":   {"?0"},
			"x-store-locale":     {t.storeLocale()},
			"user-agent":         {t.Requests.UserAgent.Useragent},
			"accept":             {"application/json"},
			"accept-version":     {"1"},
			"content-type":       {"application/json"},
			"sec-fetch-site":     {"same-origin"},
			"sec-fetch-mode":     {"cors"},
			"sec-fetch-dest":     {"empty"},
			"referer":            {"https://www.pokemoncenter.com/"},
			"accept-encoding":    {"gzip, deflate, br, zstd"},
			"accept-language":    {"en-US,en;q=0.9"},
			"header-order":       {"host", "connection", "x-store-scope", "sec-ch-ua-platform", "sec-ch-ua", "sec-ch-ua-mobile", "x-store-locale", "user-agent", "accept", "accept-version", "content-type", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		t.handleProxyRequestError("get-cart", "Proxy Failed", err)
		return
	} else {
		log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
		t.Requests.Referer = Request.Req.URL
		switch response.StatusCode {
		case 200:
			var responseBody MinicartResponse
			if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
				log.Printf("Error parsing JSON response: %v", err)
				t.Error = err
				t.BaseTask.SwapProxy("PokemonCenter")
				return
			}
			t.DynamicAdd = responseBody.FeatureFlags.DynamicAdd
		case 403:
			if strings.Contains(body, "captcha-delivery") {
				successful, challengeType, challengeUrl, hardBlocked := ParseDatadomeChallenge(body, t.DatadomeCid, "https://www.pokemoncenter.com/")
				if successful {
					t.DDHardBlocked = hardBlocked
					t.DatadomeUrl = challengeUrl
					t.Error = fmt.Errorf("datadome-%s", challengeType)
				} else {
					t.NextStep, t.Error = "get-cart", fmt.Errorf("error parsing datadome")
				}
			} else if strings.Contains(body, "This request was blocked by our security service") {
				t.NextStep, t.Error = "get-cart", fmt.Errorf("incap block")
			} else {
				t.Error = fmt.Errorf("Incap Block")
			}
		default:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.NextStep, t.Error = "get-cart", fmt.Errorf("get cart (%d)", response.StatusCode)
		}
	}
}

func (t *PokemonCenterTask) GetReleases() {
	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "GET",
			URL:    "https://www.pokemoncenter.com/category/new-releases",
		},
		Headers: map[string][]string{
			"Host":               {"www.pokemoncenter.com"},
			"Connection":         {"keep-alive"},
			"sec-ch-ua-platform": {t.DatadomeHeaders.SecPlatform},
			"User-Agent":         {t.Requests.UserAgent.Useragent},
			"Accept":             {"application/json, text/plain, */*"},
			"sec-ch-ua":          {t.Requests.UserAgent.Sec_ua},
			"sec-ch-ua-mobile":   {t.DatadomeHeaders.SecMobile},
			"Sec-Fetch-Site":     {"same-Origin"},
			"Sec-Fetch-Mode":     {"cors"},
			"Sec-Fetch-Dest":     {"empty"},
			"Referer":            {"https://www.pokemoncenter.com/"},
			"Accept-Encoding":    {"gzip, deflate, br, zstd"},
			"Accept-Language":    {"en-US,en;q=0.9"},
			"header-order":       {"Host", "Connection", "sec-ch-ua-platform", "User-Agent", "Accept", "sec-ch-ua", "sec-ch-ua-mobile", "Sec-Fetch-Site", "Sec-Fetch-Mode", "Sec-Fetch-Dest", "Referer", "Accept-Encoding", "Accept-Language", "Cookie"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[GetReleases] Request error: %v", err)
		t.handleProxyRequestError("get-releases", "Proxy Failed", err)
		return
	} else {
		log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
		t.Requests.Referer = Request.Req.URL
		switch response.StatusCode {
		case 200:
			if strings.Contains(body, "Incapsula incident ID") {
				if successful, incidentUrl := ParseIncapIncident(body); successful {
					t.IncapIncidentUrl = incidentUrl
					t.Error = fmt.Errorf("incap-challenge")
				} else {
					t.Error = fmt.Errorf("failed to parse Incap")
				}
			}
		case 403:
			if strings.Contains(body, "captcha-delivery") {
				successful, challengeType, challengeUrl, hardBlocked := ParseDatadomeChallenge(body, t.DatadomeCid, "https://www.pokemoncenter.com/")
				if successful {
					t.DatadomeUrl = challengeUrl
					t.DDHardBlocked = hardBlocked
					t.Error = fmt.Errorf("datadome-%s", challengeType)
				} else {
					t.NextStep, t.Error = "get-releases", fmt.Errorf("error parsing datadome")
				}
			} else {
				t.Error = fmt.Errorf("get releases (403)")
			}

		default:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.NextStep, t.Error = "get-releases", fmt.Errorf("error releases (%d)", response.StatusCode)
		}
	}
}

func (t *PokemonCenterTask) GetProduct(Input sites.Input) {
	productSku := Input.Input
	if Input.ProductLink {
		productSku = strings.Split(strings.Split(Input.Input, "/product/")[1], "/")[0]
	}
	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "GET",
			URL:    fmt.Sprintf("https://www.pokemoncenter.com/tpci-ecommweb-api/product/%s", productSku),
		},
		Headers: map[string][]string{
			"host":               {"www.pokemoncenter.com"},
			"connection":         {"keep-alive"},
			"x-store-scope":      {t.storeScope()},
			"sec-ch-ua-platform": {t.Requests.UserAgent.Platform},
			"sec-ch-ua":          {t.Requests.UserAgent.Sec_ua},
			"sec-ch-ua-mobile":   {"?0"},
			"x-store-locale":     {t.storeLocale()},
			"user-agent":         {t.Requests.UserAgent.Useragent},
			"accept":             {"application/json"},
			"accept-version":     {"1"},
			"content-type":       {"application/json"},
			"sec-fetch-site":     {"same-origin"},
			"sec-fetch-mode":     {"cors"},
			"sec-fetch-dest":     {"empty"},
			"referer":            {"https://www.pokemoncenter.com/"},
			"accept-encoding":    {"gzip, deflate, br, zstd"},
			"accept-language":    {"en-US,en;q=0.9"},
			"header-order":       {"host", "connection", "x-store-scope", "sec-ch-ua-platform", "sec-ch-ua", "sec-ch-ua-mobile", "x-store-locale", "user-agent", "accept", "accept-version", "content-type", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		t.handleProxyRequestError("get-product", "proxy failed", err)
		return
	} else {
		log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
		t.Requests.Referer = Request.Req.URL
		switch response.StatusCode {
		case 200:
			var responseBody ProductResponse
			if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
				log.Printf("Error parsing JSON response: %v", err)
				t.Error = err
				return
			}
			decidedQuantity := Input.Quantity
			if decidedQuantity > responseBody.Attributes.QuantityLimit {
				decidedQuantity = responseBody.Attributes.QuantityLimit
			}
			t.Products = append(t.Products, Product{
				ProductTag:   strings.Split(strings.Split(responseBody.Self.Uri, t.offersPrefix())[1], "?")[0],
				Quantity:     decidedQuantity,
				Sku:          strings.Split(strings.Split(responseBody.Items[0].Element[0].AddToCartForm[0].Self.Uri, t.cartsItemsPrefix())[1], "/form")[0],
				ProductName:  responseBody.Attributes.Name,
				ProductImage: fmt.Sprintf("https://www.pokemoncenter.com/images/DAMRoot/%s", responseBody.Attributes.ImageMainHigh),
				ProductPrice: responseBody.PriceRange[0].ListPriceRange.FromPrice[0].Amount,
				ProductLink:  fmt.Sprintf("https://www.pokemoncenter.com/product/%s", responseBody.Code[0].Code),
				ProductSize:  "Default",
			})

		case 403:
			if strings.Contains(body, "captcha-delivery") {
				successful, challengeType, challengeUrl, hardBlocked := ParseDatadomeChallenge(body, t.DatadomeCid, "https://www.pokemoncenter.com/")
				if successful {
					t.DatadomeUrl = challengeUrl
					t.DDHardBlocked = hardBlocked
					t.Error = fmt.Errorf("datadome-%s", challengeType)
				} else {
					t.NextStep, t.Error = "get-product", fmt.Errorf("error parsing datadome")
				}
			} else if strings.Contains(body, "This request was blocked by our security service") {
				t.NextStep, t.Error = "get-product", fmt.Errorf("incap block")
			} else {
				t.Error = fmt.Errorf("get product (403)")
			}
		case 404:
			t.Error = fmt.Errorf("product not found")
		default:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.NextStep, t.Error = "get-product", fmt.Errorf("get product (%d)", response.StatusCode)
		}
	}
}

func (t *PokemonCenterTask) GetAvailability(Product Product) {
	Referer := Product.ProductLink
	if Referer == "" {
		Referer = fmt.Sprintf("https://www.pokemoncenter.com/product/%s", Product.ProductTag)
	}
	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "GET",
			URL:    fmt.Sprintf("https://www.pokemoncenter.com/tpci-ecommweb-api/product/status/%s", Product.ProductTag),
		},
		Headers: map[string][]string{
			"host":               {"www.pokemoncenter.com"},
			"connection":         {"keep-alive"},
			"x-store-scope":      {t.storeScope()},
			"sec-ch-ua-platform": {t.Requests.UserAgent.Platform},
			"sec-ch-ua":          {t.Requests.UserAgent.Sec_ua},
			"sec-ch-ua-mobile":   {"?0"},
			"x-store-locale":     {t.storeLocale()},
			"user-agent":         {t.Requests.UserAgent.Useragent},
			"accept":             {"application/json"},
			"accept-version":     {"1"},
			"content-type":       {"application/json"},
			"sec-fetch-site":     {"same-origin"},
			"sec-fetch-mode":     {"cors"},
			"sec-fetch-dest":     {"empty"},
			"referer":            {Referer},
			"accept-encoding":    {"gzip, deflate, br, zstd"},
			"accept-language":    {"en-US,en;q=0.9"},
			"header-order":       {"host", "connection", "x-store-scope", "sec-ch-ua-platform", "sec-ch-ua", "sec-ch-ua-mobile", "x-store-locale", "user-agent", "accept", "accept-version", "content-type", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		t.handleProxyRequestError("get-availability", "proxy failed", err)
		return
	} else {
		log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
		t.Requests.Referer = Request.Req.URL
		switch response.StatusCode {
		case 200:
			var responseBody AvailabilityResponse
			if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
				log.Printf("Error parsing JSON response: %v", err)
				t.Error = err
				return
			}
			for i := range t.Products {
				if t.Products[i].ProductTag == Product.ProductTag {
					t.Products[i].Available = responseBody.Availability[0].State == "AVAILABLE"
					break
				}
			}
		case 403:
			if strings.Contains(body, "captcha-delivery") {
				successful, challengeType, challengeUrl, hardBlocked := ParseDatadomeChallenge(body, t.DatadomeCid, "https://www.pokemoncenter.com/")
				if successful {
					t.DDHardBlocked = hardBlocked
					t.DatadomeUrl = challengeUrl
					t.Error = fmt.Errorf("datadome-%s", challengeType)
				} else {
					t.NextStep, t.Error = "get-availability", fmt.Errorf("error parsing datadome")
				}
			} else if strings.Contains(body, "This request was blocked by our security service") {
				t.NextStep, t.Error = "get-availability", fmt.Errorf("incap block")
			} else {
				t.Error = fmt.Errorf("get availability (403)")
			}
		default:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.NextStep, t.Error = "get-availability", fmt.Errorf("get availability (%d)", response.StatusCode)
		}
	}
}

func (t *PokemonCenterTask) AddToCart(Product Product) {
	payload := fmt.Sprintf(`{"clobber":false,"quantity":%d,"configuration":{},"dynamicAdd":%t}`, Product.Quantity, t.DynamicAdd)

	Referer := Product.ProductLink
	if Referer == "" {
		Referer = fmt.Sprintf("https://www.pokemoncenter.com/product/%s", Product.ProductTag)
	}

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    fmt.Sprintf("https://www.pokemoncenter.com/tpci-ecommweb-api/cart/add-product/%s", Product.Sku), //add multicart
			Data:   payload,
		},
		Headers: map[string][]string{
			"host":               {"www.pokemoncenter.com"},
			"connection":         {"keep-alive"},
			"x-store-scope":      {t.storeScope()},
			"sec-ch-ua-platform": {t.Requests.UserAgent.Platform},
			"sec-ch-ua":          {t.Requests.UserAgent.Sec_ua},
			"sec-ch-ua-mobile":   {"?0"},
			"x-store-locale":     {t.storeLocale()},
			"user-agent":         {t.Requests.UserAgent.Useragent},
			"accept":             {"application/json"},
			"accept-version":     {"1"},
			"content-type":       {"application/json"},
			"origin":             {"https://www.pokemoncenter.com"},
			"sec-fetch-site":     {"same-origin"},
			"sec-fetch-mode":     {"cors"},
			"sec-fetch-dest":     {"empty"},
			"referer":            {Referer},
			"accept-encoding":    {"gzip, deflate, br, zstd"},
			"accept-language":    {"en-US,en;q=0.9"},
			"header-order":       {"host", "connection", "content-length", "x-store-scope", "sec-ch-ua-platform", "sec-ch-ua", "sec-ch-ua-mobile", "x-store-locale", "user-agent", "accept", "accept-version", "content-type", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		t.handleProxyRequestError("add-to-cart", "proxy failed", err)
		return
	} else {
		log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
		t.Requests.Referer = Request.Req.URL
		switch response.StatusCode {
		case 200, 201:
			var responseBody AddToCartResponse
			if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
				log.Printf("Error parsing JSON response: %v", err)
				t.Error = err
				return
			}
			if len(responseBody.Messages) > 0 {
				t.Error = fmt.Errorf("add to cart: %s", responseBody.Messages[0].ID)
			}
			t.TotalPrice += int(Product.ProductPrice) * Product.Quantity

		case 400:
			var responseBody AddToCartResponse
			if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
				log.Printf("Error parsing JSON response: %v", err)
				t.Error = err
				return
			}
			if len(responseBody.Messages) > 0 {
				if responseBody.Messages[0].ID == "item.insufficient.inventory" || responseBody.Messages[0].ID == "item.not.available" {
					t.NextStep, t.Error = "add-to-cart", fmt.Errorf("out of stock")
				} else {
					t.NextStep, t.Error = "add-to-cart", fmt.Errorf("add to cart (%d)", response.StatusCode)
				}
			}
		case 403:
			if strings.Contains(body, "captcha-delivery") {
				successful, challengeType, challengeUrl, hardBlocked := ParseDatadomeChallenge(body, t.DatadomeCid, "https://www.pokemoncenter.com/")
				if successful {
					t.DDHardBlocked = hardBlocked
					t.DatadomeUrl = challengeUrl
					t.Error = fmt.Errorf("datadome-%s", challengeType)
				} else {
					t.NextStep, t.Error = "add-to-cart", fmt.Errorf("error parsing datadome")
				}
			} else if strings.Contains(body, "This request was blocked by our security service") {
				t.NextStep, t.Error = "add-to-cart", fmt.Errorf("incap block")
			} else {
				t.Error = fmt.Errorf("add to cart (403)")
			}
		default:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.NextStep, t.Error = "add-to-cart", fmt.Errorf("add to cart (%d)", response.StatusCode)
		}
	}
}

func (t *PokemonCenterTask) SubmitEmail() {
	data := map[string]interface{}{
		"email": t.Profile.Email,
	}
	payloadBytes, _ := jsonStd.Marshal(data)

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    "https://www.pokemoncenter.com/tpci-ecommweb-api/email/add",
			Data:   string(payloadBytes),
		},
		Headers: map[string][]string{
			"host":               {"www.pokemoncenter.com"},
			"connection":         {"keep-alive"},
			"x-store-scope":      {t.storeScope()},
			"sec-ch-ua-platform": {t.Requests.UserAgent.Platform},
			"sec-ch-ua":          {t.Requests.UserAgent.Sec_ua},
			"sec-ch-ua-mobile":   {"?0"},
			"x-store-locale":     {t.storeLocale()},
			"user-agent":         {t.Requests.UserAgent.Useragent},
			"accept":             {"application/json"},
			"accept-version":     {"1"},
			"content-type":       {"application/json"},
			"origin":             {"https://www.pokemoncenter.com"},
			"sec-fetch-site":     {"same-origin"},
			"sec-fetch-mode":     {"cors"},
			"sec-fetch-dest":     {"empty"},
			"referer":            {"https://www.pokemoncenter.com/checkout/address"},
			"accept-encoding":    {"gzip, deflate, br, zstd"},
			"accept-language":    {"en-US,en;q=0.9"},
			"header-order":       {"host", "connection", "content-length", "x-store-scope", "sec-ch-ua-platform", "sec-ch-ua", "sec-ch-ua-mobile", "x-store-locale", "user-agent", "accept", "accept-version", "content-type", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		t.handleProxyRequestError("submit-email", "proxy failed", err)
		return
	} else {
		log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
		t.Requests.Referer = Request.Req.URL
		switch response.StatusCode {
		case 200, 201:
			var responseBody EmailResponse
			if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
				log.Printf("Error parsing JSON response: %v", err)
				t.Error = err
				return
			}
			if strings.ToLower(responseBody.Email) != strings.ToLower(t.Profile.Email) {
				t.Error = fmt.Errorf("failed swap email")
				return
			}
		case 403:
			if strings.Contains(body, "captcha-delivery") {
				successful, challengeType, challengeUrl, hardBlocked := ParseDatadomeChallenge(body, t.DatadomeCid, "https://www.pokemoncenter.com/")
				if successful {
					t.DDHardBlocked = hardBlocked
					t.DatadomeUrl = challengeUrl
					t.Error = fmt.Errorf("datadome-%s", challengeType)
				} else {
					t.NextStep, t.Error = "submit-email", fmt.Errorf("error parsing datadome")
				}
			} else if strings.Contains(body, "This request was blocked by our security service") {
				t.NextStep, t.Error = "submit-email", fmt.Errorf("incap block")
			} else {
				t.Error = fmt.Errorf("submit email (403)")
			}
		default:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.NextStep, t.Error = "submit-email", fmt.Errorf("submit email (%d)", response.StatusCode)
		}
	}
}

func (t *PokemonCenterTask) SubmitShipping() {

	address := map[string]interface{}{
		"familyName":      t.Profile.ShippingLastName,
		"givenName":       t.Profile.ShippingFirstName,
		"countryName":     t.Profile.ShippingCountry,
		"extendedAddress": t.Profile.ShippingAddress2,
		"locality":        t.Profile.ShippingCity,
		"phoneNumber":     t.Profile.Phone,
		"postalCode":      t.Profile.ShippingZip,
		"region":          t.Profile.ShippingState,
		"streetAddress":   t.Profile.ShippingAddress1,
		"email":           t.Profile.Email,
		"uri":             "",
	}

	billing := map[string]interface{}{
		"familyName":      t.Profile.BillingLastName,
		"givenName":       t.Profile.BillingFirstName,
		"countryName":     t.Profile.BillingCountry,
		"extendedAddress": t.Profile.BillingAddress2,
		"locality":        t.Profile.BillingCity,
		"phoneNumber":     t.Profile.Phone,
		"postalCode":      t.Profile.BillingZip,
		"region":          t.Profile.BillingState,
		"streetAddress":   t.Profile.BillingAddress1,
		"email":           t.Profile.Email,
		"uri":             "",
	}

	data := map[string]interface{}{
		"billing":      billing,
		"shipping":     address,
		"lastCartItem": "default",
	}
	payloadBytes, _ := jsonStd.Marshal(data)

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    "https://www.pokemoncenter.com/tpci-ecommweb-api/address/add",
			Data:   string(payloadBytes),
		},
		Headers: map[string][]string{
			"host":               {"www.pokemoncenter.com"},
			"connection":         {"keep-alive"},
			"x-store-scope":      {t.storeScope()},
			"sec-ch-ua-platform": {t.Requests.UserAgent.Platform},
			"sec-ch-ua":          {t.Requests.UserAgent.Sec_ua},
			"sec-ch-ua-mobile":   {"?0"},
			"x-store-locale":     {t.storeLocale()},
			"user-agent":         {t.Requests.UserAgent.Useragent},
			"accept":             {"application/json"},
			"accept-version":     {"1"},
			"content-type":       {"application/json"},
			"origin":             {"https://www.pokemoncenter.com"},
			"sec-fetch-site":     {"same-origin"},
			"sec-fetch-mode":     {"cors"},
			"sec-fetch-dest":     {"empty"},
			"referer":            {"https://www.pokemoncenter.com/checkout/address"},
			"accept-encoding":    {"gzip, deflate, br, zstd"},
			"accept-language":    {"en-US,en;q=0.9"},
			"header-order":       {"host", "connection", "content-length", "x-store-scope", "sec-ch-ua-platform", "sec-ch-ua", "sec-ch-ua-mobile", "x-store-locale", "user-agent", "accept", "accept-version", "content-type", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		t.handleProxyRequestError("submit-shipping", "proxy failed", err)
		return
	} else {
		log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
		t.Requests.Referer = Request.Req.URL
		switch response.StatusCode {
		case 200, 201:
			var responseBody ShippingResponse
			if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
				log.Printf("Error parsing JSON response: %v", err)
				t.Error = err
				return
			}
			t.ShippingAddressUri = responseBody.Shipping.Self.Uri
		case 403:
			if strings.Contains(body, "captcha-delivery") {
				successful, challengeType, challengeUrl, hardBlocked := ParseDatadomeChallenge(body, t.DatadomeCid, "https://www.pokemoncenter.com/")
				if successful {
					t.DDHardBlocked = hardBlocked
					t.DatadomeUrl = challengeUrl
					t.Error = fmt.Errorf("datadome-%s", challengeType)
				} else {
					t.NextStep, t.Error = "submit-shipping", fmt.Errorf("error parsing datadome")
				}
			} else if strings.Contains(body, "This request was blocked by our security service") {
				t.NextStep, t.Error = "submit-shipping", fmt.Errorf("incap block")
			} else {
				t.Error = fmt.Errorf("submit shipping (403)")
			}
		default:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.NextStep, t.Error = "submit-shipping", fmt.Errorf("submit shipping (%d)", response.StatusCode)
		}
	}
}

func (t *PokemonCenterTask) GetPaymentKey() {
	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "GET",
			URL:    "https://www.pokemoncenter.com/tpci-ecommweb-api/get-payment-iframe-key?microform=true&locale=" + t.paymentLocale(),
		},
		Headers: map[string][]string{
			"host":               {"www.pokemoncenter.com"},
			"connection":         {"keep-alive"},
			"x-store-scope":      {t.storeScope()},
			"sec-ch-ua-platform": {t.Requests.UserAgent.Platform},
			"user-agent":         {t.Requests.UserAgent.Useragent},
			"sec-ch-ua":          {t.Requests.UserAgent.Sec_ua},
			"sec-ch-ua-mobile":   {"?0"},
			"x-store-locale":     {t.storeLocale()},
			"accept":             {"*/*"},
			"sec-fetch-site":     {"same-origin"},
			"sec-fetch-mode":     {"cors"},
			"sec-fetch-dest":     {"empty"},
			"referer":            {"https://www.pokemoncenter.com/checkout/address"},
			"accept-encoding":    {"gzip, deflate, br, zstd"},
			"accept-language":    {"en-US,en;q=0.9"},
			"header-order":       {"host", "connection", "x-store-scope", "sec-ch-ua-platform", "user-agent", "sec-ch-ua", "sec-ch-ua-mobile", "x-store-locale", "accept", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		t.handleProxyRequestError("get-payment-key", "Proxy Failed", err)
		return
	} else {
		log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
		t.Requests.Referer = Request.Req.URL
		switch response.StatusCode {
		case 200:
			if strings.Contains(strings.ToLower(body), `meta name="robots"`) {
				t.NextStep, t.Error = "get-payment-key", fmt.Errorf("incap block")
				return
			}
			var responseBody PaymentKeyResponse
			if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
				log.Printf("Error parsing JSON response: %v", err)
				t.Error = err
				return
			}
			t.PaymentKey = responseBody.KeyId
		case 403:
			if strings.Contains(body, "captcha-delivery") {
				successful, challengeType, challengeUrl, hardBlocked := ParseDatadomeChallenge(body, t.DatadomeCid, "https://www.pokemoncenter.com/")
				if successful {
					t.DDHardBlocked = hardBlocked
					t.DatadomeUrl = challengeUrl
					t.Error = fmt.Errorf("datadome-%s", challengeType)
				} else {
					t.NextStep, t.Error = "get-payment-key", fmt.Errorf("error parsing datadome")
				}
			} else if strings.Contains(body, "This request was blocked by our security service") {
				t.NextStep, t.Error = "get-payment-key", fmt.Errorf("incap block")
			} else {
				t.Error = fmt.Errorf("get payment key (403)")
			}
		default:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.NextStep, t.Error = "get-payment-key", fmt.Errorf("get payment key (%d)", response.StatusCode)
		}
	}
}

func (t *PokemonCenterTask) SubmitPayment() {

	paymentToken, err := tokenizeCyberSourceCard(t.TaskContext.CTX, t.Requests.Client, t.PaymentKey, cyberSourceCard{
		Number:          t.Profile.CardNumber,
		SecurityCode:    t.Profile.CardCvv,
		Type:            detectCardType(t.Profile.CardNumber),
		ExpirationMonth: t.Profile.CardExpiryMonth,
		ExpirationYear:  fmt.Sprintf("20%s", t.Profile.CardExpiryYear),
	})
	if err != nil {
		t.Error = fmt.Errorf("tokenize card error")
		return
	}
	t.PaymentToken = paymentToken

	data := map[string]interface{}{
		"billingAddress": map[string]interface{}{
			"countryName":     t.Profile.BillingCountry,
			"email":           t.Profile.Email,
			"extendedAddress": t.Profile.BillingAddress2,
			"familyName":      t.Profile.BillingLastName,
			"givenName":       t.Profile.BillingFirstName,
			"locality":        t.Profile.BillingCity,
			"phoneNumber":     t.Profile.Phone,
			"postalCode":      t.Profile.BillingZip,
			"region":          t.Profile.BillingState,
			"streetAddress":   t.Profile.BillingAddress1,
			"uri":             t.ShippingAddressUri,
		},
		"isPreorder":     false,
		"paymentDisplay": fmt.Sprintf("%s %s %s", cardTypeName(detectCardType(t.Profile.CardNumber)), t.Profile.CardName, t.Profile.CardExpiryMonth+"/"+t.Profile.CardExpiryYear),
		"paymentKey":     t.PaymentKey,
		"paymentToken":   t.PaymentToken,
	}
	payloadBytes, _ := jsonStd.Marshal(data)

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    "https://www.pokemoncenter.com/tpci-ecommweb-api/payment/add?microform=true",
			Data:   string(payloadBytes),
		},
		Headers: map[string][]string{
			"host":               {"www.pokemoncenter.com"},
			"connection":         {"keep-alive"},
			"x-store-scope":      {t.storeScope()},
			"sec-ch-ua-platform": {t.Requests.UserAgent.Platform},
			"sec-ch-ua":          {t.Requests.UserAgent.Sec_ua},
			"sec-ch-ua-mobile":   {"?0"},
			"x-store-locale":     {t.storeLocale()},
			"user-agent":         {t.Requests.UserAgent.Useragent},
			"accept":             {"application/json"},
			"accept-version":     {"1"},
			"content-type":       {"application/json"},
			"origin":             {"https://www.pokemoncenter.com"},
			"sec-fetch-site":     {"same-origin"},
			"sec-fetch-mode":     {"cors"},
			"sec-fetch-dest":     {"empty"},
			"referer":            {"https://www.pokemoncenter.com/checkout/payment"},
			"accept-encoding":    {"gzip, deflate, br, zstd"},
			"accept-language":    {"en-US,en;q=0.9"},
			"header-order":       {"host", "connection", "content-length", "x-store-scope", "sec-ch-ua-platform", "sec-ch-ua", "sec-ch-ua-mobile", "x-store-locale", "user-agent", "accept", "accept-version", "content-type", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		t.handleProxyRequestError("submit-payment", "proxy failed", err)
		return
	} else {
		log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
		t.Requests.Referer = Request.Req.URL
		switch response.StatusCode {
		case 200, 201:
			var responseBody PaymentInstrumentResponse
			if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
				log.Printf("Error parsing JSON response: %v", err)
				t.Error = err
				return
			}
			t.PurchaseFormUri = strings.Split(strings.Split(responseBody.Self.Uri, "/"+t.storeScope()+"/")[1], "/")[0]
		case 403:
			if strings.Contains(body, "captcha-delivery") {
				successful, challengeType, challengeUrl, hardBlocked := ParseDatadomeChallenge(body, t.DatadomeCid, "https://www.pokemoncenter.com/")
				if successful {
					t.DDHardBlocked = hardBlocked
					t.DatadomeUrl = challengeUrl
					t.Error = fmt.Errorf("datadome-%s", challengeType)
				} else {
					t.NextStep, t.Error = "submit-payment", fmt.Errorf("error parsing datadome")
				}
			} else if strings.Contains(body, "This request was blocked by our security service") {
				t.NextStep, t.Error = "submit-payment", fmt.Errorf("incap block")
			} else {
				t.Error = fmt.Errorf("submit payment (403)")
			}
		default:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.NextStep, t.Error = "submit-payment", fmt.Errorf("submit payment (%d)", response.StatusCode)
		}
	}
}

func (t *PokemonCenterTask) SubmitOrder() {

	tzOffset := 0
	if loc, err := time.LoadLocation(t.IpInfo.Timezone); err == nil {
		_, offset := time.Now().In(loc).Zone()
		tzOffset = -offset / 60
	}
	if t.MaxPrice > 0 && t.MaxPrice < float64(t.TotalPrice) {
		t.Error = fmt.Errorf("Cart Exceeds Max Price")
		t.NextStep = "stop"
		return
	}
	if t.MinPrice > 0 && t.MinPrice > float64(t.TotalPrice) {
		t.Error = fmt.Errorf("Cart Below Min Price")
		t.NextStep = "stop"
		return
	}

	data := map[string]interface{}{
		"purchaseForm":   t.purchasesOrdersForm(t.PurchaseFormUri),
		"timeZoneOffset": tzOffset,
	}
	payloadBytes, _ := jsonStd.Marshal(data)

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    "https://www.pokemoncenter.com/tpci-ecommweb-api/order/submit",
			Data:   string(payloadBytes),
		},
		Headers: map[string][]string{
			"host":               {"www.pokemoncenter.com"},
			"connection":         {"keep-alive"},
			"x-store-scope":      {t.storeScope()},
			"sec-ch-ua-platform": {t.Requests.UserAgent.Platform},
			"sec-ch-ua":          {t.Requests.UserAgent.Sec_ua},
			"sec-ch-ua-mobile":   {"?0"},
			"x-store-locale":     {t.storeLocale()},
			"user-agent":         {t.Requests.UserAgent.Useragent},
			"accept":             {"application/json"},
			"accept-version":     {"1"},
			"content-type":       {"application/json"},
			"origin":             {"https://www.pokemoncenter.com"},
			"sec-fetch-site":     {"same-origin"},
			"sec-fetch-mode":     {"cors"},
			"sec-fetch-dest":     {"empty"},
			"referer":            {"https://www.pokemoncenter.com/checkout/summary"},
			"accept-encoding":    {"gzip, deflate, br, zstd"},
			"accept-language":    {"en-US,en;q=0.9"},
			"header-order":       {"host", "connection", "content-length", "x-store-scope", "sec-ch-ua-platform", "sec-ch-ua", "sec-ch-ua-mobile", "x-store-locale", "user-agent", "accept", "accept-version", "content-type", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		t.handleProxyRequestError("submit-order", "proxy failed", err)
		return
	} else {
		log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
		t.Requests.Referer = Request.Req.URL
		switch response.StatusCode {
		case 200, 201:
			t.Checkout = true
			var responseBody OrderSuccess
			if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
				log.Printf("Error parsing JSON response: %v", err)
				t.Error = err
				return
			}
			t.OrderNumber = responseBody.PurchaseNumber
		case 409:
			var responseBody DeclineResponse
			if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
				log.Printf("Error parsing JSON response: %v", err)
				t.Error = err
				return
			}

			if len(responseBody.Messages) > 0 {
				if responseBody.Messages[0].Data.InternalMessage != "" {
					t.DeclineReason = t.DeclineReason + fmt.Sprintf("%s\n", responseBody.Messages[0].Data.InternalMessage)
				}

				if responseBody.Messages[0].Data.ExternalMessage != "" {
					t.DeclineReason = t.DeclineReason + fmt.Sprintf("%s", responseBody.Messages[0].Data.ExternalMessage)
				}
			}
			t.Decline = true
		case 403:
			if strings.Contains(body, "captcha-delivery") {
				successful, challengeType, challengeUrl, hardBlocked := ParseDatadomeChallenge(body, t.DatadomeCid, "https://www.pokemoncenter.com/")
				if successful {
					t.DDHardBlocked = hardBlocked
					t.DatadomeUrl = challengeUrl
					t.Error = fmt.Errorf("datadome-%s", challengeType)
				} else {
					t.NextStep, t.Error = "submit-order", fmt.Errorf("error parsing datadome")
				}
			} else if strings.Contains(body, "This request was blocked by our security service") {
				t.NextStep, t.Error = "submit-order", fmt.Errorf("incap block")
			} else {
				t.Error = fmt.Errorf("submit order (403)")
			}
		case 400:
			var responseBody SubmitOrderError
			if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
				log.Printf("Error parsing JSON response: %v", err)
				t.Error = err
				return
			}
			if len(responseBody.Messages) > 0 {
				if responseBody.Messages[0].ID == "cart.empty" {
					t.NextStep, t.Error = "submit-order", fmt.Errorf("cart empty")
				} else {
					t.NextStep, t.Error = "submit-order", fmt.Errorf("submit order (%d)", response.StatusCode)
				}
			}
		default:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.NextStep, t.Error = "submit-order", fmt.Errorf("submit order (%d)", response.StatusCode)
		}
	}
}

func (t *PokemonCenterTask) CheckQueue() {
	t.PassedQueue = false
	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "GET",
			URL:    "https://www.pokemoncenter.com/_Incapsula_Resource?SWWRGTS=868",
		},
		Headers: map[string][]string{
			"Host":               {"www.pokemoncenter.com"},
			"Connection":         {"keep-alive"},
			"sec-ch-ua-platform": {t.DatadomeHeaders.SecPlatform},
			"User-Agent":         {t.Requests.UserAgent.Useragent},
			"sec-ch-ua":          {t.Requests.UserAgent.Sec_ua},
			"sec-ch-ua-mobile":   {t.DatadomeHeaders.SecMobile},
			"Accept":             {"*/*"},
			"Sec-Fetch-Site":     {"same-Origin"},
			"Sec-Fetch-Mode":     {"no-cors"},
			"Sec-Fetch-Dest":     {"script"},
			"Referer":            {"https://www.pokemoncenter.com/"},
			"Accept-Encoding":    {"gzip, deflate, br, zstd"},
			"Accept-Language":    {"en-US,en;q=0.9"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		t.handleProxyError("Proxy Failed", err)
		return
	} else {
		log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
		t.Requests.Referer = Request.Req.URL
		switch response.StatusCode {
		case 200:
			var queueResponse QueueResponse
			if err := jsoniter.Unmarshal([]byte(body), &queueResponse); err != nil {
				log.Printf("Error parsing JSON response: %v", err)
				t.Error = err
				return
			}
			if queueResponse.Pending == 0 || queueResponse.Rld == 1 {
				t.PassedQueue = true
			} else {
				ttw := queueResponse.Ttw
				t.QueueTime = &ttw
			}
		case 404:
			if t.InQueue {
				t.PassedQueue = true
			}
		default:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.NextStep, t.Error = "handle-queue", fmt.Errorf("error queue (%d)", response.StatusCode)
		}
	}
}

func (t *PokemonCenterTask) GetDatadomeScript() {
	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "GET",
			URL:    t.DatadomeUrl,
		},
		Headers: map[string][]string{
			"host":                      {"geo.captcha-delivery.com"},
			"connection":                {"keep-alive"},
			"sec-ch-ua":                 {t.Requests.UserAgent.Sec_ua},
			"sec-ch-ua-mobile":          {"?0"},
			"sec-ch-ua-platform":        {t.Requests.UserAgent.Platform},
			"upgrade-insecure-requests": {"1"},
			"user-agent":                {t.Requests.UserAgent.Useragent},
			"accept":                    {"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"},
			"sec-fetch-site":            {"cross-site"},
			"sec-fetch-mode":            {"navigate"},
			"sec-fetch-user":            {"?1"},
			"sec-fetch-dest":            {"iframe"},
			"sec-fetch-storage-access":  {"active"},
			"accept-encoding":           {"gzip, deflate, br, zstd"},
			"accept-language":           {"en-US,en;q=0.9"},
			"header-order":              {"host", "connection", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "upgrade-insecure-requests", "user-agent", "accept", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-user", "sec-fetch-dest", "sec-fetch-storage-access", "accept-encoding", "accept-language"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		t.handleProxyError("proxy failed", err)
		return
	} else {
		log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
		t.Requests.Referer = Request.Req.URL
		switch response.StatusCode {
		case 200:
			if !strings.Contains(t.DatadomeUrl, "image") {
				t.DatadomeScript = body
				if strings.Contains(t.DatadomeUrl, "/captcha/") {
					found, captchaUrl := ParseCaptchaId(body)
					if found {
						t.DatadomeDeviceLink = t.DatadomeUrl
						t.DatadomeUrl = captchaUrl
					} else {
						t.Error = fmt.Errorf("IP Banned")
					}
				}
			} else {
				if !strings.Contains(t.DatadomeUrl, "frag") {
					t.DatadomePuzzle = base64.StdEncoding.EncodeToString([]byte(body))
					t.DatadomeUrl = strings.ReplaceAll(t.DatadomeUrl, ".jpg", ".frag.png")
				} else {
					t.DatadomePiece = base64.StdEncoding.EncodeToString([]byte(body))
				}
			}
		default:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.Error = fmt.Errorf("get datadome (%d)", response.StatusCode)
		}
	}
}

func (t *PokemonCenterTask) GetInterstitialSensor() {
	data := map[string]interface{}{
		"userAgent":      t.Requests.UserAgent.Useragent,
		"deviceLink":     t.DatadomeUrl,
		"html":           t.DatadomeScript,
		"ip":             t.IpInfo.Ip,
		"acceptLanguage": "en-US,en;q=0.9",
	}
	status, body, err := t.requestHyper("datadome-interstitial", data)
	if err != nil {
		t.setHyperError("solve-datadome-ch", err)
		return
	} else {
		switch status {
		case 200:
			var responseBody DatadomeInterstitialSolveHyperResponse
			if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
				log.Printf("Error parsing JSON response: %v", err)
				t.Error = err
				return
			}
			t.DatadomePayload = responseBody.Payload
			t.DatadomeHeaders = responseBody.Headers
		default:
			t.recordUnknownHyper("datadome-interstitial", status, body)
			t.NextStep, t.Error = "solve-datadome-ch", fmt.Errorf("get datadome (%d)", status)
		}
	}
}

func (t *PokemonCenterTask) PostInterstitial() {
	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    "https://geo.captcha-delivery.com/interstitial/",
			Data:   t.DatadomePayload,
		},
		Headers: map[string][]string{
			"host":                     {"geo.captcha-delivery.com"},
			"connection":               {"keep-alive"},
			"sec-ch-ua-platform":       {t.Requests.UserAgent.Platform},
			"user-agent":               {t.Requests.UserAgent.Useragent},
			"sec-ch-ua":                {t.Requests.UserAgent.Sec_ua},
			"content-type":             {"application/x-www-form-urlencoded; charset=UTF-8"},
			"sec-ch-ua-mobile":         {"?0"},
			"accept":                   {"*/*"},
			"origin":                   {"https://geo.captcha-delivery.com"},
			"sec-fetch-site":           {"same-origin"},
			"sec-fetch-mode":           {"cors"},
			"sec-fetch-dest":           {"empty"},
			"sec-fetch-storage-access": {"active"},
			"referer":                  {"https://geo.captcha-delivery.com/interstitial/?initialCid=AHrlqAAAAAMAgp7s8IaT2j4AGBYq0Q==&cid=1RE1mVnQOscwV0gUuNjGZqhSOXOiE0O38j7AnD~QXoZ17z1zl0eJ1J2PtHhMOrLRCHFDHdDL32tXoKKwKIPtt9h~8BYZAZfbVhSWUC_a593J7jf2_zkSJGoXtqUeeaxw&referer=http%3A%2F%2Fwww.pokemoncenter.com%2Ftpci-ecommweb-api%2Fproduct%2F73-10182-101&hash=5B45875B653A484CC79E57036CE9FC&t=it&s=9817&e=5d8d5694aab5fdd2a20f5a83f777ebbbbede194e9308bef4d172d4b31c34fe20b6b804a8ae3b07c299a23cc0135c9485&b=1374360&dm=jd"},
			"accept-encoding":          {"gzip, deflate, br, zstd"},
			"accept-language":          {"en-US,en;q=0.9"},
			"header-order":             {"host", "connection", "sec-ch-ua-platform", "user-agent", "sec-ch-ua", "content-type", "sec-ch-ua-mobile", "accept", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "sec-fetch-storage-access", "referer", "accept-encoding", "accept-language"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		t.handleProxyRequestError("post-interstitial", "proxy failed", err)
		return
	} else {
		log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
		t.Requests.Referer = Request.Req.URL
		switch response.StatusCode {
		case 200:
			var responseBody DatadomeInterstitialResponse
			if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
				log.Printf("Error parsing JSON response: %v", err)
				t.Error = err
				return
			}
			t.DatadomeCid = strings.Split(strings.Split(responseBody.Cookie, "datadome=")[1], ";")[0]
			t.DatadomeUrl = responseBody.Url
			if responseBody.View != "redirect" {
				t.Error = fmt.Errorf("datadome-captcha")
			} else {
				t.Requests.AddCookie("datadome", t.DatadomeCid, "www.pokemoncenter.com")
			}
		default:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.NextStep, t.Error = "get-interstitial", fmt.Errorf("post datadome (%d)", response.StatusCode)
		}
	}
}

func (t *PokemonCenterTask) GetSliderSensor() {
	data := map[string]interface{}{
		"userAgent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		"deviceLink":     t.DatadomeDeviceLink,
		"parentUrl":      "https://www.pokemoncenter.com/",
		"html":           t.DatadomeScript,
		"puzzle":         t.DatadomePuzzle,
		"piece":          t.DatadomePiece,
		"ip":             t.IpInfo.Ip,
		"acceptLanguage": "en-US,en;q=0.9",
	}
	status, body, err := t.requestHyper("datadome-slider", data)
	if err != nil {
		t.setHyperError("solve-datadome-ch", err)
		return
	} else {
		switch status {
		case 200:
			var responseBody DatadomeInterstitialSolveHyperResponse
			if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
				log.Printf("Error parsing JSON response: %v", err)
				t.Error = err
				return
			}
			t.DatadomePayload = responseBody.Payload
			t.DatadomeHeaders = responseBody.Headers
		default:
			t.recordUnknownHyper("datadome-slider", status, body)
			t.NextStep, t.Error = "solve-datadome-ch", fmt.Errorf("get datadome (%d)", status)
		}
	}
}

func (t *PokemonCenterTask) GetSlider() {
	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "GET",
			URL:    t.DatadomePayload,
		},
		Headers: map[string][]string{
			"Host":               {"geo.captcha-delivery.com"},
			"Connection":         {"keep-alive"},
			"sec-ch-ua-platform": {t.DatadomeHeaders.SecPlatform},
			"User-Agent":         {t.Requests.UserAgent.Useragent},
			"sec-ch-ua":          {t.Requests.UserAgent.Sec_ua},
			"Content-Type":       {"application/x-www-form-urlencoded; charset=UTF-8"},
			"sec-ch-ua-mobile":   {t.DatadomeHeaders.SecMobile},
			"Accept":             {"*/*"},
			"Origin":             {"https://geo.captcha-delivery.com"},
			"Sec-Fetch-Site":     {"same-Origin"},
			"Sec-Fetch-Mode":     {"cors"},
			"Sec-Fetch-Dest":     {"empty"},
			"Referer":            {t.DatadomeUrl},
			"Accept-Encoding":    {"gzip, deflate, br, zstd"},
			"Accept-Language":    {"en-US,en;q=0.9"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		t.handleProxyRequestError("get-slider", "proxy failed", err)
		return
	} else {
		log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
		t.Requests.Referer = Request.Req.URL
		switch response.StatusCode {
		case 200:
			var responseBody DatadomeSliderResponse
			if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
				log.Printf("Error parsing JSON response: %v", err)
				t.Error = err
				return
			}
			t.DatadomeCid = responseBody.Cookie
			t.Requests.AddCookie("datadome", responseBody.Cookie, "www.pokemoncenter.com")
		default:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.NextStep, t.Error = "get-slider", fmt.Errorf("post datadome (%d)", response.StatusCode)
		}
	}
}

func (t *PokemonCenterTask) GetIncapChallenge() {
	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "GET",
			URL:    fmt.Sprintf("https://www.pokemoncenter.com%s", t.IncapIncidentUrl),
		},
		Headers: map[string][]string{
			"Host":               {"www.pokemoncenter.com"},
			"Connection":         {"keep-alive"},
			"sec-ch-ua-platform": {t.DatadomeHeaders.SecPlatform},
			"User-Agent":         {t.Requests.UserAgent.Useragent},
			"sec-ch-ua":          {t.Requests.UserAgent.Sec_ua},
			"sec-ch-ua-mobile":   {t.DatadomeHeaders.SecMobile},
			"Accept":             {"*/*"},
			"Sec-Fetch-Site":     {"same-Origin"},
			"Sec-Fetch-Mode":     {"no-cors"},
			"Sec-Fetch-Dest":     {"script"},
			"Referer":            {"https://www.pokemoncenter.com/"},
			"Accept-Encoding":    {"gzip, deflate, br, zstd"},
			"Accept-Language":    {"en-US,en;q=0.9"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		t.handleProxyRequestError("get-incap-challenge", "Proxy Failed", err)
		return
	} else {
		log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
		t.Requests.Referer = Request.Req.URL
		switch response.StatusCode {
		case 200:
			successful, challengeType, sitekey, hcapPostUrl := ParseIncapChallenge(body)
			if successful {
				t.ChallengeType = challengeType
				if challengeType == "captcha" {
					t.HcapSiteKey = sitekey
					t.HcapPostUrl = hcapPostUrl
				}
				if challengeType == "utmvc" {
					t.IncapScript = body
				}
			} else {
				t.Error = fmt.Errorf("error parsing incap")
			}
		default:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.NextStep, t.Error = "get-incap-challenge", fmt.Errorf("error incap (%d)", response.StatusCode)
		}
	}
}

func (t *PokemonCenterTask) GetUTMVCSensor() {
	targetURL, _ := url.Parse("https://www.pokemoncenter.com")
	var sessionIds []string
	for _, c := range t.Requests.Client.GetCookieJar().Cookies(targetURL) {
		if strings.HasPrefix(c.Name, "incap_ses_") {
			sessionIds = append(sessionIds, c.Value)
		}
	}

	data := map[string]interface{}{
		"script":     t.IncapScript,
		"sessionIds": sessionIds,
		"userAgent":  t.Requests.UserAgent.Useragent,
	}
	status, body, err := t.requestHyper("incapsula-utmvc", data)
	if err != nil {
		t.setHyperError("solve-utmvc", err)
		return
	} else {
		switch status {
		case 200:
			var responseBody UtmvcHyperResponse
			if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
				log.Printf("Error parsing JSON response: %v", err)
				t.Error = err
				return
			}
			t.IncapPayload = responseBody.Payload
			t.UtmvcParams = responseBody.Swhanedl
		default:
			t.recordUnknownHyper("incapsula-utmvc", status, body)
			t.NextStep, t.Error = "solve-utmvc", fmt.Errorf("error incap (%d)", status)
		}
	}
}

func (t *PokemonCenterTask) GetUTMVC() {
	// get url with the param and set Cookie ___utmvc and check the response Cookie
	t.Requests.AddCookie("___utmvc", t.IncapPayload, "www.pokemoncenter.com")
	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "GET",
			URL:    fmt.Sprintf("https://www.pokemoncenter.com/_Incapsula_Resource?SWHANEDL=%s", t.UtmvcParams),
		},
		Headers: map[string][]string{
			"Host":               {"www.pokemoncenter.com"},
			"Connection":         {"keep-alive"},
			"sec-ch-ua-platform": {t.DatadomeHeaders.SecPlatform},
			"User-Agent":         {t.Requests.UserAgent.Useragent},
			"sec-ch-ua":          {t.Requests.UserAgent.Sec_ua},
			"sec-ch-ua-mobile":   {t.DatadomeHeaders.SecMobile},
			"Accept":             {"*/*"},
			"Sec-Fetch-Site":     {"same-Origin"},
			"Sec-Fetch-Mode":     {"no-cors"},
			"Sec-Fetch-Dest":     {"script"},
			"Referer":            {"https://www.pokemoncenter.com/"},
			"Accept-Encoding":    {"gzip, deflate, br, zstd"},
			"Accept-Language":    {"en-US,en;q=0.9"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		t.handleProxyRequestError("get-utmvc", "Proxy Failed", err)
		return
	} else {
		log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
		t.Requests.Referer = Request.Req.URL
		switch response.StatusCode {
		case 200:
			utmvcURL, _ := url.Parse("https://www.pokemoncenter.com")
			var utmvcValid bool
			for _, c := range t.Requests.Client.GetCookieJar().Cookies(utmvcURL) {
				if c.Name == "___utmvc" && c.Value == "a" && c.MaxAge == 0 {
					utmvcValid = true
					break
				}
			}
			if !utmvcValid {
				t.NextStep, t.Error = "get-utmvc", fmt.Errorf("utmvc Cookie check failed")
			}
		default:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.NextStep, t.Error = "get-utmvc", fmt.Errorf("error incap (%d)", response.StatusCode)
		}
	}
}

func (t *PokemonCenterTask) PostIncapCaptcha() {
	payload := "g-recaptcha-response=" + url.QueryEscape(t.HcapToken)

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    fmt.Sprintf("https://www.pokemoncenter.com%s", t.HcapPostUrl),
			Data:   payload,
		},
		Headers: map[string][]string{
			"Host":               {"www.pokemoncenter.com"},
			"Connection":         {"keep-alive"},
			"Content-Length":     {"Not-Really-Used-For-HeaderOrder"},
			"sec-ch-ua-platform": {t.DatadomeHeaders.SecPlatform},
			"User-Agent":         {t.Requests.UserAgent.Useragent},
			"sec-ch-ua":          {t.Requests.UserAgent.Sec_ua},
			"sec-ch-ua-mobile":   {t.DatadomeHeaders.SecMobile},
			"Content-Type":       {"application/x-www-form-urlencoded"},
			"Accept":             {"*/*"},
			"Origin":             {"https://www.pokemoncenter.com"},
			"Sec-Fetch-Site":     {"same-Origin"},
			"Sec-Fetch-Mode":     {"cors"},
			"Sec-Fetch-Dest":     {"empty"},
			"Referer":            {t.HcapPostUrl},
			"Accept-Encoding":    {"gzip, deflate, br, zstd"},
			"Accept-Language":    {"en-US,en;q=0.9"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		if !t.BaseTask.MaybeRotateProxy("PokemonCenter", err) {
			t.NextStep, t.Error = "post-incap-captcha", fmt.Errorf("failed to respond")
		} else {
			t.HcapToken = ""
			t.PassedQueue = false
			t.InQueue = false
			t.QueueTime = nil
			t.NextStep, t.Error = "get-homepage", fmt.Errorf("incap captcha post failed")
		}
		return
	}
	log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
	t.Requests.Referer = Request.Req.URL
	switch response.StatusCode {
	case 200:
		// success — caller advances to LastStep
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.NextStep, t.Error = "restart", fmt.Errorf("incap captcha (%d)", response.StatusCode)
	}
}

func (t *PokemonCenterTask) CheckStatus() {
	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "GET",
			URL:    "https://polar-wss-production.up.railway.app/sites/PokemonCenter/queue-status",
		},
		Headers: map[string][]string{},
	}
	response, body, err := client.MakeRequest(Request, t.Requests.ServerClient, &t.ClientID)
	if err != nil {
		return
	}

	switch response.StatusCode {
	case 200:
		var responseBody *CheckStatusResponse
		if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
			log.Printf("Error parsing JSON response: %v", err)
			t.Error = err
			return
		}
		t.FoundQueue = responseBody.QueueUp
		t.Unlocked = responseBody.Unlocked
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.Error = fmt.Errorf("failed get status (%s)", response.Status)
	}
}
