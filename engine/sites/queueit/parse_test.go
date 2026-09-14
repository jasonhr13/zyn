package queueit

import (
	"strings"
	"testing"
)

func TestStatusLineHumanizesTicket(t *testing.T) {
	progress := 1.0
	st := &StatusResponse{
		QueueState: 2,
		Ticket:     StatusTicket{Progress: &progress, WhichIsIn: "less than a minute"},
	}
	got := statusLine(st)
	if got != "In queue · less than a minute" {
		t.Fatalf("got %q", got)
	}
}

func TestStatusLineWaitingRoomAndAhead(t *testing.T) {
	ahead := 320
	num := 1842
	st := &StatusResponse{
		QueueState:     1,
		IsBeforeOrIdle: true,
		Ticket:         StatusTicket{QueueNumber: &num, UsersInLineAheadOfYou: &ahead},
	}
	got := statusLine(st)
	if got != "Waiting room · #1842 · 320 ahead" {
		t.Fatalf("got %q", got)
	}
}

func TestDumpCookiesJSONNil(t *testing.T) {
	if dumpCookiesJSON(nil, "https://www.costco.com/") != "" {
		t.Fatal("expected empty dump")
	}
}

func TestParseStartURLQuery(t *testing.T) {
	cfg, err := ParseStartURL("https://queueitcom.queue-it.net/?c=queueitcom&e=wrdemoproduct&t=https%3A%2F%2Fexample.com%2F")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CustomerID != "queueitcom" || cfg.EventID != "wrdemoproduct" {
		t.Fatalf("got %+v", cfg)
	}
	if cfg.Origin != "https://queueitcom.queue-it.net" {
		t.Fatalf("origin %s", cfg.Origin)
	}
}

func TestCustomerFromHost(t *testing.T) {
	if customerFromHost("www.costco.com") != "costco" {
		t.Fatal("costco.com")
	}
	if customerFromHost("costco.ca") != "costco" {
		t.Fatal("costco.ca")
	}
}

func TestEmptyJSConnectorIsNotReady(t *testing.T) {
	js, ok := parseClientSideConfig(`window.queueit_clientside_config={"customerId":"costco","integrations":[]};`)
	if !ok || js.CustomerID != "costco" {
		t.Fatalf("parse %+v ok=%v", js, ok)
	}
	cfg := RoomConfig{CustomerID: "costco", TargetURL: "https://www.costco.com/pokemon.html"}.applyClientSide(js, "https://www.costco.com/pokemon.html")
	if cfg.Ready() {
		t.Fatalf("empty integrations should wait %+v", cfg)
	}
	if cfg.EventID != "" {
		t.Fatalf("event %q", cfg.EventID)
	}
}

func TestArmedJSConnectorJoinURL(t *testing.T) {
	raw := `window.queueit_clientside_config={"customerId":"costco","integrations":[{"eventId":"paldeatins","queueDomain":"costco.queue-it.net","actionType":"Queue"}]};`
	js, ok := parseClientSideConfig(raw)
	if !ok {
		t.Fatal("parse")
	}
	page := "https://www.costco.com/pokemon-3-pack-paldea-partners-tins.product.4000352232.html"
	cfg := RoomConfig{CustomerID: "costco", TargetURL: page}.applyClientSide(js, page)
	if !cfg.Ready() {
		t.Fatalf("not ready %+v", cfg)
	}
	join := cfg.JoinURL()
	if !strings.Contains(join, "e=paldeatins") || !strings.Contains(join, "c=costco") {
		t.Fatalf("join %s", join)
	}
}

func TestMergeHTMLConfig(t *testing.T) {
	html := `
        customerId: 'queueitcom',
        eventId: 'wrdemoproduct',
        culture: 'en-US',
        layout: 'Queue-it.com Queue',
        challengeVerifyEndpoint: '/challengeapi/queueitcom/wrdemoproduct/verify',
        proofOfWorkHost: 'queueitcom.queue-it.net',
        queuePathPrefix: '',
        updateInterval:2000},
`
	cfg := MergeHTMLConfig(RoomConfig{}, html, "https://queueitcom.queue-it.net/?c=queueitcom&e=wrdemoproduct")
	if !cfg.Ready() {
		t.Fatalf("not ready %+v", cfg)
	}
	if cfg.spaBase() != "https://queueitcom.queue-it.net/spa-api/queue/queueitcom/wrdemoproduct" {
		t.Fatalf("spa %s", cfg.spaBase())
	}
}
