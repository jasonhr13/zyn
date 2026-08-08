package analytics

import (
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/PolarAIO/Polar-AIO/backend/bot-base/safego"
)

const presenceInterval = 15 * time.Second

var (
	sendFn      func([]byte) error
	sendMu      sync.Mutex
	notifyTimer *time.Timer
	stopCh      chan struct{}
)

func SetSender(fn func([]byte) error) {
	sendFn = fn
}

func Start() {
	stopCh = make(chan struct{})
	safego.Go(run)
}

func Stop() {
	if stopCh == nil {
		return
	}
	select {
	case <-stopCh:
	default:
		close(stopCh)
	}
}

func run() {
	ticker := time.NewTicker(presenceInterval)
	defer ticker.Stop()

	sendSnapshot()
	for {
		select {
		case <-ticker.C:
			sendSnapshot()
		case <-stopCh:
			sendSnapshot()
			return
		}
	}
}

func scheduleSend() {
	sendMu.Lock()
	defer sendMu.Unlock()

	if notifyTimer != nil {
		notifyTimer.Stop()
	}
	notifyTimer = time.AfterFunc(200*time.Millisecond, sendSnapshot)
}

func sendSnapshot() {
	fn := sendFn
	if fn == nil {
		return
	}

	msg := PresenceMessage{
		Type:           "presence",
		Timestamp:      time.Now().UnixMilli(),
		BackendVersion: Version,
		Tasks:          snapshotTasks(),
	}

	payload, err := json.Marshal(msg)
	if err != nil {
		log.Printf("analytics: marshal presence: %v", err)
		return
	}

	if err := fn(payload); err != nil {
		log.Printf("analytics: send presence: %v", err)
	}
}
