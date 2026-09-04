package target

import (
	"time"

	"zynbot.app/engine/bot-base/task"
)

// telemetry records one task telemetry event tagged with the Shape cookie the task is
// currently holding, so blocks and successes can be compared per cookie source and age.
func (t *TargetTask) telemetry(event, step string) {
	if t == nil || t.BaseTask == nil {
		return
	}
	var cookieAge int64
	if t.ShapeCreatedAt > 0 {
		cookieAge = time.Now().UnixMilli() - t.ShapeCreatedAt
		if cookieAge < 0 {
			cookieAge = 0
		}
	}
	task.Telemetry(task.TaskTelemetryEvent{
		Event:       event,
		Site:        "Target",
		Step:        step,
		ShapeMethod: t.ShapeMethod,
		CookieType:  t.ShapeCookieType,
		CookieAgeMs: cookieAge,
		TaskID:      t.ID,
		RunID:       t.RunID,
	})
}
