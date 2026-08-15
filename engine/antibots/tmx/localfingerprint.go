package tmx

import (
	"fmt"
	"math/rand"
	"strconv"
	"strings"
	"time"
)

// The values and selection order in this file mirror the local fingerprint
// generator recovered from Zyn's symbolized backend.exe. Keeping the generator
// local removes the last Target dependency on Polar's device Railway service.

var fingerprintScreens = []string{
	"1920x1080",
	"1366x768",
	"1440x900",
	"1024x768",
	"2560x1440",
	"1280x1024",
}

var fingerprintDPRs = []string{
	"1,1920,1080,1920,1080,1920,1080,1920,1080,0,0",
	"1.5,2560x1440,2560,1440,2560,1440,2560,1440,2560,1440,0,0",
	"2,1920x1080,1920,1080,1920,1080,1920,1080,1920,1080,0,0",
}

var fingerprintMimeTypes = []string{
	"application/pdf,text/html,application/xhtml+xml",
	"text/html,application/xhtml+xml,application/xml",
	"application/pdf,text/html",
}

var fingerprintTimezones = []string{
	"America/New_York",
	"America/Chicago",
	"America/Denver",
	"America/Los_Angeles",
	"Europe/London",
	"Europe/Paris",
	"Europe/Berlin",
	"Asia/Tokyo",
	"Asia/Shanghai",
	"Australia/Sydney",
}

type localBrowserInfo struct {
	browser  string
	version  string
	jsou     string
	jso      string
	platform string
}

type webGLChoice struct {
	vendor   string
	renderer string
}

var webGLVendors = map[string][]string{
	"Windows": {"Intel", "NVIDIA", "AMD"},
	"Mac":     {"Apple", "Intel"},
	"Linux":   {"Intel", "NVIDIA", "AMD"},
}

var webGLRenderers = map[string]map[string][]string{
	"Windows": {
		"Intel":  {"Intel Iris Xe Graphics", "Intel UHD Graphics 630", "Intel HD Graphics 530"},
		"NVIDIA": {"GeForce GTX 1080", "GeForce RTX 3080", "NVIDIA GeForce MX450"},
		"AMD":    {"AMD Radeon RX 6700", "AMD Radeon RX 5700"},
	},
	"Mac": {
		"Apple": {"Apple M1", "Apple M2", "Intel(R) Iris(TM) Graphics 640"},
		"Intel": {"Intel UHD Graphics 630"},
	},
	"Linux": {
		"Intel":  {"Intel Iris Graphics 540"},
		"NVIDIA": {"NVIDIA GeForce GTX 1660"},
		"AMD":    {"AMD Radeon RX 6700 XT"},
	},
}

func GenerateLocalFingerprint(userAgent string) FingerprintPayload {
	r := rand.New(rand.NewSource(time.Now().UnixNano()))
	return generateLocalFingerprint(userAgent, r)
}

func generateLocalFingerprint(userAgent string, r *rand.Rand) FingerprintPayload {
	info := parseLocalBrowserInfo(userAgent)
	screen := fingerprintScreens[r.Intn(len(fingerprintScreens))]
	dpr := fingerprintDPRs[r.Intn(len(fingerprintDPRs))]
	mimeTypes := EncodeURIComponent(fingerprintMimeTypes[r.Intn(len(fingerprintMimeTypes))])
	hardwareConcurrency := []int{4, 8, 12, 16}[r.Intn(4)]
	deviceMemory := []int{4, 8, 16}[r.Intn(3)]

	ex3 := localRandomHash(r)
	ex4 := localRandomHash(r)
	ex5 := localRandomHash(r)
	audioHash := localRandomHash(r)
	webGLHash := localRandomHash(r)
	webGLHash2 := localRandomHash(r)
	fontCount := 30 + r.Intn(31)
	webGL := localWebGLInfo(info.jsou, r)

	uah := fmt.Sprintf(`{"architecture":"x86","model":"","platform":"%s"}`, info.platform)
	ual := fmt.Sprintf(`[{"brand":"%s","version":"%s"}]`, info.browser, info.version)

	timezone := fingerprintTimezones[r.Intn(len(fingerprintTimezones))]
	c, z := localTimezoneOffsets(timezone)
	availableScreen := localAvailableScreen(screen, r)
	screenXY := fmt.Sprintf("%d%d", r.Intn(100), r.Intn(100))
	mimeCount := 2 + r.Intn(4)
	pluginCount := 2 + r.Intn(4)
	pluginHash := md5Hex("pdf-plugin,chrome-plugin")
	mathHash := localRandomHash(r)
	mediaHash := localRandomHash(r)
	jsbValue := strings.TrimSpace(info.browser + " " + info.version)
	canvasHash := localRandomHash(r)
	fontHash := md5Hex(fmt.Sprintf("Arial,Verdana,Courier,Times New Roman,%d", fontCount))

	return FingerprintPayload{
		Data: FingerprintData{
			F:         screen,
			Af:        availableScreen,
			Sxy:       screenXY,
			Dpr:       dpr,
			Mt:        mimeTypes,
			Mn:        mimeCount,
			Scd:       24,
			Pl:        pluginCount,
			Ph:        pluginHash,
			Nhc:       hardwareConcurrency,
			Ndm:       deviceMemory,
			Nmtp:      0,
			Mathr:     mathHash,
			P:         "0",
			UserAgent: userAgent,
			Medh:      mediaHash,
			Audh:      audioHash,
			Ex3:       ex3,
			Ex4:       ex4,
			Ex5:       ex5,
			Uah:       uah,
			Ual:       ual,
			Jso:       info.jso,
			Jsb:       jsbValue,
			Jsou:      info.jsou,
			GlC:       canvasHash,
			GlH:       webGLHash,
			Wglv:      webGL.vendor,
			Wglr:      webGL.renderer,
			GlhH:      webGLHash2,
			Jfn:       fontCount,
			Jfh:       fontHash,
		},
		TZD: timezone,
		Z:   strconv.Itoa(z),
		C:   strconv.Itoa(c),
	}
}

func parseLocalBrowserInfo(userAgent string) localBrowserInfo {
	lower := strings.ToLower(userAgent)
	info := localBrowserInfo{}

	switch {
	case strings.Contains(lower, "firefox"):
		info.browser = "Firefox"
		info.version = localBrowserVersion(lower, "firefox/")
	case strings.Contains(lower, "edg"):
		info.browser = "Edge"
		info.version = localBrowserVersion(lower, "edg/")
	case strings.Contains(lower, "safari") && !strings.Contains(lower, "chrome"):
		info.browser = "Safari"
		info.version = localBrowserVersion(lower, "version/")
	case strings.Contains(lower, "chrome"):
		info.browser = "Chrome"
		info.version = localBrowserVersion(lower, "chrome/")
	}

	switch {
	case strings.Contains(lower, "windows"):
		info.jsou, info.jso, info.platform = "Windows", "Windows", "Windows"
	case strings.Contains(lower, "mac os x"):
		info.jsou, info.jso, info.platform = "Mac", "Mac OS X", "MacIntel"
	case strings.Contains(lower, "linux"):
		info.jsou, info.jso, info.platform = "Linux", "Linux", "Linux x86_64"
	case strings.Contains(lower, "android"):
		info.jsou, info.jso, info.platform = "Android", "Android", "Linux armv8l"
	}

	return info
}

func localBrowserVersion(userAgent, marker string) string {
	index := strings.Index(userAgent, marker)
	if index < 0 {
		return "100"
	}
	version := userAgent[index+len(marker):]
	if part, _, ok := strings.Cut(version, "."); ok {
		return part
	}
	if version == "" {
		return "100"
	}
	return version
}

func localAvailableScreen(screen string, r *rand.Rand) string {
	parts := strings.Split(screen, "x")
	if len(parts) != 2 {
		return screen
	}
	height, err := strconv.Atoi(parts[1])
	if err != nil {
		return screen
	}
	reduction := 40 + r.Intn(20)
	if height <= reduction {
		return screen
	}
	return fmt.Sprintf("%sx%d", parts[0], height-reduction)
}

func localWebGLInfo(platform string, r *rand.Rand) webGLChoice {
	vendors := webGLVendors[platform]
	if len(vendors) == 0 {
		vendors = webGLVendors["Windows"]
	}
	vendor := vendors[r.Intn(len(vendors))]
	renderers := webGLRenderers[platform][vendor]
	if len(renderers) == 0 {
		renderers = []string{"GPU Renderer"}
	}
	return webGLChoice{vendor: vendor, renderer: renderers[r.Intn(len(renderers))]}
}

func localTimezoneOffsets(timezone string) (c, z int) {
	offsets := map[string][2]int{
		"America/New_York":    {-300, 60},
		"America/Chicago":     {-360, 60},
		"America/Denver":      {-420, 60},
		"America/Los_Angeles": {-480, 60},
		"Europe/London":       {0, 60},
		"Europe/Paris":        {60, 60},
		"Europe/Berlin":       {60, 60},
		"Asia/Tokyo":          {540, 0},
		"Asia/Shanghai":       {480, 0},
		"Australia/Sydney":    {600, 60},
	}
	if offset, ok := offsets[timezone]; ok {
		return offset[0], offset[1]
	}
	return -300, 60
}

func localRandomHash(r *rand.Rand) string {
	const hexDigits = "0123456789abcdef"
	result := make([]byte, 32)
	for i := 0; i < 16; i++ {
		value := byte(r.Intn(256))
		result[i*2] = hexDigits[value>>4]
		result[i*2+1] = hexDigits[value&0x0f]
	}
	return string(result)
}
