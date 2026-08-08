package serverclient

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
)

type pendingEvent struct {
	ID      string          `json:"id"`
	Payload json.RawMessage `json:"payload"`
}

var (
	eventQueueMu   sync.Mutex
	eventQueue     []pendingEvent
	eventQueuePath string
	eventQueueOnce sync.Once
	eventSeq       uint64
)

func initEventQueue() {
	eventQueueOnce.Do(func() {
		dir, err := os.UserCacheDir()
		if err != nil || dir == "" {
			dir = os.TempDir()
		}
		dir = filepath.Join(dir, "PolarAIO")
		if mkErr := os.MkdirAll(dir, 0o755); mkErr != nil {
			log.Printf("server-event queue: mkdir failed: %v", mkErr)
			dir = os.TempDir()
		}
		eventQueuePath = filepath.Join(dir, "pending-server-events.json")
		loadEventQueueLocked()
		if len(eventQueue) > 0 {
			log.Printf("server-event queue: loaded %d pending event(s) from disk", len(eventQueue))
		}
	})
}

func newEventID() string {
	var b [12]byte
	if _, err := rand.Read(b[:]); err == nil {
		return hex.EncodeToString(b[:])
	}
	n := atomic.AddUint64(&eventSeq, 1)
	return fmt.Sprintf("%d-%d-%d", time.Now().UnixNano(), os.Getpid(), n)
}

func loadEventQueueLocked() {
	data, err := os.ReadFile(eventQueuePath)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("server-event queue: read failed: %v", err)
		}
		eventQueue = nil
		return
	}
	var items []pendingEvent
	if err := json.Unmarshal(data, &items); err != nil {
		log.Printf("server-event queue: corrupt file, starting empty: %v", err)
		eventQueue = nil
		return
	}
	eventQueue = items
}

func persistEventQueueLocked() {
	if eventQueuePath == "" {
		return
	}
	data, err := json.Marshal(eventQueue)
	if err != nil {
		log.Printf("server-event queue: marshal failed: %v", err)
		return
	}
	tmp := eventQueuePath + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		log.Printf("server-event queue: write failed: %v", err)
		return
	}
	if err := os.Rename(tmp, eventQueuePath); err != nil {
		if err2 := os.WriteFile(eventQueuePath, data, 0o644); err2 != nil {
			log.Printf("server-event queue: persist failed: %v / %v", err, err2)
		}
		_ = os.Remove(tmp)
	}
}

func enqueueDurableEvent(id string, payload []byte) {
	initEventQueue()
	eventQueueMu.Lock()
	defer eventQueueMu.Unlock()

	for _, item := range eventQueue {
		if item.ID == id {
			return
		}
	}
	copied := append(json.RawMessage{}, payload...)
	eventQueue = append(eventQueue, pendingEvent{ID: id, Payload: copied})
	persistEventQueueLocked()
	log.Printf("server-event queued durably id=%s (%d pending)", id, len(eventQueue))
}

func ackDurableEvent(id string) {
	if id == "" {
		return
	}
	initEventQueue()
	eventQueueMu.Lock()
	defer eventQueueMu.Unlock()

	next := eventQueue[:0]
	removed := false
	for _, item := range eventQueue {
		if item.ID == id {
			removed = true
			continue
		}
		next = append(next, item)
	}
	if !removed {
		return
	}
	eventQueue = next
	persistEventQueueLocked()
	log.Printf("server-event acked id=%s (%d pending)", id, len(eventQueue))
}

func snapshotDurableEvents() []pendingEvent {
	initEventQueue()
	eventQueueMu.Lock()
	defer eventQueueMu.Unlock()
	out := make([]pendingEvent, len(eventQueue))
	copy(out, eventQueue)
	return out
}
