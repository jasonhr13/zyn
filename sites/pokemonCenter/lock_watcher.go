package pokemoncenter

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/PolarAIO/Polar-AIO/backend/bot-base/safego"
	"github.com/PolarAIO/Polar-AIO/backend/client"
	monitorhub "github.com/PolarAIO/Polar-AIO/backend/monitor-hub"
	jsoniter "github.com/json-iterator/go"
)

const (
	unlockProductKey   = "unlock"
	statusPollInterval = 3 * time.Second
)

var statusWatcherOnce sync.Once

func ensureStatusWatcher() {
	statusWatcherOnce.Do(func() {
		safego.Go(runStatusWatcher)
	})
}

func runStatusWatcher() {
	var hc client.HttpClient
	ticker := time.NewTicker(statusPollInterval)
	defer ticker.Stop()
	for range ticker.C {
		if hc == nil {
			var err error
			hc, err = client.CreateNewTLSClient("")
			if err != nil {
				log.Printf("status watcher: failed to create client: %v", err)
				continue
			}
		}
		status, err := fetchStatus(hc)
		if err != nil {
			continue
		}
		for _, ping := range statusPings(status, time.Now()) {
			monitorhub.Default.Publish(ping)
		}
	}
}

func statusPings(status CheckStatusResponse, at time.Time) []monitorhub.StockPing {
	pings := make([]monitorhub.StockPing, 0, 2)
	if status.QueueUp {
		pings = append(pings, monitorhub.StockPing{
			Site:       "PokemonCenter",
			ProductKey: "queue",
			Name:       "Railway queue/site protection status",
			InStock:    true,
			At:         at,
			From:       "Railway",
		})
	}
	if status.Unlocked {
		pings = append(pings, monitorhub.StockPing{
			Site:       "PokemonCenter",
			ProductKey: unlockProductKey,
			InStock:    true,
			At:         at,
			From:       "Railway",
		})
	}
	return pings
}

func fetchStatus(hc client.HttpClient) (CheckStatusResponse, error) {
	Request := client.RequestStruct{
		CTX: context.Background(),
		Req: client.ReqStruct{
			Method: "GET",
			URL:    "https://polar-wss-production.up.railway.app/sites/PokemonCenter/queue-status",
		},
		Headers: map[string][]string{},
	}
	response, body, err := client.MakeRequest(Request, hc, nil)
	if err != nil {
		return CheckStatusResponse{}, err
	}
	if response.StatusCode != 200 {
		return CheckStatusResponse{}, fmt.Errorf("failed get status (%s)", response.Status)
	}
	var responseBody CheckStatusResponse
	if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
		return CheckStatusResponse{}, err
	}
	return responseBody, nil
}
