package target

import (
	"context"
	"io"
	"strings"
	"testing"

	fhttp "github.com/bogdanfinn/fhttp"
	"zynbot.app/engine/client"
)

type roundTripClient struct {
	status int
	body   string
	err    error
	sawURL string
	ua     string
}

func (c *roundTripClient) Do(req *fhttp.Request) (*fhttp.Response, error) {
	c.sawURL = req.URL.String()
	if values := req.Header["user-agent"]; len(values) > 0 {
		c.ua = values[0]
	} else {
		c.ua = req.Header.Get("User-Agent")
	}
	if c.err != nil {
		return nil, c.err
	}
	return &fhttp.Response{
		StatusCode: c.status,
		Body:       io.NopCloser(strings.NewReader(c.body)),
		Header:     make(fhttp.Header),
		Request:    req,
	}, nil
}

func (c *roundTripClient) GetCookieJar() fhttp.CookieJar { return nil }
func (c *roundTripClient) SetCookieJar(fhttp.CookieJar)  {}

var _ client.HttpClient = (*roundTripClient)(nil)

func validCanaryHeaders() ShapeHeaders {
	return ShapeHeaders{
		SecChUAPlatform: "macOS",
		XGyjwza5zZ:      "z",
		SecChUA:         `"Chromium";v="140"`,
		XGyjwza5zF:      "f",
		XGyjwza5zB:      "b",
		XGyjwza5zA:      "a",
		UserAgent:       "Mozilla/5.0 canary",
		XGyjwza5zC:      "c",
		XGyjwza5zD:      "d",
	}
}

func TestClassifyAtcReplay(t *testing.T) {
	if got := ClassifyAtcReplay(201, `{"cart_id":"x"}`); !got.OK || got.Category != "ok" {
		t.Fatalf("201 = %#v", got)
	}
	if got := ClassifyAtcReplay(401, ""); got.OK || got.Category != "shape_block" {
		t.Fatalf("401 = %#v", got)
	}
	if got := ClassifyAtcReplay(403, ""); got.Category != "target_block" {
		t.Fatalf("403 = %#v", got)
	}
	if got := ClassifyAtcReplay(424, ""); got.Category != "oos" {
		t.Fatalf("424 = %#v", got)
	}
}

func TestProxyLineToURL(t *testing.T) {
	got, err := ProxyLineToURL("host:1:user:pass")
	if err != nil || got != "http://user:pass@host:1" {
		t.Fatalf("got %q %v", got, err)
	}
	if _, err := ProxyLineToURL("bad"); err == nil {
		t.Fatal("expected invalid proxy format")
	}
}

func TestReplayAtcCookieUsesCheckoutClient(t *testing.T) {
	fake := &roundTripClient{status: 201, body: `{"cart_id":"stub"}`}
	result, err := ReplayAtcCookie(context.Background(), validCanaryHeaders(), "host:1:user:pass", "54605734", fake)
	if err != nil {
		t.Fatal(err)
	}
	if !result.OK || result.Category != "ok" || result.Status != 201 {
		t.Fatalf("result = %#v", result)
	}
	if !strings.Contains(fake.sawURL, "carts.target.com/web_checkouts/v1/cart_items") {
		t.Fatalf("url = %q", fake.sawURL)
	}
	if fake.ua != "Mozilla/5.0 canary" {
		t.Fatalf("user-agent = %q", fake.ua)
	}
}

func TestReplayAtcCookieShapeBlock(t *testing.T) {
	fake := &roundTripClient{status: 401, body: `{"error":"shape"}`}
	result, err := ReplayAtcCookie(context.Background(), validCanaryHeaders(), "", "54605734", fake)
	if err != nil {
		t.Fatal(err)
	}
	if result.OK || result.Category != "shape_block" {
		t.Fatalf("result = %#v", result)
	}
}

func TestReplayAtcCookieRejectsIncompleteHeaders(t *testing.T) {
	result, err := ReplayAtcCookie(context.Background(), ShapeHeaders{}, "", "54605734", &roundTripClient{status: 201})
	if err != nil {
		t.Fatal(err)
	}
	if result.OK || result.Category != "unknown" {
		t.Fatalf("result = %#v", result)
	}
}

type sequentialClient struct {
	codes []int
	tcins []string
}

func (c *sequentialClient) Do(req *fhttp.Request) (*fhttp.Response, error) {
	body, _ := io.ReadAll(req.Body)
	code := 201
	if len(c.codes) > 0 {
		code = c.codes[0]
		c.codes = c.codes[1:]
	}
	c.tcins = append(c.tcins, string(body))
	return &fhttp.Response{
		StatusCode: code,
		Body:       io.NopCloser(strings.NewReader(`{"cart_id":"stub"}`)),
		Header:     make(fhttp.Header),
		Request:    req,
	}, nil
}

func (c *sequentialClient) GetCookieJar() fhttp.CookieJar { return nil }
func (c *sequentialClient) SetCookieJar(fhttp.CookieJar)  {}

func TestReplayAtcCookieListSkipsOos(t *testing.T) {
	fake := &sequentialClient{codes: []int{424, 201}}
	result, err := ReplayAtcCookieList(context.Background(), validCanaryHeaders(), "", []string{"111", "222"}, fake)
	if err != nil {
		t.Fatal(err)
	}
	if !result.OK || result.Tcin != "222" {
		t.Fatalf("result = %#v bodies=%v", result, fake.tcins)
	}
}
