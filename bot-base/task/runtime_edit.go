package task

import "zynbot.app/engine/sites"

type RuntimeEditPayload struct {
	Input        sites.TaskInput
	MonitorItems []sites.Item
	ProxyGroup   *string
	ProxySources []string
}

type RuntimeEditSink interface {
	Task
	EnqueueRuntimeEditPayload(p RuntimeEditPayload) bool
}

func EnqueueRuntimeEdit(taskID string, p RuntimeEditPayload) bool {
	raw, ok := UserTasks.Get(taskID)
	if !ok {
		return false
	}
	sink, ok := raw.(RuntimeEditSink)
	if !ok {
		return false
	}
	return sink.EnqueueRuntimeEditPayload(p)
}

func (t *BaseTask) InitRuntimeEditChannel() {
	if t == nil || t.pendingRuntimeEdits != nil {
		return
	}
	t.pendingRuntimeEdits = make(chan RuntimeEditPayload, 1)
}

func (t *BaseTask) EnqueueRuntimeEditPayload(p RuntimeEditPayload) bool {
	if t == nil || !t.Running || t.pendingRuntimeEdits == nil {
		return false
	}
	select {
	case t.pendingRuntimeEdits <- p:
		return true
	default:
		select {
		case <-t.pendingRuntimeEdits:
		default:
		}
		select {
		case t.pendingRuntimeEdits <- p:
			return true
		default:
			return false
		}
	}
}

func (t *BaseTask) DrainPendingRuntimeEdits(apply func(RuntimeEditPayload)) {
	if t == nil || t.pendingRuntimeEdits == nil || apply == nil {
		return
	}
	for {
		select {
		case p := <-t.pendingRuntimeEdits:
			apply(p)
		default:
			return
		}
	}
}

func (t *BaseTask) HasPendingRuntimeEdit() bool {
	if t == nil || t.pendingRuntimeEdits == nil {
		return false
	}
	return len(t.pendingRuntimeEdits) > 0
}
