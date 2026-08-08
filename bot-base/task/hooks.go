package task

import "github.com/PolarAIO/Polar-AIO/backend/bot-base/safego"

var onTaskChange func(*BaseTask)

var onTaskRemove func(string)

func SetTaskChangeHandler(fn func(*BaseTask)) {
	onTaskChange = fn
}

func SetTaskRemoveHandler(fn func(string)) {
	onTaskRemove = fn
}

func emitTaskChange(t *BaseTask) {
	if fn := onTaskChange; fn != nil {
		safego.Go(func() { fn(t) })
	}
}

func emitTaskRemove(taskID string) {
	if fn := onTaskRemove; fn != nil {
		safego.Go(func() { fn(taskID) })
	}
}
