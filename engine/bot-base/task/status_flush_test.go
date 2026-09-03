package task

import (
	"testing"
	"time"
)

func TestFlushStatusQueueDoesNotHoldLockDuringSend(t *testing.T) {
	t.Cleanup(func() {
		sendMessage = nil
		safeTaskStatuses.mu.Lock()
		safeTaskStatuses.value = nil
		safeTaskStatuses.mu.Unlock()
	})

	unlocked := make(chan struct{})
	sendMessage = func(any) error {
		safeTaskStatuses.mu.Lock()
		safeTaskStatuses.mu.Unlock()
		close(unlocked)
		return nil
	}
	safeTaskStatuses.mu.Lock()
	safeTaskStatuses.value = []taskStatus{{TaskID: "t1", Status: "Starting", Running: true}}
	safeTaskStatuses.mu.Unlock()

	flushStatusQueue()
	select {
	case <-unlocked:
	case <-time.After(time.Second):
		t.Fatal("flushStatusQueue held the status mutex during send")
	}
}

func TestHeartbeatSkipsUnchangedStatus(t *testing.T) {
	t.Cleanup(func() {
		lastHeartbeatKeys = map[string]string{}
		safeTaskStatuses.mu.Lock()
		safeTaskStatuses.value = nil
		safeTaskStatuses.mu.Unlock()
	})
	lastHeartbeatKeys = map[string]string{}
	running := &BaseTask{
		ID:        "t1",
		Running:   true,
		TaskState: 1,
		Status:    &BaseStatus{Status: "Waiting For Restock", Color: "blue"},
	}
	if added := queueHeartbeatStatuses(map[string]*BaseTask{"t1": running}); added != 1 {
		t.Fatalf("first heartbeat added %d, want 1", added)
	}
	if added := queueHeartbeatStatuses(map[string]*BaseTask{"t1": running}); added != 0 {
		t.Fatalf("unchanged heartbeat added %d, want 0", added)
	}
	running.Status.Status = "Product Found"
	if added := queueHeartbeatStatuses(map[string]*BaseTask{"t1": running}); added != 1 {
		t.Fatalf("changed heartbeat added %d, want 1", added)
	}
}
