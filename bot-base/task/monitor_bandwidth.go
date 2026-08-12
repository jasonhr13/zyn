package task

import (
	"strings"
	"sync"
	"time"

	"github.com/bogdanfinn/tls-client/bandwidth"
)

const (
	monitorBandwidthSchemaVersion       = 1
	monitorBandwidthMeasurement         = "tls-client-wire"
	monitorBandwidthEmitInterval        = 5 * time.Second
	maxSafeTelemetryInteger       int64 = 1<<53 - 1
)

// MonitorBandwidthMessage is intentionally limited to aggregate counters and
// non-sensitive runtime identifiers. Product IDs, URLs, proxy names and proxy
// credentials must never cross this telemetry boundary.
type MonitorBandwidthMessage struct {
	SchemaVersion       int    `json:"schemaVersion"`
	Measurement         string `json:"measurement"`
	MonitorID           string `json:"monitorId"`
	RunID               string `json:"runId"`
	Site                string `json:"site"`
	StartedAt           int64  `json:"startedAt"`
	ObservedAt          int64  `json:"observedAt"`
	Sequence            int64  `json:"sequence"`
	Running             bool   `json:"running"`
	DownloadBytes       int64  `json:"downloadBytes"`
	UploadBytes         int64  `json:"uploadBytes"`
	TotalBytes          int64  `json:"totalBytes"`
	ProxyDownloadBytes  int64  `json:"proxyDownloadBytes"`
	ProxyUploadBytes    int64  `json:"proxyUploadBytes"`
	DirectDownloadBytes int64  `json:"directDownloadBytes"`
	DirectUploadBytes   int64  `json:"directUploadBytes"`
	Polls               int64  `json:"polls"`
	FailedPolls         int64  `json:"failedPolls"`
	WatchedItems        int    `json:"watchedItems"`
}

type monitorBandwidthState struct {
	mu sync.Mutex

	monitorID     string
	runID         string
	site          string
	startedAt     int64
	lastEmittedAt int64
	sequence      int64
	started       bool
	finished      bool
	watchedItems  int
	polls         int64
	failedPolls   int64

	proxyDownloadBytes  int64
	proxyUploadBytes    int64
	directDownloadBytes int64
	directUploadBytes   int64

	tracker      bandwidth.BandwidthTracker
	lastDownload int64
	lastUpload   int64
	proxyRoute   bool
}

// PrepareMonitorBandwidth must run before the monitor creates its HTTP client.
// That lets EnsureTLSClient enable connection-level tracking for monitors only.
func (t *BaseTask) PrepareMonitorBandwidth(watchedItems int) {
	if t == nil || !strings.EqualFold(strings.TrimSpace(t.Mode), "Monitor") {
		return
	}
	t.RunID = newRunID()
	t.monitorBandwidth = &monitorBandwidthState{
		monitorID:    cleanMonitorTelemetryID(t.ID, "monitor"),
		runID:        t.RunID,
		site:         canonicalMonitorSite(t.Site),
		watchedItems: boundedWatchedItems(watchedItems),
	}
}

// StartMonitorBandwidth emits the zero-valued beginning of a monitor run. The
// current tracker values become the baseline so client/proxy setup is not
// presented as retailer polling traffic.
func (t *BaseTask) StartMonitorBandwidth() {
	state := t.monitorBandwidthState()
	if state == nil {
		return
	}

	tracker, download, upload, proxyRoute := t.currentMonitorBandwidth()
	now := time.Now().UnixMilli()
	state.mu.Lock()
	if state.started || state.finished {
		state.mu.Unlock()
		return
	}
	state.tracker = tracker
	state.lastDownload = download
	state.lastUpload = upload
	state.proxyRoute = proxyRoute
	state.proxyDownloadBytes = 0
	state.proxyUploadBytes = 0
	state.directDownloadBytes = 0
	state.directUploadBytes = 0
	state.polls = 0
	state.failedPolls = 0
	state.startedAt = now
	state.lastEmittedAt = now
	state.started = true
	message := state.messageLocked(now, true)
	state.mu.Unlock()
	emitMonitorBandwidth(message)
}

// ObserveMonitorBandwidthPoll captures all connection bytes consumed by one
// completed poll before its error handler can rotate the proxy or replace the
// HTTP client. Counters stay cumulative for the lifetime of this run.
func (t *BaseTask) ObserveMonitorBandwidthPoll(failed bool) {
	t.captureMonitorBandwidth()
	state := t.monitorBandwidthState()
	if state == nil {
		return
	}
	now := time.Now().UnixMilli()
	state.mu.Lock()
	if !state.started || state.finished {
		state.mu.Unlock()
		return
	}
	state.polls = incrementTelemetryCounter(state.polls)
	if failed {
		state.failedPolls = incrementTelemetryCounter(state.failedPolls)
	}
	if now-state.lastEmittedAt < monitorBandwidthEmitInterval.Milliseconds() {
		state.mu.Unlock()
		return
	}
	message := state.messageLocked(now, true)
	state.lastEmittedAt = now
	state.mu.Unlock()
	emitMonitorBandwidth(message)
}

// FinishMonitorBandwidth emits one terminal cumulative snapshot. Monitor loops
// defer this until after their request has unwound, so cancellation bytes are
// not lost and no periodic sample can follow the terminal one.
func (t *BaseTask) FinishMonitorBandwidth() {
	t.captureMonitorBandwidth()
	state := t.monitorBandwidthState()
	if state == nil {
		return
	}
	now := time.Now().UnixMilli()
	state.mu.Lock()
	if !state.started || state.finished {
		state.mu.Unlock()
		return
	}
	state.finished = true
	message := state.messageLocked(now, false)
	state.mu.Unlock()
	emitMonitorBandwidth(message)
}

func (t *BaseTask) SetMonitorBandwidthWatchedItems(watchedItems int) {
	state := t.monitorBandwidthState()
	if state == nil {
		return
	}
	state.mu.Lock()
	state.watchedItems = boundedWatchedItems(watchedItems)
	state.mu.Unlock()
}

func (t *BaseTask) monitorBandwidthState() *monitorBandwidthState {
	if t == nil {
		return nil
	}
	return t.monitorBandwidth
}

func (t *BaseTask) monitorBandwidthEnabled() bool {
	return t.monitorBandwidthState() != nil
}

// captureMonitorBandwidth settles the current tracker into the run totals. It
// is called before client replacement and on both sides of proxy changes, which
// keeps direct and proxied byte attribution correct even when a run switches.
func (t *BaseTask) captureMonitorBandwidth() {
	state := t.monitorBandwidthState()
	if state == nil {
		return
	}
	tracker, download, upload, proxyRoute := t.currentMonitorBandwidth()
	state.mu.Lock()
	defer state.mu.Unlock()

	if tracker == nil {
		return
	}
	if state.tracker != tracker {
		state.tracker = tracker
		state.lastDownload = 0
		state.lastUpload = 0
		state.proxyRoute = proxyRoute
	}

	downloadDelta := bandwidthCounterDelta(download, state.lastDownload)
	uploadDelta := bandwidthCounterDelta(upload, state.lastUpload)
	state.addTransferLocked(state.proxyRoute, downloadDelta, uploadDelta)
	state.lastDownload = download
	state.lastUpload = upload
	// A caller changing proxy state first settles the old route, then calls this
	// again with no byte delta so subsequent traffic uses the actual new route.
	state.proxyRoute = proxyRoute
}

func (t *BaseTask) currentMonitorBandwidth() (bandwidth.BandwidthTracker, int64, int64, bool) {
	if t == nil || t.Requests == nil || t.Requests.Client == nil {
		return nil, 0, 0, false
	}
	tracker := t.Requests.Client.GetBandwidthTracker()
	if tracker == nil {
		return nil, 0, 0, strings.TrimSpace(t.Requests.Client.GetProxy()) != ""
	}
	return tracker,
		clampTelemetryCounter(tracker.GetReadBytes()),
		clampTelemetryCounter(tracker.GetWriteBytes()),
		strings.TrimSpace(t.Requests.Client.GetProxy()) != ""
}

func (state *monitorBandwidthState) messageLocked(observedAt int64, running bool) MonitorBandwidthMessage {
	if observedAt < state.startedAt {
		observedAt = state.startedAt
	}
	state.sequence = incrementTelemetryCounter(state.sequence)
	download := state.proxyDownloadBytes + state.directDownloadBytes
	upload := state.proxyUploadBytes + state.directUploadBytes
	return MonitorBandwidthMessage{
		SchemaVersion:       monitorBandwidthSchemaVersion,
		Measurement:         monitorBandwidthMeasurement,
		MonitorID:           state.monitorID,
		RunID:               state.runID,
		Site:                state.site,
		StartedAt:           state.startedAt,
		ObservedAt:          observedAt,
		Sequence:            state.sequence,
		Running:             running,
		DownloadBytes:       download,
		UploadBytes:         upload,
		TotalBytes:          download + upload,
		ProxyDownloadBytes:  state.proxyDownloadBytes,
		ProxyUploadBytes:    state.proxyUploadBytes,
		DirectDownloadBytes: state.directDownloadBytes,
		DirectUploadBytes:   state.directUploadBytes,
		Polls:               state.polls,
		FailedPolls:         state.failedPolls,
		WatchedItems:        state.watchedItems,
	}
}

func (state *monitorBandwidthState) addTransferLocked(proxyRoute bool, download, upload int64) {
	download = clampTelemetryCounter(download)
	upload = clampTelemetryCounter(upload)
	used := state.proxyDownloadBytes + state.proxyUploadBytes +
		state.directDownloadBytes + state.directUploadBytes
	remaining := maxSafeTelemetryInteger - used
	if remaining <= 0 {
		return
	}
	if download > remaining {
		download = remaining
	}
	remaining -= download
	if upload > remaining {
		upload = remaining
	}
	if proxyRoute {
		state.proxyDownloadBytes += download
		state.proxyUploadBytes += upload
	} else {
		state.directDownloadBytes += download
		state.directUploadBytes += upload
	}
}

func emitMonitorBandwidth(message MonitorBandwidthMessage) {
	if sendMessage == nil {
		return
	}
	_ = sendMessage(statusMessage{
		Type:     "monitor-bandwidth",
		Messages: []MonitorBandwidthMessage{message},
	})
}

func canonicalMonitorSite(site string) string {
	value := strings.TrimSpace(site)
	switch {
	case strings.EqualFold(value, "Target"):
		return "Target"
	case strings.EqualFold(value, "Walmart"):
		return "Walmart"
	default:
		return cleanMonitorTelemetryText(value, 80)
	}
}

func cleanMonitorTelemetryText(value string, max int) string {
	value = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, strings.TrimSpace(value))
	if len(value) > max {
		value = value[:max]
	}
	return value
}

func cleanMonitorTelemetryID(value, fallback string) string {
	var out strings.Builder
	for _, r := range strings.TrimSpace(value) {
		allowed := r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' ||
			r >= '0' && r <= '9' || r == '.' || r == '_' || r == ':' || r == '-'
		if !allowed {
			r = '-'
		}
		if out.Len() == 0 && !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')) {
			continue
		}
		if out.Len() >= 160 {
			break
		}
		out.WriteRune(r)
	}
	if out.Len() == 0 {
		return fallback
	}
	return out.String()
}

func boundedWatchedItems(value int) int {
	if value < 0 {
		return 0
	}
	if value > 100000 {
		return 100000
	}
	return value
}

func clampTelemetryCounter(value int64) int64 {
	if value < 0 {
		return 0
	}
	if value > maxSafeTelemetryInteger {
		return maxSafeTelemetryInteger
	}
	return value
}

func incrementTelemetryCounter(value int64) int64 {
	if value >= maxSafeTelemetryInteger {
		return maxSafeTelemetryInteger
	}
	return value + 1
}

func bandwidthCounterDelta(current, previous int64) int64 {
	current = clampTelemetryCounter(current)
	previous = clampTelemetryCounter(previous)
	if current < previous {
		// A tracker reset starts a new counter epoch; count its current value.
		return current
	}
	return current - previous
}
