package target

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"zynbot.app/engine/bot-base/siteconfig"
)

const zynShapeTimeout = 35 * time.Second

func zynShapeBrokerURL() string {
	port := strings.TrimSpace(os.Getenv("ZYN_SHAPE_PORT"))
	if port == "" {
		return ""
	}
	value, err := strconv.Atoi(port)
	if err != nil || value < 1 || value > 65535 {
		return ""
	}
	return "http://127.0.0.1:" + strconv.Itoa(value)
}

func fetchZynShape(ctx context.Context, brokerURL, token, cookieType string, client *http.Client) (ShapeAPIResponse, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, zynShapeTimeout)
	defer cancel()

	endpoint, err := url.Parse(strings.TrimRight(brokerURL, "/") + "/cookie")
	if err != nil {
		return ShapeAPIResponse{}, fmt.Errorf("parse broker URL: %w", err)
	}
	query := endpoint.Query()
	if strings.EqualFold(strings.TrimSpace(cookieType), "atc") {
		query.Set("type", "atc")
	} else {
		query.Set("type", "login")
	}
	query.Set("wait", "1")
	query.Set("timeout", "30000")
	endpoint.RawQuery = query.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return ShapeAPIResponse{}, fmt.Errorf("create broker request: %w", err)
	}
	if token = strings.TrimSpace(token); token != "" {
		req.Header.Set("x-zyn-token", token)
	}
	if client == nil {
		client = &http.Client{Timeout: zynShapeTimeout}
	}
	response, err := client.Do(req)
	if err != nil {
		return ShapeAPIResponse{}, fmt.Errorf("request broker cookie: %w", err)
	}
	defer response.Body.Close()

	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return ShapeAPIResponse{}, fmt.Errorf("read broker response: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return ShapeAPIResponse{}, fmt.Errorf("broker returned %s", response.Status)
	}

	var payload ShapeAPIResponse
	if err := json.Unmarshal(body, &payload); err != nil {
		return ShapeAPIResponse{}, fmt.Errorf("decode broker response: %w", err)
	}
	if !payload.OK {
		return ShapeAPIResponse{}, fmt.Errorf("broker has no %s cookie", query.Get("type"))
	}
	return payload, nil
}

func (t *TargetTask) applyShapeResponse(response ShapeAPIResponse) {
	t.ShapeHeaders = response.Cookie.Headers
	t.ShapeProxy = response.Cookie.Proxy
	t.ShapeMethod = strings.TrimSpace(response.Cookie.Source)
	if t.ShapeMethod == "" {
		t.ShapeMethod = siteconfig.ShapeMethod()
	}
	t.ShapeCreatedAt = response.Cookie.CreatedAt
	if !t.ShapeHeaders.Valid() {
		t.ShapeHeaders = ShapeHeaders{}
		t.ShapeProxy = ""
		t.ShapeMethod = ""
		t.ShapeCreatedAt = 0
	}
}
