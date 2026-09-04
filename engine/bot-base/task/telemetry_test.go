package task

import (
	"sync"
	"testing"
	"time"
)

func captureTelemetry(t *testing.T) func() []TaskTelemetryEvent {
	t.Helper()
	// Drop anything earlier tests queued so this test only sees its own events.
	telemetryMu.Lock()
	telemetryQueue = nil
	if telemetryTimer != nil {
		telemetryTimer.Stop()
		telemetryTimer = nil
	}
	telemetryMu.Unlock()
	var mu sync.Mutex
	var got []TaskTelemetryEvent
	SetMessageSender(func(value any) error {
		message := value.(statusMessage)
		if message.Type != "task-telemetry" {
			return nil
		}
		mu.Lock()
		defer mu.Unlock()
		got = append(got, message.Messages.([]TaskTelemetryEvent)...)
		return nil
	})
	t.Cleanup(func() {
		SetMessageSender(nil)
		SetTelemetryVersion("")
	})
	return func() []TaskTelemetryEvent {
		FlushTelemetry()
		mu.Lock()
		defer mu.Unlock()
		return append([]TaskTelemetryEvent(nil), got...)
	}
}

func TestTelemetryBatchesEventsAndStampsVersion(t *testing.T) {
	collect := captureTelemetry(t)
	SetTelemetryVersion("1.2.3")

	Telemetry(TaskTelemetryEvent{Event: TelemetryCartAttempt, Site: "Target", ShapeMethod: "mobile", CookieAgeMs: 1500})
	Telemetry(TaskTelemetryEvent{Event: TelemetryShapeBlockCart, Site: "Target", Step: "add-to-cart", CookieAgeMs: -5})
	Telemetry(TaskTelemetryEvent{Event: "", Site: "Target"})
	Telemetry(TaskTelemetryEvent{Event: TelemetryCarted, Site: ""})

	events := collect()
	if len(events) != 2 {
		t.Fatalf("events = %#v", events)
	}
	if events[0].Event != TelemetryCartAttempt || events[0].ShapeMethod != "mobile" || events[0].EngineVersion != "1.2.3" || events[0].OccurredAt <= 0 {
		t.Fatalf("first = %#v", events[0])
	}
	if events[1].CookieAgeMs != 0 || events[1].Step != "add-to-cart" {
		t.Fatalf("second = %#v", events[1])
	}
}

func TestTelemetryFlushesOnTimer(t *testing.T) {
	collect := captureTelemetry(t)
	Telemetry(TaskTelemetryEvent{Event: TelemetryCheckout, Site: "Target"})
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		telemetryMu.Lock()
		queued := len(telemetryQueue)
		telemetryMu.Unlock()
		if queued == 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if events := collect(); len(events) != 1 || events[0].Event != TelemetryCheckout {
		t.Fatalf("events = %#v", events)
	}
}

func TestSendProductWebhookEmitsOutcomeTelemetry(t *testing.T) {
	collect := captureTelemetry(t)
	SendProductWebhook(ProductWebhookData{Success: false, Site: "Target", TaskID: "run-9", ClientTaskID: "task-9", RunID: "run-9"})
	events := collect()
	if len(events) != 1 || events[0].Event != TelemetryDecline || events[0].TaskID != "task-9" || events[0].RunID != "run-9" {
		t.Fatalf("events = %#v", events)
	}
}
