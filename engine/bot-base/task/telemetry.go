package task

import (
	"strings"
	"sync"
	"time"
)

// Task telemetry events are lightweight counters that describe how tasks are doing
// against site protections (Shape blocks, rate limits, cart attempts, ...). They are
// batched to the launcher, which rolls them up and uploads them to the Zyn analytics
// service. Unlike analytics-event, they never carry product, account or order data.

const (
	telemetryFlushInterval = 500 * time.Millisecond
	telemetryMaxQueued     = 5000
)

// Telemetry event names. Keep these stable: the license service and the admin dashboard key on them.
const (
	TelemetryCartAttempt       = "cart_attempt"
	TelemetryCarted            = "carted"
	TelemetryCheckout          = "checkout"
	TelemetryDecline           = "decline"
	TelemetryShapeReady        = "shape_ready"
	TelemetryShapeUnavailable  = "shape_unavailable"
	TelemetryShapeBlockLogin   = "shape_block_login"
	TelemetryShapeBlockCart    = "shape_block_cart"
	TelemetryShapeBlockPreCart = "shape_block_precart"
	TelemetryShapeSoftBlock    = "shape_soft_block"
	TelemetryDcoRateLimited    = "dco_rate_limited"
	TelemetryRateLimited429    = "rate_limited_429"
	TelemetryPassedQueue       = "passed_queue"
)

type TaskTelemetryEvent struct {
	Event         string `json:"event"`
	Site          string `json:"site"`
	Step          string `json:"step,omitempty"`
	ShapeMethod   string `json:"shapeMethod,omitempty"`
	CookieType    string `json:"cookieType,omitempty"`
	CookieAgeMs   int64  `json:"cookieAgeMs,omitempty"`
	TaskID        string `json:"taskId,omitempty"`
	RunID         string `json:"runId,omitempty"`
	EngineVersion string `json:"engineVersion,omitempty"`
	OccurredAt    int64  `json:"occurredAt"`
}

var (
	telemetryMu      sync.Mutex
	telemetryQueue   []TaskTelemetryEvent
	telemetryVersion string
	telemetryTimer   *time.Timer
)

// SetTelemetryVersion stamps every telemetry event with the running engine version so
// shape changes can be compared release to release.
func SetTelemetryVersion(version string) {
	telemetryMu.Lock()
	defer telemetryMu.Unlock()
	telemetryVersion = strings.TrimSpace(version)
}

// Telemetry queues one task telemetry event. Events with no name or site are dropped.
func Telemetry(event TaskTelemetryEvent) {
	event.Event = strings.TrimSpace(event.Event)
	event.Site = strings.TrimSpace(event.Site)
	if event.Event == "" || event.Site == "" {
		return
	}
	if event.OccurredAt <= 0 {
		event.OccurredAt = time.Now().UnixMilli()
	}
	if event.CookieAgeMs < 0 {
		event.CookieAgeMs = 0
	}

	telemetryMu.Lock()
	defer telemetryMu.Unlock()
	if event.EngineVersion == "" {
		event.EngineVersion = telemetryVersion
	}
	if len(telemetryQueue) >= telemetryMaxQueued {
		telemetryQueue = telemetryQueue[1:]
	}
	telemetryQueue = append(telemetryQueue, event)
	if telemetryTimer == nil {
		telemetryTimer = time.AfterFunc(telemetryFlushInterval, flushTelemetry)
	}
}

func flushTelemetry() {
	telemetryMu.Lock()
	batch := telemetryQueue
	telemetryQueue = nil
	telemetryTimer = nil
	telemetryMu.Unlock()

	if len(batch) == 0 || sendMessage == nil {
		return
	}
	_ = sendMessage(statusMessage{Type: "task-telemetry", Messages: batch})
}

// FlushTelemetry sends anything still queued. Called on shutdown so the last events of a
// run are not lost with the process.
func FlushTelemetry() {
	telemetryMu.Lock()
	if telemetryTimer != nil {
		telemetryTimer.Stop()
		telemetryTimer = nil
	}
	telemetryMu.Unlock()
	flushTelemetry()
}

func outcomeTelemetry(data ProductWebhookData) TaskTelemetryEvent {
	event := TelemetryDecline
	if data.Success {
		event = TelemetryCheckout
	}
	taskID := data.ClientTaskID
	if taskID == "" {
		taskID = data.TaskID
	}
	return TaskTelemetryEvent{
		Event:  event,
		Site:   data.Site,
		TaskID: taskID,
		RunID:  data.RunID,
	}
}
