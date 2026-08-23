package walmart

import (
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	parallaxsdk "github.com/ParallaxAPIs/parallaxapis-sdk-go"
	"zynbot.app/engine/bot-base/proxy"
	"zynbot.app/engine/bot-base/pxsolve"
	"zynbot.app/engine/bot-base/siteconfig"
)

func (t *WalmartTask) handlePX412(body string) bool {
	trimmed := strings.TrimSpace(body)
	if trimmed != "" {
		var px pxBlockResponse
		if json.Unmarshal([]byte(trimmed), &px) == nil && px.isPerimeterXBlock() {
			t.Error = fmt.Errorf("px blocked")
			return true
		}
	}

	lower := strings.ToLower(body)
	if strings.Contains(lower, "px-captcha") ||
		strings.Contains(lower, "_pxcaptcha") {
		t.Error = fmt.Errorf("px blocked")
		return true
	}
	return false
}

func isPXSolverAuthError(err error) bool {
	if err == nil {
		return false
	}
	return containsAnyText(err.Error(),
		"no valid auth token",
		"invalid auth token",
		"invalid api key",
		"unauthorized",
	)
}

func (t *WalmartTask) SolvePXInit() {
	allowed, err := pxsolve.CheckAndIncrement()
	if err != nil {
		log.Printf("[solvePXInit] px usage check ERROR: %s", err)
	}
	if !allowed {
		t.Error = fmt.Errorf("px solve quota exceeded")
		return
	}

	proxyURL := proxy.AssignedProxyURL(t.ProxyGroup, t.ID)
	if proxyURL == "" {
		t.Error = fmt.Errorf("no proxy assigned")
		return
	}

	key := siteconfig.WaitForLucaAPIKey(15 * time.Second)
	if key == "" {
		t.Error = fmt.Errorf("px solver key not configured")
		return
	}
	sdk := parallaxsdk.NewPerimeterxSDK(key, parallaxsdk.DefaultPXHost)
	result, err := sdk.GenerateCookies(parallaxsdk.TaskGeneratePXCookies{
		Site:        "walmart",
		Region:      "com",
		Proxyregion: "us",
		Proxy:       proxyURL,
	})
	if err != nil {
		log.Printf("[solvePXInit] ERROR: %s", err)
		if isPXSolverAuthError(err) {
			t.Error = fmt.Errorf("invalid px solver key")
		} else {
			t.Error = fmt.Errorf("px init failed")
		}
		return
	}
	t.applyPXResponse(result)
}

func (t *WalmartTask) SolvePXHoldCaptcha() {
	proxyURL := proxy.AssignedProxyURL(t.ProxyGroup, t.ID)
	if proxyURL == "" {
		t.Error = fmt.Errorf("no proxy assigned")
		return
	}
	if t.PxData == "" {
		t.SolvePXInit()
		return
	}

	allowed, err := pxsolve.CheckAndIncrement()
	if err != nil {
		log.Printf("[solvePXHoldCaptcha] px usage check ERROR: %s", err)
	}
	if !allowed {
		t.Error = fmt.Errorf("px solve quota exceeded")
		return
	}

	key := siteconfig.WaitForLucaAPIKey(15 * time.Second)
	if key == "" {
		t.Error = fmt.Errorf("px solver key not configured")
		return
	}
	sdk := parallaxsdk.NewPerimeterxSDK(key, parallaxsdk.DefaultPXHost)
	result, err := sdk.GenerateHoldCaptcha(parallaxsdk.TaskGenerateHoldCaptcha{
		Site:        "walmart",
		Region:      "com",
		Proxyregion: "us",
		Proxy:       proxyURL,
		Data:        t.PxData,
	})
	if err != nil {
		log.Printf("[solvePXHoldCaptcha] ERROR: %s", err)
		if isPXSolverAuthError(err) {
			t.Error = fmt.Errorf("invalid px solver key")
		} else {
			t.SwapProxy("Walmart")
			t.Error = fmt.Errorf("px hc failed")
		}
		return
	}
	t.applyPXResponse(&result.PxCookieResponse)
}

func (t *WalmartTask) applyPXResponse(resp *parallaxsdk.PxCookieResponse) {
	if resp == nil {
		return
	}

	raw := strings.TrimSpace(resp.Cookie)
	if raw != "" {
		if strings.Contains(raw, "=") {
			for _, part := range strings.Split(raw, ";") {
				part = strings.TrimSpace(part)
				kv := strings.SplitN(part, "=", 2)
				if len(kv) == 2 && kv[1] != "" {
					t.addWalmartCookie(strings.TrimSpace(kv[0]), strings.TrimSpace(kv[1]))
				}
			}
		} else {
			t.addWalmartCookie("_px3", raw)
		}
	}
	if resp.Vid != "" {
		t.addWalmartCookie("_pxvid", resp.Vid)
	}
	if resp.Cts != "" {
		t.addWalmartCookie("pxcts", resp.Cts)
	}
	if resp.DeviceFp != "" {
		t.DeviceProfileRefID = resp.DeviceFp
	}
	if resp.UserAgent != "" && t.Requests.UserAgent != nil {
		t.Requests.UserAgent.Useragent = resp.UserAgent
	}
	if resp.Data != "" {
		t.PxData = resp.Data
	}
}
