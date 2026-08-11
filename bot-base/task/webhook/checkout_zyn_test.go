//go:build zyn

package webhook

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/PolarAIO/Polar-AIO/backend/bot-base/task"
)

func TestZynProductWebhookBrand(t *testing.T) {
	previousClient := httpClient
	previousCheckout := CheckoutURL
	previousDecline := DeclineURL
	t.Cleanup(func() {
		httpClient = previousClient
		SetURLs(previousCheckout, previousDecline)
	})

	for _, success := range []bool{true, false} {
		name := "decline"
		if success {
			name = "checkout"
		}
		t.Run(name, func(t *testing.T) {
			var payload struct {
				Username  string `json:"username"`
				AvatarURL string `json:"avatar_url"`
				Embeds    []struct {
					Footer struct {
						Text    string `json:"text"`
						IconURL string `json:"icon_url"`
					} `json:"footer"`
				} `json:"embeds"`
			}

			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				defer request.Body.Close()
				if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
					t.Errorf("decode Discord payload: %v", err)
				}
				w.WriteHeader(http.StatusNoContent)
			}))
			defer server.Close()

			httpClient = server.Client()
			SetURLs(server.URL, server.URL)
			SendProductCheckout(task.ProductWebhookData{
				Success: success,
				Site:    "Target",
				CheckoutProducts: []task.ProductWebhookItem{{
					Name: "Test product", Quantity: 1, Price: 10,
				}},
			})

			if payload.Username != "Zyn" {
				t.Fatalf("webhook username = %q, want Zyn", payload.Username)
			}
			if payload.AvatarURL != "https://zynbot.app/zyn-icon.png" {
				t.Fatalf("webhook avatar = %q", payload.AvatarURL)
			}
			if len(payload.Embeds) != 1 || payload.Embeds[0].Footer.Text != "Zyn" {
				t.Fatalf("webhook footer = %#v", payload.Embeds)
			}
			if payload.Embeds[0].Footer.IconURL != payload.AvatarURL {
				t.Fatalf("footer icon = %q, avatar = %q", payload.Embeds[0].Footer.IconURL, payload.AvatarURL)
			}
			encoded, _ := json.Marshal(payload)
			if strings.Contains(string(encoded), "Polar AIO") {
				t.Fatalf("legacy webhook brand remains in payload: %s", encoded)
			}
		})
	}
}
