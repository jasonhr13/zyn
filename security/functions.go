package security

import (
	"time"

	"zynbot.app/engine/bot-base/safego"
)

func SafeEnv() bool {
	threats := Scan()
	if len(threats) == 0 {
		return true
	}
	return false
}
func StartMonitor(interval time.Duration) {
	safego.Go(func() { Monitor(interval) })
}
