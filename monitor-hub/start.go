package monitorhub

import (
	"log"
	"strings"
	"sync"

	"github.com/PolarAIO/Polar-AIO/backend/bot-base/safego"
	"github.com/PolarAIO/Polar-AIO/backend/bot-base/task"
)

type Item struct {
	MonitorInput string
	Quantity     int
	MaxPrice     float64
}

type StartInput struct {
	ID           string
	Site         string
	ProxyGroup   string
	MonitorDelay int
	Items        []Item
}

type Starter func(in StartInput)

var (
	startersMu sync.RWMutex
	starters   = map[string]Starter{}
)

func Register(site string, fn Starter) {
	key := normalizeSite(site)
	if key == "" || fn == nil {
		return
	}
	startersMu.Lock()
	starters[key] = fn
	startersMu.Unlock()
}

func Start(in StartInput) {
	if in.ID == "" {
		log.Printf("monitor-hub: missing task id")
		return
	}
	if _, ok := task.UserTasks.Get(in.ID); ok {
		return
	}
	if len(in.Items) == 0 {
		log.Printf("monitor-hub: task %s: no items", in.ID)
		return
	}

	key := normalizeSite(in.Site)
	startersMu.RLock()
	fn, ok := starters[key]
	startersMu.RUnlock()
	if !ok {
		log.Printf("monitor-hub: unsupported site %q", in.Site)
		return
	}

	safego.Go(func() { fn(in) })
}

func normalizeSite(site string) string {
	return strings.TrimSpace(site)
}
