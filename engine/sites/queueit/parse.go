package queueit

import (
	"encoding/json"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

type RoomConfig struct {
	Origin                  string
	Host                    string
	CustomerID              string
	EventID                 string
	Culture                 string
	Layout                  string
	TargetURL               string
	QueuePathPrefix         string
	ChallengeVerifyEndpoint string
	ProofOfWorkHost         string
	UpdateIntervalMS        int
}

var (
	reCustomer   = regexp.MustCompile(`customerId:\s*'([^']+)'`)
	reEvent      = regexp.MustCompile(`eventId:\s*'([^']+)'`)
	reCulture    = regexp.MustCompile(`culture:\s*'([^']+)'`)
	reLayout     = regexp.MustCompile(`layout:\s*'([^']+)'`)
	reInterval   = regexp.MustCompile(`updateInterval:\s*(\d+)`)
	reVerify     = regexp.MustCompile(`challengeVerifyEndpoint:\s*'([^']+)'`)
	rePowHost    = regexp.MustCompile(`proofOfWorkHost:\s*'([^']+)'`)
	rePathPrefix = regexp.MustCompile(`queuePathPrefix:\s*'([^']*)'`)
)

func firstItemURL(items []string) string {
	for _, item := range items {
		if s := strings.TrimSpace(item); s != "" {
			return s
		}
	}
	return ""
}

func ParseStartURL(raw string) (RoomConfig, error) {
	cfg := RoomConfig{Culture: "en-US", UpdateIntervalMS: 2000}
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme == "" || u.Host == "" {
		return cfg, err
	}
	cfg.Host = u.Host
	cfg.Origin = u.Scheme + "://" + u.Host
	q := u.Query()
	cfg.CustomerID = firstNonEmpty(q.Get("c"), q.Get("customerId"))
	cfg.EventID = firstNonEmpty(q.Get("e"), q.Get("eventId"))
	cfg.TargetURL = firstNonEmpty(q.Get("t"), q.Get("targetUrl"))
	if cid := q.Get("cid"); cid != "" {
		cfg.Culture = cid
	}
	if cfg.CustomerID == "" && strings.HasSuffix(strings.ToLower(u.Host), ".queue-it.net") {
		sub := strings.TrimSuffix(strings.ToLower(u.Host), ".queue-it.net")
		if sub != "" && !strings.Contains(sub, ".") {
			cfg.CustomerID = sub
		}
	}
	return cfg, nil
}

func MergeHTMLConfig(cfg RoomConfig, html, landedURL string) RoomConfig {
	if landed, err := url.Parse(landedURL); err == nil && landed.Host != "" {
		if cfg.EventID == "" || strings.Contains(strings.ToLower(landed.Host), "queue-it") {
			cfg.Host = landed.Host
			cfg.Origin = landed.Scheme + "://" + landed.Host
		}
		if cfg.CustomerID == "" {
			if cid := customerFromHost(landed.Host); cid != "" {
				cfg.CustomerID = cid
			}
		}
	}
	if js, ok := parseClientSideConfig(html); ok {
		cfg = cfg.applyClientSide(js, firstNonEmpty(cfg.TargetURL, landedURL))
	}
	if v := match1(reCustomer, html); v != "" {
		cfg.CustomerID = v
	}
	if v := match1(reEvent, html); v != "" {
		cfg.EventID = v
	}
	if v := match1(reCulture, html); v != "" {
		cfg.Culture = v
	}
	if v := match1(reLayout, html); v != "" {
		cfg.Layout = v
	}
	if v := match1(reVerify, html); v != "" {
		cfg.ChallengeVerifyEndpoint = v
	}
	if v := match1(rePowHost, html); v != "" {
		cfg.ProofOfWorkHost = v
	}
	if v := match1(rePathPrefix, html); v != "" {
		cfg.QueuePathPrefix = v
	}
	if v := match1(reInterval, html); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			cfg.UpdateIntervalMS = n
		}
	}
	if cfg.ProofOfWorkHost == "" {
		cfg.ProofOfWorkHost = cfg.Host
	}
	if cfg.ChallengeVerifyEndpoint == "" && cfg.CustomerID != "" && cfg.EventID != "" {
		cfg.ChallengeVerifyEndpoint = "/challengeapi/" + cfg.CustomerID + "/" + cfg.EventID + "/verify"
	}
	if cfg.UpdateIntervalMS <= 0 {
		cfg.UpdateIntervalMS = 2000
	}
	if cfg.Culture == "" {
		cfg.Culture = "en-US"
	}
	return cfg
}

func (c RoomConfig) Ready() bool {
	return c.Origin != "" && c.CustomerID != "" && c.EventID != ""
}

type clientSideConfig struct {
	CustomerID   string              `json:"customerId"`
	Integrations []clientIntegration `json:"integrations"`
}

type clientIntegration struct {
	EventID     string          `json:"eventId"`
	QueueDomain string          `json:"queueDomain"`
	ActionType  string          `json:"actionType"`
	Culture     string          `json:"culture"`
	LayoutName  string          `json:"layoutName"`
	Triggers    []clientTrigger `json:"triggers"`
}

type clientTrigger struct {
	TriggerParts []clientTriggerPart `json:"triggerParts"`
}

type clientTriggerPart struct {
	Operator       string `json:"operator"`
	ValueToCompare string `json:"valueToCompare"`
	URLPart        string `json:"urlPart"`
	IsNegative     bool   `json:"isNegative"`
	IsIgnoreCase   bool   `json:"isIgnoreCase"`
}

func customerFromHost(host string) string {
	h := strings.ToLower(strings.TrimSpace(host))
	h = strings.TrimPrefix(h, "www.")
	if h == "costco.com" || strings.HasSuffix(h, ".costco.com") || h == "costco.ca" || strings.HasSuffix(h, ".costco.ca") {
		return "costco"
	}
	if strings.HasSuffix(h, ".queue-it.net") {
		sub := strings.TrimSuffix(h, ".queue-it.net")
		if sub != "" && !strings.Contains(sub, ".") {
			return sub
		}
	}
	return ""
}

func jsConnectorURL(customerID string) string {
	cid := strings.TrimSpace(customerID)
	if cid == "" {
		return ""
	}
	return "https://assets.queue-it.net/" + url.PathEscape(cid) + "/integrationconfig/javascript/queueclientConfig.js"
}

func parseClientSideConfig(raw string) (clientSideConfig, bool) {
	const marker = "queueit_clientside_config"
	i := strings.Index(raw, marker)
	if i < 0 {
		return clientSideConfig{}, false
	}
	rest := raw[i+len(marker):]
	brace := strings.Index(rest, "{")
	if brace < 0 {
		return clientSideConfig{}, false
	}
	dec := json.NewDecoder(strings.NewReader(rest[brace:]))
	var cfg clientSideConfig
	if err := dec.Decode(&cfg); err != nil {
		return clientSideConfig{}, false
	}
	return cfg, true
}

func (c RoomConfig) applyClientSide(js clientSideConfig, pageURL string) RoomConfig {
	if js.CustomerID != "" {
		c.CustomerID = js.CustomerID
	}
	hit, ok := matchClientIntegration(js.Integrations, pageURL)
	if !ok {
		return c
	}
	c.EventID = hit.EventID
	if hit.Culture != "" {
		c.Culture = hit.Culture
	}
	if hit.LayoutName != "" {
		c.Layout = hit.LayoutName
	}
	if c.TargetURL == "" {
		c.TargetURL = pageURL
	}
	host := strings.TrimSpace(hit.QueueDomain)
	host = strings.TrimPrefix(host, "https://")
	host = strings.TrimPrefix(host, "http://")
	host = strings.TrimSuffix(host, "/")
	if host == "" && c.CustomerID != "" {
		host = c.CustomerID + ".queue-it.net"
	}
	if host != "" {
		c.Host = host
		c.Origin = "https://" + host
	}
	return c
}

func matchClientIntegration(list []clientIntegration, pageURL string) (clientIntegration, bool) {
	var fallback clientIntegration
	var foundFallback bool
	for _, item := range list {
		if strings.TrimSpace(item.EventID) == "" {
			continue
		}
		action := strings.ToLower(strings.TrimSpace(item.ActionType))
		if action == "cancel" || action == "ignore" {
			continue
		}
		if integrationMatchesURL(item, pageURL) {
			return item, true
		}
		if !foundFallback {
			fallback = item
			foundFallback = true
		}
	}
	if foundFallback {
		return fallback, true
	}
	return clientIntegration{}, false
}

func integrationMatchesURL(item clientIntegration, pageURL string) bool {
	if len(item.Triggers) == 0 {
		return true
	}
	for _, trig := range item.Triggers {
		if triggerMatchesURL(trig, pageURL) {
			return true
		}
	}
	return false
}

func triggerMatchesURL(trig clientTrigger, pageURL string) bool {
	if len(trig.TriggerParts) == 0 {
		return true
	}
	for _, part := range trig.TriggerParts {
		hay := pageURL
		if part.IsIgnoreCase {
			hay = strings.ToLower(hay)
		}
		needle := part.ValueToCompare
		if part.IsIgnoreCase {
			needle = strings.ToLower(needle)
		}
		op := strings.ToLower(strings.TrimSpace(part.Operator))
		matched := false
		switch op {
		case "", "contains":
			matched = needle != "" && strings.Contains(hay, needle)
		case "equals":
			matched = hay == needle
		default:
			matched = needle != "" && strings.Contains(hay, needle)
		}
		if part.IsNegative {
			matched = !matched
		}
		if !matched {
			return false
		}
	}
	return true
}

func (c RoomConfig) JoinURL() string {
	if c.CustomerID == "" || c.EventID == "" {
		return ""
	}
	host := c.Host
	if host == "" || !c.IsQueueHost() {
		host = c.CustomerID + ".queue-it.net"
	}
	q := url.Values{}
	q.Set("c", c.CustomerID)
	q.Set("e", c.EventID)
	if c.TargetURL != "" {
		q.Set("t", c.TargetURL)
	}
	return "https://" + host + "/?" + q.Encode()
}

func (c RoomConfig) IsQueueHost() bool {
	h := strings.ToLower(c.Host)
	return strings.Contains(h, "queue-it.net") || strings.Contains(h, "queueit")
}

func (c RoomConfig) spaBase() string {
	prefix := strings.TrimSuffix(c.QueuePathPrefix, "/")
	return c.Origin + prefix + "/spa-api/queue/" + c.CustomerID + "/" + c.EventID
}

func (c RoomConfig) powOrigin() string {
	host := strings.TrimSpace(c.ProofOfWorkHost)
	if strings.HasPrefix(host, "http://") || strings.HasPrefix(host, "https://") {
		return strings.TrimRight(host, "/")
	}
	if host == "" {
		return c.Origin
	}
	return "https://" + host
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func match1(re *regexp.Regexp, s string) string {
	m := re.FindStringSubmatch(s)
	if len(m) < 2 {
		return ""
	}
	return m[1]
}

func absURL(base, loc string) string {
	if loc == "" {
		return ""
	}
	u, err := url.Parse(loc)
	if err != nil {
		return loc
	}
	if u.IsAbs() {
		return u.String()
	}
	b, err := url.Parse(base)
	if err != nil {
		return loc
	}
	return b.ResolveReference(u).String()
}

func looksLikePassURL(raw string) bool {
	return strings.Contains(strings.ToLower(raw), "queueittoken=")
}
