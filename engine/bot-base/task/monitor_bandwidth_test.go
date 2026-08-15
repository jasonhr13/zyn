package task

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"reflect"
	"regexp"
	"testing"
	"time"

	"github.com/bogdanfinn/tls-client/bandwidth"
)

func TestMonitorBandwidthLifecycleIsCumulativeAndReplacementSafe(t *testing.T) {
	var attempts []MonitorBandwidthMessage
	var delivered []MonitorBandwidthMessage
	dropNextRunning := false
	SetMessageSender(func(value any) error {
		envelope, ok := value.(statusMessage)
		if !ok || envelope.Type != "monitor-bandwidth" {
			return nil
		}
		messages, ok := envelope.Messages.([]MonitorBandwidthMessage)
		if !ok || len(messages) != 1 {
			t.Fatalf("monitor bandwidth messages = %#v", envelope.Messages)
		}
		message := messages[0]
		attempts = append(attempts, message)
		if dropNextRunning && message.Running {
			dropNextRunning = false
			return errors.New("simulated IPC delivery failure")
		}
		delivered = append(delivered, message)
		return nil
	})
	t.Cleanup(func() { SetMessageSender(nil) })

	base := &BaseTask{
		ID:       "target monitor / private input",
		Site:     "target",
		Mode:     "Monitor",
		Requests: &BaseRequestsInfo{},
	}
	base.PrepareMonitorBandwidth(3)
	if err := base.EnsureTLSClient(true); err != nil {
		t.Fatalf("EnsureTLSClient(initial): %v", err)
	}
	if _, ok := base.Requests.Client.GetBandwidthTracker().(*bandwidth.Tracker); !ok {
		t.Fatalf("initial tracker = %T, want *bandwidth.Tracker", base.Requests.Client.GetBandwidthTracker())
	}
	base.StartMonitorBandwidth()

	if len(delivered) != 1 {
		t.Fatalf("start deliveries = %d, want 1", len(delivered))
	}
	start := delivered[0]
	assertMonitorBandwidthShape(t, start)
	if start.Sequence != 1 || !start.Running || start.TotalBytes != 0 || start.Polls != 0 {
		t.Fatalf("start = %#v", start)
	}
	if start.MonitorID != "target-monitor---private-input" {
		t.Fatalf("sanitized monitor ID = %q", start.MonitorID)
	}

	addTrackedBytes(t, base.Requests.Client.GetBandwidthTracker(), 100, 40)
	dropNextRunning = true
	allowPeriodicMonitorBandwidthEmission(base)
	base.ObserveMonitorBandwidthPoll(false)
	if len(attempts) != 2 || len(delivered) != 1 {
		t.Fatalf("after dropped snapshot: attempts=%d delivered=%d", len(attempts), len(delivered))
	}
	dropped := attempts[1]
	if dropped.Sequence != 2 || dropped.DownloadBytes != 100 || dropped.UploadBytes != 40 || dropped.Polls != 1 {
		t.Fatalf("dropped snapshot = %#v", dropped)
	}

	addTrackedBytes(t, base.Requests.Client.GetBandwidthTracker(), 25, 10)
	base.ObserveMonitorBandwidthPoll(true)
	if len(attempts) != 2 {
		t.Fatalf("uncoalesced running delivery count = %d, want 2", len(attempts))
	}
	allowPeriodicMonitorBandwidthEmission(base)
	base.ObserveMonitorBandwidthPoll(false)
	if len(delivered) != 2 {
		t.Fatalf("recovery deliveries = %d, want 2", len(delivered))
	}
	recovered := delivered[1]
	if recovered.Sequence != 3 || recovered.DownloadBytes != 125 || recovered.UploadBytes != 50 || recovered.Polls != 3 || recovered.FailedPolls != 1 {
		t.Fatalf("recovered cumulative snapshot = %#v", recovered)
	}
	if recovered.DirectDownloadBytes != 125 || recovered.DirectUploadBytes != 50 || recovered.ProxyDownloadBytes != 0 || recovered.ProxyUploadBytes != 0 {
		t.Fatalf("recovered route split = %#v", recovered)
	}

	if err := base.setHTTPClientProxy("http://127.0.0.1:8080"); err != nil {
		t.Fatalf("setHTTPClientProxy: %v", err)
	}
	addTrackedBytes(t, base.Requests.Client.GetBandwidthTracker(), 30, 12)
	oldTracker := base.Requests.Client.GetBandwidthTracker()
	if err := base.EnsureTLSClient(true); err != nil {
		t.Fatalf("EnsureTLSClient(replacement): %v", err)
	}
	newTracker := base.Requests.Client.GetBandwidthTracker()
	if oldTracker == newTracker {
		t.Fatal("forced replacement retained the old tracker")
	}
	if _, ok := newTracker.(*bandwidth.Tracker); !ok {
		t.Fatalf("replacement tracker = %T, want *bandwidth.Tracker", newTracker)
	}
	addTrackedBytes(t, newTracker, 7, 3)

	// Final delivery is immediate even though the most recent running snapshot
	// was less than one emit interval ago, and duplicate finishes are ignored.
	base.FinishMonitorBandwidth()
	base.FinishMonitorBandwidth()
	if len(delivered) != 3 {
		t.Fatalf("final deliveries = %d, want 3", len(delivered))
	}
	final := delivered[2]
	assertMonitorBandwidthShape(t, final)
	if final.Sequence != 4 || final.Running {
		t.Fatalf("final sequence/running = %d/%v, want 4/false", final.Sequence, final.Running)
	}
	if final.DirectDownloadBytes != 132 || final.DirectUploadBytes != 53 || final.ProxyDownloadBytes != 30 || final.ProxyUploadBytes != 12 {
		t.Fatalf("final route split = %#v", final)
	}
	if final.DownloadBytes != 162 || final.UploadBytes != 65 || final.TotalBytes != 227 {
		t.Fatalf("final totals = %#v", final)
	}
	if final.Polls != 3 || final.FailedPolls != 1 || final.WatchedItems != 3 {
		t.Fatalf("final poll metadata = %#v", final)
	}
	assertMonitorBandwidthJSONBoundary(t, final)
}

func TestMonitorBandwidthOnlyConfiguresMonitorMode(t *testing.T) {
	nonMonitor := &BaseTask{ID: "checkout", Site: "Target", Mode: "Fast", Requests: &BaseRequestsInfo{}}
	nonMonitor.PrepareMonitorBandwidth(1)
	if nonMonitor.monitorBandwidth != nil {
		t.Fatal("non-monitor task prepared bandwidth state")
	}
	if err := nonMonitor.EnsureTLSClient(true); err != nil {
		t.Fatalf("non-monitor EnsureTLSClient: %v", err)
	}
	if _, ok := nonMonitor.Requests.Client.GetBandwidthTracker().(*bandwidth.NopeTracker); !ok {
		t.Fatalf("non-monitor tracker = %T, want *bandwidth.NopeTracker", nonMonitor.Requests.Client.GetBandwidthTracker())
	}

	monitor := &BaseTask{ID: "monitor", Site: "Target", Mode: "Monitor", Requests: &BaseRequestsInfo{}}
	monitor.PrepareMonitorBandwidth(1)
	if err := monitor.EnsureTLSClient(true); err != nil {
		t.Fatalf("monitor EnsureTLSClient: %v", err)
	}
	if _, ok := monitor.Requests.Client.GetBandwidthTracker().(*bandwidth.Tracker); !ok {
		t.Fatalf("monitor tracker = %T, want *bandwidth.Tracker", monitor.Requests.Client.GetBandwidthTracker())
	}
}

func TestMonitorSwapProxyLocalClearsExistingProxy(t *testing.T) {
	base := &BaseTask{
		ID:         "monitor-route",
		Site:       "Target",
		Mode:       "Monitor",
		ProxyGroup: "Residential",
		Requests:   &BaseRequestsInfo{},
	}
	base.PrepareMonitorBandwidth(1)
	if err := base.EnsureTLSClient(true); err != nil {
		t.Fatalf("EnsureTLSClient: %v", err)
	}
	if err := base.setHTTPClientProxy("http://127.0.0.1:8080"); err != nil {
		t.Fatalf("setHTTPClientProxy: %v", err)
	}
	if base.Requests.Client.GetProxy() == "" {
		t.Fatal("test proxy was not installed")
	}

	base.ProxyGroup = "Local"
	if err := base.SwapProxy("Target"); err != nil {
		t.Fatalf("SwapProxy(Local): %v", err)
	}
	if proxyValue := base.Requests.Client.GetProxy(); proxyValue != "" {
		t.Fatalf("local monitor retained proxy %q", proxyValue)
	}
	if err := base.SwapProxy("Target"); err != nil {
		t.Fatalf("SwapProxy(already Local): %v", err)
	}
	if proxyValue := base.Requests.Client.GetProxy(); proxyValue != "" {
		t.Fatalf("already-local monitor gained proxy %q", proxyValue)
	}
}

func TestMonitorBandwidthCountersRemainSafeAndInternallyConsistent(t *testing.T) {
	state := &monitorBandwidthState{
		monitorID: "monitor",
		runID:     "run",
		site:      "Target",
		startedAt: 1,
	}
	state.addTransferLocked(false, maxSafeTelemetryInteger, maxSafeTelemetryInteger)
	state.addTransferLocked(true, maxSafeTelemetryInteger, maxSafeTelemetryInteger)
	state.polls = maxSafeTelemetryInteger
	state.failedPolls = maxSafeTelemetryInteger
	message := state.messageLocked(2, true)

	assertMonitorBandwidthShape(t, message)
	if message.TotalBytes != maxSafeTelemetryInteger {
		t.Fatalf("totalBytes = %d, want %d", message.TotalBytes, maxSafeTelemetryInteger)
	}
	if message.DownloadBytes != message.ProxyDownloadBytes+message.DirectDownloadBytes ||
		message.UploadBytes != message.ProxyUploadBytes+message.DirectUploadBytes ||
		message.TotalBytes != message.DownloadBytes+message.UploadBytes {
		t.Fatalf("inconsistent capped totals: %#v", message)
	}
	if incrementTelemetryCounter(message.Polls) != maxSafeTelemetryInteger {
		t.Fatalf("safe counter increment overflowed: %d", incrementTelemetryCounter(message.Polls))
	}
}

func allowPeriodicMonitorBandwidthEmission(base *BaseTask) {
	base.monitorBandwidth.mu.Lock()
	base.monitorBandwidth.lastEmittedAt = time.Now().Add(-monitorBandwidthEmitInterval).UnixMilli()
	base.monitorBandwidth.mu.Unlock()
}

func addTrackedBytes(t *testing.T, tracker bandwidth.BandwidthTracker, download, upload int) {
	t.Helper()
	local, remote := net.Pipe()
	tracked := tracker.TrackConnection(context.Background(), local)

	if upload > 0 {
		readDone := make(chan error, 1)
		go func() {
			_, err := io.CopyN(io.Discard, remote, int64(upload))
			readDone <- err
		}()
		written, err := tracked.Write(bytes.Repeat([]byte{'u'}, upload))
		if err != nil || written != upload {
			t.Fatalf("tracked upload = %d, %v; want %d, nil", written, err, upload)
		}
		if err := <-readDone; err != nil {
			t.Fatalf("remote upload read: %v", err)
		}
	}

	if download > 0 {
		writeDone := make(chan error, 1)
		go func() {
			written, err := remote.Write(bytes.Repeat([]byte{'d'}, download))
			if err == nil && written != download {
				err = io.ErrShortWrite
			}
			writeDone <- err
		}()
		buffer := make([]byte, download)
		if _, err := io.ReadFull(tracked, buffer); err != nil {
			t.Fatalf("tracked download: %v", err)
		}
		if err := <-writeDone; err != nil {
			t.Fatalf("remote download write: %v", err)
		}
	}

	_ = tracked.Close()
	_ = remote.Close()
}

func assertMonitorBandwidthShape(t *testing.T, message MonitorBandwidthMessage) {
	t.Helper()
	idPattern := regexp.MustCompile(`^[a-z0-9][a-z0-9._:-]{0,159}$`)
	if message.SchemaVersion != 1 || message.Measurement != "tls-client-wire" || message.Site != "Target" {
		t.Fatalf("schema identity = %#v", message)
	}
	if !idPattern.MatchString(message.MonitorID) || !idPattern.MatchString(message.RunID) {
		t.Fatalf("invalid IDs monitor=%q run=%q", message.MonitorID, message.RunID)
	}
	if message.StartedAt <= 0 || message.ObservedAt < message.StartedAt || message.ObservedAt > time.Now().Add(5*time.Minute).UnixMilli() {
		t.Fatalf("invalid timestamps started=%d observed=%d", message.StartedAt, message.ObservedAt)
	}
	if message.Sequence <= 0 || message.Sequence > maxSafeTelemetryInteger || message.Polls < 0 || message.Polls > maxSafeTelemetryInteger || message.FailedPolls < 0 || message.FailedPolls > message.Polls {
		t.Fatalf("invalid sequence/polls = %#v", message)
	}
	values := []int64{
		message.DownloadBytes, message.UploadBytes, message.TotalBytes,
		message.ProxyDownloadBytes, message.ProxyUploadBytes,
		message.DirectDownloadBytes, message.DirectUploadBytes,
	}
	for _, value := range values {
		if value < 0 || value > maxSafeTelemetryInteger {
			t.Fatalf("unsafe byte counter %d in %#v", value, message)
		}
	}
	if message.DownloadBytes != message.ProxyDownloadBytes+message.DirectDownloadBytes ||
		message.UploadBytes != message.ProxyUploadBytes+message.DirectUploadBytes ||
		message.TotalBytes != message.DownloadBytes+message.UploadBytes {
		t.Fatalf("inconsistent totals: %#v", message)
	}
}

func assertMonitorBandwidthJSONBoundary(t *testing.T, message MonitorBandwidthMessage) {
	t.Helper()
	encoded, err := json.Marshal(message)
	if err != nil {
		t.Fatalf("marshal monitor bandwidth: %v", err)
	}
	var actual map[string]any
	if err := json.Unmarshal(encoded, &actual); err != nil {
		t.Fatalf("unmarshal monitor bandwidth: %v", err)
	}
	expected := map[string]struct{}{
		"schemaVersion": {}, "measurement": {}, "monitorId": {}, "runId": {}, "site": {},
		"startedAt": {}, "observedAt": {}, "sequence": {}, "running": {},
		"downloadBytes": {}, "uploadBytes": {}, "totalBytes": {},
		"proxyDownloadBytes": {}, "proxyUploadBytes": {},
		"directDownloadBytes": {}, "directUploadBytes": {},
		"polls": {}, "failedPolls": {}, "watchedItems": {},
	}
	actualKeys := make(map[string]struct{}, len(actual))
	for key := range actual {
		actualKeys[key] = struct{}{}
	}
	if !reflect.DeepEqual(actualKeys, expected) {
		t.Fatalf("JSON fields = %#v, want %#v; encoded=%s", actualKeys, expected, encoded)
	}
}
