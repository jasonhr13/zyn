package target

import (
	"testing"

	"zynbot.app/engine/bot-base/proxy"
	"zynbot.app/engine/bot-base/task"
	"zynbot.app/engine/sites"
)

func testMonitorTask(t *testing.T, group string, sources []string) *TargetMonitorTask {
	t.Helper()
	proxy.ResetForTest()
	proxy.SetProxies(map[string][]proxy.Proxy{
		"ISP": {{Address: "1.1.1.1", Port: "80", Username: "u", Password: "p"}},
		"DC":  {{Address: "2.2.2.2", Port: "80", Username: "u", Password: "p"}},
	})
	base := &task.BaseTask{
		ID:           "target-monitor-main-1",
		Site:         "Target",
		Mode:         "Monitor",
		ProxyGroup:   group,
		ProxySources: append([]string(nil), sources...),
		Requests:     &task.BaseRequestsInfo{},
	}
	base.PrepareMonitorBandwidth(1)
	if err := base.EnsureTLSClient(true); err != nil {
		t.Fatalf("EnsureTLSClient: %v", err)
	}
	if group != "" && group != "Local" {
		if err := base.SwapProxy("Target"); err != nil {
			t.Fatalf("SwapProxy(%s): %v", group, err)
		}
	}
	return &TargetMonitorTask{
		BaseTask:      base,
		MonitorInputs: []MonitorInput{{Tcin: "11111111", Qty: 2, MaxPrice: 24.99}},
	}
}

func TestMonitorSetTaskProxyChangesGroupWithoutClearingWatchList(t *testing.T) {
	monitor := testMonitorTask(t, "ISP", []string{"ISP"})
	group := "DC"
	monitor.applyRuntimeEdit(task.RuntimeEditPayload{
		ProxyGroup:   &group,
		ProxySources: []string{"DC"},
	})
	if monitor.ProxyGroup != "DC" {
		t.Fatalf("ProxyGroup = %q, want DC", monitor.ProxyGroup)
	}
	if len(monitor.ProxySources) != 1 || monitor.ProxySources[0] != "DC" {
		t.Fatalf("ProxySources = %#v, want [DC]", monitor.ProxySources)
	}
	if len(monitor.MonitorInputs) != 1 || monitor.MonitorInputs[0].Tcin != "11111111" {
		t.Fatalf("watch list changed on proxy-only edit: %#v", monitor.MonitorInputs)
	}
	if got := monitor.Requests.Client.GetProxy(); got == "" || got == "http://u:p@1.1.1.1:80" {
		t.Fatalf("client proxy = %q, want DC line", got)
	}
}

func TestMonitorEditTasksCopiesProxySources(t *testing.T) {
	monitor := testMonitorTask(t, "ISP", []string{"ISP"})
	monitor.applyRuntimeEdit(task.RuntimeEditPayload{
		Input: sites.TaskInput{
			Proxy:        "DC",
			ProxySources: []string{"DC"},
			MonitorDelay: 2500,
			MonitorItems: []sites.Item{{MonitorInput: "22222222", Quantity: 1}},
		},
		MonitorItems: []sites.Item{{MonitorInput: "22222222", Quantity: 1}},
	})
	if monitor.ProxyGroup != "DC" {
		t.Fatalf("ProxyGroup = %q, want DC", monitor.ProxyGroup)
	}
	if len(monitor.ProxySources) != 1 || monitor.ProxySources[0] != "DC" {
		t.Fatalf("ProxySources = %#v, want [DC]", monitor.ProxySources)
	}
	if monitor.MonitorDelay != 2500 {
		t.Fatalf("MonitorDelay = %d, want 2500", monitor.MonitorDelay)
	}
	if len(monitor.MonitorInputs) != 1 || monitor.MonitorInputs[0].Tcin != "22222222" {
		t.Fatalf("watch list not updated: %#v", monitor.MonitorInputs)
	}
}

func TestMonitorRuntimeProxyLocalClearsClient(t *testing.T) {
	monitor := testMonitorTask(t, "ISP", []string{"ISP"})
	if monitor.Requests.Client.GetProxy() == "" {
		t.Fatal("expected an assigned proxy before Local")
	}
	group := "Local"
	monitor.applyRuntimeEdit(task.RuntimeEditPayload{ProxyGroup: &group})
	if monitor.ProxyGroup != "Local" {
		t.Fatalf("ProxyGroup = %q, want Local", monitor.ProxyGroup)
	}
	if len(monitor.ProxySources) != 0 {
		t.Fatalf("ProxySources = %#v, want empty", monitor.ProxySources)
	}
	if got := monitor.Requests.Client.GetProxy(); got != "" {
		t.Fatalf("Local retained proxy %q", got)
	}
}

func TestMonitorRuntimeProxyNoopWhenUnchanged(t *testing.T) {
	monitor := testMonitorTask(t, "ISP", []string{"ISP"})
	before := monitor.Requests.Client.GetProxy()
	group := "ISP"
	monitor.applyRuntimeEdit(task.RuntimeEditPayload{
		ProxyGroup:   &group,
		ProxySources: []string{"ISP"},
	})
	if got := monitor.Requests.Client.GetProxy(); got != before {
		t.Fatalf("unchanged proxy swapped client %q -> %q", before, got)
	}
}
