package tmx

import (
	"fmt"
	"strings"
	"sync"

	"github.com/PolarAIO/Polar-AIO/backend/antibots/tmx/dynamic"
	"github.com/PolarAIO/Polar-AIO/backend/bot-base/safego"
)

func SolveTMX(t *TMXConfig) (bool, error) {
	device, err := t.GetDevice()
	if err != nil {
		return false, err
	}
	t.Device.Data = *device
	t.UA = ParseUA(t.UserAgent)
	t.ApplyTimezoneFields()
	if t.IPv4 == "" {
		if ip, err := t.GetIPv4(); err == nil && ip != "" {
			t.IPv4 = ip
		}
	}
	var wg sync.WaitGroup
	async := func(url string) {
		wg.Add(1)
		safego.Go(func() {
			defer wg.Done()
			t.MakeTMXRequest(url)
		})
	}

	if t.SendM1M2 {
		async(t.BuildUrl("m2"))
		async(t.BuildUrl("m1"))
	}

	initURL := t.BuildUrl("init")
	if t.InitSuffix != "" {
		initURL = t.BuildUrl("initWM") + t.InitSuffix
	}
	initScript, err := t.MakeTMXRequest(initURL)
	if err != nil {
		return false, err
	}

	if t.SendKClear {
		async(t.BuildUrl("kClear"))
	}

	tags, err := dynamic.PullDynamicInfo(initScript, t.Domain)
	if err != nil {
		return false, err
	}

	async(tags.ImgSrcUrl)
	async(tags.CssURl)

	secondScript, err := t.MakeTMXRequest(fmt.Sprintf("%s&jb=%s", tags.CheckUrl, t.GenBrowserSmallPayload()))
	if err != nil {
		return false, err
	}

	second, err := dynamic.PullDynamicInfo(secondScript, t.Domain)
	if err != nil {
		return false, err
	}

	thirdScript, err := t.MakeTMXRequest(second.CspUrl)
	if err != nil {
		return false, err
	}

	third, err := dynamic.PullDynamicInfo(thirdScript, t.Domain)
	if err != nil {
		return false, err
	}

	check := second.CheckUrl2
	async(fmt.Sprintf("%s&ja=%s&jb=%s", check, t.GenBrowserGeneralPayload(), t.GenLQPayload()))
	async(fmt.Sprintf("%s&jb=%s", check, t.GenLSAPayload(strings.Split(second.LSABValue, "_")[0])))
	async(second.GHLUrl)
	async(second.LocalStorageUrl)
	async(fmt.Sprintf("https://%s/fp/clear.png", t.Domain))
	async(fmt.Sprintf("%s&jac=1&je=%s", check, t.GenWGLPayload()))
	async(fmt.Sprintf("%s&jac=1&je=%s", check, t.GenHashPayload()))
	async(fmt.Sprintf("%s&bbv=3&jac=1&je=%s", check, t.GenMEDHPayload()))
	async(fmt.Sprintf("%s&jf=%s", third.LSBUrl, t.GenLSBPayload(third.LSABValue)))
	async(fmt.Sprintf("%s&fr=", third.LocalStorageUrl))

	if t.SendPortCheck {
		async(fmt.Sprintf("%s&je=%s", check, t.GenPortCheckPayload()))
	}
	if t.SendSig && second.SigUrl != "" {
		async(fmt.Sprintf("%s&jf=%s", second.SigUrl, t.GenSigPayload(second.Nonce)))
	}

	async(fmt.Sprintf("%s&jac=1&je=%s", check, t.GenIPV4Payload()))

	if t.SendJF {
		async(fmt.Sprintf("%s&jac=1&je=%s", check, t.GenJFPayload()))
	}

	wg.Wait()
	return true, nil
}
