package target

import (
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/PolarAIO/Polar-AIO/backend/bot-base/datadog"
	"github.com/PolarAIO/Polar-AIO/backend/bot-base/safego"
	"github.com/PolarAIO/Polar-AIO/backend/bot-base/task/constants"
	"github.com/PolarAIO/Polar-AIO/backend/client"
	"github.com/gorilla/websocket"
	jsoniter "github.com/json-iterator/go"
)

func (t *TargetTask) GetSession() {
	if t.Account.Cookie != "" {
		cookies := strings.Split(t.Account.Cookie, "; ")

		for i := range cookies {
			parts := strings.SplitN(cookies[i], "=", 2)
			key := parts[0]
			value := ""
			if len(parts) > 1 {
				value = parts[1]
			}
			t.Requests.AddCookie(key, value, "www.target.com")
		}
	}

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "GET",
			URL:    "https://www.target.com/",
		},
		Headers: map[string][]string{
			"upgrade-insecure-requests": {"1"},
			"user-agent":                {t.Requests.UserAgent.Useragent},
			"accept":                    {"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"},
			"sec-fetch-site":            {"none"},
			"sec-fetch-mode":            {"navigate"},
			"sec-fetch-user":            {"?1"},
			"sec-fetch-dest":            {"document"},
			"sec-ch-ua":                 {t.Requests.UserAgent.Sec_ua},
			"sec-ch-ua-mobile":          {"?0"},
			"sec-ch-ua-platform":        {t.Requests.UserAgent.Platform},
			"accept-encoding":           {"gzip, deflate, br, zstd"},
			"accept-language":           {"en-US,en;q=0.9"},
			"priority":                  {"u=0, i"},
			"header-order":              {"upgrade-insecure-requests", "user-agent", "accept", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-user", "sec-fetch-dest", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "accept-encoding", "accept-language", "priority"},
		},
	}
	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("Request error: %v", err)
		t.NextStep, t.Error = "get-session", fmt.Errorf("Proxy Failed")
		t.BaseTask.MaybeRotateProxy("Target", err)
		return
	} else {
		log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
		switch response.StatusCode {
		case 200:
		case 429:
			t.NextStep = "get-session"
			if strings.Contains(body, "DCO_RATE_LIMITED") {
				t.Error = fmt.Errorf("DCO_RATE_LIMITED")
			} else {
				t.Error = fmt.Errorf("error get-session (%d)", response.StatusCode)
			}
		default:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.NextStep, t.Error = "get-session", fmt.Errorf("error get-session (%d)", response.StatusCode)
		}
	}
}

func (t *TargetTask) GetShape(CookieType string) {
	if brokerURL := hopeShapeBrokerURL(); brokerURL != "" {
		responseBody, err := fetchHopeShape(t.TaskContext.CTX, brokerURL, os.Getenv("HOPE_SHAPE_TOKEN"), CookieType, nil)
		if err != nil {
			log.Printf("[GetShape] Hope broker error: %v", err)
			return
		}
		t.applyShapeResponse(responseBody)
		return
	}

	dialer := websocket.Dialer{HandshakeTimeout: 5 * time.Second}
	shapeURL := strings.TrimSpace(os.Getenv("POLAR_TARGET_SHAPE_URL"))
	if shapeURL == "" {
		shapeURL = "ws://127.0.0.1:4312/ws"
	}
	conn, _, err := dialer.Dial(shapeURL, nil)
	if err != nil {
		log.Printf("[GetShape] WS dial error: %v", err)
		return
	}
	defer conn.Close()

	if t.TaskContext.CTX != nil {
		stop := make(chan struct{})
		defer close(stop)
		go func() {
			select {
			case <-t.TaskContext.CTX.Done():
				cancelReq, cancelErr := json.Marshal(map[string]any{"action": "cancel"})
				if cancelErr == nil {
					_ = conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
					_ = conn.WriteMessage(websocket.TextMessage, cancelReq)
				}
				_ = conn.Close()
			case <-stop:
			}
		}()
	}

	req, err := json.Marshal(map[string]any{
		"action":  "get",
		"type":    CookieType,
		"timeout": 30000,
	})
	if err != nil {
		log.Printf("[GetShape] marshal error: %v", err)
		return
	}

	_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := conn.WriteMessage(websocket.TextMessage, req); err != nil {
		log.Printf("[GetShape] WS write error: %v", err)
		return
	}

	_ = conn.SetReadDeadline(time.Now().Add(35 * time.Second))
	_, body, err := conn.ReadMessage()
	if err != nil {
		log.Printf("[GetShape] WS read error: %v", err)
		return
	}

	var responseBody ShapeAPIResponse
	if err := jsoniter.Unmarshal(body, &responseBody); err != nil {
		log.Printf("Error parsing JSON response: %v", err)
		t.Error = err
		return
	}

	t.applyShapeResponse(responseBody)
}

func (t *TargetTask) GetLoginSession() {
	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "GET",
			URL:    "https://gsp.target.com/gsp/authentications/v1/auth_codes?client_id=ecom-web-1.0.0&redirect_uri=https%3A%2F%2Fwww.target.com%2F&acr=create_session_request_username&state=1776735094581&assurance_level=M&trident=true&signin_amr=true",
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
			"referer":                   {"https://www.target.com/"},
			"accept-encoding":           {"gzip, deflate, br, zstd"},
			"accept-language":           {"en-US,en;q=0.9"},
			"priority":                  {"u=0, i"},
			"header-order":              {"sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "upgrade-insecure-requests", "user-agent", "accept", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-user", "sec-fetch-dest", "referer", "accept-encoding", "accept-language", "cookie", "priority"},
		},
	}
	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("Request error: %v", err)
		t.NextStep, t.Error = "get-login-session", fmt.Errorf("Proxy Failed")
		t.BaseTask.MaybeRotateProxy("Target", err)
		return
	} else {
		log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
		switch response.StatusCode {
		case 200:
		case 302:
		case 429:
			t.NextStep = "get-login-session"
			if strings.Contains(body, "DCO_RATE_LIMITED") {
				t.Error = fmt.Errorf("DCO_RATE_LIMITED")
			} else {
				t.Error = fmt.Errorf("error get-login-session (%d)", response.StatusCode)
			}
		case 403:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.Error = fmt.Errorf("proxy block")
		default:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.NextStep, t.Error = "get-login-session", fmt.Errorf("error get-login-session (%d)", response.StatusCode)
		}
	}
}

func (t *TargetTask) GetAuthCodes() {
	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "GET",
			URL:    "https://gsp.target.com/gsp/authentications/v1/auth_codes?client_id=ecom-web-1.0.0",
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
			"referer":                   {"https://www.target.com/"},
			"accept-encoding":           {"gzip, deflate, br, zstd"},
			"accept-language":           {"en-US,en;q=0.9"},
			"priority":                  {"u=0, i"},
			"header-order":              {"sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "upgrade-insecure-requests", "user-agent", "accept", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-user", "sec-fetch-dest", "referer", "accept-encoding", "accept-language", "cookie", "priority"},
		},
	}
	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("Request error: %v", err)
		t.NextStep, t.Error = "get-auth-codes", fmt.Errorf("Proxy Failed")
		t.BaseTask.MaybeRotateProxy("Target", err)
		return
	} else {
		log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
		switch response.StatusCode {
		case 302:
			location := response.Header.Get("Location")
			if strings.Contains(location, "&status=success") {
				t.RedirectLocation = location
				t.Requests.AddCookie("mystate", strings.Split(strings.Split(t.RedirectLocation, "&state=")[1], "&")[0], "www.target.com")
			} else {
				t.Error = fmt.Errorf("locked_account")
			}
		case 429:
			t.NextStep = "get-auth-codes"
			if strings.Contains(body, "DCO_RATE_LIMITED") {
				t.Error = fmt.Errorf("DCO_RATE_LIMITED")
			} else {
				t.Error = fmt.Errorf("error get-auth-codes (%d)", response.StatusCode)
			}
		default:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.NextStep, t.Error = "get-auth-codes", fmt.Errorf("error get-auth-codes (%d)", response.StatusCode)
		}
	}
}

func (t *TargetTask) GetAuthRedirect() {
	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "GET",
			URL:    t.RedirectLocation,
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
		log.Printf("Request error: %v", err)
		t.NextStep, t.Error = "get-auth-redirect", fmt.Errorf("Proxy Failed")
		t.BaseTask.MaybeRotateProxy("Target", err)
		return
	} else {
		log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
		switch response.StatusCode {
		case 302:
			t.SessionRefreshAttempts = 0
			targetURL, _ := url.Parse("https://www.target.com")
			var jar strings.Builder
			for _, c := range t.Requests.Client.GetCookieJar().Cookies(targetURL) {
				if c.Name == "accessToken" ||
					c.Name == "idToken" ||
					c.Name == "login-session" ||
					c.Name == "refreshToken" ||
					c.Name == "visitorId" ||
					c.Name == "TealeafAkaSid" {

					if jar.Len() > 0 {
						jar.WriteString("; ")
					}
					jar.WriteString(c.Name)
					jar.WriteByte('=')
					jar.WriteString(c.Value)
				}
			}
			safego.Go(func() { t.UpdateCookie(jar.String(), t.Account.Id) })
		case 429:
			t.NextStep = "get-auth-redirect"
			if strings.Contains(body, "DCO_RATE_LIMITED") {
				t.Error = fmt.Errorf("DCO_RATE_LIMITED")
			} else {
				t.Error = fmt.Errorf("error get-auth-redirect (%d)", response.StatusCode)
			}
		default:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.NextStep, t.Error = "get-auth-redirect", fmt.Errorf("error get-auth-redirect (%d)", response.StatusCode)
		}
	}
}

func (t *TargetTask) LoginOTP() {
	if !t.shapeOK() {
		t.Error = fmt.Errorf("missing shape headers")
		return
	}
	h := t.ShapeHeaders
	data := loginOtpCredentialPayload{
		DeviceInfo: loginDeviceInfo{
			UserAgent:               h.UserAgent,
			Language:                "en-US",
			Canvas:                  "f418b62b527756dce2ba14edd74195ce",
			ColorDepth:              "30",
			DeviceMemory:            "16",
			PixelRatio:              "unknown",
			HardwareConcurrency:     "10",
			Resolution:              "[1710,1107]",
			AvailableResolution:     "[1710,998]",
			TimezoneOffset:          "420",
			SessionStorage:          "1",
			LocalStorage:            "1",
			IndexedDB:               "1",
			AddBehavior:             "unknown",
			OpenDatabase:            "unknown",
			CPUClass:                "unknown",
			NavigatorPlatform:       "MacIntel",
			DoNotTrack:              "unknown",
			RegularPlugins:          "[\"PDF Viewer::Portable Document Format::application/pdf~pdf,text/pdf~pdf\",\"Chrome PDF Viewer::Portable Document Format::application/pdf~pdf,text/pdf~pdf\",\"Chromium PDF Viewer::Portable Document Format::application/pdf~pdf,text/pdf~pdf\",\"Microsoft Edge PDF Viewer::Portable Document Format::application/pdf~pdf,text/pdf~pdf\",\"WebKit built-in PDF::Portable Document Format::application/pdf~pdf,text/pdf~pdf\"]",
			Adblock:                 "false",
			HasLiedLanguages:        "false",
			HasLiedResolution:       "false",
			HasLiedOS:               "false",
			HasLiedBrowser:          "false",
			TouchSupport:            "[0,false,false]",
			JSFonts:                 "[\"Andale Mono\",\"Arial\",\"Arial Black\",\"Arial Hebrew\",\"Arial Narrow\",\"Arial Rounded MT Bold\",\"Arial Unicode MS\",\"Comic Sans MS\",\"Courier\",\"Courier New\",\"Geneva\",\"Georgia\",\"Helvetica\",\"Helvetica Neue\",\"Impact\",\"LUCIDA GRANDE\",\"Microsoft Sans Serif\",\"Monaco\",\"Palatino\",\"Tahoma\",\"Times\",\"Times New Roman\",\"Trebuchet MS\",\"Verdana\",\"Wingdings\",\"Wingdings 2\",\"Wingdings 3\"]",
			NavigatorVendor:         "Google Inc.",
			NavigatorWebdriver:      "false",
			NavigatorAppName:        "Netscape",
			NavigatorAppCodeName:    "Mozilla",
			NavigatorAppVersion:     navigatorAppVersionFromUA(h.UserAgent),
			NavigatorLanguages:      "[\"en-US\",\"en\"]",
			NavigatorCookiesEnabled: "true",
			NavigatorJavaEnabled:    "false",
			VisitorID:               CreateVisitorId(),
			TealeafID:               "MIzsZeZVW99J8gZ45fY-c-Lcrfqb-mA6",
			Webgl:                   "unknown",
			WebglVendor:             "unknown",
			BrowserName:             "Unknown",
			BrowserVersion:          "Unknown",
			CPUArchitecture:         "Unknown",
			DeviceVendor:            "Unknown",
			DeviceModel:             "Unknown",
			DeviceType:              "Unknown",
			EngineName:              "Unknown",
			EngineVersion:           "Unknown",
			OSName:                  "Unknown",
			OSVersion:               "Unknown",
		},
		EmailId:        t.Account.Username,
		Flow:           "otp_signin",
		KeepMeSignedIn: true,
	}

	payloadBytes, err := json.Marshal(data)
	if err != nil {
		t.NextStep, t.Error = "login", fmt.Errorf("marshal login body: %w", err)
		return
	}

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    "https://gsp.target.com/gsp/authentications/v1/secure_codes_unidentified",
			Data:   string(payloadBytes),
		},
		Headers: map[string][]string{
			"sec-ch-ua-platform":           {h.SecChUAPlatform},
			"x-gyjwza5z-z":                 {h.XGyjwza5zZ},
			"sec-ch-ua":                    {h.SecChUA},
			"x-application-mouse-tool-key": {"cnviSRUCGOlanm_whtf8vJLJefPoIKi_RVUQTN7bKn5Ap0gxhQ5thjBQTUPnMVwl0FG2_i4tGmFQd-FL1DWo9iZaslBcV8Qjcv2Mqiy4Km7dO1pe24iWnnr0KvPMENPH"},
			"x-gyjwza5z-f":                 {h.XGyjwza5zF},
			"sec-ch-ua-mobile":             {"?0"},
			"x-gyjwza5z-a0":                {h.XGyjwza5zA0},
			"x-gyjwza5z-b":                 {h.XGyjwza5zB},
			"x-gyjwza5z-a":                 {h.XGyjwza5zA},
			"user-agent":                   {h.UserAgent},
			"accept":                       {"application/json"},
			"x-gyjwza5z-c":                 {h.XGyjwza5zC},
			"content-type":                 {"application/json"},
			"x-gyjwza5z-d":                 {h.XGyjwza5zD},
			"origin":                       {"https://www.target.com"},
			"sec-fetch-site":               {"same-site"},
			"sec-fetch-mode":               {"cors"},
			"sec-fetch-dest":               {"empty"},
			"referer":                      {"https://www.target.com/login?client_id=ecom-web-1.0.0&ui_namespace=ui-default&back_button_action=browser&keep_me_signed_in=true&kmsi_default=false&actions=create_session_request_username&signin_amr=true"},
			"accept-encoding":              {"gzip, deflate, br, zstd"},
			"accept-language":              {"en-US,en;q=0.9"},
			"priority":                     {"u=1, i"},
			"header-order":                 {"content-length", "sec-ch-ua-platform", "x-gyjwza5z-z", "sec-ch-ua", "x-application-mouse-tool-key", "x-gyjwza5z-f", "sec-ch-ua-mobile", "x-gyjwza5z-a0", "x-gyjwza5z-b", "x-gyjwza5z-a", "user-agent", "accept", "x-gyjwza5z-c", "content-type", "x-gyjwza5z-d", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language", "cookie", "priority"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[Login] Request error: %v", err)
		t.NextStep, t.Error = "login", fmt.Errorf("Proxy Failed")
		t.BaseTask.MaybeRotateProxy("Target", err)
		return
	}
	t.ShapeHeaders = ShapeHeaders{}
	t.ShapeMethod = ""
	log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
	t.Requests.Referer = Request.Req.URL
	switch response.StatusCode {
	case 200, 202:
	case 429:
		t.NextStep = "login"
		if strings.Contains(body, "DCO_RATE_LIMITED") {
			t.Error = fmt.Errorf("DCO_RATE_LIMITED")
		} else {
			t.Error = fmt.Errorf("error login (%d)", response.StatusCode)
		}
	case 401:
		if strings.Contains(body, "refresh your browser and try again") {
			t.Error = fmt.Errorf("Shape Block (Login)")
			return
		}
		var responseBody TargetErrorResponse
		if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
			log.Printf("Error parsing JSON response: %v", err)
			t.Error = err
			return
		}
		if len(responseBody.Errors) > 0 {
			t.Error = fmt.Errorf("%s", responseBody.Errors[0].ErrorMessage2)
			return
		}
		t.Error = fmt.Errorf("login failed (401)")
	case 400:
		var responseBody TargetErrorResponse
		if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
			log.Printf("Error parsing JSON response: %v", err)
			t.Error = err
			return
		}
		if len(responseBody.Errors) > 0 {
			t.Error = fmt.Errorf("%s", responseBody.Errors[0].ErrorMessage2)
			return
		}
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.NextStep, t.Error = "login", fmt.Errorf("error (otp) login (%d)", response.StatusCode)
	}
}

func (t *TargetTask) Login() {
	fmt.Println(t.Account.Password)
	if !t.shapeOK() {
		t.Error = fmt.Errorf("missing shape headers")
		return
	}
	h := t.ShapeHeaders
	data := loginCredentialPayload{
		Username:       t.Account.Username,
		Password:       t.Account.Password,
		KeepMeSignedIn: true,
		DeviceInfo: loginDeviceInfo{
			UserAgent:               h.UserAgent,
			Language:                "en-US",
			Canvas:                  "f418b62b527756dce2ba14edd74195ce",
			ColorDepth:              "30",
			DeviceMemory:            "16",
			PixelRatio:              "unknown",
			HardwareConcurrency:     "10",
			Resolution:              "[1710,1107]",
			AvailableResolution:     "[1710,998]",
			TimezoneOffset:          "420",
			SessionStorage:          "1",
			LocalStorage:            "1",
			IndexedDB:               "1",
			AddBehavior:             "unknown",
			OpenDatabase:            "unknown",
			CPUClass:                "unknown",
			NavigatorPlatform:       "MacIntel",
			DoNotTrack:              "unknown",
			RegularPlugins:          "[\"PDF Viewer::Portable Document Format::application/pdf~pdf,text/pdf~pdf\",\"Chrome PDF Viewer::Portable Document Format::application/pdf~pdf,text/pdf~pdf\",\"Chromium PDF Viewer::Portable Document Format::application/pdf~pdf,text/pdf~pdf\",\"Microsoft Edge PDF Viewer::Portable Document Format::application/pdf~pdf,text/pdf~pdf\",\"WebKit built-in PDF::Portable Document Format::application/pdf~pdf,text/pdf~pdf\"]",
			Adblock:                 "false",
			HasLiedLanguages:        "false",
			HasLiedResolution:       "false",
			HasLiedOS:               "false",
			HasLiedBrowser:          "false",
			TouchSupport:            "[0,false,false]",
			JSFonts:                 "[\"Andale Mono\",\"Arial\",\"Arial Black\",\"Arial Hebrew\",\"Arial Narrow\",\"Arial Rounded MT Bold\",\"Arial Unicode MS\",\"Comic Sans MS\",\"Courier\",\"Courier New\",\"Geneva\",\"Georgia\",\"Helvetica\",\"Helvetica Neue\",\"Impact\",\"LUCIDA GRANDE\",\"Microsoft Sans Serif\",\"Monaco\",\"Palatino\",\"Tahoma\",\"Times\",\"Times New Roman\",\"Trebuchet MS\",\"Verdana\",\"Wingdings\",\"Wingdings 2\",\"Wingdings 3\"]",
			NavigatorVendor:         "Google Inc.",
			NavigatorWebdriver:      "false",
			NavigatorAppName:        "Netscape",
			NavigatorAppCodeName:    "Mozilla",
			NavigatorAppVersion:     navigatorAppVersionFromUA(h.UserAgent),
			NavigatorLanguages:      "[\"en-US\",\"en\"]",
			NavigatorCookiesEnabled: "true",
			NavigatorJavaEnabled:    "false",
			VisitorID:               CreateVisitorId(),
			TealeafID:               "MIzsZeZVW99J8gZ45fY-c-Lcrfqb-mA6",
			Webgl:                   "unknown",
			WebglVendor:             "unknown",
			BrowserName:             "Unknown",
			BrowserVersion:          "Unknown",
			CPUArchitecture:         "Unknown",
			DeviceVendor:            "Unknown",
			DeviceModel:             "Unknown",
			DeviceType:              "Unknown",
			EngineName:              "Unknown",
			EngineVersion:           "Unknown",
			OSName:                  "Unknown",
			OSVersion:               "Unknown",
		},
	}

	payloadBytes, err := json.Marshal(data)
	if err != nil {
		t.NextStep, t.Error = "login", fmt.Errorf("marshal login body: %w", err)
		return
	}

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    "https://gsp.target.com/gsp/authentications/v1/credential_validations?client_id=ecom-web-1.0.0",
			Data:   string(payloadBytes),
		},
		Headers: map[string][]string{
			"sec-ch-ua-platform":           {h.SecChUAPlatform},
			"x-gyjwza5z-z":                 {h.XGyjwza5zZ},
			"sec-ch-ua":                    {h.SecChUA},
			"x-application-mouse-tool-key": {"cnviSRUCGOlanm_whtf8vJLJefPoIKi_RVUQTN7bKn5Ap0gxhQ5thjBQTUPnMVwl0FG2_i4tGmFQd-FL1DWo9iZaslBcV8Qjcv2Mqiy4Km7dO1pe24iWnnr0KvPMENPH"},
			"x-gyjwza5z-f":                 {h.XGyjwza5zF},
			"sec-ch-ua-mobile":             {"?0"},
			"x-gyjwza5z-a0":                {h.XGyjwza5zA0},
			"x-gyjwza5z-b":                 {h.XGyjwza5zB},
			"x-gyjwza5z-a":                 {h.XGyjwza5zA},
			"user-agent":                   {h.UserAgent},
			"accept":                       {"application/json"},
			"x-gyjwza5z-c":                 {h.XGyjwza5zC},
			"content-type":                 {"application/json"},
			"x-gyjwza5z-d":                 {h.XGyjwza5zD},
			"origin":                       {"https://www.target.com"},
			"sec-fetch-site":               {"same-site"},
			"sec-fetch-mode":               {"cors"},
			"sec-fetch-dest":               {"empty"},
			"referer":                      {"https://www.target.com/login?client_id=ecom-web-1.0.0&ui_namespace=ui-default&back_button_action=browser&keep_me_signed_in=true&kmsi_default=false&actions=create_session_request_username&signin_amr=true"},
			"accept-encoding":              {"gzip, deflate, br, zstd"},
			"accept-language":              {"en-US,en;q=0.9"},
			"priority":                     {"u=1, i"},
			"header-order":                 {"content-length", "sec-ch-ua-platform", "x-gyjwza5z-z", "sec-ch-ua", "x-application-mouse-tool-key", "x-gyjwza5z-f", "sec-ch-ua-mobile", "x-gyjwza5z-a0", "x-gyjwza5z-b", "x-gyjwza5z-a", "user-agent", "accept", "x-gyjwza5z-c", "content-type", "x-gyjwza5z-d", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language", "cookie", "priority"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[Login] Request error: %v", err)
		t.NextStep, t.Error = "login", fmt.Errorf("Proxy Failed")
		t.BaseTask.MaybeRotateProxy("Target", err)
		return
	}
	t.ShapeHeaders = ShapeHeaders{}
	t.ShapeMethod = ""
	log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
	t.Requests.Referer = Request.Req.URL
	switch response.StatusCode {
	case 200, 202:
		if strings.Contains(body, "additional_factor_required") {
			t.Error = fmt.Errorf("2FA Needed")
			return
		}
	case 429:
		t.NextStep = "login"
		if strings.Contains(body, "DCO_RATE_LIMITED") {
			t.Error = fmt.Errorf("DCO_RATE_LIMITED")
		} else {
			t.Error = fmt.Errorf("error login (%d)", response.StatusCode)
		}
	case 401:
		if strings.Contains(body, "refresh your browser and try again") {
			t.Error = fmt.Errorf("Shape Block (Login)")
			return
		}
		var responseBody TargetErrorResponse
		if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
			log.Printf("Error parsing JSON response: %v", err)
			t.Error = err
			return
		}
		if len(responseBody.Errors) > 0 {
			if responseBody.Errors[0].ErrorKey != "" {
				t.Error = fmt.Errorf("%s", responseBody.Errors[0].ErrorKey)
				return
			}
		}
		t.Error = fmt.Errorf("invalid_credentials")
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.NextStep, t.Error = "login", fmt.Errorf("error login (%d)", response.StatusCode)
	}
}

func (t *TargetTask) Get2faCode() {
	if !t.shapeOK() {
		t.Error = fmt.Errorf("missing shape headers")
		return
	}
	h := t.ShapeHeaders
	data := twofaCredentialPayload{
		DeviceInfo: loginDeviceInfo{
			UserAgent:               h.UserAgent,
			Language:                "en-US",
			Canvas:                  "f418b62b527756dce2ba14edd74195ce",
			ColorDepth:              "30",
			DeviceMemory:            "16",
			PixelRatio:              "unknown",
			HardwareConcurrency:     "10",
			Resolution:              "[1710,1107]",
			AvailableResolution:     "[1710,998]",
			TimezoneOffset:          "420",
			SessionStorage:          "1",
			LocalStorage:            "1",
			IndexedDB:               "1",
			AddBehavior:             "unknown",
			OpenDatabase:            "unknown",
			CPUClass:                "unknown",
			NavigatorPlatform:       "MacIntel",
			DoNotTrack:              "unknown",
			RegularPlugins:          "[\"PDF Viewer::Portable Document Format::application/pdf~pdf,text/pdf~pdf\",\"Chrome PDF Viewer::Portable Document Format::application/pdf~pdf,text/pdf~pdf\",\"Chromium PDF Viewer::Portable Document Format::application/pdf~pdf,text/pdf~pdf\",\"Microsoft Edge PDF Viewer::Portable Document Format::application/pdf~pdf,text/pdf~pdf\",\"WebKit built-in PDF::Portable Document Format::application/pdf~pdf,text/pdf~pdf\"]",
			Adblock:                 "false",
			HasLiedLanguages:        "false",
			HasLiedResolution:       "false",
			HasLiedOS:               "false",
			HasLiedBrowser:          "false",
			TouchSupport:            "[0,false,false]",
			JSFonts:                 "[\"Andale Mono\",\"Arial\",\"Arial Black\",\"Arial Hebrew\",\"Arial Narrow\",\"Arial Rounded MT Bold\",\"Arial Unicode MS\",\"Comic Sans MS\",\"Courier\",\"Courier New\",\"Geneva\",\"Georgia\",\"Helvetica\",\"Helvetica Neue\",\"Impact\",\"LUCIDA GRANDE\",\"Microsoft Sans Serif\",\"Monaco\",\"Palatino\",\"Tahoma\",\"Times\",\"Times New Roman\",\"Trebuchet MS\",\"Verdana\",\"Wingdings\",\"Wingdings 2\",\"Wingdings 3\"]",
			NavigatorVendor:         "Google Inc.",
			NavigatorWebdriver:      "false",
			NavigatorAppName:        "Netscape",
			NavigatorAppCodeName:    "Mozilla",
			NavigatorAppVersion:     navigatorAppVersionFromUA(h.UserAgent),
			NavigatorLanguages:      "[\"en-US\",\"en\"]",
			NavigatorCookiesEnabled: "true",
			NavigatorJavaEnabled:    "false",
			VisitorID:               CreateVisitorId(),
			TealeafID:               "MIzsZeZVW99J8gZ45fY-c-Lcrfqb-mA6",
			Webgl:                   "unknown",
			WebglVendor:             "unknown",
			BrowserName:             "Unknown",
			BrowserVersion:          "Unknown",
			CPUArchitecture:         "Unknown",
			DeviceVendor:            "Unknown",
			DeviceModel:             "Unknown",
			DeviceType:              "Unknown",
			EngineName:              "Unknown",
			EngineVersion:           "Unknown",
			OSName:                  "Unknown",
			OSVersion:               "Unknown",
		},
		EmailId:        t.Account.Username,
		Flow:           "otp_signin",
		KeepMeSignedIn: true,
	}

	payloadBytes, err := json.Marshal(data)
	if err != nil {
		t.NextStep, t.Error = "login", fmt.Errorf("marshal login body: %w", err)
		return
	}

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    "https://gsp.target.com/gsp/authentications/v1/secure_codes_identified",
			Data:   string(payloadBytes),
		},
		Headers: map[string][]string{
			"sec-ch-ua-platform": {h.SecChUAPlatform},
			"x-gyjwza5z-z":       {h.XGyjwza5zZ},
			"sec-ch-ua":          {h.SecChUA},
			"x-gyjwza5z-f":       {h.XGyjwza5zF},
			"sec-ch-ua-mobile":   {"?0"},
			"x-gyjwza5z-a0":      {h.XGyjwza5zA0},
			"x-gyjwza5z-b":       {h.XGyjwza5zB},
			"x-gyjwza5z-a":       {h.XGyjwza5zA},
			"user-agent":         {h.UserAgent},
			"accept":             {"application/json"},
			"x-gyjwza5z-c":       {h.XGyjwza5zC},
			"content-type":       {"application/json"},
			"x-gyjwza5z-d":       {h.XGyjwza5zD},
			"origin":             {"https://www.target.com"},
			"sec-fetch-site":     {"same-site"},
			"sec-fetch-mode":     {"cors"},
			"sec-fetch-dest":     {"empty"},
			"referer":            {"https://www.target.com/login?client_id=ecom-web-1.0.0&ui_namespace=ui-default&back_button_action=browser&keep_me_signed_in=true&kmsi_default=false&actions=create_session_request_username&signin_amr=true"},
			"accept-encoding":    {"gzip, deflate, br, zstd"},
			"accept-language":    {"en-US,en;q=0.9"},
			"priority":           {"u=1, i"},
			"header-order":       {"content-length", "sec-ch-ua-platform", "x-gyjwza5z-z", "sec-ch-ua", "x-gyjwza5z-f", "sec-ch-ua-mobile", "x-gyjwza5z-a0", "x-gyjwza5z-b", "x-gyjwza5z-a", "user-agent", "accept", "x-gyjwza5z-c", "content-type", "x-gyjwza5z-d", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language", "cookie", "priority"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[Login] Request error: %v", err)
		t.NextStep, t.Error = "login", fmt.Errorf("Proxy Failed")
		t.BaseTask.MaybeRotateProxy("Target", err)
		return
	}
	t.ShapeHeaders = ShapeHeaders{}
	t.ShapeMethod = ""
	log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
	t.Requests.Referer = Request.Req.URL
	switch response.StatusCode {
	case 200, 202:
		log.Print(body)
	case 401:
		if strings.Contains(body, "refresh your browser and try again") {
			t.Error = fmt.Errorf("Shape Block (Login)")
			return
		}
		var responseBody TargetErrorResponse
		if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
			log.Printf("Error parsing JSON response: %v", err)
			t.Error = err
			return
		}
		if len(responseBody.Errors) > 0 {
			t.Error = fmt.Errorf("%s", responseBody.Errors[0].ErrorKey)
			return
		}
		t.Error = fmt.Errorf("get code failed (401)")
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.NextStep, t.Error = "request-code", fmt.Errorf("error get code (%d)", response.StatusCode)
	}
}

func (t *TargetTask) Submit2faCode() {
	if !t.shapeOK() {
		t.Error = fmt.Errorf("missing shape headers")
		return
	}
	h := t.ShapeHeaders
	data := submitTwofaCredentialPayload{
		Code: t.TwoFACode,
		DeviceInfo: loginDeviceInfo{
			UserAgent:               h.UserAgent,
			Language:                "en-US",
			Canvas:                  "f418b62b527756dce2ba14edd74195ce",
			ColorDepth:              "30",
			DeviceMemory:            "16",
			PixelRatio:              "unknown",
			HardwareConcurrency:     "10",
			Resolution:              "[1710,1107]",
			AvailableResolution:     "[1710,998]",
			TimezoneOffset:          "420",
			SessionStorage:          "1",
			LocalStorage:            "1",
			IndexedDB:               "1",
			AddBehavior:             "unknown",
			OpenDatabase:            "unknown",
			CPUClass:                "unknown",
			NavigatorPlatform:       "MacIntel",
			DoNotTrack:              "unknown",
			RegularPlugins:          "[\"PDF Viewer::Portable Document Format::application/pdf~pdf,text/pdf~pdf\",\"Chrome PDF Viewer::Portable Document Format::application/pdf~pdf,text/pdf~pdf\",\"Chromium PDF Viewer::Portable Document Format::application/pdf~pdf,text/pdf~pdf\",\"Microsoft Edge PDF Viewer::Portable Document Format::application/pdf~pdf,text/pdf~pdf\",\"WebKit built-in PDF::Portable Document Format::application/pdf~pdf,text/pdf~pdf\"]",
			Adblock:                 "false",
			HasLiedLanguages:        "false",
			HasLiedResolution:       "false",
			HasLiedOS:               "false",
			HasLiedBrowser:          "false",
			TouchSupport:            "[0,false,false]",
			JSFonts:                 "[\"Andale Mono\",\"Arial\",\"Arial Black\",\"Arial Hebrew\",\"Arial Narrow\",\"Arial Rounded MT Bold\",\"Arial Unicode MS\",\"Comic Sans MS\",\"Courier\",\"Courier New\",\"Geneva\",\"Georgia\",\"Helvetica\",\"Helvetica Neue\",\"Impact\",\"LUCIDA GRANDE\",\"Microsoft Sans Serif\",\"Monaco\",\"Palatino\",\"Tahoma\",\"Times\",\"Times New Roman\",\"Trebuchet MS\",\"Verdana\",\"Wingdings\",\"Wingdings 2\",\"Wingdings 3\"]",
			NavigatorVendor:         "Google Inc.",
			NavigatorWebdriver:      "false",
			NavigatorAppName:        "Netscape",
			NavigatorAppCodeName:    "Mozilla",
			NavigatorAppVersion:     navigatorAppVersionFromUA(h.UserAgent),
			NavigatorLanguages:      "[\"en-US\",\"en\"]",
			NavigatorCookiesEnabled: "true",
			NavigatorJavaEnabled:    "false",
			VisitorID:               CreateVisitorId(),
			TealeafID:               "MIzsZeZVW99J8gZ45fY-c-Lcrfqb-mA6",
			Webgl:                   "unknown",
			WebglVendor:             "unknown",
			BrowserName:             "Unknown",
			BrowserVersion:          "Unknown",
			CPUArchitecture:         "Unknown",
			DeviceVendor:            "Unknown",
			DeviceModel:             "Unknown",
			DeviceType:              "Unknown",
			EngineName:              "Unknown",
			EngineVersion:           "Unknown",
			OSName:                  "Unknown",
			OSVersion:               "Unknown",
		},
	}

	payloadBytes, err := json.Marshal(data)
	if err != nil {
		t.NextStep, t.Error = "login", fmt.Errorf("marshal login body: %w", err)
		return
	}

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    "https://gsp.target.com/gsp/authentications/v1/secure_code_verifications",
			Data:   string(payloadBytes),
		},
		Headers: map[string][]string{
			"sec-ch-ua-platform": {h.SecChUAPlatform},
			"x-gyjwza5z-z":       {h.XGyjwza5zZ},
			"sec-ch-ua":          {h.SecChUA},
			"x-gyjwza5z-f":       {h.XGyjwza5zF},
			"sec-ch-ua-mobile":   {"?0"},
			"x-gyjwza5z-a0":      {h.XGyjwza5zA0},
			"x-gyjwza5z-b":       {h.XGyjwza5zB},
			"x-gyjwza5z-a":       {h.XGyjwza5zA},
			"user-agent":         {h.UserAgent},
			"accept":             {"application/json"},
			"x-gyjwza5z-c":       {h.XGyjwza5zC},
			"content-type":       {"application/json"},
			"x-gyjwza5z-d":       {h.XGyjwza5zD},
			"origin":             {"https://www.target.com"},
			"sec-fetch-site":     {"same-site"},
			"sec-fetch-mode":     {"cors"},
			"sec-fetch-dest":     {"empty"},
			"referer":            {"https://www.target.com/login?client_id=ecom-web-1.0.0&ui_namespace=ui-default&back_button_action=browser&keep_me_signed_in=true&kmsi_default=false&actions=create_session_request_username&signin_amr=true"},
			"accept-encoding":    {"gzip, deflate, br, zstd"},
			"accept-language":    {"en-US,en;q=0.9"},
			"priority":           {"u=1, i"},
			"header-order":       {"content-length", "sec-ch-ua-platform", "x-gyjwza5z-z", "sec-ch-ua", "x-gyjwza5z-f", "sec-ch-ua-mobile", "x-gyjwza5z-a0", "x-gyjwza5z-b", "x-gyjwza5z-a", "user-agent", "accept", "x-gyjwza5z-c", "content-type", "x-gyjwza5z-d", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language", "cookie", "priority"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[Login] Request error: %v", err)
		t.NextStep, t.Error = "login", fmt.Errorf("Proxy Failed")
		t.BaseTask.MaybeRotateProxy("Target", err)
		return
	}
	t.ShapeHeaders = ShapeHeaders{}
	t.ShapeMethod = ""
	log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
	t.Requests.Referer = Request.Req.URL
	switch response.StatusCode {
	case 200, 202:
		var responseBody SecureCodeVerificationResponse
		if err := jsoniter.Unmarshal([]byte(body), &responseBody); err == nil {
			for _, action := range responseBody.Actions {
				if action == "reset_password" {
					t.NeedsPasswordReset = true
					break
				}
			}
		}
	case 401:
		if strings.Contains(body, "refresh your browser and try again") {
			t.Error = fmt.Errorf("Shape Block (Login)")
			return
		}
		var responseBody TargetErrorResponse
		if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
			log.Printf("Error parsing JSON response: %v", err)
			t.Error = err
			return
		}
		if len(responseBody.Errors) > 0 {
			t.Error = fmt.Errorf("%s", responseBody.Errors[0].ErrorKey)
			return
		}
		t.Error = fmt.Errorf("get code failed (401)")
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.NextStep, t.Error = "request-code", fmt.Errorf("submit-code (%d)", response.StatusCode)
	}
}

func (t *TargetTask) RequestPasswordResetCode() {
	if !t.shapeOK() {
		t.Error = fmt.Errorf("missing shape headers")
		return
	}
	h := t.ShapeHeaders
	data := twofaCredentialPayload{
		DeviceInfo: loginDeviceInfo{
			UserAgent:               h.UserAgent,
			Language:                "en-US",
			Canvas:                  "f418b62b527756dce2ba14edd74195ce",
			ColorDepth:              "30",
			DeviceMemory:            "16",
			PixelRatio:              "unknown",
			HardwareConcurrency:     "10",
			Resolution:              "[1710,1107]",
			AvailableResolution:     "[1710,998]",
			TimezoneOffset:          "420",
			SessionStorage:          "1",
			LocalStorage:            "1",
			IndexedDB:               "1",
			AddBehavior:             "unknown",
			OpenDatabase:            "unknown",
			CPUClass:                "unknown",
			NavigatorPlatform:       "MacIntel",
			DoNotTrack:              "unknown",
			RegularPlugins:          "[\"PDF Viewer::Portable Document Format::application/pdf~pdf,text/pdf~pdf\",\"Chrome PDF Viewer::Portable Document Format::application/pdf~pdf,text/pdf~pdf\",\"Chromium PDF Viewer::Portable Document Format::application/pdf~pdf,text/pdf~pdf\",\"Microsoft Edge PDF Viewer::Portable Document Format::application/pdf~pdf,text/pdf~pdf\",\"WebKit built-in PDF::Portable Document Format::application/pdf~pdf,text/pdf~pdf\"]",
			Adblock:                 "false",
			HasLiedLanguages:        "false",
			HasLiedResolution:       "false",
			HasLiedOS:               "false",
			HasLiedBrowser:          "false",
			TouchSupport:            "[0,false,false]",
			JSFonts:                 "[\"Andale Mono\",\"Arial\",\"Arial Black\",\"Arial Hebrew\",\"Arial Narrow\",\"Arial Rounded MT Bold\",\"Arial Unicode MS\",\"Comic Sans MS\",\"Courier\",\"Courier New\",\"Geneva\",\"Georgia\",\"Helvetica\",\"Helvetica Neue\",\"Impact\",\"LUCIDA GRANDE\",\"Microsoft Sans Serif\",\"Monaco\",\"Palatino\",\"Tahoma\",\"Times\",\"Times New Roman\",\"Trebuchet MS\",\"Verdana\",\"Wingdings\",\"Wingdings 2\",\"Wingdings 3\"]",
			NavigatorVendor:         "Google Inc.",
			NavigatorWebdriver:      "false",
			NavigatorAppName:        "Netscape",
			NavigatorAppCodeName:    "Mozilla",
			NavigatorAppVersion:     navigatorAppVersionFromUA(h.UserAgent),
			NavigatorLanguages:      "[\"en-US\",\"en\"]",
			NavigatorCookiesEnabled: "true",
			NavigatorJavaEnabled:    "false",
			VisitorID:               CreateVisitorId(),
			TealeafID:               "MIzsZeZVW99J8gZ45fY-c-Lcrfqb-mA6",
			Webgl:                   "unknown",
			WebglVendor:             "unknown",
			BrowserName:             "Unknown",
			BrowserVersion:          "Unknown",
			CPUArchitecture:         "Unknown",
			DeviceVendor:            "Unknown",
			DeviceModel:             "Unknown",
			DeviceType:              "Unknown",
			EngineName:              "Unknown",
			EngineVersion:           "Unknown",
			OSName:                  "Unknown",
			OSVersion:               "Unknown",
		},
		EmailId:        t.Account.Username,
		Flow:           "forgot_password",
		KeepMeSignedIn: true,
	}

	payloadBytes, err := json.Marshal(data)
	if err != nil {
		t.NextStep, t.Error = "reset-password", fmt.Errorf("marshal reset-password body: %w", err)
		return
	}

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    "https://gsp.target.com/gsp/authentications/v1/secure_codes_unidentified",
			Data:   string(payloadBytes),
		},
		Headers: map[string][]string{
			"sec-ch-ua-platform":           {h.SecChUAPlatform},
			"x-gyjwza5z-z":                 {h.XGyjwza5zZ},
			"sec-ch-ua":                    {h.SecChUA},
			"x-application-mouse-tool-key": {"cnviSRUCGOlanm_whtf8vJLJefPoIKi_RVUQTN7bKn5Ap0gxhQ5thjBQTUPnMVwl0FG2_i4tGmFQd-FL1DWo9iZaslBcV8Qjcv2Mqiy4Km7dO1pe24iWnnr0KvPMENPH"},
			"x-gyjwza5z-f":                 {h.XGyjwza5zF},
			"sec-ch-ua-mobile":             {"?0"},
			"x-gyjwza5z-a0":                {h.XGyjwza5zA0},
			"x-gyjwza5z-b":                 {h.XGyjwza5zB},
			"x-gyjwza5z-a":                 {h.XGyjwza5zA},
			"user-agent":                   {h.UserAgent},
			"accept":                       {"application/json"},
			"x-gyjwza5z-c":                 {h.XGyjwza5zC},
			"content-type":                 {"application/json"},
			"x-gyjwza5z-d":                 {h.XGyjwza5zD},
			"origin":                       {"https://www.target.com"},
			"sec-fetch-site":               {"same-site"},
			"sec-fetch-mode":               {"cors"},
			"sec-fetch-dest":               {"empty"},
			"referer":                      {"https://www.target.com/login?client_id=ecom-web-1.0.0&ui_namespace=ui-default&back_button_action=browser&keep_me_signed_in=true&kmsi_default=false&actions=create_session_request_username&signin_amr=true"},
			"accept-encoding":              {"gzip, deflate, br, zstd"},
			"accept-language":              {"en-US,en;q=0.9"},
			"priority":                     {"u=1, i"},
			"header-order":                 {"content-length", "sec-ch-ua-platform", "x-gyjwza5z-z", "sec-ch-ua", "x-application-mouse-tool-key", "x-gyjwza5z-f", "sec-ch-ua-mobile", "x-gyjwza5z-a0", "x-gyjwza5z-b", "x-gyjwza5z-a", "user-agent", "accept", "x-gyjwza5z-c", "content-type", "x-gyjwza5z-d", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language", "cookie", "priority"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[ResetPassword] Request error: %v", err)
		t.NextStep, t.Error = "reset-password", fmt.Errorf("Proxy Failed")
		t.BaseTask.MaybeRotateProxy("Target", err)
		return
	}
	t.ShapeHeaders = ShapeHeaders{}
	t.ShapeMethod = ""
	log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
	t.Requests.Referer = Request.Req.URL
	switch response.StatusCode {
	case 200, 202:
	case 429:
		t.NextStep = "reset-password"
		if strings.Contains(body, "DCO_RATE_LIMITED") {
			t.Error = fmt.Errorf("DCO_RATE_LIMITED")
		} else {
			t.Error = fmt.Errorf("error reset-password (%d)", response.StatusCode)
		}
	case 401:
		if strings.Contains(body, "refresh your browser and try again") {
			t.Error = fmt.Errorf("Shape Block (Login)")
			return
		}
		var responseBody TargetErrorResponse
		if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
			log.Printf("Error parsing JSON response: %v", err)
			t.Error = err
			return
		}
		if len(responseBody.Errors) > 0 {
			t.Error = fmt.Errorf("%s", responseBody.Errors[0].ErrorKey)
			return
		}
		t.Error = fmt.Errorf("reset-password failed (401)")
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.NextStep, t.Error = "reset-password", fmt.Errorf("error reset-password (%d)", response.StatusCode)
	}
}

func (t *TargetTask) VerifyPasswordResetCode() {
	if !t.shapeOK() {
		t.Error = fmt.Errorf("missing shape headers")
		return
	}
	h := t.ShapeHeaders
	data := submitTwofaCredentialPayload{
		Code: t.TwoFACode,
		DeviceInfo: loginDeviceInfo{
			UserAgent:               h.UserAgent,
			Language:                "en-US",
			Canvas:                  "f418b62b527756dce2ba14edd74195ce",
			ColorDepth:              "30",
			DeviceMemory:            "16",
			PixelRatio:              "unknown",
			HardwareConcurrency:     "10",
			Resolution:              "[1710,1107]",
			AvailableResolution:     "[1710,998]",
			TimezoneOffset:          "420",
			SessionStorage:          "1",
			LocalStorage:            "1",
			IndexedDB:               "1",
			AddBehavior:             "unknown",
			OpenDatabase:            "unknown",
			CPUClass:                "unknown",
			NavigatorPlatform:       "MacIntel",
			DoNotTrack:              "unknown",
			RegularPlugins:          "[\"PDF Viewer::Portable Document Format::application/pdf~pdf,text/pdf~pdf\",\"Chrome PDF Viewer::Portable Document Format::application/pdf~pdf,text/pdf~pdf\",\"Chromium PDF Viewer::Portable Document Format::application/pdf~pdf,text/pdf~pdf\",\"Microsoft Edge PDF Viewer::Portable Document Format::application/pdf~pdf,text/pdf~pdf\",\"WebKit built-in PDF::Portable Document Format::application/pdf~pdf,text/pdf~pdf\"]",
			Adblock:                 "false",
			HasLiedLanguages:        "false",
			HasLiedResolution:       "false",
			HasLiedOS:               "false",
			HasLiedBrowser:          "false",
			TouchSupport:            "[0,false,false]",
			JSFonts:                 "[\"Andale Mono\",\"Arial\",\"Arial Black\",\"Arial Hebrew\",\"Arial Narrow\",\"Arial Rounded MT Bold\",\"Arial Unicode MS\",\"Comic Sans MS\",\"Courier\",\"Courier New\",\"Geneva\",\"Georgia\",\"Helvetica\",\"Helvetica Neue\",\"Impact\",\"LUCIDA GRANDE\",\"Microsoft Sans Serif\",\"Monaco\",\"Palatino\",\"Tahoma\",\"Times\",\"Times New Roman\",\"Trebuchet MS\",\"Verdana\",\"Wingdings\",\"Wingdings 2\",\"Wingdings 3\"]",
			NavigatorVendor:         "Google Inc.",
			NavigatorWebdriver:      "false",
			NavigatorAppName:        "Netscape",
			NavigatorAppCodeName:    "Mozilla",
			NavigatorAppVersion:     navigatorAppVersionFromUA(h.UserAgent),
			NavigatorLanguages:      "[\"en-US\",\"en\"]",
			NavigatorCookiesEnabled: "true",
			NavigatorJavaEnabled:    "false",
			VisitorID:               CreateVisitorId(),
			TealeafID:               "MIzsZeZVW99J8gZ45fY-c-Lcrfqb-mA6",
			Webgl:                   "unknown",
			WebglVendor:             "unknown",
			BrowserName:             "Unknown",
			BrowserVersion:          "Unknown",
			CPUArchitecture:         "Unknown",
			DeviceVendor:            "Unknown",
			DeviceModel:             "Unknown",
			DeviceType:              "Unknown",
			EngineName:              "Unknown",
			EngineVersion:           "Unknown",
			OSName:                  "Unknown",
			OSVersion:               "Unknown",
		},
	}

	payloadBytes, err := json.Marshal(data)
	if err != nil {
		t.NextStep, t.Error = "reset-password", fmt.Errorf("marshal reset-password body: %w", err)
		return
	}

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    "https://gsp.target.com/gsp/authentications/v1/secure_code_verifications",
			Data:   string(payloadBytes),
		},
		Headers: map[string][]string{
			"sec-ch-ua-platform":           {h.SecChUAPlatform},
			"x-gyjwza5z-z":                 {h.XGyjwza5zZ},
			"sec-ch-ua":                    {h.SecChUA},
			"x-application-mouse-tool-key": {"cnviSRUCGOlanm_whtf8vJLJefPoIKi_RVUQTN7bKn5Ap0gxhQ5thjBQTUPnMVwl0FG2_i4tGmFQd-FL1DWo9iZaslBcV8Qjcv2Mqiy4Km7dO1pe24iWnnr0KvPMENPH"},
			"x-gyjwza5z-f":                 {h.XGyjwza5zF},
			"sec-ch-ua-mobile":             {"?0"},
			"x-gyjwza5z-a0":                {h.XGyjwza5zA0},
			"x-gyjwza5z-b":                 {h.XGyjwza5zB},
			"x-gyjwza5z-a":                 {h.XGyjwza5zA},
			"user-agent":                   {h.UserAgent},
			"accept":                       {"application/json"},
			"x-gyjwza5z-c":                 {h.XGyjwza5zC},
			"content-type":                 {"application/json"},
			"x-gyjwza5z-d":                 {h.XGyjwza5zD},
			"origin":                       {"https://www.target.com"},
			"sec-fetch-site":               {"same-site"},
			"sec-fetch-mode":               {"cors"},
			"sec-fetch-dest":               {"empty"},
			"referer":                      {"https://www.target.com/login?client_id=ecom-web-1.0.0&ui_namespace=ui-default&back_button_action=browser&keep_me_signed_in=true&kmsi_default=false&actions=create_session_request_username&signin_amr=true"},
			"accept-encoding":              {"gzip, deflate, br, zstd"},
			"accept-language":              {"en-US,en;q=0.9"},
			"priority":                     {"u=1, i"},
			"header-order":                 {"content-length", "sec-ch-ua-platform", "x-gyjwza5z-z", "sec-ch-ua", "x-application-mouse-tool-key", "x-gyjwza5z-f", "sec-ch-ua-mobile", "x-gyjwza5z-a0", "x-gyjwza5z-b", "x-gyjwza5z-a", "user-agent", "accept", "x-gyjwza5z-c", "content-type", "x-gyjwza5z-d", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language", "cookie", "priority"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[ResetPassword] Request error: %v", err)
		t.NextStep, t.Error = "reset-password", fmt.Errorf("Proxy Failed")
		t.BaseTask.MaybeRotateProxy("Target", err)
		return
	}
	t.ShapeHeaders = ShapeHeaders{}
	t.ShapeMethod = ""
	log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
	t.Requests.Referer = Request.Req.URL
	switch response.StatusCode {
	case 200, 202:
	case 401:
		if strings.Contains(body, "refresh your browser and try again") {
			t.Error = fmt.Errorf("Shape Block (Login)")
			return
		}
		var responseBody TargetErrorResponse
		if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
			log.Printf("Error parsing JSON response: %v", err)
			t.Error = err
			return
		}
		if len(responseBody.Errors) > 0 {
			t.Error = fmt.Errorf("%s", responseBody.Errors[0].ErrorKey)
			return
		}
		t.Error = fmt.Errorf("verify-reset-code failed (401)")
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.NextStep, t.Error = "reset-password", fmt.Errorf("error verify-reset-code (%d)", response.StatusCode)
	}
}

func (t *TargetTask) ResetPassword() {
	if !t.shapeOK() {
		t.Error = fmt.Errorf("missing shape headers")
		return
	}
	h := t.ShapeHeaders
	t.NewPassword = randomPassword(16)
	data := resetPasswordPayload{
		DeviceInfo: loginDeviceInfo{
			UserAgent:               h.UserAgent,
			Language:                "en-US",
			Canvas:                  "f418b62b527756dce2ba14edd74195ce",
			ColorDepth:              "30",
			DeviceMemory:            "16",
			PixelRatio:              "unknown",
			HardwareConcurrency:     "10",
			Resolution:              "[1710,1107]",
			AvailableResolution:     "[1710,998]",
			TimezoneOffset:          "420",
			SessionStorage:          "1",
			LocalStorage:            "1",
			IndexedDB:               "1",
			AddBehavior:             "unknown",
			OpenDatabase:            "unknown",
			CPUClass:                "unknown",
			NavigatorPlatform:       "MacIntel",
			DoNotTrack:              "unknown",
			RegularPlugins:          "[\"PDF Viewer::Portable Document Format::application/pdf~pdf,text/pdf~pdf\",\"Chrome PDF Viewer::Portable Document Format::application/pdf~pdf,text/pdf~pdf\",\"Chromium PDF Viewer::Portable Document Format::application/pdf~pdf,text/pdf~pdf\",\"Microsoft Edge PDF Viewer::Portable Document Format::application/pdf~pdf,text/pdf~pdf\",\"WebKit built-in PDF::Portable Document Format::application/pdf~pdf,text/pdf~pdf\"]",
			Adblock:                 "false",
			HasLiedLanguages:        "false",
			HasLiedResolution:       "false",
			HasLiedOS:               "false",
			HasLiedBrowser:          "false",
			TouchSupport:            "[0,false,false]",
			JSFonts:                 "[\"Andale Mono\",\"Arial\",\"Arial Black\",\"Arial Hebrew\",\"Arial Narrow\",\"Arial Rounded MT Bold\",\"Arial Unicode MS\",\"Comic Sans MS\",\"Courier\",\"Courier New\",\"Geneva\",\"Georgia\",\"Helvetica\",\"Helvetica Neue\",\"Impact\",\"LUCIDA GRANDE\",\"Microsoft Sans Serif\",\"Monaco\",\"Palatino\",\"Tahoma\",\"Times\",\"Times New Roman\",\"Trebuchet MS\",\"Verdana\",\"Wingdings\",\"Wingdings 2\",\"Wingdings 3\"]",
			NavigatorVendor:         "Google Inc.",
			NavigatorWebdriver:      "false",
			NavigatorAppName:        "Netscape",
			NavigatorAppCodeName:    "Mozilla",
			NavigatorAppVersion:     navigatorAppVersionFromUA(h.UserAgent),
			NavigatorLanguages:      "[\"en-US\",\"en\"]",
			NavigatorCookiesEnabled: "true",
			NavigatorJavaEnabled:    "false",
			VisitorID:               CreateVisitorId(),
			TealeafID:               "MIzsZeZVW99J8gZ45fY-c-Lcrfqb-mA6",
			Webgl:                   "unknown",
			WebglVendor:             "unknown",
			BrowserName:             "Unknown",
			BrowserVersion:          "Unknown",
			CPUArchitecture:         "Unknown",
			DeviceVendor:            "Unknown",
			DeviceModel:             "Unknown",
			DeviceType:              "Unknown",
			EngineName:              "Unknown",
			EngineVersion:           "Unknown",
			OSName:                  "Unknown",
			OSVersion:               "Unknown",
		},
		Password: t.NewPassword,
	}

	payloadBytes, err := json.Marshal(data)
	if err != nil {
		t.NextStep, t.Error = "reset-password", fmt.Errorf("marshal reset-password body: %w", err)
		return
	}

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "PUT",
			URL:    "https://gsp.target.com/gsp/authentications/v2/reset_password",
			Data:   string(payloadBytes),
		},
		Headers: map[string][]string{
			"sec-ch-ua-platform":           {h.SecChUAPlatform},
			"x-gyjwza5z-z":                 {h.XGyjwza5zZ},
			"sec-ch-ua":                    {h.SecChUA},
			"x-application-mouse-tool-key": {"cnviSRUCGOlanm_whtf8vJLJefPoIKi_RVUQTN7bKn5Ap0gxhQ5thjBQTUPnMVwl0FG2_i4tGmFQd-FL1DWo9iZaslBcV8Qjcv2Mqiy4Km7dO1pe24iWnnr0KvPMENPH"},
			"x-gyjwza5z-f":                 {h.XGyjwza5zF},
			"sec-ch-ua-mobile":             {"?0"},
			"x-gyjwza5z-a0":                {h.XGyjwza5zA0},
			"x-gyjwza5z-b":                 {h.XGyjwza5zB},
			"x-gyjwza5z-a":                 {h.XGyjwza5zA},
			"user-agent":                   {h.UserAgent},
			"accept":                       {"application/json"},
			"x-gyjwza5z-c":                 {h.XGyjwza5zC},
			"content-type":                 {"application/json"},
			"x-gyjwza5z-d":                 {h.XGyjwza5zD},
			"origin":                       {"https://www.target.com"},
			"sec-fetch-site":               {"same-site"},
			"sec-fetch-mode":               {"cors"},
			"sec-fetch-dest":               {"empty"},
			"referer":                      {"https://www.target.com/login?client_id=ecom-web-1.0.0&ui_namespace=ui-default&back_button_action=browser&keep_me_signed_in=true&kmsi_default=false&actions=create_session_request_username&signin_amr=true"},
			"accept-encoding":              {"gzip, deflate, br, zstd"},
			"accept-language":              {"en-US,en;q=0.9"},
			"priority":                     {"u=1, i"},
			"header-order":                 {"content-length", "sec-ch-ua-platform", "x-gyjwza5z-z", "sec-ch-ua", "x-application-mouse-tool-key", "x-gyjwza5z-f", "sec-ch-ua-mobile", "x-gyjwza5z-a0", "x-gyjwza5z-b", "x-gyjwza5z-a", "user-agent", "accept", "x-gyjwza5z-c", "content-type", "x-gyjwza5z-d", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language", "cookie", "priority"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[ResetPassword] Request error: %v", err)
		t.NextStep, t.Error = "reset-password", fmt.Errorf("Proxy Failed")
		t.BaseTask.MaybeRotateProxy("Target", err)
		return
	}
	t.ShapeHeaders = ShapeHeaders{}
	t.ShapeMethod = ""
	log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
	t.Requests.Referer = Request.Req.URL
	switch response.StatusCode {
	case 200, 202:
		t.Account.Password = t.NewPassword
	case 401:
		if strings.Contains(body, "refresh your browser and try again") {
			t.Error = fmt.Errorf("Shape Block (Login)")
			return
		}
		var responseBody TargetErrorResponse
		if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
			log.Printf("Error parsing JSON response: %v", err)
			t.Error = err
			return
		}
		if len(responseBody.Errors) > 0 {
			t.Error = fmt.Errorf("%s", responseBody.Errors[0].ErrorKey)
			return
		}
		t.Error = fmt.Errorf("reset-password failed (401)")
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.NextStep, t.Error = "reset-password", fmt.Errorf("error reset-password (%d)", response.StatusCode)
	}
}

func (t *TargetTask) ValidateToken() {
	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    "https://gsp.target.com/gsp/oauth_validations/v3/token_validations",
			Data:   "{}",
		},
		Headers: map[string][]string{
			"sec-ch-ua-platform": {t.Requests.UserAgent.Platform},
			"user-agent":         {t.Requests.UserAgent.Useragent},
			"accept":             {"application/json"},
			"sec-ch-ua":          {t.Requests.UserAgent.Sec_ua},
			"content-type":       {"application/json"},
			"sec-ch-ua-mobile":   {"?0"},
			"origin":             {"https://www.target.com"},
			"sec-fetch-site":     {"same-site"},
			"sec-fetch-mode":     {"cors"},
			"sec-fetch-dest":     {"empty"},
			"referer":            {"https://www.target.com/"},
			"accept-encoding":    {"gzip, deflate, br, zstd"},
			"accept-language":    {"en-US,en;q=0.9"},
			"priority":           {"u=1, i"},
			"header-order":       {"content-length", "sec-ch-ua-platform", "user-agent", "accept", "sec-ch-ua", "content-type", "sec-ch-ua-mobile", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language", "cookie", "priority"},
		},
	}
	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[ValidateToken] Request error: %v", err)
		t.NextStep, t.Error = "validate-token", fmt.Errorf("Proxy Failed")
		t.BaseTask.MaybeRotateProxy("Target", err)
		return
	}
	log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
	switch response.StatusCode {
	case 200:
		var responseBody TokenV3Response
		if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
			log.Printf("Error parsing JSON response: %v", err)
			t.Error = err
			return
		}
		t.Requests.AddCookie("accessToken", responseBody.AccessToken, "www.target.com")
		targetURL, _ := url.Parse("https://www.target.com")
		var jar strings.Builder
		for _, c := range t.Requests.Client.GetCookieJar().Cookies(targetURL) {
			if c.Name == "accessToken" ||
				c.Name == "idToken" ||
				c.Name == "login-session" ||
				c.Name == "refreshToken" ||
				c.Name == "visitorId" ||
				c.Name == "TealeafAkaSid" {

				if jar.Len() > 0 {
					jar.WriteString("; ")
				}
				jar.WriteString(c.Name)
				jar.WriteByte('=')
				jar.WriteString(c.Value)
			}
		}
		safego.Go(func() { t.UpdateCookie(jar.String(), t.Account.Id) })
	case 401:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.Error = fmt.Errorf("bad session")
	case 429:
		t.NextStep = "validate-token"
		if strings.Contains(body, "DCO_RATE_LIMITED") {
			t.Error = fmt.Errorf("DCO_RATE_LIMITED")
		} else {
			t.Error = fmt.Errorf("error validate-token (%d)", response.StatusCode)
		}
	case 403:
		t.Error = fmt.Errorf("proxy block")
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.NextStep, t.Error = "validate-token", fmt.Errorf("error validate-token (%d)", response.StatusCode)
	}
}

func (t *TargetTask) RefreshLogin() {
	data := refreshLoginPayload{
		GrantType:        "refresh_token",
		ClientCredential: refreshClientCredential{ClientID: "ecom-web-1.0.0"},
		DeviceInfo: loginDeviceInfo{
			UserAgent:               "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
			Language:                "en-US",
			Canvas:                  "8c12b809478d20518fc10cb90289fe19",
			ColorDepth:              "32",
			DeviceMemory:            "32",
			PixelRatio:              "unknown",
			HardwareConcurrency:     "28",
			Resolution:              "[2560,1440]",
			AvailableResolution:     "[2560,1440]",
			TimezoneOffset:          "240",
			SessionStorage:          "1",
			LocalStorage:            "1",
			IndexedDB:               "1",
			AddBehavior:             "unknown",
			OpenDatabase:            "unknown",
			CPUClass:                "unknown",
			NavigatorPlatform:       "Win32",
			DoNotTrack:              "unknown",
			RegularPlugins:          "[\"PDF Viewer::Portable Document Format::application/pdf~pdf,text/pdf~pdf\",\"Chrome PDF Viewer::Portable Document Format::application/pdf~pdf,text/pdf~pdf\",\"Chromium PDF Viewer::Portable Document Format::application/pdf~pdf,text/pdf~pdf\",\"Microsoft Edge PDF Viewer::Portable Document Format::application/pdf~pdf,text/pdf~pdf\",\"WebKit built-in PDF::Portable Document Format::application/pdf~pdf,text/pdf~pdf\"]",
			Adblock:                 "false",
			HasLiedLanguages:        "false",
			HasLiedResolution:       "false",
			HasLiedOS:               "false",
			HasLiedBrowser:          "false",
			TouchSupport:            "[0,false,false]",
			JSFonts:                 "[\"Arial\",\"Arial Black\",\"Arial Narrow\",\"Calibri\",\"Cambria\",\"Cambria Math\",\"Comic Sans MS\",\"Consolas\",\"Courier\",\"Courier New\",\"Georgia\",\"Helvetica\",\"Impact\",\"Lucida Console\",\"Lucida Sans Unicode\",\"Microsoft Sans Serif\",\"MS Gothic\",\"MS PGothic\",\"MS Sans Serif\",\"MS Serif\",\"Palatino Linotype\",\"Segoe Print\",\"Segoe Script\",\"Segoe UI\",\"Segoe UI Light\",\"Segoe UI Semibold\",\"Segoe UI Symbol\",\"Tahoma\",\"Times\",\"Times New Roman\",\"Trebuchet MS\",\"Verdana\",\"Wingdings\"]",
			NavigatorVendor:         "Google Inc.",
			NavigatorWebdriver:      "false",
			NavigatorAppName:        "Netscape",
			NavigatorAppCodeName:    "Mozilla",
			NavigatorAppVersion:     "5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
			NavigatorLanguages:      "[\"en-US\",\"en\"]",
			NavigatorCookiesEnabled: "true",
			NavigatorJavaEnabled:    "false",
			VisitorID:               "019DF718AA84020092EEF414FFCB79E5",
			TealeafID:               "MIzsZeZVW99J8gZ45fY-c-Lcrfqb-mA6",
			Webgl:                   "unknown",
			WebglVendor:             "unknown",
			BrowserName:             "Unknown",
			BrowserVersion:          "Unknown",
			CPUArchitecture:         "Unknown",
			DeviceVendor:            "Unknown",
			DeviceModel:             "Unknown",
			DeviceType:              "Unknown",
			EngineName:              "Unknown",
			EngineVersion:           "Unknown",
			OSName:                  "Unknown",
			OSVersion:               "Unknown",
		},
	}
	payloadBytes, err := json.Marshal(data)
	if err != nil {
		t.NextStep, t.Error = "refresh-login", fmt.Errorf("marshal refresh-login body: %w", err)
		return
	}

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    "https://gsp.target.com/gsp/oauth_tokens/v2/client_tokens",
			Data:   string(payloadBytes),
		},
		Headers: map[string][]string{
			"sec-ch-ua-platform": {"\"Windows\""},
			"user-agent":         {"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"},
			"accept":             {"application/json"},
			"sec-ch-ua":          {t.Requests.UserAgent.Sec_ua},
			"content-type":       {"application/json"},
			"sec-ch-ua-mobile":   {"?0"},
			"origin":             {"https://www.target.com"},
			"sec-fetch-site":     {"same-site"},
			"sec-fetch-mode":     {"cors"},
			"sec-fetch-dest":     {"empty"},
			"referer":            {"https://www.target.com/p/oversized-picnic-blanket-tan-gingham---hearth---hand--with-magnolia--no-aasa/-/A-94825625"},
			"accept-encoding":    {"gzip, deflate, br, zstd"},
			"accept-language":    {"en-US,en;q=0.9"},
			"priority":           {"u=1, i"},
			"header-order":       {"content-length", "sec-ch-ua-platform", "user-agent", "accept", "sec-ch-ua", "content-type", "sec-ch-ua-mobile", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language", "cookie", "priority"},
		},
	}
	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("Request error: %v", err)
		t.NextStep, t.Error = "refresh-login", fmt.Errorf("Proxy Failed")
		t.BaseTask.MaybeRotateProxy("Target", err)
		return
	} else {
		log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
		switch response.StatusCode {
		case 201:
			var responseBody TokenV3Response
			if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
				log.Printf("Error parsing JSON response: %v", err)
				t.Error = err
				return
			}
			targetURL, _ := url.Parse("https://www.target.com")
			var jar strings.Builder
			for _, c := range t.Requests.Client.GetCookieJar().Cookies(targetURL) {
				if c.Name == "accessToken" ||
					c.Name == "idToken" ||
					c.Name == "login-session" ||
					c.Name == "refreshToken" ||
					c.Name == "visitorId" ||
					c.Name == "TealeafAkaSid" {

					if jar.Len() > 0 {
						jar.WriteString("; ")
					}
					jar.WriteString(c.Name)
					jar.WriteByte('=')
					jar.WriteString(c.Value)
				}
			}
			safego.Go(func() { t.UpdateCookie(jar.String(), t.Account.Id) })

		case 429:
			t.NextStep = "refresh-login"
			if strings.Contains(body, "DCO_RATE_LIMITED") {
				t.Error = fmt.Errorf("DCO_RATE_LIMITED")
			} else {
				t.Error = fmt.Errorf("error refresh-login (%d)", response.StatusCode)
			}
		case 404:
			t.NextStep, t.Error = "get-login-session", fmt.Errorf("error refreshing session")
		case 403:
			t.Error = fmt.Errorf("proxy block")
		default:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.NextStep, t.Error = "refresh-login", fmt.Errorf("error refresh-login (%d)", response.StatusCode)
		}
	}
}

func (t *TargetTask) GetCart() {
	data := map[string]interface{}{
		"cart_type":            "REGULAR",
		"shopping_context":     "DIGITAL",
		"channel_id":           "10",
		"guest_location":       map[string]interface{}{},
		"shopping_location_id": "1406",
	}
	payloadBytes, _ := json.Marshal(data)

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "PUT",
			URL:    "https://carts.target.com/web_checkouts/v1/cart?cart_type=REGULAR&field_groups=CART%2CCART_ITEMS%2CPAYMENT_INSTRUCTIONS%2CSUMMARY&key=e59ce3b531b2c39afb2e2b8a71ff10113aac2a14",
			Data:   string(payloadBytes),
		},
		Headers: map[string][]string{
			"sec-ch-ua-platform": {t.Requests.UserAgent.Platform},
			"x-application-name": {"web"},
			"accept":             {"application/json"},
			"sec-ch-ua":          {t.Requests.UserAgent.Sec_ua},
			"content-type":       {"application/json"},
			"user-agent":         {t.Requests.UserAgent.Useragent},
			"sec-ch-ua-mobile":   {"?0"},
			"origin":             {"https://www.target.com"},
			"sec-fetch-site":     {"same-site"},
			"sec-fetch-mode":     {"cors"},
			"sec-fetch-dest":     {"empty"},
			"referer":            {"https://www.target.com/checkout"},
			"accept-encoding":    {"gzip, deflate, br, zstd"},
			"accept-language":    {"en-US,en;q=0.9"},
			"priority":           {"u=1, i"},
			"header-order":       {"sec-ch-ua-platform", "x-application-name", "accept", "sec-ch-ua", "content-type", "user-agent", "sec-ch-ua-mobile", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language", "cookie", "priority"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("Request error: %v", err)
		t.NextStep, t.Error = "get-cart", fmt.Errorf("Proxy Failed")
		t.BaseTask.MaybeRotateProxy("Target", err)
		return
	} else {
		log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
		t.Requests.Referer = Request.Req.URL
		switch response.StatusCode {
		case 200:
			var responseBody targetCartResponse

			if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
				log.Printf("Error parsing JSON response: %v", err)
				t.Error = err
				return
			}

			t.CartID = responseBody.CartID
			t.PaymentInstId = paymentInstructionID(responseBody.PaymentInstructions)
			t.CartedItems = nil
			for i := range responseBody.CartItems {
				t.CartedItems = append(t.CartedItems, responseBody.CartItems[i])
			}
		case 429:
			t.NextStep = "get-cart"
			if strings.Contains(body, "DCO_RATE_LIMITED") {
				t.Error = fmt.Errorf("DCO_RATE_LIMITED")
			} else {
				t.Error = fmt.Errorf("error get-cart (%d)", response.StatusCode)
			}
		case 401:
			t.StepAfterSolve = "get-cart"
			t.NextStep = "refresh-login"
			t.Error = fmt.Errorf("error get-cart (401)")
		default:
			fmt.Println(body)
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.NextStep, t.Error = "get-cart", fmt.Errorf("error get-cart (%d)", response.StatusCode)
		}
	}
}

func (t *TargetTask) RemoveFromCart(productID string) {
	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "DELETE",
			URL:    "https://carts.target.com/web_checkouts/v1/cart_items/" + productID + "?cart_type=REGULAR&field_groups=ADDRESSES%2CCART%2CCART_ITEMS%2CFINANCE_PROVIDERS%2CPROMOTION_CODES%2CSUMMARY&key=e59ce3b531b2c39afb2e2b8a71ff10113aac2a14",
		},
		Headers: map[string][]string{
			"sec-ch-ua-platform": {t.Requests.UserAgent.Platform},
			"x-application-name": {"web"},
			"sec-ch-ua":          {t.Requests.UserAgent.Sec_ua},
			"sec-ch-ua-mobile":   {"?0"},
			"user-agent":         {t.Requests.UserAgent.Useragent},
			"accept":             {"application/json"},
			"content-type":       {"application/json"},
			"origin":             {"https://www.target.com"},
			"sec-fetch-site":     {"same-site"},
			"sec-fetch-mode":     {"cors"},
			"sec-fetch-dest":     {"empty"},
			"referer":            {"https://www.target.com/cart"},
			"accept-encoding":    {"gzip, deflate, br, zstd"},
			"accept-language":    {"en-US,en;q=0.9"},
			"priority":           {"u=1, i"},
		},
	}
	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("Request error: %v", err)
		t.NextStep, t.Error = "clear-cart", fmt.Errorf("Proxy Failed")
		t.BaseTask.MaybeRotateProxy("Target", err)
		return
	} else {
		log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
		t.Requests.Referer = Request.Req.URL
		switch response.StatusCode {
		case 200:

			var responseBody targetCartResponse

			if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
				log.Printf("Error parsing JSON response: %v", err)
				t.Error = err
				return
			}
			t.CartedItems = []CartItem{}
			for i := range responseBody.CartItems {
				t.CartedItems = append(t.CartedItems, responseBody.CartItems[i])
			}
		case 401:
			//prob shape block check response
			t.NextStep, t.Error = "clear-cart", fmt.Errorf("shape-block-ccart")
		case 429:
			t.NextStep = "clear-cart"
			if strings.Contains(body, "DCO_RATE_LIMITED") {
				t.Error = fmt.Errorf("DCO_RATE_LIMITED")
			} else {
				t.Error = fmt.Errorf("error clear-cart (%d)", response.StatusCode)
			}
		case 404:

		default:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.NextStep, t.Error = "clear-cart", fmt.Errorf("error clear-cart (%d)", response.StatusCode)
		}
	}
}

func (t *TargetTask) GetPayments() {
	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "GET",
			URL:    "https://api.target.com/guest_payments/v1/payment_cards",
		},
		Headers: map[string][]string{
			"sec-ch-ua-platform": {t.Requests.UserAgent.Platform},
			"user-agent":         {t.Requests.UserAgent.Useragent},
			"accept":             {"application/json"},
			"sec-ch-ua":          {t.Requests.UserAgent.Sec_ua},
			"x-api-key":          {"a770bb029cbcb909b2d00ef9a5291f7189a4ef19"},
			"sec-ch-ua-mobile":   {"?0"},
			"origin":             {"https://www.target.com"},
			"sec-fetch-site":     {"same-site"},
			"sec-fetch-mode":     {"cors"},
			"sec-fetch-dest":     {"empty"},
			"referer":            {"https://www.target.com/account/payments"},
			"accept-encoding":    {"gzip, deflate, br, zstd"},
			"accept-language":    {"en-US,en;q=0.9"},
			"priority":           {"u=1, i"},
			"header-order":       {"sec-ch-ua-platform", "user-agent", "accept", "sec-ch-ua", "x-api-key", "sec-ch-ua-mobile", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language", "cookie", "priority"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[GetPayments] ERROR: %s", err)
		t.Error = fmt.Errorf("Proxy Failed")
		t.BaseTask.MaybeRotateProxy("Target", err)
		return
	} else {
		log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
		t.Requests.Referer = Request.Req.URL
		switch response.StatusCode {
		case 200:
			var responseBody PaymentCardsResponse
			if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
				log.Printf("Error parsing JSON response: %v", err)
				t.Error = err
				return
			}
			t.AccountPaymentCards = responseBody.Cards
		case 401:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.Error = fmt.Errorf("bad session")
		case 429:
			if strings.Contains(body, "DCO_RATE_LIMITED") {
				t.Error = fmt.Errorf("DCO_RATE_LIMITED")
			} else {
				t.Error = fmt.Errorf("get-payments (%d)", response.StatusCode)
			}
		case 403:
			t.Error = fmt.Errorf("proxy block")
			t.AddUnkownResponse(Request.Req.URL, *response, body)
		default:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.Error = fmt.Errorf("get-payments (%d)", response.StatusCode)
		}
	}
}

func (t *TargetTask) DeletePaymentCard(cardID string) {
	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "DELETE",
			URL:    "https://api.target.com/guest_payments/v1/payment_cards/" + cardID,
		},
		Headers: map[string][]string{
			"sec-ch-ua-platform": {t.Requests.UserAgent.Platform},
			"user-agent":         {t.Requests.UserAgent.Useragent},
			"accept":             {"application/json"},
			"sec-ch-ua":          {t.Requests.UserAgent.Sec_ua},
			"content-type":       {"application/json"},
			"x-api-key":          {"a770bb029cbcb909b2d00ef9a5291f7189a4ef19"},
			"sec-ch-ua-mobile":   {"?0"},
			"origin":             {"https://www.target.com"},
			"sec-fetch-site":     {"same-site"},
			"sec-fetch-mode":     {"cors"},
			"sec-fetch-dest":     {"empty"},
			"referer":            {"https://www.target.com/account/payments"},
			"accept-encoding":    {"gzip, deflate, br, zstd"},
			"accept-language":    {"en-US,en;q=0.9"},
			"priority":           {"u=1, i"},
			"header-order":       {"sec-ch-ua-platform", "user-agent", "accept", "sec-ch-ua", "content-type", "x-api-key", "sec-ch-ua-mobile", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language", "cookie", "priority"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[DeletePaymentCard] Request error: %v", err)
		t.Error = fmt.Errorf("Proxy Failed")
		t.BaseTask.MaybeRotateProxy("Target", err)
		return
	}
	log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
	t.Requests.Referer = Request.Req.URL
	switch response.StatusCode {
	case 200, 201, 204, 400, 403:
	case 401:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.Error = fmt.Errorf("bad session")
	case 429:
		if strings.Contains(body, "DCO_RATE_LIMITED") {
			t.Error = fmt.Errorf("DCO_RATE_LIMITED")
		} else {
			t.Error = fmt.Errorf("error delete-payment (%d)", response.StatusCode)
		}
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.Error = fmt.Errorf("error delete-payment (%d)", response.StatusCode)
	}
}

func (t *TargetTask) GetAddresses() {
	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "GET",
			URL:    "https://api.target.com/guest_addresses/v1/addresses?key=a770bb029cbcb909b2d00ef9a5291f7189a4ef19",
		},
		Headers: map[string][]string{
			"sec-ch-ua-platform": {t.Requests.UserAgent.Platform},
			"user-agent":         {t.Requests.UserAgent.Useragent},
			"accept":             {"application/json"},
			"sec-ch-ua":          {t.Requests.UserAgent.Sec_ua},
			"sec-ch-ua-mobile":   {"?0"},
			"origin":             {"https://www.target.com"},
			"sec-fetch-site":     {"same-site"},
			"sec-fetch-mode":     {"cors"},
			"sec-fetch-dest":     {"empty"},
			"referer":            {"https://www.target.com/account/settings"},
			"accept-encoding":    {"gzip, deflate, br, zstd"},
			"accept-language":    {"en-US,en;q=0.9"},
			"priority":           {"u=1, i"},
			"header-order":       {"sec-ch-ua-platform", "user-agent", "accept", "sec-ch-ua", "sec-ch-ua-mobile", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language", "cookie", "priority"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[GetAdresses] ERROR: %s", err)
		t.Error = fmt.Errorf("Proxy Failed")
		t.BaseTask.MaybeRotateProxy("Target", err)
		return
	} else {
		log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
		t.Requests.Referer = Request.Req.URL
		switch response.StatusCode {
		case 200:
			var responseBody AddressesResponse
			if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
				log.Printf("Error parsing JSON response: %v", err)
				t.Error = err
				return
			}
			t.AccountAddresses = t.AccountAddresses[:0]
			for i := range responseBody.Addresses {
				t.AccountAddresses = append(t.AccountAddresses, responseBody.Addresses[i].Address)
			}
		case 401:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.Error = fmt.Errorf("bad session")
		case 429:
			if strings.Contains(body, "DCO_RATE_LIMITED") {
				t.Error = fmt.Errorf("DCO_RATE_LIMITED")
			} else {
				t.Error = fmt.Errorf("get-addresses (%d)", response.StatusCode)
			}
		case 403:
			t.Error = fmt.Errorf("proxy block")
			t.AddUnkownResponse(Request.Req.URL, *response, body)
		default:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.Error = fmt.Errorf("get-addresses (%d)", response.StatusCode)
		}
	}
}

func (t *TargetTask) SetAddress() {
	data := setAddressPayload{
		AddressLine1:          t.Profile.ShippingAddress1,
		AddressLine2:          t.Profile.ShippingAddress2,
		City:                  t.Profile.ShippingCity,
		ZipCode:               t.Profile.ShippingZip,
		State:                 t.Profile.ShippingState,
		Country:               constants.NormalizeCountryCode(t.Profile.ShippingCountry),
		DefaultAddress:        true,
		DeliveryInstructions:  "",
		FirstName:             t.Profile.ShippingFirstName,
		LastName:              t.Profile.ShippingLastName,
		PhoneNumber:           t.Profile.Phone,
		AddressType:           "S",
		DropOffLocation:       "",
		BuildingName:          "",
		SecurityCode:          "",
		CallBox:               "",
		AddressCategory:       "",
		SkipAddressValidation: true,
	}

	payloadBytes, err := json.Marshal(data)
	if err != nil {
		t.NextStep, t.Error = "set-address", fmt.Errorf("marshal set-address body: %w", err)
		return
	}

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    "https://api.target.com/guest_addresses/v1/addresses",
			Data:   string(payloadBytes),
		},
		Headers: map[string][]string{
			"sec-ch-ua-platform": {t.Requests.UserAgent.Platform},
			"user-agent":         {t.Requests.UserAgent.Useragent},
			"accept":             {"application/json"},
			"sec-ch-ua":          {t.Requests.UserAgent.Sec_ua},
			"content-type":       {"application/json"},
			"x-api-key":          {"a770bb029cbcb909b2d00ef9a5291f7189a4ef19"},
			"sec-ch-ua-mobile":   {"?0"},
			"origin":             {"https://www.target.com"},
			"sec-fetch-site":     {"same-site"},
			"sec-fetch-mode":     {"cors"},
			"sec-fetch-dest":     {"empty"},
			"referer":            {"https://www.target.com/account/settings/addresses/new"},
			"accept-encoding":    {"gzip, deflate, br, zstd"},
			"accept-language":    {"en-US,en;q=0.9"},
			"priority":           {"u=1, i"},
			"header-order":       {"content-length", "sec-ch-ua-platform", "user-agent", "accept", "sec-ch-ua", "content-type", "x-api-key", "sec-ch-ua-mobile", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language", "cookie", "priority"},
		},
	}
	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[SetAddresses] Request error: %v", err)
		t.NextStep, t.Error = "set-address", fmt.Errorf("Proxy Failed")
		t.BaseTask.MaybeRotateProxy("Target", err)
		return
	} else {
		log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
		t.Requests.Referer = Request.Req.URL
		switch response.StatusCode {
		case 200, 201:
			var responseBody SetAddressResponse
			if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
				log.Printf("Error parsing JSON response: %v", err)
				t.Error = err
				return
			}
			t.ShippingAddressID = responseBody.Address.AddressID
		case 401:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.Error = fmt.Errorf("bad session")
		case 403:
			t.Error = fmt.Errorf("proxy block")
			t.AddUnkownResponse(Request.Req.URL, *response, body)
		case 429:
			t.NextStep = "set-address"
			if strings.Contains(body, "DCO_RATE_LIMITED") {
				t.Error = fmt.Errorf("DCO_RATE_LIMITED")
			} else {
				t.Error = fmt.Errorf("error set-address (%d)", response.StatusCode)
			}
		case 400:
			var responseBody TargetErrorResponse
			if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
				log.Printf("Error parsing JSON response: %v", err)
				t.Error = err
				return
			}
			if len(responseBody.Errors) == 0 {
				t.Error = fmt.Errorf("error set-address (%d)", response.StatusCode)
				return
			}
			if responseBody.Errors[0].ErrorMessage == "Invalid address format" {
				t.Error = fmt.Errorf("Invalid address format")
				return
			} else {
				t.Error = fmt.Errorf("error set-address (%d)", response.StatusCode)
				t.AddUnkownResponse(Request.Req.URL, *response, body)
			}
		default:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.NextStep, t.Error = "set-address", fmt.Errorf("error set-address (%d)", response.StatusCode)
		}
	}
}

func (t *TargetTask) DeleteAddress(addressID string) {
	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "DELETE",
			URL:    "https://api.target.com/guest_addresses/v1/addresses/" + addressID,
		},
		Headers: map[string][]string{
			"sec-ch-ua-platform": {t.Requests.UserAgent.Platform},
			"user-agent":         {t.Requests.UserAgent.Useragent},
			"accept":             {"application/json"},
			"sec-ch-ua":          {t.Requests.UserAgent.Sec_ua},
			"content-type":       {"application/json"},
			"x-api-key":          {"a770bb029cbcb909b2d00ef9a5291f7189a4ef19"},
			"sec-ch-ua-mobile":   {"?0"},
			"origin":             {"https://www.target.com"},
			"sec-fetch-site":     {"same-site"},
			"sec-fetch-mode":     {"cors"},
			"sec-fetch-dest":     {"empty"},
			"referer":            {"https://www.target.com/account/settings/addresses"},
			"accept-encoding":    {"gzip, deflate, br, zstd"},
			"accept-language":    {"en-US,en;q=0.9"},
			"priority":           {"u=1, i"},
			"header-order":       {"sec-ch-ua-platform", "user-agent", "accept", "sec-ch-ua", "content-type", "x-api-key", "sec-ch-ua-mobile", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language", "cookie", "priority"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[DeleteAddress] Request error: %v", err)
		t.Error = fmt.Errorf("Proxy Failed")
		t.BaseTask.MaybeRotateProxy("Target", err)
		return
	}
	log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
	t.Requests.Referer = Request.Req.URL
	switch response.StatusCode {
	case 200, 201, 204, 400, 403:
	case 401:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.Error = fmt.Errorf("bad session")
	case 429:
		if strings.Contains(body, "DCO_RATE_LIMITED") {
			t.Error = fmt.Errorf("DCO_RATE_LIMITED")
		} else {
			t.Error = fmt.Errorf("error delete-address (%d)", response.StatusCode)
		}
	default:
		fmt.Println(body)
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.Error = fmt.Errorf("error delete-address (%d)", response.StatusCode)
	}
}

func (t *TargetTask) AddToCart(Tcin string, Qty int, PreCart bool) {
	if !PreCart && !t.shapeOK() {
		t.Error = fmt.Errorf("missing shape headers")
		return
	}
	data := addToCartPayload{
		CartItem: addToCartItemPayload{
			ItemChannelID: "10",
			Tcin:          Tcin,
			Quantity:      Qty,
		},
		CartType:        "REGULAR",
		ChannelID:       "10",
		ShoppingContext: "DIGITAL",
	}
	payloadBytes, err := json.Marshal(data)
	if err != nil {
		t.Error = fmt.Errorf("marshal add-to-cart body: %w", err)
		return
	}

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    "https://carts.target.com/web_checkouts/v1/cart_items?field_groups=CART%2CCART_ITEMS%2CSUMMARY&key=9f36aeafbe60771e321a7cc95a78140772ab3e96",
			Data:   string(payloadBytes),
		},
		Headers: map[string][]string{
			"sec-ch-ua-platform": {t.Requests.UserAgent.Platform},
			"x-gyjwza5z-z":       {"q"},
			"x-application-name": {"web"},
			"sec-ch-ua":          {t.Requests.UserAgent.Sec_ua},
			"x-gyjwza5z-f":       {"A3mGPJOdAQAAFgJHRlnABQ529LKQj-1U1OJsev2A-Y6_oumH2GeQxZhAr9jvARgWKtGuco1HwH9eCOfvosJeCA=="},
			"sec-ch-ua-mobile":   {"?0"},
			"x-gyjwza5z-a0":      {"80EHJ=eyZEom6V4w_ohmAxIfn3lNnQDIoqjRgtqEIVvtVj41KZ8d6zKGV9eFEMFED0kWjeMtA9Y3WmO2Y4aF9A4jcsJVUg=Jdz_asFbA=F=wVvBxsHq6ENVCKshzV-OJLv=4c2HLatmGp7aYlnuD13yrAMSLDmhFYNRBx4SQP=Ltd=glEG5xjl7bAtA53QNtO1I0Jq9nLdUjOHFKoLFQ2LsIJC1zxtKoXg4gKxsv3UhJSZjoRzmLecqZ6LA0PXZfQ-=pr_0l3Y6a8k=r6PulyYA3-ZGfTuN2uTyjvTQdlbKofBYRnG2O_tV9dLELEH9De40hL4HFGZgSU5yGNlnK7s-zfuQkd1g-WqAmjy3ujz0bhm7djryZr_a2xTCzC6brOc5sBdcMsl9=ODlvcFxBHhQKkyCeb-MBFOjOQk0rmQKHsSPTzwpgTdKrrBRC7O5JqnmVd3dIz6cDsJ9a=dQgP9W_-Be0BU5l3R9U5n=TV_Ldd2uAvMMunUaAfMLKk5hs0V9=UFqnxh5tvzH1Lbp0yudV4QKuXL7gvyRm=Ham5DCLBJrVr=Qu=dcHp0Z7K_h1EN3eS_9Dj=1_GAWYUg5SwPflDl1r0Gt2OMztocgXI-A68HTPq8dp6L1RA7ZfClqd6nNPWs4=8m5s40qq7L8vZaRKNrvgsaT=7aAuK_GZmGWGT4SlTNSIj7ILt=stWPUxcpIIM8tKqAXemApDPX9X6DLA8dYu7=dIU3TA-1u4rOddEWJu4jgz3cMwSQXzcl0eCsmH=nbmQPSzD5SFFoF7St3kbE1f69sA2jHRqNAqQbTOrbc91ZIevC6tEC=Sd2GCSlsnOwWmJsmrW1PvaptygU76rW0l5nofkarzaZ7xMdNv8asOSYf64XrMoJIZYj1W1Ycn3rqv8-hb=5gDw8EqOc6X0LRE8r6bBm2eyUp-kN0GfQnqfTmVwsGUOwQDUtuxaysBoDFoysstAMyJUVdIMfeoGEmuoOfjQj5Muf7b9JAh4CQ7GL2mD6j8zJ3MqayxfJR2WV_YofWNjmLspZWLG9VXhQGmpLaFM92g2aqCnLAuZKKRQWQd08V_a_zEjg3vhXahqd9OqVL0z-GMt2QTc7RRJam7B_Z5c22-EEawyTXwN=qhnWMaH65fmkjXhhzBNcOjqULlb0=Qqmd819dK5UyozzAyLGUMR-SJszOG74cFInmjKbeuyznzuquefkrLukl-tjEd4TCoFPkpxZQcuBsB=j0saleHMOS-S8LWd1oyX5VRktujX62g=yf_Pm36w4TTQ8yTlvaqC0QwhHtK=DUNcdkORc_FckB8k3Qlyd0=jZlNFWwdOEDrleQYBeBINOSUza8FTrFzcFrD1pU4GcgHZrAFld3tbyO3veB7oSF4K_UKMmTUk3f8GfTJF6Dlsp5RV8u90BoutYz6FtC1znwQtNp=TaRAVusfLQ2tQn3D8_k4Yar1ILB_klEZojNZsVz8yBwmkNJOZ=I5gdm3uEdrMS91D3J9DUY29M_dK7IFSbBn7EdMJzHWKoey2peP5MGCNXXE2VZyMU4A5vZm2YM66bOy5U8=eGtwymYtNAgdUFjHS8jcWbRLxqQQE5gO9vcAL_TQ3QV1K0GtJ-79avss4uuRcOzKkHnZVIs4rGFBKewZ4Y5_lel92czy9__nE3O2VWmYa7495CnADAYAxl2mADFg2JkVx9XLxTeCNT3vgFay_YWN1HcNJb839KX8cLFq_sBCHDyMjw7urtvfPXAQJXXjI3WPEV9bSHE8tCboedo5UBfdB7F-hTaIZZVz8pmNW2N4a1WL7w2fjBKcr39wB-zl672kDnhOSge8O91CkO6r=enfuwcs2wfJcF_DWfc0Y=pupsGkpW85jSmW1vJUjjvNkZsfQvO1AaZ7=oa9c8Bg8MHcWPoZBM5RaqjYaz=b1DYSegO5juva4oj-PArtaab8o_8OGW6hXzpAmGC1kcUrvdmaEqo1ZhqUDTpZ2z_1vrLkb1YJBYV__G=HvppH3T1EnXW216unYbVvX43r-8UKrGU4BMnzcZzok610m0enBN-bz6J6o=rMRf66EwvLLs9lrW5Wkd3Vqx-"},
			"x-gyjwza5z-b":       {"-a52sha"},
			"x-gyjwza5z-a":       {"slkayX4cjEjg_bzgAdCJBldxZH4drGO5lOPM_Dtr3FddeXsZBrov9xXOkAflTU=ryR=E9cvocqlxgnfB2P2WmKBKhStSthcZ-dgDNNgNlv4CkHQvD9HFP4qc9lKIxb3Qe41cGROq1HSwL_q-UdTLaT0nTT_HR0a1-LNs5KD0Z9ORMT3A0QhEfvERTPhEwInsXkT7DuFvNSDsE9xoK3f=SXo7zYxnBosvuJvRntc5G38AYMlbcX=RGZAe26Z89YSJV1f-Z6B0cZ3PANz8__dMQc6F3MzqpkOEnKG_OI8-=NGnELqRCeCdftwRp2EKQcj3DFNMbWpQr778Z_Oq8Ssmo1p4-LRF4tv3oLh4w3nNUEefI3xjNN5urrrV4CRdqrkg1Idc8PVh731TO6hwk-q4=dRceuaKCC-7W4jzwe5V=-Eg86NdthCeFCZpYXIb5TQ2CXXQZyB=BuMkpWk_nxuP3tuUm0xP6UQ8TH55u6BQskSkNMIGUKouG6bcM7W0UE_mQQlc571=rdCFBJVXJlybaU9auQqd=xH-M3oIU47Sxfm-2k5LkPNo7MX9pP81J4otv10eD_WWZDS_mQMrIH-mnvD2WdmWDBaP4EA1mt1mPt9x1Qf95XZaqF32J7KzfaOsIfgwsFMCns_Az7XgCdvlpuBSrxUMUsqRh_2MmVm392h1x34=Z1W6uUGRCyAf2eJ2EVxUUSerCZzuVBAU3Ajdx2ybMdH1o8WTv=P7xYPfKj94DgqlN=aDquz1sSTXmll1zJQtDL0ZXJtZ4SO_VhX_37waeWpBSj-gQc3l1g7Ezcw07eVjmMydCx33wzU0muYufAsBn6o9g2=Nncab9oB3GXpfgcCG8W=vRR9n-YHG83SrrsKIBk=nnG7wEZjsYjZ60tAgeVIw9=6ZmFC2CAwR36d7UDBvHf=ePdkMCjFszIF63P-1RPdA2o_L7sGqmYt5uDVRybIEmr90BuYdJSkwghJuFkJyIExBC4hlUQkD5vHV9OEDF6P-GfXKA0TWafdqoYyaUgR3p9WTSb0VvrsStnyy8LAHNY2y3S1TZNPBWleXJ5nCGBmkbWIYDmLrBWIcoy_Iz_Yd2AraM6fX9TIM_E6mIEHzW4ZKkrVxxrfmDWN42qmjzxPo5LjQc0rQJjxNvzD8UO20chO-CZrtZArY25Xzo0hOlaLmRoHX0T42J8ed87cnrCmHYRH9YkK=ETIg7vb7ZlfFF-TBvNCz2l5Ax5u83vF2SsMuzRh5n-FBkSXwDK-QM4l281hPb--UWvTZflaw2Z94OfwqD47Br10NCmDqYp8WIyq5c-EuoCTHGZwlOu6vBkmE6FaTyclq_w56yZHhBoxYO3P8L4U4z6lO-X7RY6d9z3hRDQG8h7Yke4jB5UFJDuqQNoYC00CEuaStfJn08BNdTbghxIU0OLE5gxjd4I=Q94HKdPPhzKuQoD7Qoy-dg_LxVM8176l-dFslvY=BszBfn_=cmUf1pADQdDRTwZKQsf_tMJOWgOxntcxQ5VYrPyTOQOGOEUVmNWN76Tcsqpl6yaDl2Jv-bDFS0QaLjOgqgUzuo5byNHJ27nlVDTjrQGpBNevAOvAYNcgotY1P5WeLPt0wzuX3VrS4j65y9fagcx4IY==jV3fS2ZCG33=cFswxdN6J8LgTSqCulk1qKeb9ajF23XtVOWU0Ua6b9u4WdW1oEhu=-cq4bu9vbk2bDE-AOxjCxesV7zQNqZkXJrJ_Df4Gss4TOzIkJ7KBTAS6Yt0jkHHVNqMV-0c8lef4s1dvDu8NWqqN-Qjp_dNWN67x6ne=htmHtzAwcdMW9lkFr3ICya5Gx1AMkufChrTpne5BWtaAcZQMc=qSkRCauXV3FSLDX-=l-wrCcxoU0HBVs71Slka7x1cLm8SHQ09cIDVts7F-EFjo5SsMFh6bBpevnOA67mjtx3trkfk-=ArpnyWSuxwgd99VwLOFO9vawZ77maM0UqGyW0DOUjReGot2TCyHoRAgtO_VajfZsVpVl73rnxHIQQjmvwauySBETXvd0QgEoAQToTROGcvMO7jsE5gmDM_nZQwvQDJ=yVn49jY4zG939D1nqAGjZOO2BWKrM1ztQfMMBIRhMsKKny8DA6vP6R8nDIFF4-8LZ4Wcy-JytqSafshboqmefzVRhzvaUM4nGkBzwdymTJkPleWFnN_yu6MwcL5pT2vlDEojAOvBcrLkmAlvBAb3d2O2Ry8VkBk_DoT4o0mpCZImPpkVcS5rDSqTgpxUOScDfLrS0QBxz92W4ptzlSAw5W5f-49=GH6cZulXGf8M-RNwCRf-XcKX4SX3p2n=4QLF4d_6soGsjOhVOkqlOESPRWqW=NF5CN318z6o26g9pW=sfatJmlGQypRxlzDtkkenh8Relk2B66y_87J5SjzeKL-ZFFFx5zpwDZsmuVb96-YCOO4cz2jHjrpx-3yQaauebJAalNmbEsWroVJ4kxw-KlhPygXJ6j1=qBr1J_ml1CmOSwcJo_ODoH2ZV_-G0OT5Epvmm4crSfWyZmkdQyCNhTs_vABSey_Zu=1AeBEPfTb2Nw5_BqA99wVfbC3IXZPG8tlgufDU4LIsDGtJOzj73YO_Kp8T-OWdjXFJrR6IwS--fj=WnxOZsF0IE-Djr8LC29NLgEfaNjd3XTJDOI5NeREe14FE7cqIU8Ftmr2xzrYKkKGbTQKaSMkuHslyreQ4hhTnf2LfzBzEc4q0-PPMVT0d9ajIP7MJ=vNOLZ-=KU1d_uIUAl68D3rxfsybcB078nw=Qve-_a0p8BbuHUX_SoRl3nUxjQ=B6z=P4-hm6GFg3sLcEBGOGxDaqLXojZDV0eQ89rvpO-BxQaNsvtYF3bMVCHYhNa-1INmQg=hynz0TVvf8NDKmFk1zSCV=NG4w0Sd4TQLGSXOhmZupSYnePK5mz6qO6VOX0SLt6LSG2rIfJRnYGEXGjK9nqaI0fTuzwpNpuqfNsWz0klW=fZx3WqhQCVzSTcOP84ml2uE_p_lpOkebbQrTZIykpbD6JDAASKtUcuxRxf5YG_UIfRIvE8HogZPKVePgGmWlLIRLPLT-uR_cMs-4yf5buAfI5T6dZkjDcOc61OIdoNCgDf_1E-tpoIL8v_hZ3BrDRm0so3ldbqh_njt7oRM5IPBmVAD7VhSQK1cwg=dHtyOCAeMvr_UBbgE5_VKWLzbToe2js9J41uapjeCzCQQwcOKTAupZh8o0Zwqm8u1VN0zLvqAHOLPF=pIk-KnjOT1SLLYBxyyzdfl2Bt2yy2FewURamrrBsqY7yUnffU1kYYH6kvRlD33VztxSZXGcIFdTycTLs1pYK_snCJZMlEf9o10ChH_EtjjvsFrXGj4YnkBpDe6luL=yShf4Wco1kj0DOBcla4yWenu28XDFAD3ILClnhUY7lbad9FgWkVGZR9ES7k04XWFjXKxZjYYNtl_EXSmNY4-z3Xlj2hjL=5aYWFK5O_j1E9OA4G_yKUbAxuU7SU2NSFKyUu7ERr3j00xZ248a53CZUO9KY2SmNIQoW_GZ_MoD3dM66lNKMZsS_aDgEx0PhdcZf0BchDyIBcb_N=XqYUYldnvZGa8YGdDTfka0=LZbrbYU8l2bSwFUgsJN02AEAJDMDOzXwW3o=mXKhpDc5g2ojB1MNeIAFuNmn3IhR4CbT0lqvjOZF8R5opY6dTt8SwTaL_E=e=eVamQycPmsP7FLJn8eVmyLUM0eemodV5hzC2q-b=hmjqAwCxzJ=Jrr4tzVM49HH_6JKcE1VTOxARnIRLHPLkFm_zBrQVnHOpAjlg8wtF2lxZJHzm904jThZSk0_Xd10tdQ1Sy25ZeKv8TTqDu-la=X121Jd6kb_M1-BxRLUsQur4aDSUjsN9FHWO_V6pSnGtssj=vpPr6A=y2S40EoEQkbWOU1p-JZhTRCzvTjBd8mdA3A_RXGKa4XP03OwRXRP2JyXnINrhr86-19lW93gaWa5PLeU4=ZG01k12hpSS4XakDkA8JDUGrJzSOYcxoKj37huZ=RPsyke2hJezERNGvXCXolSTTpDR0M_z7UGgpbbMjSB82Gw-yLjfMBQNMGkWb-M7tFqnWEzLfuzfwXuf=2X3-8fGHnfLsTuR4YJaqujrjvvnk6DXaKS5BEn6SEm1=WfwnrSujJSncODlPqEvbPhjnjU-YzJ31uefQUcRv_15pRKGHO0J8kXKTt=gEoJILcPZyMLUXGFW31ybQcp_cc09SY7ALy1L1T2Ob5KbE7Cg-978eFzZSO9porpWlSM4TawkV2MAT2zEfwwelOqWcM6WAhts5c8oGLDJNLLEygCzQ8fss-HfBy4LC_dptTtXyFHMd0yvvLyz_MUYDzgGZ4qATU18yC286_eAG9eo7k9zKqVsam4-YNCSk_Ad3eN4xdzMcMYSKy43KHJ5mCF3XQ_AOsYILSvQydj1u1=N_luX95NfMcPyWWITws0T3Yk1UH0dvcs-2UTTn9ZASIvPrtYe8pbFMGHxjdUzUbn4X6s4V121HzNvqEHGZ2c2pevUGRwKXDRw4h-bxym_fIdkkaNwh=-AlcZEXMCeaLC8CZVpxvE3XK4mMNWOuADxMnkmCxZBDB4JJWyg6_9HMKNOTVaxsw9f9F49Dbg=nl1Zk1-aCymIt6gnjgrAu49-W3gdD8oH_RNGtkZUMNNQOw1Wp3t0mdHR4U_K4osEJ=7TSg73ghZuyqwvnhdNl3NTo7uB65YFd1BFmdB2BGc2=71D5pX0wv8NAa5_n8FctEG2F6kQuZkbXfZ0leBTWj8k3o4aJNGPMvr7c680L_UB1bRmIaH_2a2w5ub9q54aEPIOX0X6AlYKZYXhAcfN36eJ_AP9EJ6IHzMzl0bE_XdIAv7zPc14RGaCw3ct7tju_H5Z4UQ8V6leA1=WKF49SvyyYnPwv38cujMzGmuZCFJYwAX9XLLTgNEtdJzGCQNTnko=x1r_1N-oUXTUQ7jFQSx-GuzW5LbFP0E11567MotUO8kK23-xD8hp6YjqKf4s7llT2m5mvEHmMZA_G6Uca5Gl0hP9X-7SmRoCwnB5mhCFCRg0q7CewHSwDty3tO_r2LYw1jppNMgRU=wEudHzkeZdmEuVzSgg3lqklkSBpV7DuUz_P7ymdoZrly0CdBonP=d7DPMI6rfbgrYuGGJL_mbdbVGQdbI4qzAt8LPB3LOKCjkt9nZWMCvYSelCs1kyhE=xa5GgO7ONIZ4eoOpnS5=sKf_=s9cXgVeXGOS0MmOz=ZM95kMVI2DRH8X_Z=FTM=MbA5b4_cZhWPp=BtaWuwoJ5y_hQ9RLQRyhTaEPXz5h8p=2BIBNPVml7mTYx93Rw7mGWbtLjraRWP1_WA8sRDYdXBEDIRxftk6HGzqeKHrFuVWD8Dml739wr8y_4x2F87w5TTorxOdaDYbrruN81KyqhlJlS2WeTXD1JluwXXfTMxNrJlTU-jBSL-rFsUJ_zDgaFPeTOMZKFxjOj27R_5g5_ysYsa5kC6N8LdzOaPrdfaE876n_jymSKLnIc_Xw2txkeOdDcCVM2Tfug60gxjjwKeQkC6w9BpMCOUCNg54XjlvHDs51z=pPN1AVeVIwe-2ewOJ7GbB3DEEoGRYMSGR-G8E7SfA788ZP3QC4gGByD0rANllwTwKQK9EP3TVDOQS74X2JK5v0uatnAKmh9phyHAMcPN6FW6YZtdOq-fY288vEdvUFtjvQPXtryXonlusUmVmj1FuPBtJXKv=5HzFfTYSyF5NkbZ7YT5yanWyM3JTv8l6GNVPSpbw7zn2wZZqN47coGj3P9ZNnZEqQZwJOwgkROZnXSn=-SAw=STeAH9=QMQ1Qm0bbqSZLryNypEWYQFo7wbm9_B07X48olvxWeyVjzJeOkxJhEmKEUcqlwuBlQ5jQxubwfITP3WkyjE5Om8E1dn2jXyTQVl9Kjal1ul7zX4Zp3=KADqhFE35k2aZZ67owUjLJJn3n76Dv_Yhj0_q2x8QcQuXjO_Fyg28avZ-p8YjB7Pg5hGad6E0ZRHq35Mxur69Q1RPxBN-USfL15q7QCVIGSbNjohxzEj8oSjp5GDq7fVlaz4EfPLkLeIVbgdbtfV2jUtQxzBI6e5Y1S6C_f1xm2S59L=XFZkCM8Z73zRqp8LTccnqreheGGJ3fYyYvWYRydgusRHqCBlkDoIqv8=g9jQKW_NTCWuTXghthwk4AFW=V_uevnLgDbreWleM0GHNF57xzvzd2YA8NBfMEBA06Um52gLqqsjbbUWQ56Hq45UXlOsdfZMTvoFAkQYT5kjsghtD-mQE3FGEkoqM5KyKHabN=Oc-l3awo4cSMU=MLEqnJFOYzRYcQr8O5H62VNMNPoUAxhXN4hzTmsqIOkjysv=OdfwoYz0euKswsnr19bgvo9zPTSnGqnr20cvO5U4dB3-JAtgcYRSB8jEFAjbgcl9EbP2VC=k9kx8jDNNQtxbcMzMbozKPu9KNfrHb2RXr8vVcYjjdEx-gQa1uVEqu0UVhpwPqZLC__lJoWFaFUtIPXtmhkp6cbz9YpQOCEzNNJvgx2VBErzHZodan3OvFSLgGs=OoAn2cAvVl_qaZ61OS7c0HDKp34Sbp_w5q7=M9U9FWmQZP8cg7oM6rpZZfgaH1nrRV1mc1M7ubIYUxF6V_SjfF8LP_Z1bGAA4TJuDdTTH2R9kPgEZWPbSWCNxn8wwfzmsfh3QuSRm2pSzUHnNhG0Sye=3A_E1pryEWLo65Wv2Zj8Hmrxl2EBrRJkkf2ze2vZ1ppCCGsHfvR9sT6GXCHJ0hqq0Ig4YaL18YhxA8KwuYMuXDPK1zpak85R199XxlVdmA2XIVktpZMjhH4-VnV6V-uNRTyjnTf-N1P16a8NUjcYg55-S9Ks1EnOA_Ml_uJ=0A6jdLBhNk6JeKa-bq2vuYYZ6YbgJEDYIaQn997Vmx4SsvamzYao=FJ99D0gxudxfwq=-CO=LJZHuLKGPHAkb1VfKH4oDJ=BU_Oz7IOCds0esmELI=MRbd-sC_=aGEQd2pTTgqeeOme=D5WooIjXZNcLWyaTBJtDDH44Z2GCrl=ablR08rkpLvrGue5egr5dkGjw3vfQ2rjfDI5NOnOklvufOHh6Xb5ucAA10jK8sEZ5WNmRHSSPRjqwnYPfKseI8FzW_CSZZjw2DaMdOqj2nOFXoY5n7aV1kUqbR_9O=yOmzH7CyRF823Qm_rgPS0_elAoF___E7j1_5TQxPt3G09cWLYE2-KmzoNFzEkHCrhDUK2O5VbMTrHdKaT2-fsYSA6VgXLTxAKmLLWtSkOX9C464nCyRQQIgX=M2ShI4jFxySH8a2OXKFj0ukjLCadk-bj9SJslsaXdjz2J8lwlOeW7AtdrBS751OEF9wGrMdmNkSonON_bnAqzmZpO2RrrvWSdIST2R3QwEy4wGsH6TXQxmyoAg0J5L0JYA1fCwuoCo_c=eDVsp8kZzFWf2ts5kAkCfW_g74wEnpuBS-ZFnTrPtvmPWzedHlfpmFW_vtFWEEo_AuXL_FUd8Dda-2W0QVqcaPppevoOJw2y-9WcSM5ANtG2StfXSw9leUwpflHCJdljo7Qzz-jl3CyL34xHWlU3drBA1kc-Euq8u3yKsKeVHqFRmoOHedb9ov9KCF3kzql=oEHsp8Tqcxz=zpgprRzJGtGfvzQmFF4Oj6zIlKud7sazsbqxK85Zzg1luoTEeCI9zO8DJ4tOC22hUDz0mW657ncfVCj2Ffu3Lqyz6HWFLSyZtyyxc9ogU9xfyq7TcpjzNWb-MxkUr_cWspEnSmzqeFrDqU4D_FM=OVnCbPYl=4xEazKtQUa4ylMA=hDrzWhorzo8Lp8LSNVttdtOoh0tFDfXXKz=0Uyp-4-TYxQtQX5vo0lbZ4cQCRv1YopIVPfP5="},
			"user-agent":         {t.Requests.UserAgent.Useragent},
			"accept":             {"application/json"},
			"x-gyjwza5z-c":       {"AACHKJOdAQAAEIv0UExGOwRh6wy9B69vae3J7V-TxlF_OsD_XjoGTvLlBzAW"},
			"content-type":       {"application/json"},
			"x-gyjwza5z-d":       {"ADYAhICBAKGAgQGAAYAQgISigaIAwAGAyPpCxg_13ocR3sD_CLzTADoGTvLlBzAW_____5yYML0B18FuOhmNl44QGyKNBDOzGg"},
			"origin":             {"https://www.target.com"},
			"sec-fetch-site":     {"same-site"},
			"sec-fetch-mode":     {"cors"},
			"sec-fetch-dest":     {"empty"},
			"referer":            {"https://www.target.com/p/charmin-ultra-soft-toilet-paper/-/A-54605734"},
			"accept-encoding":    {"gzip, deflate, br, zstd"},
			"accept-language":    {"en-US,en;q=0.9"},
			"priority":           {"u=1, i"},
			"header-order":       {"content-length", "sec-ch-ua-platform", "x-gyjwza5z-z", "x-application-name", "sec-ch-ua", "x-gyjwza5z-f", "sec-ch-ua-mobile", "x-gyjwza5z-a0", "x-gyjwza5z-b", "x-gyjwza5z-a", "user-agent", "accept", "x-gyjwza5z-c", "content-type", "x-gyjwza5z-d", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language", "cookie", "priority"},
		},
	}
	if !PreCart {
		datadog.Info("cartAttempt", map[string]interface{}{"event": "cartAttempt", "site": "Target", "task_id": t.RunID, "shapeMethod": t.ShapeMethod})
		h := t.ShapeHeaders
		Request.Headers = map[string][]string{
			"sec-ch-ua-platform": {h.SecChUAPlatform},
			"x-gyjwza5z-z":       {h.XGyjwza5zZ},
			"x-application-name": {"web"},
			"sec-ch-ua":          {h.SecChUA},
			"x-gyjwza5z-f":       {h.XGyjwza5zF},
			"sec-ch-ua-mobile":   {"?0"},
			"x-gyjwza5z-a0":      {h.XGyjwza5zA0},
			"x-gyjwza5z-b":       {h.XGyjwza5zB},
			"x-gyjwza5z-a":       {h.XGyjwza5zA},
			"user-agent":         {h.UserAgent},
			"accept":             {"application/json"},
			"x-gyjwza5z-c":       {h.XGyjwza5zC},
			"content-type":       {"application/json"},
			"x-gyjwza5z-d":       {h.XGyjwza5zD},
			"origin":             {"https://www.target.com"},
			"sec-fetch-site":     {"same-site"},
			"sec-fetch-mode":     {"cors"},
			"sec-fetch-dest":     {"empty"},
			"referer":            {fmt.Sprintf("https://www.target.com/p/-/A-%s", Tcin)},
			"accept-encoding":    {"gzip, deflate, br, zstd"},
			"accept-language":    {"en-US,en;q=0.9"},
			"priority":           {"u=1, i"},
			"header-order":       {"content-length", "sec-ch-ua-platform", "x-gyjwza5z-z", "x-application-name", "sec-ch-ua", "x-gyjwza5z-f", "sec-ch-ua-mobile", "x-gyjwza5z-a0", "x-gyjwza5z-b", "x-gyjwza5z-a", "user-agent", "accept", "x-gyjwza5z-c", "content-type", "x-gyjwza5z-d", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language", "cookie", "priority"},
		}
	}
	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[AddToCart] ERROR: %s", err)
		t.Error = fmt.Errorf("Proxy Failed")
		t.BaseTask.MaybeRotateProxy("Target", err)
		return
	} else {
		t.ShapeHeaders = ShapeHeaders{}
		log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
		t.Requests.Referer = Request.Req.URL
		switch response.StatusCode {
		case 200, 201, 206:
			var responseBody ATCResponse
			if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
				log.Printf("Error parsing JSON response: %v", err)
				t.Error = err
				return
			}
			t.CartID = responseBody.CartId
			t.CartData = responseBody
		case 401:
			if PreCart {
				t.AddUnkownResponse(Request.Req.URL, *response, body)
				t.Error = fmt.Errorf("Shape Block (Precart)")
			} else {
				t.Error = fmt.Errorf("Shape Block (Cart)")
			}
		case 424:
			t.Error = fmt.Errorf("Out Of Stock")
		case 404:
			t.Error = fmt.Errorf("product not found")
		case 429:
			TgtCartErrorKey := response.Header.Get("Tgt-Cart-Error-Key")
			if strings.Contains(body, "DCO_RATE_LIMITED") {
				t.Error = fmt.Errorf("DCO_RATE_LIMITED")
			} else if TgtCartErrorKey == "FAST_SELLING_ITEM_RATE_LIMIT_EXCEPTION" {
				t.Error = fmt.Errorf("DCO_RATE_LIMITED")
			} else if TgtCartErrorKey == "ERR_A2C_TCIN_RATE_LIMITED" {
				t.Error = fmt.Errorf("DCO_RATE_LIMITED")
			} else {
				t.Error = fmt.Errorf("cart-429")
			}
		default:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.Error = fmt.Errorf("add-to-cart (%d)", response.StatusCode)
		}
	}

}

func (t *TargetTask) PrepareCheckout() {
	data := cartChannelPayload{
		CartType:  "REGULAR",
		ChannelID: "10",
	}
	payloadBytes, err := json.Marshal(data)
	if err != nil {
		t.Error = fmt.Errorf("marshal prepare-checkout body: %w", err)
		return
	}

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    "https://carts.target.com/web_checkouts/v1/pre_checkout?cart_type=REGULAR&field_groups=ADDRESSES%2CCART%2CCART_ITEMS%2CDELIVERY_WINDOWS%2CFINANCE_PROVIDERS%2CPAYMENT_INSTRUCTIONS%2CPICKUP_INSTRUCTIONS%2CPROMOTION_CODES%2CSUMMARY&key=e59ce3b531b2c39afb2e2b8a71ff10113aac2a14",
			Data:   string(payloadBytes),
		},
		Headers: map[string][]string{
			"sec-ch-ua-platform": {t.Requests.UserAgent.Platform},
			"x-application-name": {"web"},
			"accept":             {"application/json"},
			"sec-ch-ua":          {t.Requests.UserAgent.Sec_ua},
			"content-type":       {"application/json"},
			"sec-ch-ua-mobile":   {"?0"},
			"user-agent":         {t.Requests.UserAgent.Useragent},
			"origin":             {"https://www.target.com"},
			"sec-fetch-site":     {"same-site"},
			"sec-fetch-mode":     {"cors"},
			"sec-fetch-dest":     {"empty"},
			"referer":            {"https://www.target.com/checkout/start"},
			"accept-encoding":    {"gzip, deflate, br, zstd"},
			"accept-language":    {"en-US,en;q=0.9"},
			"priority":           {"u=1, i"},
			"header-order":       {"content-length", "sec-ch-ua-platform", "x-application-name", "accept", "sec-ch-ua", "content-type", "sec-ch-ua-mobile", "user-agent", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language", "cookie", "priority"},
		},
	}
	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[PrepareCheckout] ERROR: %s", err)
		t.Error = fmt.Errorf("Proxy Failed")
		t.BaseTask.MaybeRotateProxy("Target", err)
		return
	} else {
		log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
		switch response.StatusCode {
		case 200, 201:
			var responseBody PrepareCheckoutResponse
			if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
				log.Printf("Error parsing JSON response: %v", err)
				t.Error = err
				return
			}
			t.PrepCheckoutData = responseBody
			for i := range responseBody.CartItems {
				t.CartedItems = append(t.CartedItems, responseBody.CartItems[i])
			}
		case 429:
			if strings.Contains(body, "DCO_RATE_LIMITED") {
				t.Error = fmt.Errorf("DCO_RATE_LIMITED")
			} else {
				t.Error = fmt.Errorf("prep-checkout (%d)", response.StatusCode)
			}
		default:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.Error = fmt.Errorf("prep-checkout (%d)", response.StatusCode)
		}
	}
}

func (t *TargetTask) SubmitPayment(usePut bool) {
	data := submitPaymentPayload{
		BillingAddress: submitPaymentBilling{
			Country:      constants.NormalizeCountryCode(t.Profile.BillingCountry),
			FirstName:    t.Profile.BillingFirstName,
			LastName:     t.Profile.BillingLastName,
			AddressLine1: t.Profile.BillingAddress1,
			AddressLine2: t.Profile.BillingAddress2,
			ZipCode:      t.Profile.BillingZip,
			City:         t.Profile.BillingCity,
			State:        t.Profile.BillingState,
			Phone:        t.Profile.Phone,
		},
		CardDetails: submitPaymentCard{
			CardName:    fmt.Sprintf("%s %s", t.Profile.BillingFirstName, t.Profile.BillingLastName),
			CardNumber:  t.Profile.CardNumber,
			ExpiryYear:  fmt.Sprintf("20%s", t.Profile.CardExpiryYear),
			ExpiryMonth: t.Profile.CardExpiryMonth,
			CVV:         t.Profile.CardCvv,
		},
		CartID:       t.CartID,
		PaymentType:  "CARD",
		WalletCardID: "",
		WalletMode:   "NONE",
	}
	payloadBytes, err := json.Marshal(data)
	if err != nil {
		t.Error = fmt.Errorf("marshal submit-payment body: %w", err)
		return
	}

	method := "POST"
	payURL := "https://carts.target.com/checkout_payments/v1/payment_instructions?key=e59ce3b531b2c39afb2e2b8a71ff10113aac2a14"
	if usePut {
		method = "PUT"
		payURL = "https://carts.target.com/checkout_payments/v1/payment_instructions/" + t.PaymentInstId + "?key=e59ce3b531b2c39afb2e2b8a71ff10113aac2a14"
	}

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: method,
			URL:    payURL,
			Data:   string(payloadBytes),
		},
		Headers: map[string][]string{
			"sec-ch-ua-platform": {t.Requests.UserAgent.Platform},
			"x-application-name": {"web"},
			"accept":             {"application/json"},
			"sec-ch-ua":          {t.Requests.UserAgent.Sec_ua},
			"content-type":       {"application/json"},
			"sec-ch-ua-mobile":   {"?0"},
			"user-agent":         {t.Requests.UserAgent.Useragent},
			"origin":             {"https://www.target.com"},
			"sec-fetch-site":     {"same-site"},
			"sec-fetch-mode":     {"cors"},
			"sec-fetch-dest":     {"empty"},
			"referer":            {"https://www.target.com/checkout"},
			"accept-encoding":    {"gzip, deflate, br, zstd"},
			"accept-language":    {"en-US,en;q=0.9"},
			"priority":           {"u=1, i"},
			"header-order":       {"content-length", "sec-ch-ua-platform", "x-application-name", "accept", "sec-ch-ua", "content-type", "sec-ch-ua-mobile", "user-agent", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language", "cookie", "priority"},
		},
	}
	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[SubmitPayment] ERROR: %s", err)
		t.Error = fmt.Errorf("Proxy Failed")
		t.BaseTask.MaybeRotateProxy("Target", err)
		return
	}
	log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
	t.Requests.Referer = Request.Req.URL
	switch response.StatusCode {
	case 201, 200:
		var responseBody SubmitPaymentResponse
		if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
			log.Printf("Error parsing JSON response: %v", err)
			t.Error = err
			return
		}
		t.PaymentInstId = responseBody.PaymentInstructionId
	case 429:
		if strings.Contains(body, "DCO_RATE_LIMITED") {
			t.Error = fmt.Errorf("DCO_RATE_LIMITED")
		} else {
			t.Error = fmt.Errorf("submit-payment (%d)", response.StatusCode)
		}
	case 403:
		t.Error = fmt.Errorf("proxy block")
		t.AddUnkownResponse(Request.Req.URL, *response, body)
	case 400:
		var responseBody *SubmitPayment400
		if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
			t.Error = fmt.Errorf("submit-payment (%d)", response.StatusCode)
			return
		}
		if responseBody.Code != "" {
			t.Error = fmt.Errorf("submit-payment (%s)", responseBody.Code)
		} else {
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.Error = fmt.Errorf("submit-payment (%d)", response.StatusCode)
		}
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.Error = fmt.Errorf("submit-payment (%d)", response.StatusCode)
	}
}

func cartItemHasTcin(item CartItem, tcin string) bool {
	if tcin == "" {
		return false
	}
	if item.Tcin == tcin {
		return true
	}
	if item.ChildCartItem != nil && item.ChildCartItem.Tcin == tcin {
		return true
	}
	for _, child := range item.ChildCartItems {
		if child.Tcin == tcin {
			return true
		}
	}
	return false
}

func (t *TargetTask) SubmitOrder() {
	data := cartChannelPayload{
		CartType:  "REGULAR",
		ChannelID: "10",
	}

	payloadBytes, err := json.Marshal(data)
	if err != nil {
		t.Error = fmt.Errorf("marshal submit-order body: %w", err)
		return
	}

	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    "https://carts.target.com/web_checkouts/v1/checkout?cart_type=REGULAR&field_groups=ADDRESSES%2CCART%2CCART_ITEMS%2CFINANCE_PROVIDERS%2CPAYMENT_INSTRUCTIONS%2CPICKUP_INSTRUCTIONS%2CPROMOTION_CODES%2CSUMMARY&key=e59ce3b531b2c39afb2e2b8a71ff10113aac2a14",
			Data:   string(payloadBytes),
		},
		Headers: map[string][]string{
			"sec-ch-ua-platform": {t.Requests.UserAgent.Platform},
			"x-gyjwza5z-z":       {"q"},
			"x-application-name": {"web"},
			"sec-ch-ua":          {t.Requests.UserAgent.Sec_ua},
			"x-gyjwza5z-f":       {"A5izAYCdAQAAnpet2JQ49wxIYQeGVlsXvVYBEatvnZfmK9EdJvgo0b0GUYtWARgWKtGuco1HwH9eCOfvosJeCA=="},
			"sec-ch-ua-mobile":   {"?0"},
			"x-gyjwza5z-a0":      {"T7oVCC2pK_cTifO9C1GGy-GS32G8AD=WRjIUc8s8amfiiZfXKWqKWmTF_wiwLM3zYSK3CGBKq8Rv89UqSy52QSMagO3-vcZDzHgQrX-hZ_Vz0utkFBXbQN6oEjLEdM1b-3wUvcQHB-qThrw_uMaM-1_7fHZsadv_v55hqjX9TwvQN0MGI8Z1GCvE5zW-hOq13avF75jWdLTqZwubvFzvsICF9yggiM4JYxkjd0us2En7Zr5sGt1G1SXkFve_VMKSmQsNpcSS7kxpo7IzsRuwMb0whXWkL-o0Ts_Vr2A5hYV5isjfF0rDiF-5R4Xp76GSYGqJomXjCwq8ioVEFnFZOWMbH2BlwGzd5AsABmKxh-5_VQLVdoTcm1i6c9zokW7c02uZVbe4luJOg_KW5aZHNwJK9x0zeg7U-eVvQ5=n_pgXBEJ362X-Xw7B=cXxTg_tMWMlaxIrAez8ofoxY-jlLnfSf1r66Edavov-TkEZK7YlJugJ=WxkmNQxVfa87eKTAdJiiCNa4cXoEguKBVuwadAoemzKTeukLk5gjB4XS9M2SZQIzB4p7p3N7S-d6_VFCzMbZ7sv=e3wT8A2eB=GX0K7Gw00kOEWp4CZSxHcussX7yX6BFiBqiQayfvxwZJk0WH57MJDp3E6OjD5bzbOFhaueRBNbbGwDuMGLWOGeEbsTnMNFswL-lR20cSRXZqNBFYhf5uO5GeYc--3WchHftBA5uK8DKjXOjHCSeKuqcwzBN6nfQ5HCZwVXygIGIuAeLg6ezKbh_srN6kFQTG-TYzo_7LEmUKDOex06c2OgcMYj2qlYjVCxUoZ=z28Rok1XX7zkT1Mgq-gvm2IMd5qMRYwo4z2lo2vIWuL7UOUU=3w5MiFE7gKpNDd-El45iaK7ZXJV1zMNJnsHIzwrRRNGAzYAxGteNhDzGsiiJNOOzp2RHBu9AcEWZroelqmhy10AF9AGf2vFgGVjuAhkEOIjFLfaODzR0DbkM3eB_QL4lKpDMX-=vex7x8NcbleLqyXNa-Xq5lfJkghsS_h6EgyTkibFGgQwEQ40x7uC_lxrUfdLT_EyBl57F3=JEx6KbpdISAhWOEHSsSweEGMcGg1bZ2Cyn=wxhy3XMdLlEKLIddds2LLgHpDeV9gYHRNaSDojfZ8Bu1zgMgD13vFl7yJTRgXR3IXuMfRJXmSQHOWhBkl=fp"},
			"x-gyjwza5z-b":       {"-13howq"},
			"x-gyjwza5z-a":       {"A75HDWVwe-oMIh0OYq4rCuVAvyO_gcSsNJ_C4A7J1KSnvSahARxC3ytjKnYsw0X4UenDbojCg9pJ5_QrCXJRKwa-2qa9TSxN8Ay90uD1xhzhhIn5sFimDOOXSD6uafZgQ9TfzJOHdVKqnny5=nzQQHnsN5DliREdiNeRIAr5kLfhRyUis8RAGvCXH1e4Ov4J19keHw9wconxcjUNIbvJYM0MOjEqWKk2e1jWdOKO63omOGAwVkmyTpALd9BWLQk1ubOtmvQccRcLD54s4pzmjUwYbj=jKw1BDgU9Bs5gjYN6bkr-8XaGjUXWY7xtDxpTyVRd-OzNUZQ7fxftC7tEpjuw49fFAv47_2BYbUbJfuNfO5adH4EDWk4W_o1SaJC0MJDFEuovhpntcFbfC2GOw4Z7wrX-eSfRM4j8uUNqZUtJhm_n1e9hT5y4ZRws7ieq1D3VCtX8ddXLQLONO0-Wb5-=zkuC9kiUzpV6HXbD6TGZaquOfGhRG2ISUw10fnIrNWWYgvAFrNg30=-0_VZ_ObFHWYSxz3ILLg-VgH3Ivzbo7idLzJkIbObwHLTY=vXoVZBN=RwDpYW1jo=HR0bw9g-giqC4XnZc7ZtBFG1VKtVo04mgTF9g7F3NKWEUIUOn5zRK-X=M8YzDShM8uu9y51i6abMAw8a3A4fy4-aF1m7CxXpAXmpwQwtF_vSYeGXuBOGfhV8fXY7SXHQ5AOeigg2cqpzBL0_Zsm8meRD4ankTFcTe7hJSKGuABiVXMDn4d-NgVVph8yj=Zq7lnZi67VyvtJi5sOQ=OI5c_CtkraSO=cCqmAUnVw-xcf8=8RGHY0KDlZWRVN0ZpVJkpuQr=nX7yjdNzlZZAVAE=ydI9Wpk9M3soHqY8Q8uBwHc41dMlJbgLJwxTuT1pwGWO9gQitU0s9-NLn=gkSmK9=unGz_DJQ4yw5-jC8ws8pSDd8qz09Jz7diWgoIB4Rath3zkX5M2Jpt3m-9xJs2Hup6oeGQjm5nw7gpu8CaLgyoZSEg2rs3mkQr7-Xj976dHMIc4pefYtyp=NlntoUZB2AxHJMc4NgDZGNXGooBJTEjSt=Odvu0330=2-uAMdFOJ1-fOZlXqFFNDxqxqpbRy57-ArF24ULReGlGAnT6TTdeYUS_f56hErpr77vSsQ_ddsCB6WvCs8HleabawrJTrJrqiKKyxYEm8YBar-iAtDkrmbgzXcvvlVI=6zYrzFR1ObUMnt-n6wiGp89CaGUmZ2pj4ctvp1oA4uAKa_YoSz4uFg1befogIlnTtxTb3Jsej=NeTvrwresIkOJiMeV3OWtoa6OVMhSqkJkvYRF-6clSXdZHDNv=nQAnfXc5rO3Ve0MryC5F3bUh5-Vagj0gx9ULhNNJJg4Z-dFLx1pJa6W376ivapn=Si-8vJHt2zeKaagMBzux6TkvYRhCZ7f8oJi6Eksq4M0cNxq7MKMb3FlEb=9xUEX_-G_BwJbweDgQcABUkzIptI6ej6cIBAkGgKo7nDkD4y5uFmyafG-VXwJ0_ZFYOhs8DINC-Nup=f2ggZ-MeSJXtGdz5p4LwkoZAMq7aoA4yBGR2bIck2hiz0K_T0mOeC-JkieztcEKG0FQju6xK2w1WzonxcQwtRhKJYCFlwIJgw0mSLKJq_zpU80mzIjb0gqEn=bNJ2oEmzec4iE5OrdV7CKTHiBkKFnxxpvxRnF-W3KMa6799Kvdop30bn7kKyimp8sTcFjAnAkvi2IazSBf7MHwbF10=tpGWTpEFLeYYzswMt0yxd5M-9b-aROEbHFfo9OpnxsxJBc=y-Vlnu=RSzvede9n4Xmfdsjov5B9Fg=dgytHmJ5WjDxjuQ_ezFUrc6NpSjChBTDcFRpIV9WkkfUe_BI48A-1cO=1CZdo_RKv1z64wkmpCmtOTnenkyfIw8x9pjaj=yCg0gQEQcZGmioF8DniTjZrzpixQ4FkLI2Oc_9Z_OQ5aeBKySQiCpkBhlQdW432r-NhbCyVnX8wsuDRyQCwppHMp0C3booAVvBJQv9q8DeG2u-gGbFNhn0I02ktCo84yW1iGTti4mGIS1S8c7mlTVGfb3FrYwJYtwJ2OGtHLJIU2HsJzDcZZDkH-OWFSLc1GXE2m7DM5gDQkSI8HRCpL1FDEesl6lewk-09Q=wbFIFKinH6nOB4Au2pIRSmbs=DTh-_t0-_gWwdv2hM9nzFtyLe1GOe1Zuorw0Xj4ex5T4gpvDpqeefBc1XduTdSTtrf6yy1DJWAZdgkV2eY3Qk0_svuN925cMUQzEjyHYJR5SfH0pIk8pCjAH00sfrFtNGYe=se3fbvyrbu3L_VG=lUggv0aF-XBkFQYBNJWfQmIvSMykTO59pV8O7B5datqAZDYNhXIABYk8A_TvD6273SsKNLNWBXpbdWDRmJTjtFDm395H3gKfTfzwqUoc8bUz__wCNVQg7d-gM3jsIWZc1khXGnAyQJZ_tM2ineGtdu8j=TRaBnd-7aghtNkbL6FuO5RHc1NBMcmceFVKcufTwgwYK99kk5fQ6BVgZlgqUw-RunF8QYZWH8RsXpQu4JUgRMJsEBm4-oKowAc8168G8UCeh71j_Ux2E3JNrIqYYboXkJyvmDoB6Iyl5KnGYCYspNKId3lFL90uq8pd2B849H7YUAqXxR5_orIZ1Xd-vNxDJVW=y2=xsvJVsopQe3q2Tq8kXkEFhp6Eu10YDVAnxMghVjz-vvsV2iqEsznAtEOUYqQM2knKFun5fNRU38Nbc86Fq4vJzCeocXr3DyKHYfrMctwI3_OGL4CBFGypaARzougSocZkEugS2ZSVuEu2q0Ehw1v5kaaVEAn0fZBzISy_tiK071s4jC8Y41XHQVdMVDLck99Rd-jkYSGZMVUlnAulLUWzcFvZqYEs=t8GX1x8cdkb4FKe4gJTiM_kkjixL0GLc5LXDwGvZGIm_vewFlI7MSq79FFKaA3Qz1WZG0d7MWnjQjFvOUFVCiTOUCRpCRrqkRbGmIlm41qE8UXMT5qpfxZaGbcFWCekgD3qRgwr1Je0aouwSCWepr=uJBgoSdcyz5Cmjtx6Ao9MhNXMe_pb=7NHfqhEK=Gkwn0U58rKI9d4ZECpy_eRea3eSdn8c0JLY8B3GIlwgfyreOIHGy4ycqWUeKWfirnL=3lVf9s2tdX2QhijueVRJt2z0sMH4=kStEapu6tQE4GihFSbGvHjMXV1DWuh4V_rZl83m-6LJnRa0=cezMg17oDf2g5ekGUoaYp=jcZsKZEBD7uOHbRENYyk4GJYIhj9WJQyJi5HHHIjOmhWm=aQk-EJ53Ekxh82dFc7fDbqMWsm0h6vndBCM3iupI8UB_t3Vjcs4TIcXLnLuKHylaNkWHGfuk51CpbvTkQ=u2HC2bXjuH3W_N57msZhnQjveQBnhyfBmRjD=LysllNhtUmOlSLofcVW_eomXYwI=t953NiTsfr-W8nS07eV6To4QuVErGW-2dOSxpS1neU8p0cfC=928bFgMXTfNN_0RFlVZ7gg3TBRHEXibDDMyxTbiejJgCDzIHZZMbqRDJzih7HvuqrYANaUVO=bAcy4uSXMxTZq2UyGNstF6V5eAmvwc4TJc7ULyTi3owmKsawzRzDFzgmzFvjcwp3NWk_teFwv4SCh3MSvR8ocsOcDT=ocjvfnuw=hUY5acy63c2heTHH74o8zm1pr32fZ37DsCuRRHYRq270m=sVJCgSO05hIwnHgqodSCepNdHUy6Z-SSJ55wacEL7xH8=MpnWXBonyeDO1McxNGst5A4XFp0ccVibyr3-swbGJgC3nbc72=wIvTAO0sRdSCzbScCik=sNjB84RSuQ1s-w4_5zOV5otuLCD_RGawbm21HlupMW15TSkDS83G-wKbZc_wKsZtoAXtnJsDyG8W7_79WIaUl-dxUxXC1I05DJxBSxEEMYU3bppOSCaGUOz-90RuXl2x-xVQ2W5S6OXzMInVrUdfJ=oEpE3GDTtS1REJwq1Xt_8kxOfcS6n3nmQ6H6kuwr=9ksuIB9ga5aJuWye83nGBAHuHRxbdxw8y-qtak_B7TSTeSdQUH1D9AvAXkkMDOp2Fdz14nFn6lxaKGcOnlVQIe-06KrIA-l2DeRduE6a0hgWjaN68LATYGXGpe6GgkIfrtUy7LA1BmtBrj85HJoaDQF-359YkQt4XJ41NlDpd5=WnS9mn0htsRJQi1BBhe6ElnOjDxBdH6OH=BX7SfzYN=uVZ5y=Rc8-RGT6Tc8pjN6DbOjDVv=n=39JYhqUd7Iqz899VXjwD=83mcVdBuJtvFA5Dvot-ackZ9zUYMHuz3YxXY2FFCGpm1hSSxpjOCF5s0dH-TunhpaKfsyNOzxub3T=pnDagX2V7o_WdtEuMK=s3gUFvwwiOmT7ol0DT4SRmeCh0QqkoB9K-qKqQLtCpDNIG6MTJ6ZS=URy=rZKb1T=ROY=G4ULj0B6mHyV7Bhk6EZSWX6Mohs0Lr-0nem2NLr7pdk=dh4DMzjY7eT2ZWmjBfrGXdo6AAY85Fw6_Ncp8ZvvrUT6GUa=lO6nd6vODrCceoELpei5Bh7xjq3wGk4d_ZoBI2SXkumAN01cCYHGdtZvbldvAsT0W7sHTMIqH03KM0J7g=I6Sllx1u9ztnezQh1bqjdeOD=scaSuCtsWU1fs74EZniaBNF=Wxbn6Ag66=dRjczV4xLRKmQpIkLbrogGWe7iI0shvTpEHpnSMYR-jaC9BxUbNAItRu69Ne6nvfbuedWCBmtzufeq3eOup73EfBs=tkoGgd768x84t4CMQC_0kf5tWXJGX15x_xbh1dz6saF-3fuWzkZRvf3eFh-0q3VwZqzek9oi3DT9MOxA3v5XOqkTAHTW4WAlKUSd471sBiaaC9HS=5bjXlTuvHqyKypWXwLlkqb1_2=6jbeAYtreIkV4jJp-HK8woc0MI4R1roTedn3toRNyEkoOHocxMpagHIuUIqhD2frNVCoVN=HThQyf_UUqvNIg4RSnr8tTz8bvgw74QaK3iTOrO=FcHgyTlR8uxNRbGILCSxRZSsCMNfsKRQN2RZuWABW7ocTF3OjA2NuZv0Bjb8Oeb-ej15AIpjYgiArUUdDD6lFqjkdVSft2Que7VXD9Yc02L31_Xf5yYBi116UQyHMyJ0NwjX1--tcVkUD7HOvdvV-pBaijnZMAFOFZ3FwM9BKyKxb7xIEQR9tLhu6gBQph15Ij7M2BbBK-Wo70=ImZ0EY23t=FwKHVcMg8_5bUxf8ckYaXnGmg7kjuXTfUZm1JVSWoULjY_qROMJfQikdLFrwR92r_6DRSBbo=12bZ9C4tFbLiLbtgnSww=A8xKil97KsaAJExAL95dMOhMeehUOxxvp4Fkkfw2xTDN46c6XbO5EDGlJ5XUjgNGVGavi5_Kg=iiVGfeUzaqcKbzrsK1=F6MhWa24wRVpzp=1UkOi8_DSw03YOF-nKE2B2QsW9cyCHxvDtltO7lhfzO9xFspAUcMQIdKReRp5gyNTCjEJMZEvCkWxygDSdzk1LTOGZInfea6gUph6qiMnkFsHQ0ADZGOmp7vpZ6x7cgyr71a4EB0dKF06JnR2_FvsQ-b3A2KUK1CkB0gmD9F64z9gN9kJCfBx0MUqSrfjS4rR7Xp6z8VcXjRCG==no1oyj7cHHzjOlSxqrcwpBW9Kmd6gF3iDr4uwSXB=2-5rVt3Sw6rn3XRb9gptcl7Ej7M6TYm6cCsg8aeRX3hXgk8Rqgl_mMO43pGyNYOfHUqAho=LFeUcqUdisqcHzsopbCm-Ge_3=jLgt1iC78SIwDObF3UabJ6S0u_uLeUg8wVSlhZTzNq29iZGjNB159V4hEh-Y312m1zsVKGB3XxUGEFiL3ehxcNHJSAG6t077JCvCYC0fU=7WJnVEiWmq96Qe62VQNf6LhxDtlr-TNsyZAlekU67ml4-5gXGXWRkooNYf5VmEJqAzyzAr9vtLKG470TCCqKTKYANIUgAl7co7ole5jQKG5C_FoneEA0LMpyA8pcX0mnFhD0TmkZYbNV5U6LUdqlxjo9kHwvF4Kx6-0=qkDfR7FChvICNL3vl6SCc7Veo1Nu6422IuM1f3hApAFm9s8Ok5_VdzO_WNU0_JUw33NXBuuy7VsLI-pzJ5Kh3fCYmIf1G34mEAAfM01QkWshYVTG2YmkHHTA8ug_yziT80dYNAQeYGZfF_wTa5GUiKv_OglNjJg1o_t9VRsjF5lzt4XcwDzevo9iyEK0==bGAb4gz-tGZ7Io3jJDEe8pwtkkK_MSUG4c=Kd_cbAyEiQZM5b1xxqudAvOQnWCcRlzUi7y317IUtJDJCQeGOznaC9UaW22-KOfLz8Gyc66Ej9lzW9i5nnm5k5Z_8UOZAeWz-dm=sCenV=qL9Wmr6MA0ZZC6AuHLACvn6ftG9knR367naz4w8BBcwfZ8ENKwh5nzx7S-T1YCfjEiFb4tLHXHnuIy5tAUEH1F56TCTIVTaRVF7vXATMKU=KK-v3rAitRZtA1-xLm--r-G=EU9OA5fO6cbHm0Slxoj6MKEuROs4uTOWyZBh7MX2hIORJklRbMmqH5m=SgM2yqmOGmOkvRioIdkikvVdN_9LBWoltCMzcO8dqiC81WK7OIqQo_VXfHUutXRnoMpYKwLkpWLYK1oC-y9iZ0dNWUgku7xb5vUt5H3KRgQeRUzzwUWXtzY8M65kQpI0ZBxxZpnh8B1zDctjvb-wfRlnHQTT6GbDdh_CBNpCBNoysOZm8VNwBLpxwTIcOx2N0d0tYrO-vKVXyMCy0ymVyAIqt0YWztDWHByyg9OplQ7nC-__m0xV61XnFe2s-miaUNJEdmVo4KsRFDWaA6lJ-8lZE_sOX2sHFWFwt0lQCUGu89IpvnekDRfW93Xy_tU4s-kCrWTYAGa3zDJqnsBHD6JAe7v0UDhL3m3t0BJjetKhQnfHsmokatkGCVucj1MSHve-qA2NDXuXfT-98_i5IodStcrFMUdGY=DmUZMy8Z7XzgxmhVGL9uuf_8skjCjbJ=921KssiCq878rmxAYmi1HB6KjVy9ivnsnNxBueFkH7Wt3vkoSONaRGd_Kk0gxfzHsbzILJeOHISvgjEHoeTvEfK7i9dImrnWDXZ6E5XL6_J2vSa4t6QMyFKidoF1V_4K5tHr63wrrwgeEcO7qxts-MtTNULwDcp8W5wjYr2MfLrczSJv9yb27HczjmUZG12DfQ18GbxkBQBU8D19nUSY70K1Lv--kXfjaGqaCJT=jLm_aXcIlLk302SrwMhx2U8y1FbjWBwoG7_ssQ31l8F0CH5LBLJ0xXHJq66HY4QFrUc-ctzuJn8IyIwZ7xE_gKQVuaJBi5QkCXurSrkYiejofAmQs4kD4w3fWGupFjVLuXGKgU-Z59cura0Lgs2h4Xik6iCrh6L=CJa42yCoCIr432iv=Coux6FhpvCWI7-cHxQCmjtZiQ5fj_kF5Us8HCJLmeKQ2QgzLHRkZ_-tK1L7ZIi-vfDmFUKywYn5z=nL2ccn_dQTyH53w112FHnzsnOmQWL6zBHNEMJlOXq6MWlqdlJK1EZGCe8Wyb1vf2I2a7TxNIAhhq1iMe7EyZJFwUWbdmpewn6RZYQ=jI2hB4U=knKBNirXyqqiQDvV_Rpdw_0leVYIeXUiu6Qw=iMiJmjEJplXy3BQKl=_OIEHYiwon9BxXIg7d3o-eXgvgNfL_C0wUt-zlYq0Vh66bUQbT45cpkvE9cEL_FLs2TkI9Gwz7UbED_Hr_OFV9GokBOBGUed4bstRqz=qYhNqq7LC07bSmoZMt53hgzaDjJD5uuzWG44u1ScE2OuBaB09r5l6xrtucZwl_vjAL36Ss6_mWq98y=X-MlbAAIXvo7zmBM9ImIaA3OlJMid"},
			"user-agent":         {t.Requests.UserAgent.Useragent},
			"accept":             {"application/json"},
			"x-gyjwza5z-c":       {"AEAl9H-dAQAAWsRLdtoOP9Pwe2O5WvSX7IWVshlZKWYXi-pHo9U6ICXrKn8K"},
			"content-type":       {"application/json"},
			"x-gyjwza5z-d":       {"ADYAhICBAKGAgQGAAYAQgISigaIAwAGAyPpCxg_13ocR3sD_CLzTANU6ICXrKn8K_____5yYML0BEDYQRSJH9ptPFzumV5-L-w"},
			"origin":             {"https://www.target.com"},
			"sec-fetch-site":     {"same-site"},
			"sec-fetch-mode":     {"cors"},
			"sec-fetch-dest":     {"empty"},
			"referer":            {"https://www.target.com/checkout"},
			"accept-encoding":    {"gzip, deflate, br, zstd"},
			"accept-language":    {"en-US,en;q=0.9"},
			"priority":           {"u=1, i"},
			"header-order":       {"content-length", "sec-ch-ua-platform", "x-gyjwza5z-z", "x-application-name", "sec-ch-ua", "x-gyjwza5z-f", "sec-ch-ua-mobile", "x-gyjwza5z-a0", "x-gyjwza5z-b", "x-gyjwza5z-a", "user-agent", "accept", "x-gyjwza5z-c", "content-type", "x-gyjwza5z-d", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language", "cookie", "priority"},
		},
	}

	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[AddToCart] ERROR: %s", err)
		t.Error = fmt.Errorf("Proxy Failed")
		t.BaseTask.MaybeRotateProxy("Target", err)
		return
	} else {
		log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
		t.Requests.Referer = Request.Req.URL
		switch response.StatusCode {
		case 200, 201:
			var responseBody SubmitOrderSuccess
			if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
				log.Printf("Error parsing JSON response: %v", err)
				t.Error = err
				return
			}
			if len(responseBody.Orders) == 0 {
				t.Error = fmt.Errorf("submit-order (%d)", response.StatusCode)
				return
			}
			for _, checkout := range responseBody.Orders {
				isRealOrder := !t.UseFillerItem
				for _, item := range checkout.CartItems {
					if cartItemHasTcin(item, t.RestockTCIN) {
						isRealOrder = true
						break
					}
				}
				if isRealOrder {
					t.CheckoutData = checkout
				} else {
					qty := 0
					if len(checkout.CartItems) > 0 {
						qty = checkout.CartItems[0].Quantity
					}
					t.FillerOrders = append(t.FillerOrders, &FillerOrderState{ReferenceId: checkout.ReferenceId, ItemQty: qty})
				}
			}
		case 400:
			var responseBody SubmitOrderFailed
			if err := jsoniter.Unmarshal([]byte(body), &responseBody); err == nil {
				t.DeclineReason = responseBody.Message
				t.Decline = true
			} else {
				t.Error = fmt.Errorf("submit-order (%d)", response.StatusCode)
			}
		case 424:
			if strings.Contains(body, "INVENTORY UNAVAILABLE") {
				t.Error = fmt.Errorf("out of stock")
				return
			}
			var responseBody SubmitOrderSuccess
			if err := jsoniter.Unmarshal([]byte(body), &responseBody); err == nil &&
				len(responseBody.Orders) > 0 && responseBody.Orders[0].ReferenceId != "" {
				t.CheckoutData = responseBody.Orders[0]
			} else {
				t.Decline = true
				t.AddUnkownResponse(Request.Req.URL, *response, body)
			}
		case 429:
			if strings.Contains(body, "DCO_RATE_LIMITED") {
				t.Error = fmt.Errorf("DCO_RATE_LIMITED")
			} else {
				t.Error = fmt.Errorf("submit-order (%d)", response.StatusCode)
			}
		default:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.Error = fmt.Errorf("submit-order (%d)", response.StatusCode)
		}
	}
}

func (t *TargetTask) RemovePaymentMethod() {
	if t.PaymentInstId == "" {
		return
	}
	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "DELETE",
			URL:    fmt.Sprintf("https://carts.target.com/checkout_payments/v1/payment_instructions/%s?cart_id=%s&key=e59ce3b531b2c39afb2e2b8a71ff10113aac2a14", t.PaymentInstId, t.CartID),
		},
		Headers: map[string][]string{
			"sec-ch-ua-platform": {t.Requests.UserAgent.Platform},
			"x-application-name": {"web"},
			"accept":             {"application/json"},
			"sec-ch-ua":          {t.Requests.UserAgent.Sec_ua},
			"content-type":       {"application/json"},
			"sec-ch-ua-mobile":   {"?0"},
			"user-agent":         {t.Requests.UserAgent.Useragent},
			"origin":             {"https://www.target.com"},
			"sec-fetch-site":     {"same-site"},
			"sec-fetch-mode":     {"cors"},
			"sec-fetch-dest":     {"empty"},
			"referer":            {"https://www.target.com/checkout/payment"},
			"accept-encoding":    {"gzip, deflate, br, zstd"},
			"accept-language":    {"en-US,en;q=0.9"},
			"priority":           {"u=1, i"},
			"header-order":       {"sec-ch-ua-platform", "x-application-name", "accept", "sec-ch-ua", "content-type", "sec-ch-ua-mobile", "user-agent", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language", "cookie", "priority"},
		},
	}
	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[removePaymentMethod] ERROR: %s", err)
		t.Error = fmt.Errorf("Proxy Failed")
		t.BaseTask.MaybeRotateProxy("Target", err)
		return
	} else {
		switch response.StatusCode {
		case 204:
		default:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
		}
	}
}

func (t *TargetTask) recordFillerOrderLine(referenceId string, line OrderLine) {
	for _, fo := range t.FillerOrders {
		if fo.ReferenceId == referenceId {
			fo.OrderLineId = line.OrderLineId
			fo.OrderLineKey = line.OrderLineKey
			if fo.ItemQty <= 0 {
				fo.ItemQty = int(line.Item.Quantity)
			}
			t.NeedCancelFiller = true
			return
		}
	}
	t.FillerOrders = append(t.FillerOrders, &FillerOrderState{
		ReferenceId:  referenceId,
		ItemQty:      int(line.Item.Quantity),
		OrderLineId:  line.OrderLineId,
		OrderLineKey: line.OrderLineKey,
	})
	t.NeedCancelFiller = true
}

func (t *TargetTask) CheckOrder(orderNum string, isFillerOrder bool) {
	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "GET",
			URL:    fmt.Sprintf("https://api.target.com/post_orders/v1/%s", orderNum),
		},
		Headers: map[string][]string{
			"sec-ch-ua-platform": {t.Requests.UserAgent.Platform},
			"trishool":           {"true"},
			"user-agent":         {t.Requests.UserAgent.Useragent},
			"accept":             {"application/json"},
			"sec-ch-ua":          {t.Requests.UserAgent.Sec_ua},
			"x-api-key":          {"ff457966e64d5e877fdbad070f276d18ecec4a01"},
			"sec-ch-ua-mobile":   {"?0"},
			"origin":             {"https://www.target.com"},
			"sec-fetch-site":     {"same-site"},
			"sec-fetch-mode":     {"cors"},
			"sec-fetch-dest":     {"empty"},
			"referer":            {fmt.Sprintf("https://www.target.com/orders/%s", orderNum)},
			"accept-encoding":    {"gzip, deflate, br, zstd"},
			"accept-language":    {"en-US,en;q=0.9"},
			"priority":           {"u=1, i"},
			"header-order":       {"sec-ch-ua-platform", "trishool", "user-agent", "accept", "sec-ch-ua", "x-api-key", "sec-ch-ua-mobile", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language", "cookie", "priority"},
		},
	}
	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[checkOrder] ERROR: %s", err)
		t.Error = fmt.Errorf("Proxy Failed")
		t.BaseTask.MaybeRotateProxy("Target", err)
		return
	} else {
		log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
		t.Requests.Referer = Request.Req.URL
		switch response.StatusCode {
		case 200, 201:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			var responseBody OrderCheckResponse
			if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
				log.Printf("Error parsing JSON response: %v", err)
				t.Error = err
				return
			}
			if responseBody.FraudStatus == "" {
				t.Error = fmt.Errorf("status not found")
				return
			}
			fraudStatus := strings.TrimSpace(responseBody.FraudStatus)

			if isFillerOrder {
				for _, pkg := range responseBody.Packages {
					for _, item := range pkg.OrderLines {
						if item.OrderLineId != item.OrderLineKey {
							t.recordFillerOrderLine(orderNum, item)
						}
					}
				}
				break
			}

			t.FraudStatus = fraudStatus
			if t.fraudStatusIsSuccess(t.FraudStatus) {
				t.OrderNumber = responseBody.OrderNumber
				t.Checkout = true
				t.Decline = false
				if t.UseFillerItem {
					for _, pkg := range responseBody.Packages {
						for _, item := range pkg.OrderLines {
							if item.Item.Tcin == FillerItem && item.OrderLineId != item.OrderLineKey {
								t.recordFillerOrderLine(orderNum, item)
							}
						}
					}
				}
			} else {
				for _, pkg := range responseBody.Packages {
					if pkg.GroupingMetadata.Cancellation.CancelReasonText != "" {
						t.DeclineReason = pkg.GroupingMetadata.Cancellation.CancelReasonText
						break
					}
				}
				t.Checkout = false
				t.Decline = true
			}
		case 429:
			if strings.Contains(body, "DCO_RATE_LIMITED") {
				t.Error = fmt.Errorf("DCO_RATE_LIMITED")
			} else {
				t.Error = fmt.Errorf("check-order (%d)", response.StatusCode)
			}
		case 401:
			t.Error = fmt.Errorf("out of stock (check)")
		default:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			t.Error = fmt.Errorf("check-order (%d)", response.StatusCode)
		}
	}
}

func (t *TargetTask) RemoveFillerItem() {
	allCanceled := true
	for _, fo := range t.FillerOrders {
		if fo.Canceled || fo.OrderLineId == "" {
			continue
		}
		if !t.cancelFillerOrder(fo) {
			allCanceled = false
		}
	}
	if allCanceled {
		t.CanceledFillerItem = true
	}
}

func (t *TargetTask) cancelFillerOrder(fo *FillerOrderState) bool {
	qtyValue := fo.ItemQty
	if qtyValue <= 0 {
		qtyValue = 1
	}
	qty := strconv.Itoa(qtyValue)
	data := map[string]interface{}{
		"order_lines": []map[string]interface{}{
			{
				"order_line_id":      fo.OrderLineId,
				"order_line_key":     fo.OrderLineKey,
				"requested_quantity": qty,
				"reason_code":        "GUEST_CANCEL",
				"comments":           "No longer want the item",
			},
		},
	}

	payloadBytes, err := json.Marshal(data)
	if err != nil {
		t.Error = fmt.Errorf("marshal submit-order body: %w", err)
		return false
	}
	Request := client.RequestStruct{
		CTX: t.TaskContext.CTX,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    fmt.Sprintf("https://api.target.com/post_order_support/v1/orders/%s/cancellations", fo.ReferenceId),
			Data:   string(payloadBytes),
		},
		Headers: map[string][]string{
			"accept":             {"application/json"},
			"accept-language":    {"en-US,en;q=0.9"},
			"content-type":       {"application/json"},
			"origin":             {"https://www.target.com"},
			"priority":           {"u=1, i"},
			"referer":            {fmt.Sprintf("https://www.target.com/orders/%s", fo.ReferenceId)},
			"sec-ch-ua":          {t.Requests.UserAgent.Sec_ua},
			"sec-ch-ua-mobile":   {"?0"},
			"sec-ch-ua-platform": {t.Requests.UserAgent.Platform},
			"sec-fetch-dest":     {"empty"},
			"sec-fetch-mode":     {"cors"},
			"sec-fetch-site":     {"same-site"},
			"user-agent":         {t.Requests.UserAgent.Useragent},
			"x-api-key":          {"ff457966e64d5e877fdbad070f276d18ecec4a01"},
		},
	}
	response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
	if err != nil {
		log.Printf("[checkOrder] ERROR: %s", err)
		t.Error = fmt.Errorf("Proxy Failed")
		t.BaseTask.MaybeRotateProxy("Target", err)
		return false
	}
	log.Printf("[ID:'%s' | Request Status: %s]", t.ID, response.Status)
	t.Requests.Referer = Request.Req.URL
	switch response.StatusCode {
	case 200, 201:
		fo.Canceled = true
		return true
	default:
		t.AddUnkownResponse(Request.Req.URL, *response, body)
		t.Error = fmt.Errorf("cancel-filler (%d)", response.StatusCode)
		return false
	}
}

const maxTcinsPerRequest = 30

func (t *TargetMonitorTask) GetStock() {
	if t.missingTcins == nil {
		t.missingTcins = make(map[string]struct{})
	}

	inputs := t.inputsForStockCheck()
	if len(inputs) == 0 {
		t.ProductStock = nil
		return
	}

	allSummaries := make([]ProductSummary, 0, len(inputs))
	for start := 0; start < len(inputs); start += maxTcinsPerRequest {
		end := start + maxTcinsPerRequest
		if end > len(inputs) {
			end = len(inputs)
		}
		summaries, err := t.fetchStockBatch(inputs[start:end])
		if err != nil {
			t.Error = err
			return
		}
		allSummaries = append(allSummaries, summaries...)
	}

	for _, summary := range allSummaries {
		delete(t.missingTcins, summary.Tcin)
	}
	t.ProductStock = allSummaries
}

func (t *TargetMonitorTask) fetchStockBatch(batch []MonitorInput) ([]ProductSummary, error) {
	remaining := append([]MonitorInput(nil), batch...)
	for len(remaining) > 0 {
		var b strings.Builder
		for i, input := range remaining {
			if i > 0 {
				b.WriteString(",")
			}
			b.WriteString(input.Tcin)
		}
		TcinStr := b.String()

		Request := client.RequestStruct{
			CTX: t.TaskContext.CTX,
			Req: client.ReqStruct{
				Method: "GET",
				URL:    fmt.Sprintf("https://redsky.target.com/redsky_aggregations/v1/apps/tcin_product_list_v2?key=9f36aeafbe60771e321a7cc95a78140772ab3e96&pricing_store_id=875&store_id=875&tcins=%s", TcinStr),
			},
			Headers: map[string][]string{
				"accept":             {"*/*"},
				"x-scr":              {"42d16a82"},
				"x-client-version":   {"2026.28.0"},
				"accept-language":    {"en-US,en;q=0.9"},
				"x-client-platform":  {"iPhone"},
				"x-channel-id":       {"APPS"},
				"x-sapphire-context": {"app_name=Target&app_version=2026.28.0&base_membership=true&card_membership=false&channel=apps&deployment_method=appStore&device=iPhone15,2&in_store=false&loyalty_id=tly.123123&member_id=a123&os_family=iOS&os_version=26.4.1&paid_membership=false&profile_created_date=2022-06-01T22:13:59.245Z&redcard_holder=false&source=flagship_ios&state=DC&store_id=2259&tm=false&visitor_id=asdfasfasdfasdfasdf&zip=20002"},
				"x-request-id":       {"FF90022C-F70B-42C5-BDD1-6C6325A1B8F6"},
				"user-agent":         {"Target/2026.28.0 iPhone15,2 iOS/26.4.1 CFNetwork/3860.500.112 Darwin/25.4.0"},
				"x-device-id":        {"A2358F36-5C19-47CB-8FC7-F9B26287AFD6"},
				"accept-encoding":    {"gzip, deflate, br"},
				"connection":         {"keep-alive"},
				"x-device-model":     {"iPhone15,2"},
				"traceparent":        {"00-17a00c62bff901ed23bec3fb87e97c5a-832a02d3145c203c-01"},
			},
		}

		response, body, err := client.MakeRequest(Request, t.Requests.Client, &t.ClientID)
		if err != nil {
			log.Printf("[GetStock] ERROR: %s", err)
			if t.BaseTask.MaybeRotateProxy("Target", err) {
				return nil, fmt.Errorf("Proxy Failed")
			}
			return nil, fmt.Errorf("failed to respond")
		}

		var responseBody ProductStockResponse
		_ = jsoniter.Unmarshal([]byte(body), &responseBody)
		missing := parseMissingTcinsFromErrors(responseBody.Errors)

		switch response.StatusCode {
		case 200:
			if len(missing) > 0 {
				t.markMissingTcins(missing)
				if len(responseBody.Data.ProductSummaries) > 0 {
					return responseBody.Data.ProductSummaries, nil
				}
				exclude := make(map[string]struct{}, len(missing))
				for _, tcin := range missing {
					exclude[tcin] = struct{}{}
				}
				remaining = filterMonitorInputs(remaining, exclude)
				continue
			}
			return responseBody.Data.ProductSummaries, nil
		case 404:
			if len(missing) == 0 {
				return nil, fmt.Errorf("get-stock (404)")
			}
			t.markMissingTcins(missing)
			exclude := make(map[string]struct{}, len(missing))
			for _, tcin := range missing {
				exclude[tcin] = struct{}{}
			}
			remaining = filterMonitorInputs(remaining, exclude)
			continue
		default:
			t.AddUnkownResponse(Request.Req.URL, *response, body)
			return nil, fmt.Errorf("get-stock (%d)", response.StatusCode)
		}
	}
	return nil, nil
}
