package task

import "github.com/PolarAIO/Polar-AIO/backend/bot-base/safego"

func StartTaskServices() {
	safego.Go(StartStatusHeartbeat)
	SendStatuses()
}
