package target

import (
	"strings"
	"testing"

	"zynbot.app/engine/bot-base/proxy"
	"zynbot.app/engine/bot-base/task"
)

func TestCheckoutProxyPrefersShapeCookie(t *testing.T) {
	proxy.ResetForTest()
	proxy.SetProxies(map[string][]proxy.Proxy{
		"ISP": {{Address: "1.1.1.1", Port: "80", Username: "u", Password: "p"}},
	})
	if _, err := proxy.GetProxy("ISP", "task-a"); err != nil {
		t.Fatal(err)
	}

	got := (&TargetTask{
		BaseTask:   &task.BaseTask{ID: "task-a", ProxyGroup: "ISP"},
		ShapeProxy: "10.0.0.9:8000:harvest:secret",
	}).checkoutProxy()
	if got != "10.0.0.9:8000:harvest:secret" {
		t.Fatalf("checkoutProxy() = %q, want ATC cookie proxy", got)
	}
}

func TestCheckoutProxyFallsBackToAssignedTaskLine(t *testing.T) {
	proxy.ResetForTest()
	proxy.SetProxies(map[string][]proxy.Proxy{
		"ISP": {{Address: "1.1.1.1", Port: "80", Username: "u", Password: "p"}},
	})
	if _, err := proxy.GetProxy("ISP", "task-a"); err != nil {
		t.Fatal(err)
	}

	got := (&TargetTask{
		BaseTask: &task.BaseTask{ID: "task-a", ProxyGroup: "ISP"},
	}).checkoutProxy()
	if !strings.Contains(got, "1.1.1.1") {
		t.Fatalf("checkoutProxy() = %q, want assigned task proxy", got)
	}
}

func TestCheckoutProxyEmptyWithoutCookieOrAssignment(t *testing.T) {
	if got := (&TargetTask{}).checkoutProxy(); got != "" {
		t.Fatalf("checkoutProxy() = %q, want empty", got)
	}
}
