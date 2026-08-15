package task

import (
	"context"
	"sync"
	"testing"

	"zynbot.app/engine/bot-base/task/constants"
)

func TestStopTaskIsIdempotentUnderConcurrentBulkStop(t *testing.T) {
	safeTaskStatuses.mu.Lock()
	safeTaskStatuses.value = nil
	safeTaskStatuses.mu.Unlock()

	ctx, cancel := context.WithCancel(context.Background())
	base := &BaseTask{
		ID:          "bulk-stop-test",
		Running:     true,
		TaskState:   constants.StatusSteps.Running,
		TaskContext: &BaseContext{CTX: ctx, Cancel: cancel},
		Status:      &BaseStatus{Status: "Running"},
	}
	UserTasks.Set(base.ID, base, base)
	t.Cleanup(func() { UserTasks.Delete(base.ID) })

	var wg sync.WaitGroup
	for i := 0; i < 500; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			base.StopTask("Idle", constants.Colors.DEFAULT, constants.StatusSteps.Idle)
		}()
	}
	wg.Wait()

	if _, ok := UserTasks.Get(base.ID); ok {
		t.Fatal("task remained registered after stop")
	}
	if base.Running {
		t.Fatal("task remained running after stop")
	}
	if ctx.Err() != context.Canceled {
		t.Fatalf("context error = %v, want context.Canceled", ctx.Err())
	}

	safeTaskStatuses.mu.Lock()
	defer safeTaskStatuses.mu.Unlock()
	count := 0
	for _, status := range safeTaskStatuses.value {
		if status.TaskID == base.ID {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("terminal status count = %d, want 1", count)
	}
}
