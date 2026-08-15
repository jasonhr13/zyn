package tmx

import (
	"regexp"
	"strconv"
	"strings"
)

var (
	chromeVersionRe = regexp.MustCompile(`Chrome/(\d+)`)
	macOSRe         = regexp.MustCompile(`Mac OS X ([0-9_]+)`)
	windowsNTRe     = regexp.MustCompile(`Windows NT ([0-9.]+)`)
)

const defaultUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"

func (t *TMXConfig) userAgent() string {
	if t.UserAgent != "" {
		return t.UserAgent
	}
	return defaultUserAgent
}

type UAFields struct {
	JSOU string
	JSO  string
	JSBU string
	JSB  string
}

func ParseUA(ua string) UAFields {
	fields := UAFields{}

	if m := chromeVersionRe.FindStringSubmatch(ua); len(m) > 1 {
		fields.JSBU = "Chrome"
		fields.JSB = "Chrome " + m[1]
	} else if m := regexp.MustCompile(`Firefox/(\d+)`).FindStringSubmatch(ua); len(m) > 1 {
		fields.JSBU = "Firefox"
		fields.JSB = "Firefox " + m[1]
	} else if m := regexp.MustCompile(`Edg/(\d+)`).FindStringSubmatch(ua); len(m) > 1 {
		fields.JSBU = "Edge"
		fields.JSB = "Edge " + m[1]
	} else if m := regexp.MustCompile(`Version/(\d+).*Safari/`).FindStringSubmatch(ua); len(m) > 1 {
		fields.JSBU = "Safari"
		fields.JSB = "Safari " + m[1]
	}

	switch {
	case strings.Contains(ua, "Mac OS X"):
		if m := macOSRe.FindStringSubmatch(ua); len(m) > 1 {
			fields.JSOU = "Mac"
			fields.JSO = "Mac OS X " + m[1]
		}
	case strings.Contains(ua, "Windows NT"):
		if m := windowsNTRe.FindStringSubmatch(ua); len(m) > 1 {
			fields.JSOU = "Windows"
			fields.JSO = windowsVersionFromNT(m[1])
		}
	case strings.Contains(ua, "CrOS"):
		fields.JSOU = "Chrome OS"
		fields.JSO = "Chrome OS"
	case strings.Contains(ua, "Android"):
		fields.JSOU = "Android"
		if m := regexp.MustCompile(`Android ([0-9.]+)`).FindStringSubmatch(ua); len(m) > 1 {
			fields.JSO = "Android " + m[1]
		}
	case strings.Contains(ua, "Linux"):
		fields.JSOU = "Linux"
		fields.JSO = "Linux"
	}

	return fields
}

func windowsVersionFromNT(nt string) string {
	switch nt {
	case "10.0":
		return "Windows 10"
	case "6.3":
		return "Windows 8.1"
	case "6.2":
		return "Windows 8"
	case "6.1":
		return "Windows 7"
	default:
		if f, err := strconv.ParseFloat(nt, 64); err == nil && f >= 10 {
			return "Windows 10"
		}
		return "Windows NT " + nt
	}
}
