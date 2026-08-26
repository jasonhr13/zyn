package target

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"zynbot.app/engine/client"
)

var defaultCanaryTcins = []string{
	"15011547", // bananas — grocery staple, standard cart_items payload
	"12953662", // grocery filler
	"54605734", // Charmin Ultra Soft, last resort
}

type AtcReplayResult struct {
	OK        bool   `json:"ok"`
	Status    int    `json:"status"`
	Category  string `json:"category"`
	LatencyMs int64  `json:"latencyMs"`
	Error     string `json:"error,omitempty"`
	Tcin      string `json:"tcin,omitempty"`
}

type atcReplayInput struct {
	Headers ShapeHeaders `json:"headers"`
	Proxy   string       `json:"proxy"`
	Tcin    string       `json:"tcin"`
	Tcins   []string     `json:"tcins"`
}

func normalizeCanaryTcins(primary string, extra []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, 4)
	add := func(value string) {
		tcin := strings.TrimSpace(value)
		if tcin == "" {
			return
		}
		if _, ok := seen[tcin]; ok {
			return
		}
		seen[tcin] = struct{}{}
		out = append(out, tcin)
	}
	add(primary)
	for _, value := range extra {
		add(value)
	}
	if len(out) == 0 {
		for _, value := range defaultCanaryTcins {
			add(value)
		}
	}
	return out
}

func ProxyLineToURL(proxyStr string) (string, error) {
	proxyStr = strings.TrimSpace(proxyStr)
	if proxyStr == "" {
		return "", nil
	}
	parts := strings.Split(proxyStr, ":")
	switch len(parts) {
	case 2:
		return "http://" + parts[0] + ":" + parts[1], nil
	case 4:
		return "http://" + parts[2] + ":" + parts[3] + "@" + parts[0] + ":" + parts[1], nil
	default:
		return "", fmt.Errorf("invalid proxy format")
	}
}

func ClassifyAtcReplay(statusCode int, body string) AtcReplayResult {
	switch statusCode {
	case 200, 201, 206:
		return AtcReplayResult{OK: true, Status: statusCode, Category: "ok"}
	case 401:
		return AtcReplayResult{Status: statusCode, Category: "shape_block"}
	case 403:
		return AtcReplayResult{Status: statusCode, Category: "target_block"}
	case 424:
		return AtcReplayResult{Status: statusCode, Category: "oos"}
	case 404:
		return AtcReplayResult{Status: statusCode, Category: "not_found"}
	case 429:
		return AtcReplayResult{Status: statusCode, Category: "rate_limit"}
	default:
		if statusCode <= 0 {
			return AtcReplayResult{Category: "proxy", Error: strings.TrimSpace(body)}
		}
		return AtcReplayResult{Status: statusCode, Category: "unknown", Error: strings.TrimSpace(body)}
	}
}

func AtcReplayHeaders(h ShapeHeaders, tcin string) map[string][]string {
	return map[string][]string{
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
		"referer":            {fmt.Sprintf("https://www.target.com/p/-/A-%s", tcin)},
		"accept-encoding":    {"gzip, deflate, br, zstd"},
		"accept-language":    {"en-US,en;q=0.9"},
		"priority":           {"u=1, i"},
		"header-order":       {"content-length", "sec-ch-ua-platform", "x-gyjwza5z-z", "x-application-name", "sec-ch-ua", "x-gyjwza5z-f", "sec-ch-ua-mobile", "x-gyjwza5z-a0", "x-gyjwza5z-b", "x-gyjwza5z-a", "user-agent", "accept", "x-gyjwza5z-c", "content-type", "x-gyjwza5z-d", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language", "cookie", "priority"},
	}
}

func ReplayAtcCookie(ctx context.Context, headers ShapeHeaders, proxyLine, tcin string, doer client.HttpClient) (AtcReplayResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	tcin = strings.TrimSpace(tcin)
	if tcin == "" {
		tcin = defaultCanaryTcins[0]
	}
	if !headers.Valid() {
		return AtcReplayResult{Category: "unknown", Error: "missing shape headers", Tcin: tcin}, nil
	}

	if doer == nil {
		proxyURL, err := ProxyLineToURL(proxyLine)
		if err != nil {
			return AtcReplayResult{Category: "proxy", Error: err.Error(), Tcin: tcin}, nil
		}
		built, err := client.CreateNewTLSClient(proxyURL)
		if err != nil {
			return AtcReplayResult{Category: "proxy", Error: err.Error(), Tcin: tcin}, nil
		}
		doer = built
	}

	payloadBytes, err := json.Marshal(addToCartPayload{
		CartItem: addToCartItemPayload{
			ItemChannelID: "10",
			Tcin:          tcin,
			Quantity:      1,
		},
		CartType:        "REGULAR",
		ChannelID:       "10",
		ShoppingContext: "DIGITAL",
	})
	if err != nil {
		return AtcReplayResult{}, err
	}

	started := time.Now()
	response, body, err := client.MakeRequest(client.RequestStruct{
		CTX: ctx,
		Req: client.ReqStruct{
			Method: "POST",
			URL:    "https://carts.target.com/web_checkouts/v1/cart_items?field_groups=CART%2CCART_ITEMS%2CSUMMARY&key=9f36aeafbe60771e321a7cc95a78140772ab3e96",
			Data:   string(payloadBytes),
		},
		Headers: AtcReplayHeaders(headers, tcin),
	}, doer, nil)
	result := ClassifyAtcReplay(0, "")
	result.Tcin = tcin
	result.LatencyMs = time.Since(started).Milliseconds()
	if err != nil {
		result.Category = "proxy"
		result.Error = err.Error()
		return result, nil
	}
	classified := ClassifyAtcReplay(response.StatusCode, body)
	classified.Tcin = tcin
	classified.LatencyMs = result.LatencyMs
	return classified, nil
}

func ReplayAtcCookieList(ctx context.Context, headers ShapeHeaders, proxyLine string, tcins []string, doer client.HttpClient) (AtcReplayResult, error) {
	list := normalizeCanaryTcins("", tcins)
	var last AtcReplayResult
	started := time.Now()
	for _, tcin := range list {
		result, err := ReplayAtcCookie(ctx, headers, proxyLine, tcin, doer)
		if err != nil {
			return result, err
		}
		result.LatencyMs = time.Since(started).Milliseconds()
		last = result
		if result.Category == "oos" || result.Category == "not_found" {
			continue
		}
		return result, nil
	}
	if last.Category == "" {
		last = AtcReplayResult{Category: "unknown", Error: "no canary tcins"}
	}
	last.LatencyMs = time.Since(started).Milliseconds()
	return last, nil
}

func RunShapeCanaryCLI() int {
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, 1<<20))
	if err != nil {
		return writeCanaryResult(AtcReplayResult{Category: "unknown", Error: err.Error()})
	}
	var input atcReplayInput
	if err := json.Unmarshal(raw, &input); err != nil {
		return writeCanaryResult(AtcReplayResult{Category: "unknown", Error: "invalid canary payload"})
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	result, err := ReplayAtcCookieList(ctx, input.Headers, input.Proxy, append([]string{input.Tcin}, input.Tcins...), nil)
	if err != nil {
		result.Error = err.Error()
		result.Category = "unknown"
	}
	return writeCanaryResult(result)
}

func writeCanaryResult(result AtcReplayResult) int {
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		return 2
	}
	if result.OK || result.Category == "oos" || result.Category == "not_found" || result.Category == "rate_limit" {
		return 0
	}
	return 1
}
