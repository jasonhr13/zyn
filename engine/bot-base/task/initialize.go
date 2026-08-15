package task

import "zynbot.app/engine/bot-base/safego"

func StartTaskServices() {
	safego.Go(StartStatusHeartbeat)
	SendStatuses()
}
