package task

import "sync"

var siteLimits = map[string]int{
	"Walmart":           700,
	"Pokemon Center":    700, // legacy alias
	"Pokemon Center US": 700,
	"Pokemon Center CA": 700,
	"Pokemon Center DE": 700,
	"Pokemon Center UK": 700,
}

var (
	siteRunningMu sync.Mutex
	siteRunning   = map[string]int{}
)

func reserveSiteSlot(site string) bool {
	siteRunningMu.Lock()
	defer siteRunningMu.Unlock()
	if limit, ok := siteLimits[site]; ok && siteRunning[site] >= limit {
		return false
	}
	siteRunning[site]++
	return true
}

func releaseSiteSlot(site string) {
	siteRunningMu.Lock()
	defer siteRunningMu.Unlock()
	if siteRunning[site] > 0 {
		siteRunning[site]--
	}
}
