package pokemoncenter

import (
	"fmt"
	"log"

	"github.com/PolarAIO/Polar-AIO/backend/bot-base/hyperbroker"
	http "github.com/bogdanfinn/fhttp"
)

var hyperOperationURLs = map[string]string{
	"reese84":               "https://incapsula.hypersolutions.co/reese84",
	"datadome-tags":         "https://datadome.hypersolutions.co/tags",
	"datadome-interstitial": "https://datadome.hypersolutions.co/interstitial",
	"datadome-slider":       "https://datadome.hypersolutions.co/slider",
	"incapsula-utmvc":       "https://incapsula.hypersolutions.co/utmvc",
}

func (t *PokemonCenterTask) requestHyper(operation string, payload any) (int, string, error) {
	result, err := hyperbroker.Request(t.TaskContext.CTX, t.ID, operation, payload)
	if err != nil {
		return 0, "", err
	}
	requestURL := hyperOperationURLs[operation]
	statusText := http.StatusText(result.Status)
	if statusText == "" {
		statusText = "Unknown"
	}
	log.Printf("[ID:'%s' | Hyper Request Status: %d %s]", t.ID, result.Status, statusText)
	t.Requests.Referer = requestURL
	return result.Status, string(result.Body), nil
}

func (t *PokemonCenterTask) recordUnknownHyper(operation string, status int, body string) {
	statusText := http.StatusText(status)
	response := http.Response{StatusCode: status, Status: fmt.Sprintf("%d %s", status, statusText)}
	t.AddUnkownResponse(hyperOperationURLs[operation], response, body)
}

func (t *PokemonCenterTask) setHyperError(step string, err error) {
	t.NextStep = step
	t.Error = fmt.Errorf("Hyper broker failed: %w", err)
}
