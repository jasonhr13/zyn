package pokemoncenter

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	jsoniter "github.com/json-iterator/go"
	"zynbot.app/engine/bot-base/safego"
	"zynbot.app/engine/client"
	monitorhub "zynbot.app/engine/monitor-hub"
)

const (
	unlockProductKey   = "unlock"
	statusPollInterval = 3 * time.Second
)

var statusWatcherOnce sync.Once

type statusWatcherHealth struct {
	LastAttempt time.Time
	LastSuccess time.Time
	Failed      bool
	QueueUp     bool
	Unlocked    bool
}

var statusWatcherState = struct {
	sync.RWMutex
	value statusWatcherHealth
}{}

func setStatusWatcherAttempt(at time.Time) {
	statusWatcherState.Lock()
	statusWatcherState.value.LastAttempt = at
	statusWatcherState.Unlock()
}

func setStatusWatcherFailure() {
	statusWatcherState.Lock()
	statusWatcherState.value.Failed = true
	statusWatcherState.Unlock()
}

func setStatusWatcherSuccess(status CheckStatusResponse, at time.Time) {
	statusWatcherState.Lock()
	statusWatcherState.value.LastAttempt = at
	statusWatcherState.value.LastSuccess = at
	statusWatcherState.value.Failed = false
	statusWatcherState.value.QueueUp = status.QueueUp
	statusWatcherState.value.Unlocked = status.Unlocked
	statusWatcherState.Unlock()
}

func getStatusWatcherHealth() statusWatcherHealth {
	statusWatcherState.RLock()
	defer statusWatcherState.RUnlock()
	return statusWatcherState.value
}

func ensureStatusWatcher() {
	statusWatcherOnce.Do(func() {
		safego.Go(runStatusWatcher)
	})
}

func runStatusWatcher() {
	var hc client.HttpClient
	ticker := time.NewTicker(statusPollInterval)
	defer ticker.Stop()
	for {
		attemptedAt := time.Now()
		setStatusWatcherAttempt(attemptedAt)
		if hc == nil {
			var err error
			hc, err = client.CreateNewTLSClient("")
			if err != nil {
				setStatusWatcherFailure()
				log.Printf("status watcher: failed to create client: %v", err)
				<-ticker.C
				continue
			}
		}
		status, err := fetchStatus(hc)
		if err != nil {
			setStatusWatcherFailure()
		} else {
			setStatusWatcherSuccess(status, time.Now())
			for _, ping := range statusPings(status, time.Now()) {
				monitorhub.Default.Publish(ping)
			}
		}
		<-ticker.C
	}
}

func statusPings(status CheckStatusResponse, at time.Time) []monitorhub.StockPing {
	pings := make([]monitorhub.StockPing, 0, 2)
	if status.QueueUp {
		pings = append(pings, monitorhub.StockPing{
			Site:       "PokemonCenter",
			ProductKey: "queue",
			Name:       "Zyn queue/site protection status",
			InStock:    true,
			At:         at,
			From:       "Zyn",
		})
	}
	if status.Unlocked {
		pings = append(pings, monitorhub.StockPing{
			Site:       "PokemonCenter",
			ProductKey: unlockProductKey,
			InStock:    true,
			At:         at,
			From:       "Zyn",
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
