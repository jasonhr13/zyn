package target

import (
	"strings"
	"sync"
	"time"

	"zynbot.app/engine/bot-base/proxy"
	"zynbot.app/engine/bot-base/siteconfig"
	"zynbot.app/engine/bot-base/task/constants"
)

const localThrottleFallbackLeaseDuration = 2 * time.Minute

type throttleFallbackLease struct {
	mu        sync.Mutex
	owner     string
	claimedAt time.Time
}

var localThrottleFallback throttleFallbackLease

func (l *throttleFallbackLease) claim(taskID string, now time.Time) bool {
	taskID = strings.TrimSpace(taskID)
	if taskID == "" {
		return false
	}

	l.mu.Lock()
	defer l.mu.Unlock()

	if l.owner != "" && l.owner != taskID && now.Sub(l.claimedAt) < localThrottleFallbackLeaseDuration {
		return false
	}

	l.owner = taskID
	l.claimedAt = now
	return true
}

func claimLocalThrottleFallback(taskID string) bool {
	return localThrottleFallback.claim(taskID, time.Now())
}

func (t *TargetTask) tryThrottleFallback() bool {
	if t == nil || t.BaseTask == nil || t.throttleFallbackTried || t.TaskState != constants.StatusSteps.Carted {
		return false
	}

	fallbackGroup := siteconfig.ThrottleFallbackGroup()
	if fallbackGroup == "" || strings.EqualFold(fallbackGroup, t.ProxyGroup) {
		return false
	}

	isLocal := strings.EqualFold(fallbackGroup, "Local")
	if isLocal && !claimLocalThrottleFallback(t.ID) {
		t.UpdateStatus("Throttled - Home IP In Use", constants.Colors.YELLOW)
		return false
	}

	previousGroup := t.ProxyGroup
	t.throttleFallbackTried = true

	if isLocal {
		if err := t.SetProxy(""); err != nil {
			t.UpdateStatus("Throttle Fallback Failed", constants.Colors.RED)
			return false
		}
		t.ProxyGroup = "Local"
		proxy.ReleaseProxy(previousGroup, t.ID)
		t.UpdateStatus("Throttled - Finishing On Home IP", constants.Colors.YELLOW)
		t.AddLog("Throttle fallback switched checkout traffic to the home IP")
		return true
	}

	t.ProxyGroup = fallbackGroup
	if err := t.SwapProxy("Target"); err != nil {
		t.ProxyGroup = previousGroup
		t.UpdateStatus("Throttle Fallback Failed", constants.Colors.RED)
		return false
	}

	proxy.ReleaseProxy(previousGroup, t.ID)
	t.UpdateStatus("Throttled - Switched To "+fallbackGroup, constants.Colors.YELLOW)
	t.AddLog("Throttle fallback switched checkout traffic to proxy group " + fallbackGroup)
	return true
}
