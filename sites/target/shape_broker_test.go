package target

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestZynShapeBrokerURLUsesZynPort(t *testing.T) {
	t.Setenv("ZYN_SHAPE_PORT", "4312")
	if got := zynShapeBrokerURL(); got != "http://127.0.0.1:4312" {
		t.Fatalf("broker URL = %q", got)
	}
}

func TestFetchZynShape(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-zyn-token") != "secret" {
			t.Errorf("token header = %q", r.Header.Get("x-zyn-token"))
		}
		if r.URL.Query().Get("type") != "atc" || r.URL.Query().Get("wait") != "1" || r.URL.Query().Get("timeout") != "30000" {
			t.Errorf("query = %q", r.URL.RawQuery)
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"cookie":{"headers":{"sec-ch-ua-platform":"macOS","x-gyjwza5z-z":"z","sec-ch-ua":"ua","x-gyjwza5z-f":"f","x-gyjwza5z-b":"b","x-gyjwza5z-a":"a","user-agent":"agent","x-gyjwza5z-c":"c","x-gyjwza5z-d":"d"},"proxy":"host:1:user:pass","source":"Harvester"}}`))
	}))
	defer server.Close()

	payload, err := fetchZynShape(context.Background(), server.URL, "secret", "atc", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if !payload.Cookie.Headers.Valid() || payload.Cookie.Proxy != "host:1:user:pass" || payload.Cookie.Source != "Harvester" {
		t.Fatalf("payload = %#v", payload)
	}
}

func TestFetchZynShapeRejectsUnavailableCookie(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"ok":false,"cookie":{"headers":{},"proxy":""}}`))
	}))
	defer server.Close()

	if _, err := fetchZynShape(context.Background(), server.URL, "", "login", server.Client()); err == nil {
		t.Fatal("unavailable cookie did not return an error")
	}
}
