package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	fhttp "github.com/bogdanfinn/fhttp"
	tls_client "github.com/bogdanfinn/tls-client"

	"zynbot.app/engine/bot-base/task"
	"zynbot.app/engine/client"
	pokemoncenter "zynbot.app/engine/sites/pokemonCenter"
)

const (
	pageURL      = "https://www.pokemoncenter.com/"
	staticScript = "https://www.pokemoncenter.com/vice-come-Soldenyson-it-non-Banquoh-Chare-Hart-C"
	licenseBase  = "https://license.zynbot.app"
	zynDataDir   = "Library/Application Support/Zyn"
)

var (
	reIncident   = regexp.MustCompile(`src="(/_Incapsula_Resource\?[^"]*)"`)
	reSWJIYLWA   = regexp.MustCompile(`/_Incapsula_Resource\?SWJIYLWA=`)
	reWaitingCfg = regexp.MustCompile(`(?i)WAITING_ROOM_|Waiting Room|waiting-room|position in line|estimated wait|\$ESTIMATED_TIME_TO_WAIT\$`)
)

func main() {
	defaultPoll := envDuration("POLL_S", 10*time.Second)
	defaultHold := envDuration("HOLD_S", 90*time.Second)
	if os.Getenv("PORT") != "" && os.Getenv("HOLD_S") == "" {
		defaultHold = 0
	}
	poll := flag.Duration("poll", defaultPoll, "homepage poll interval after solve")
	hold := flag.Duration("hold", defaultHold, "how long to keep the solved session alive (0 = until Ctrl-C)")
	proxyFlag := flag.String("proxy", os.Getenv("PROXY"), "optional single proxy (url or host:port:user:pass)")
	webhook := flag.String("webhook", firstEnv("QUEUE_WEBHOOK", "WEBHOOK_URL"), "optional POST URL when waiting room appears")
	dumpDir := flag.String("dump", envOr("DUMP", "snapshots"), "directory for HTML snapshots on state change")
	flag.Parse()

	discordURL := strings.TrimSpace(os.Getenv("DISCORD_WEBHOOK_URL"))
	opsURL := strings.TrimSpace(os.Getenv("OPS_DISCORD_WEBHOOK_URL"))
	listen := strings.TrimSpace(os.Getenv("PORT"))

	proxies := envList("PROXY_URLS")
	if *proxyFlag != "" {
		proxies = append([]string{*proxyFlag}, proxies...)
	}
	pool := newProxyPool(proxies)

	ua := task.ChooseUseragent()
	stats := &monitorStats{startedAt: time.Now(), state: "starting"}
	if listen != "" {
		startHealthServer(":"+listen, stats)
	}

	hyper, err := newHyperClient()
	for err != nil {
		log.Printf("waiting for HYPER_API_KEY or license session: %v", err)
		stats.mu.Lock()
		stats.state = "unconfigured"
		stats.mu.Unlock()
		time.Sleep(15 * time.Second)
		hyper, err = newHyperClient()
	}
	log.Printf("hyper broker: %s", hyper.mode)
	startHeartbeat(opsURL, envDuration("HEALTH_INTERVAL_S", 30*time.Minute), stats)

	session := &sessionState{ua: ua, hyper: hyper}
	if err := session.rebuild(pool.current()); err != nil {
		log.Fatalf("tls client: %v", err)
	}

	kind, body, hdr, err := session.bootstrap()
	if err != nil {
		log.Printf("bootstrap: %v", err)
		pool.mark(false)
	} else if kind == "captcha" {
		log.Printf("bootstrap landed on captcha — rotating proxy")
		pool.rotate()
	} else {
		pool.mark(true)
	}
	announce := func(k, b string, h fhttp.Header) {
		announceQueue(k, b, h, *webhook, discordURL)
	}

	if kind == "store" {
		log.Printf("solved session is live — watching for Imperva Waiting Room (queue)")
		_ = dumpSnapshot(*dumpDir, "start", kind, body, hdr, session)
	}
	if kind == "waiting_room" {
		announce(kind, body, hdr)
	}
	updateStats(stats, pool, session, kind, hdr, len(body), false)

	deadline := time.Time{}
	if *hold > 0 {
		deadline = time.Now().Add(*hold)
	}
	nextRenew := time.Now().Add(24 * time.Hour)
	if session.reeseToken != "" {
		nextRenew = time.Now().Add(session.renewWait())
	}
	prev := kind
	queued := kind == "waiting_room"
	for deadline.IsZero() || time.Now().Before(deadline) {
		wait := *poll
		if session.reeseToken != "" && time.Until(nextRenew) < wait {
			wait = time.Until(nextRenew)
		}
		if wait < time.Second {
			wait = time.Second
		}
		time.Sleep(wait)

		if session.reeseToken != "" && time.Now().After(nextRenew) {
			if err := session.renewReese(); err != nil {
				log.Printf("reese renew failed: %v", err)
				pool.mark(false)
			} else {
				log.Printf("reese84 renewed; next in %ds", session.renewInSec)
				pool.mark(true)
			}
			nextRenew = time.Now().Add(session.renewWait())
		}

		body, hdr, err = session.getHomepage()
		if err != nil {
			log.Printf("poll error: %v", err)
			pool.mark(false)
			stats.mu.Lock()
			stats.errors++
			stats.mu.Unlock()
			if err := failover(session, pool, stats); err != nil {
				log.Printf("failover: %v", err)
			} else {
				nextRenew = time.Now().Add(session.renewWait())
			}
			continue
		}
		kind = classify(body)
		stats.mu.Lock()
		stats.polls++
		stats.lastPoll = time.Now()
		stats.mu.Unlock()
		updateStats(stats, pool, session, kind, hdr, len(body), false)

		if kind != prev {
			log.Printf("state %s -> %s (%d bytes) x-iinfo=%q cookies=%s", prev, kind, len(body), hdr.Get("X-Iinfo"), session.cookieNames())
			if err := dumpSnapshot(*dumpDir, prev, kind, body, hdr, session); err != nil {
				log.Printf("snapshot: %v", err)
			}
		} else {
			log.Printf("poll %s (%d bytes) x-iinfo=%q cookies=%s", kind, len(body), hdr.Get("X-Iinfo"), session.cookieNames())
		}

		if kind == "poi" || kind == "utmvc" {
			log.Printf("session dropped to %s — re-solving Reese84", kind)
			if err := session.solveReese(body); err != nil {
				log.Printf("re-solve failed: %v", err)
				pool.mark(false)
				if ferr := failover(session, pool, stats); ferr != nil {
					log.Printf("failover: %v", ferr)
				} else {
					nextRenew = time.Now().Add(session.renewWait())
				}
			} else {
				pool.mark(true)
				nextRenew = time.Now().Add(session.renewWait())
			}
		} else if kind == "captcha" {
			log.Printf("captcha — rotating sticky proxy")
			pool.rotate()
			if ferr := failover(session, pool, stats); ferr != nil {
				log.Printf("failover: %v", ferr)
			} else {
				nextRenew = time.Now().Add(session.renewWait())
			}
		} else {
			pool.mark(true)
		}

		if kind == "waiting_room" && !queued {
			announce(kind, body, hdr)
			queued = true
			stats.mu.Lock()
			stats.queueUps++
			stats.mu.Unlock()
		}
		if kind == "store" {
			queued = false
		}
		prev = kind
	}
	log.Printf("monitor finished; last state=%s", kind)
}

func failover(session *sessionState, pool *proxyPool, stats *monitorStats) error {
	stats.mu.Lock()
	stats.failovers++
	stats.mu.Unlock()
	if err := session.rebuild(pool.current()); err != nil {
		return err
	}
	kind, _, _, err := session.bootstrap()
	if err != nil {
		pool.mark(false)
		return err
	}
	if kind == "captcha" {
		pool.rotate()
		return fmt.Errorf("failover still captcha")
	}
	pool.mark(true)
	log.Printf("failover session live (%s)", kind)
	return nil
}

func updateStats(stats *monitorStats, pool *proxyPool, session *sessionState, kind string, hdr fhttp.Header, bytes int, _ bool) {
	total, benched, idx := pool.status()
	xiinfo := ""
	if hdr != nil {
		xiinfo = hdr.Get("X-Iinfo")
	}
	stats.mu.Lock()
	stats.state = kind
	stats.lastBytes = bytes
	stats.lastXIinfo = xiinfo
	stats.hasReese = session.reeseToken != ""
	stats.proxyTotal = total
	stats.proxyBench = benched
	stats.proxyIdx = idx
	stats.mu.Unlock()
}

func (s *sessionState) rebuild(proxy string) error {
	c, err := client.CreateNewTLSClient(proxy)
	if err != nil {
		return err
	}
	s.client = c
	s.ip = ""
	s.scriptURL = ""
	s.postURL = ""
	s.reeseToken = ""
	s.renewInSec = 0
	if proxy == "" {
		log.Printf("tls client ready (direct)")
	} else {
		log.Printf("tls client ready (proxy)")
	}
	return nil
}

func (s *sessionState) bootstrap() (string, string, fhttp.Header, error) {
	log.Printf("GET homepage (unsolved)")
	body, hdr, err := s.getHomepage()
	if err != nil {
		return "", "", nil, err
	}
	kind := classify(body)
	log.Printf("unsolved page: %s (%d bytes) x-iinfo=%q cookies=%s", kind, len(body), hdr.Get("X-Iinfo"), s.cookieNames())
	if err := s.solveReese(body); err != nil {
		log.Printf("reese84 not solved: %v", err)
		if kind != "store" && kind != "waiting_room" {
			return kind, body, hdr, err
		}
	} else {
		log.Printf("reese84 cookie set; renewInSec=%d", s.renewInSec)
		body, hdr, err = s.getHomepage()
		if err != nil {
			return "", "", nil, err
		}
		kind = classify(body)
		log.Printf("after reese84: %s (%d bytes) x-iinfo=%q cookies=%s", kind, len(body), hdr.Get("X-Iinfo"), s.cookieNames())
	}
	if kind == "captcha" || kind == "utmvc" {
		if err := s.solveUtmvc(body); err != nil {
			log.Printf("utmvc skipped/failed: %v", err)
		} else {
			body, hdr, err = s.getHomepage()
			if err != nil {
				return "", "", nil, err
			}
			kind = classify(body)
			log.Printf("after utmvc: %s (%d bytes) x-iinfo=%q cookies=%s", kind, len(body), hdr.Get("X-Iinfo"), s.cookieNames())
		}
	}
	return kind, body, hdr, nil
}

func dumpSnapshot(dir, from, to, body string, hdr fhttp.Header, s *sessionState) error {
	if strings.TrimSpace(dir) == "" {
		return nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	stamp := time.Now().UTC().Format("20060102-150405")
	base := filepath.Join(dir, stamp+"-"+from+"-"+to)
	meta, _ := json.MarshalIndent(map[string]any{
		"at":      time.Now().UTC().Format(time.RFC3339),
		"from":    from,
		"to":      to,
		"bytes":   len(body),
		"xIinfo":  hdr.Get("X-Iinfo"),
		"xCdn":    hdr.Get("X-CDN"),
		"cookies": s.cookieNames(),
	}, "", "  ")
	if err := os.WriteFile(base+".json", append(meta, '\n'), 0o644); err != nil {
		return err
	}
	return os.WriteFile(base+".html", []byte(body), 0o644)
}

func announceQueue(kind, body string, hdr fhttp.Header, webhook, discord string) {
	log.Printf("QUEUE UP — %s on homepage (%d bytes)", kind, len(body))
	xi := ""
	if hdr != nil {
		xi = hdr.Get("X-Iinfo")
	}
	postJSON(webhook, map[string]any{
		"event":  "pokemoncenter_queue_up",
		"state":  kind,
		"url":    pageURL,
		"bytes":  len(body),
		"xIinfo": xi,
		"at":     time.Now().UTC().Format(time.RFC3339),
	})
	postJSON(discord, discordQueueEmbed(kind, len(body), xi))
}

func firstEnv(keys ...string) string {
	for _, k := range keys {
		if v := strings.TrimSpace(os.Getenv(k)); v != "" {
			return v
		}
	}
	return ""
}

type sessionState struct {
	client     tls_client.HttpClient
	ua         *task.BaseUserAgentInfo
	hyper      *hyperClient
	ip         string
	scriptURL  string
	postURL    string
	reeseToken string
	renewInSec int
}

func (s *sessionState) navHeaders() map[string][]string {
	return map[string][]string{
		"host":                      {"www.pokemoncenter.com"},
		"connection":                {"keep-alive"},
		"sec-ch-ua":                 {s.ua.Sec_ua},
		"sec-ch-ua-mobile":          {"?0"},
		"sec-ch-ua-platform":        {s.ua.Platform},
		"upgrade-insecure-requests": {"1"},
		"user-agent":                {s.ua.Useragent},
		"accept":                    {"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"},
		"sec-fetch-site":            {"none"},
		"sec-fetch-mode":            {"navigate"},
		"sec-fetch-user":            {"?1"},
		"sec-fetch-dest":            {"document"},
		"accept-encoding":           {"gzip, deflate, br, zstd"},
		"accept-language":           {"en-US,en;q=0.9"},
		"header-order":              {"host", "connection", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "upgrade-insecure-requests", "user-agent", "accept", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-user", "sec-fetch-dest", "accept-encoding", "accept-language"},
	}
}

func (s *sessionState) scriptHeaders() map[string][]string {
	return map[string][]string{
		"host":               {"www.pokemoncenter.com"},
		"connection":         {"keep-alive"},
		"sec-ch-ua-platform": {s.ua.Platform},
		"user-agent":         {s.ua.Useragent},
		"sec-ch-ua":          {s.ua.Sec_ua},
		"sec-ch-ua-mobile":   {"?0"},
		"accept":             {"*/*"},
		"sec-fetch-site":     {"same-origin"},
		"sec-fetch-mode":     {"no-cors"},
		"sec-fetch-dest":     {"script"},
		"referer":            {pageURL},
		"accept-encoding":    {"gzip, deflate, br, zstd"},
		"accept-language":    {"en-US,en;q=0.9"},
		"header-order":       {"host", "connection", "sec-ch-ua-platform", "user-agent", "sec-ch-ua", "sec-ch-ua-mobile", "accept", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language"},
	}
}

func (s *sessionState) getHomepage() (string, fhttp.Header, error) {
	resp, body, err := client.MakeRequest(client.RequestStruct{
		CTX:     context.Background(),
		Req:     client.ReqStruct{Method: "GET", URL: pageURL},
		Headers: s.navHeaders(),
	}, s.client, nil)
	if err != nil {
		return "", nil, err
	}
	return body, resp.Header, nil
}

func (s *sessionState) solveReese(homeHTML string) error {
	// Match the live Pokémon Center checkout path: static sensor uses ?d=host,
	// dynamic POI uses the scriptElement.src URL for GET, Hyper, and POST.
	// Checkout does not fetch or send PoW to Hyper.
	scriptURL, postURL := staticScript, staticScript+"?d=www.pokemoncenter.com"
	if strings.Contains(homeHTML, "Pardon Our Interruption") {
		ok, fullPath := pokemoncenter.ParseIncapDynamic(homeHTML)
		if !ok || fullPath == "" {
			return fmt.Errorf("failed to parse dynamic reese script")
		}
		scriptURL = "https://www.pokemoncenter.com" + fullPath
		postURL = scriptURL
		log.Printf("dynamic reese script %s", fullPath)
	}
	s.scriptURL = scriptURL
	s.postURL = postURL

	_, script, err := client.MakeRequest(client.RequestStruct{
		CTX:     context.Background(),
		Req:     client.ReqStruct{Method: "GET", URL: scriptURL},
		Headers: s.scriptHeaders(),
	}, s.client, nil)
	if err != nil {
		return fmt.Errorf("fetch script: %w", err)
	}
	if len(script) < 1000 {
		return fmt.Errorf("script too small (%d bytes)", len(script))
	}
	log.Printf("reese script %d bytes", len(script))

	if err := s.lookupIP(); err != nil {
		return err
	}

	payload, err := s.hyper.reese84(map[string]any{
		"userAgent":      s.ua.Useragent,
		"pageUrl":        pageURL,
		"script":         script,
		"scriptUrl":      scriptURL,
		"ip":             s.ip,
		"acceptLanguage": "en-US,en;q=0.9",
	})
	if err != nil {
		return err
	}

	resp, body, err := client.MakeRequest(client.RequestStruct{
		CTX: context.Background(),
		Req: client.ReqStruct{Method: "POST", URL: postURL, Data: payload},
		Headers: map[string][]string{
			"host":               {"www.pokemoncenter.com"},
			"connection":         {"keep-alive"},
			"sec-ch-ua-platform": {s.ua.Platform},
			"user-agent":         {s.ua.Useragent},
			"accept":             {"application/json; charset=utf-8"},
			"sec-ch-ua":          {s.ua.Sec_ua},
			"content-type":       {"text/plain; charset=utf-8"},
			"sec-ch-ua-mobile":   {"?0"},
			"origin":             {"https://www.pokemoncenter.com"},
			"sec-fetch-site":     {"same-origin"},
			"sec-fetch-mode":     {"cors"},
			"sec-fetch-dest":     {"empty"},
			"referer":            {pageURL},
			"accept-encoding":    {"gzip, deflate, br, zstd"},
			"accept-language":    {"en-US,en;q=0.9"},
			"header-order":       {"host", "connection", "content-length", "sec-ch-ua-platform", "user-agent", "accept", "sec-ch-ua", "content-type", "sec-ch-ua-mobile", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language"},
		},
	}, s.client, nil)
	if err != nil {
		return fmt.Errorf("post reese: %w", err)
	}
	if resp.StatusCode != 200 {
		return fmt.Errorf("post reese status %s: %s", resp.Status, truncate(body, 180))
	}
	var parsed struct {
		Token        string `json:"token"`
		RenewInSec   int    `json:"renewInSec"`
		CookieDomain string `json:"cookieDomain"`
	}
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		return fmt.Errorf("parse reese token: %w", err)
	}
	if parsed.Token == "" {
		return fmt.Errorf("empty reese token")
	}
	domain := parsed.CookieDomain
	if domain == "" {
		domain = "www.pokemoncenter.com"
	}
	s.setCookie("reese84", parsed.Token, domain)
	s.reeseToken = parsed.Token
	s.renewInSec = parsed.RenewInSec
	if s.renewInSec <= 0 {
		s.renewInSec = 600
	}
	return nil
}

func (s *sessionState) renewReese() error {
	if s.reeseToken == "" || s.postURL == "" {
		return fmt.Errorf("no reese token")
	}
	resp, body, err := client.MakeRequest(client.RequestStruct{
		CTX: context.Background(),
		Req: client.ReqStruct{Method: "POST", URL: s.postURL, Data: s.reeseToken},
		Headers: map[string][]string{
			"host":               {"www.pokemoncenter.com"},
			"connection":         {"keep-alive"},
			"sec-ch-ua-platform": {s.ua.Platform},
			"user-agent":         {s.ua.Useragent},
			"accept":             {"application/json; charset=utf-8"},
			"sec-ch-ua":          {s.ua.Sec_ua},
			"content-type":       {"text/plain; charset=utf-8"},
			"sec-ch-ua-mobile":   {"?0"},
			"origin":             {"https://www.pokemoncenter.com"},
			"sec-fetch-site":     {"same-origin"},
			"sec-fetch-mode":     {"cors"},
			"sec-fetch-dest":     {"empty"},
			"referer":            {pageURL},
			"accept-encoding":    {"gzip, deflate, br, zstd"},
			"accept-language":    {"en-US,en;q=0.9"},
			"header-order":       {"host", "connection", "content-length", "sec-ch-ua-platform", "user-agent", "accept", "sec-ch-ua", "content-type", "sec-ch-ua-mobile", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language"},
		},
	}, s.client, nil)
	if err != nil {
		return err
	}
	if resp.StatusCode != 200 {
		return fmt.Errorf("status %s", resp.Status)
	}
	var parsed struct {
		Token      string `json:"token"`
		RenewInSec int    `json:"renewInSec"`
	}
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		return err
	}
	if parsed.Token != "" {
		s.setCookie("reese84", parsed.Token, "www.pokemoncenter.com")
		s.reeseToken = parsed.Token
	}
	if parsed.RenewInSec > 0 {
		s.renewInSec = parsed.RenewInSec
	}
	return nil
}

func (s *sessionState) renewWait() time.Duration {
	sec := s.renewInSec - 30
	if sec < 15 {
		sec = 15
	}
	return time.Duration(sec) * time.Second
}

func (s *sessionState) solveUtmvc(homeHTML string) error {
	incident := reIncident.FindStringSubmatch(homeHTML)
	if len(incident) < 2 {
		return fmt.Errorf("no incap iframe")
	}
	iframeURL := "https://www.pokemoncenter.com" + incident[1]
	resp, iframe, err := client.MakeRequest(client.RequestStruct{
		CTX:     context.Background(),
		Req:     client.ReqStruct{Method: "GET", URL: iframeURL},
		Headers: s.scriptHeaders(),
	}, s.client, nil)
	if err != nil {
		return err
	}
	if resp.StatusCode != 200 {
		return fmt.Errorf("iframe status %s", resp.Status)
	}
	if strings.Contains(iframe, "h-captcha") || strings.Contains(iframe, "g-recaptcha-response") {
		return fmt.Errorf("iframe is hCaptcha, not utmvc")
	}
	if !reSWJIYLWA.MatchString(iframe) && !strings.Contains(iframe, "SWJIYLWA") {
		return fmt.Errorf("iframe is not utmvc")
	}

	sessionIDs := s.incapSessionIDs()
	payload, swhanedl, err := s.hyper.utmvc(map[string]any{
		"script":     iframe,
		"sessionIds": sessionIDs,
		"userAgent":  s.ua.Useragent,
	})
	if err != nil {
		return err
	}
	s.setCookie("___utmvc", payload, "www.pokemoncenter.com")
	resp, _, err = client.MakeRequest(client.RequestStruct{
		CTX:     context.Background(),
		Req:     client.ReqStruct{Method: "GET", URL: "https://www.pokemoncenter.com/_Incapsula_Resource?SWHANEDL=" + swhanedl},
		Headers: s.scriptHeaders(),
	}, s.client, nil)
	if err != nil {
		return err
	}
	if resp.StatusCode != 200 {
		return fmt.Errorf("swhanedl status %s", resp.Status)
	}
	log.Printf("utmvc submitted")
	return nil
}

func (s *sessionState) lookupIP() error {
	for _, ipURL := range []string{"https://ip.graphlabs.xyz/", "https://api.ipify.org?format=json"} {
		_, body, err := client.MakeRequest(client.RequestStruct{
			CTX:     context.Background(),
			Req:     client.ReqStruct{Method: "GET", URL: ipURL},
			Headers: map[string][]string{"accept": {"application/json"}},
		}, s.client, nil)
		if err != nil {
			continue
		}
		var parsed struct {
			IP string `json:"ip"`
		}
		_ = json.Unmarshal([]byte(body), &parsed)
		if parsed.IP == "" {
			parsed.IP = strings.TrimSpace(body)
		}
		if parsed.IP != "" && !strings.Contains(parsed.IP, "<") {
			s.ip = parsed.IP
			log.Printf("egress ip %s", s.ip)
			return nil
		}
	}
	return fmt.Errorf("could not determine egress IP")
}

func (s *sessionState) setCookie(name, value, host string) {
	host = strings.TrimPrefix(host, ".")
	u, _ := url.Parse("https://" + host)
	s.client.SetCookies(u, []*fhttp.Cookie{{
		Name:   name,
		Value:  value,
		Path:   "/",
		Domain: host,
	}})
}

func (s *sessionState) cookieNames() string {
	u, _ := url.Parse(pageURL)
	var names []string
	for _, c := range s.client.GetCookies(u) {
		names = append(names, c.Name)
	}
	if len(names) == 0 {
		return "-"
	}
	return strings.Join(names, ",")
}

func (s *sessionState) incapSessionIDs() []string {
	u, _ := url.Parse(pageURL)
	var ids []string
	for _, c := range s.client.GetCookies(u) {
		if strings.HasPrefix(c.Name, "incap_ses_") {
			ids = append(ids, c.Value)
		}
	}
	return ids
}

func classify(body string) string {
	switch {
	case reWaitingCfg.MatchString(body):
		return "waiting_room"
	case strings.Contains(body, "Pardon Our Interruption"):
		return "poi"
	case strings.Contains(body, "h-captcha") || strings.Contains(body, "SWUDNSAI"):
		return "captcha"
	case strings.Contains(body, "Incapsula incident ID"):
		if strings.Contains(body, "SWJIYLWA") {
			return "utmvc"
		}
		return "captcha"
	case strings.Contains(body, "pokemoncenter") && len(body) > 8000:
		return "store"
	case len(body) > 20000:
		return "store"
	default:
		return "unknown"
	}
}

type hyperClient struct {
	mode     string
	apiKey   string
	token    string
	deviceID string
	base     string
	http     *http.Client
}

func newHyperClient() (*hyperClient, error) {
	h := &hyperClient{
		http: &http.Client{Timeout: 40 * time.Second},
		base: strings.TrimRight(envOr("LICENSE_API_BASE", licenseBase), "/"),
	}
	if key := strings.TrimSpace(os.Getenv("HYPER_API_KEY")); key != "" {
		h.mode = "direct"
		h.apiKey = key
		return h, nil
	}
	token, deviceID, err := loadLicense()
	if err != nil {
		return nil, fmt.Errorf("no HYPER_API_KEY and %w", err)
	}
	h.mode = "license-broker"
	h.token = token
	h.deviceID = deviceID
	return h, nil
}

func loadLicense() (string, string, error) {
	if t := strings.TrimSpace(os.Getenv("LICENSE_TOKEN")); t != "" {
		return t, strings.TrimSpace(os.Getenv("DEVICE_ID")), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", "", err
	}
	dir := filepath.Join(home, zynDataDir)
	sessionRaw, err := os.ReadFile(filepath.Join(dir, "license-session.json"))
	if err != nil {
		return "", "", fmt.Errorf("license-session.json: %w (set HYPER_API_KEY)", err)
	}
	var session struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(sessionRaw, &session); err != nil || session.Token == "" {
		return "", "", fmt.Errorf("license-session.json has no token")
	}
	deviceID := ""
	if raw, err := os.ReadFile(filepath.Join(dir, "device-id.json")); err == nil {
		var dev struct {
			DeviceID string `json:"deviceId"`
		}
		_ = json.Unmarshal(raw, &dev)
		deviceID = dev.DeviceID
	}
	return session.Token, deviceID, nil
}

func (h *hyperClient) reese84(payload map[string]any) (string, error) {
	body, err := h.call("reese84", payload, false)
	if err != nil {
		return "", err
	}
	var parsed struct {
		Payload string `json:"payload"`
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", fmt.Errorf("hyper reese json: %w (%s)", err, truncate(string(body), 180))
	}
	if parsed.Payload == "" {
		return "", fmt.Errorf("hyper reese empty payload: %s", truncate(string(body), 180))
	}
	return parsed.Payload, nil
}

func (h *hyperClient) utmvc(payload map[string]any) (string, string, error) {
	body, err := h.call("incapsula-utmvc", payload, h.mode == "direct")
	if err != nil {
		return "", "", err
	}
	var parsed struct {
		Payload  string `json:"payload"`
		Swhanedl string `json:"swhanedl"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", "", fmt.Errorf("hyper utmvc json: %w", err)
	}
	if parsed.Payload == "" {
		return "", "", fmt.Errorf("hyper utmvc empty payload")
	}
	return parsed.Payload, parsed.Swhanedl, nil
}

func (h *hyperClient) call(operation string, payload map[string]any, gzipBody bool) ([]byte, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	var reqURL string
	headers := map[string]string{"content-type": "application/json"}
	body := raw
	if h.mode == "direct" {
		path := "/reese84"
		if operation == "incapsula-utmvc" {
			path = "/utmvc"
		}
		reqURL = "https://incapsula.hypersolutions.co" + path
		headers["x-api-key"] = h.apiKey
		if gzipBody {
			var buf bytes.Buffer
			zw := gzip.NewWriter(&buf)
			if _, err := zw.Write(raw); err != nil {
				return nil, err
			}
			if err := zw.Close(); err != nil {
				return nil, err
			}
			body = buf.Bytes()
			headers["content-encoding"] = "gzip"
		}
	} else {
		reqURL = h.base + "/api/services/hyper/" + operation
		headers["authorization"] = "Bearer " + h.token
		if h.deviceID != "" {
			headers["x-rcart-device-id"] = h.deviceID
		}
	}

	req, err := http.NewRequest(http.MethodPost, reqURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := h.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("hyper %s status %d: %s", operation, resp.StatusCode, truncate(string(respBody), 240))
	}
	log.Printf("hyper %s ok (%d bytes)", operation, len(respBody))
	return respBody, nil
}

func normalizeProxy(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if strings.Contains(raw, "://") {
		return raw
	}
	parts := strings.Split(raw, ":")
	switch len(parts) {
	case 2:
		return "http://" + parts[0] + ":" + parts[1]
	case 4:
		return "http://" + url.QueryEscape(parts[2]) + ":" + url.QueryEscape(parts[3]) + "@" + parts[0] + ":" + parts[1]
	default:
		return raw
	}
}

func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func truncate(s string, n int) string {
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
