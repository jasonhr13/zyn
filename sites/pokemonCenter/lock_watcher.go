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
	unlockProductKey = "unlock"
	lockPollInterval = 3 * time.Second
)

var lockWatcherOnce sync.Once

func ensureLockWatcher() {
	lockWatcherOnce.Do(func() {
		safego.Go(runLockWatcher)
	})
}

func runLockWatcher() {
	hc, err := client.CreateNewTLSClient("")
	if err != nil {
		log.Printf("lock watcher: failed to create client: %v", err)
		return
	}

	ticker := time.NewTicker(lockPollInterval)
	defer ticker.Stop()
	for range ticker.C {
		unlocked, err := fetchUnlocked(hc)
		if err != nil || !unlocked {
			continue
		}
		monitorhub.Default.Publish(monitorhub.StockPing{
			Site:       "PokemonCenter",
			ProductKey: unlockProductKey,
			InStock:    true,
			At:         time.Now(),
		})
	}
}

func fetchUnlocked(hc client.HttpClient) (bool, error) {
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
		return false, err
	}
	if response.StatusCode != 200 {
		return false, fmt.Errorf("failed get status (%s)", response.Status)
	}
	var responseBody CheckStatusResponse
	if err := jsoniter.Unmarshal([]byte(body), &responseBody); err != nil {
		return false, err
	}
	return responseBody.Unlocked, nil
}
