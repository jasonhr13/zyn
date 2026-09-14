package queueit

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"

	http "github.com/bogdanfinn/fhttp"
	"zynbot.app/engine/bot-base/task"
	"zynbot.app/engine/client"
)

func chromeNavigateHeaders(ua *task.BaseUserAgentInfo) map[string][]string {
	return map[string][]string{
		"upgrade-insecure-requests": {"1"},
		"user-agent":                {ua.Useragent},
		"accept":                    {"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"},
		"sec-fetch-site":            {"none"},
		"sec-fetch-mode":            {"navigate"},
		"sec-fetch-user":            {"?1"},
		"sec-fetch-dest":            {"document"},
		"sec-ch-ua":                 {ua.Sec_ua},
		"sec-ch-ua-mobile":          {"?0"},
		"sec-ch-ua-platform":        {ua.Platform},
		"accept-encoding":           {"gzip, deflate, br, zstd"},
		"accept-language":           {"en-US,en;q=0.9"},
		"priority":                  {"u=0, i"},
		"header-order":              {"upgrade-insecure-requests", "user-agent", "accept", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-user", "sec-fetch-dest", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "accept-encoding", "accept-language", "priority"},
	}
}

func chromeXHRHeaders(ua *task.BaseUserAgentInfo, origin, referer string) map[string][]string {
	return map[string][]string{
		"sec-ch-ua":          {ua.Sec_ua},
		"sec-ch-ua-mobile":   {"?0"},
		"sec-ch-ua-platform": {ua.Platform},
		"user-agent":         {ua.Useragent},
		"content-type":       {"application/json"},
		"accept":             {"application/json, text/javascript, */*; q=0.01"},
		"origin":             {origin},
		"sec-fetch-site":     {"same-origin"},
		"sec-fetch-mode":     {"cors"},
		"sec-fetch-dest":     {"empty"},
		"referer":            {referer},
		"accept-encoding":    {"gzip, deflate, br, zstd"},
		"accept-language":    {"en-US,en;q=0.9"},
		"priority":           {"u=1, i"},
		"header-order":       {"sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "user-agent", "content-type", "accept", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language", "priority"},
	}
}

type httpSession struct {
	ctx    context.Context
	client client.HttpClient
	ua     *task.BaseUserAgentInfo
	taskID *string
}

func (s *httpSession) do(method, rawURL string, headers map[string][]string, body string) (*http.Response, string, error) {
	req := client.RequestStruct{
		CTX: s.ctx,
		Req: client.ReqStruct{
			Method: method,
			URL:    rawURL,
			Data:   body,
		},
		Headers: headers,
	}
	if body == "" {
		req.Req.Data = "nil"
	}
	return client.MakeRequest(req, s.client, s.taskID)
}

func (s *httpSession) land(startURL string) (landedURL, html string, err error) {
	url := startURL
	for hop := 0; hop < 8; hop++ {
		resp, body, reqErr := s.do("GET", url, chromeNavigateHeaders(s.ua), "")
		if reqErr != nil {
			return url, "", reqErr
		}
		if resp.StatusCode >= 300 && resp.StatusCode < 400 {
			loc := absURL(url, resp.Header.Get("Location"))
			if loc == "" {
				return url, body, fmt.Errorf("redirect %d with no location", resp.StatusCode)
			}
			url = loc
			continue
		}
		if resp.StatusCode >= 400 {
			return url, body, fmt.Errorf("land %d", resp.StatusCode)
		}
		return url, body, nil
	}
	return url, "", fmt.Errorf("too many redirects")
}

func (s *httpSession) fetchText(rawURL string) (string, error) {
	resp, body, err := s.do("GET", rawURL, chromeNavigateHeaders(s.ua), "")
	if err != nil {
		return "", err
	}
	if resp.StatusCode >= 400 {
		return body, fmt.Errorf("fetch %d", resp.StatusCode)
	}
	return body, nil
}

func (s *httpSession) postJSON(rawURL, origin, referer string, payload any) (*http.Response, []byte, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, nil, err
	}
	resp, body, err := s.do("POST", rawURL, chromeXHRHeaders(s.ua, origin, referer), string(raw))
	if err != nil {
		return nil, nil, err
	}
	return resp, []byte(body), nil
}

func dumpCookieHeader(c client.HttpClient, origin string) string {
	if c == nil {
		return ""
	}
	jar := c.GetCookieJar()
	if jar == nil {
		return ""
	}
	u, err := url.Parse(origin)
	if err != nil {
		return ""
	}
	var b strings.Builder
	for i, ck := range jar.Cookies(u) {
		if ck == nil || ck.Name == "" {
			continue
		}
		if i > 0 {
			b.WriteString("; ")
		}
		b.WriteString(ck.Name)
		b.WriteByte('=')
		b.WriteString(ck.Value)
	}
	return b.String()
}

type dumpedCookie struct {
	Name  string `json:"name"`
	Value string `json:"value"`
	URL   string `json:"url"`
}

func dumpCookiesJSON(c client.HttpClient, origins ...string) string {
	if c == nil {
		return ""
	}
	jar := c.GetCookieJar()
	if jar == nil {
		return ""
	}
	out := make([]dumpedCookie, 0)
	seen := map[string]struct{}{}
	for _, origin := range origins {
		origin = strings.TrimSpace(origin)
		if origin == "" {
			continue
		}
		u, err := url.Parse(origin)
		if err != nil || u.Scheme == "" || u.Host == "" {
			continue
		}
		base := u.Scheme + "://" + u.Host
		for _, ck := range jar.Cookies(u) {
			if ck == nil || ck.Name == "" {
				continue
			}
			key := ck.Name + "\n" + strings.ToLower(u.Host)
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			out = append(out, dumpedCookie{Name: ck.Name, Value: ck.Value, URL: base + "/"})
		}
	}
	if len(out) == 0 {
		return ""
	}
	raw, err := json.Marshal(out)
	if err != nil {
		return ""
	}
	return string(raw)
}
