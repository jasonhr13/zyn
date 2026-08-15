package proxy

import (
	"testing"
	"time"
)

func line(host string) Proxy {
	return Proxy{Address: host, Port: "8000"}
}

func TestGetProxySingleListCompat(t *testing.T) {
	ResetForTest()
	SetProxies(map[string][]Proxy{
		"Residential": {line("1.1.1.1"), line("2.2.2.2")},
	})
	got, err := GetProxy("Residential", "task-a")
	if err != nil {
		t.Fatal(err)
	}
	if got.Address != "1.1.1.1" && got.Address != "2.2.2.2" {
		t.Fatalf("unexpected address %q", got.Address)
	}
	if AssignedProxyURL("Residential", "task-a") == "" {
		t.Fatal("assigned URL missing")
	}
	ReleaseProxy("Residential", "task-a")
	if AssignedProxyURL("Residential", "task-a") != "" {
		t.Fatal("assignment survived release")
	}
}

func TestGetProxyFromPrefersRewardedSource(t *testing.T) {
	ResetForTest()
	SetProxies(map[string][]Proxy{
		"Resi": {line("1.1.1.1")},
		"ISP":  {line("9.9.9.9")},
	})
	if _, err := GetProxyFrom([]string{"Resi", "ISP"}, "task-a"); err != nil {
		t.Fatal(err)
	}
	// Force the current assignment onto ISP, then reward it heavily.
	state.mu.Lock()
	state.assigned["task-a"] = assignment{source: "ISP", key: proxyKey(line("9.9.9.9"))}
	state.scores["ISP"] = sourceScore{successes: 8}
	state.scores["Resi"] = sourceScore{fails: 8}
	state.mu.Unlock()

	randF = func() float64 { return 0.99 } // exploit
	randN = func(n int) int { return 0 }
	ReleaseProxy("", "task-a")
	got, err := GetProxyFrom([]string{"Resi", "ISP"}, "task-b")
	if err != nil {
		t.Fatal(err)
	}
	if got.Address != "9.9.9.9" {
		t.Fatalf("expected rewarded ISP line, got %q", got.Address)
	}
}

func TestGetProxyFromStillExplores(t *testing.T) {
	ResetForTest()
	SetProxies(map[string][]Proxy{
		"Resi": {line("1.1.1.1")},
		"ISP":  {line("9.9.9.9")},
	})
	state.mu.Lock()
	state.scores["ISP"] = sourceScore{successes: 8}
	state.mu.Unlock()
	randF = func() float64 { return 0.01 } // explore
	randN = func(n int) int { return 0 }
	got, err := GetProxyFrom([]string{"Resi", "ISP"}, "task-a")
	if err != nil {
		t.Fatal(err)
	}
	if got.Address != "1.1.1.1" {
		t.Fatalf("explore should have taken first listed source, got %q", got.Address)
	}
}

func TestFailedLineIsNotImmediatelyReissued(t *testing.T) {
	ResetForTest()
	SetProxies(map[string][]Proxy{
		"Residential": {line("1.1.1.1"), line("2.2.2.2")},
	})
	first, err := GetProxy("Residential", "task-a")
	if err != nil {
		t.Fatal(err)
	}
	RecordProxyResult("task-a", false)
	ReleaseProxy("Residential", "task-a")
	second, err := GetProxy("Residential", "task-b")
	if err != nil {
		t.Fatal(err)
	}
	if second.Address == first.Address {
		t.Fatalf("failed line %q was reissued immediately", first.Address)
	}
}

func TestOOSDoesNotCallRecord(t *testing.T) {
	ResetForTest()
	SetProxies(map[string][]Proxy{"Residential": {line("1.1.1.1")}})
	if _, err := GetProxy("Residential", "task-a"); err != nil {
		t.Fatal(err)
	}
	// Intentionally do not record an OOS. Score must stay unused.
	state.mu.Lock()
	score := state.scores["Residential"]
	state.mu.Unlock()
	if score.successes != 0 || score.fails != 0 {
		t.Fatalf("unexpected score %#v", score)
	}
}

func TestRecordSuccessUpdatesSource(t *testing.T) {
	ResetForTest()
	SetProxies(map[string][]Proxy{"Residential": {line("1.1.1.1")}})
	if _, err := GetProxy("Residential", "task-a"); err != nil {
		t.Fatal(err)
	}
	RecordProxyResult("task-a", true)
	state.mu.Lock()
	score := state.scores["Residential"]
	state.mu.Unlock()
	if score.successes != 1 || score.fails != 0 {
		t.Fatalf("success was not recorded: %#v", score)
	}
}

func TestCooldownExpires(t *testing.T) {
	ResetForTest()
	now := time.Date(2026, 8, 14, 12, 0, 0, 0, time.UTC)
	nowFn = func() time.Time { return now }
	SetProxies(map[string][]Proxy{"Residential": {line("1.1.1.1")}})
	if _, err := GetProxy("Residential", "task-a"); err != nil {
		t.Fatal(err)
	}
	RecordProxyResult("task-a", false)
	ReleaseProxy("Residential", "task-a")
	nowFn = func() time.Time { return now.Add(lineQuarantine + time.Second) }
	if _, err := GetProxy("Residential", "task-b"); err != nil {
		t.Fatal(err)
	}
}

func TestInvalidAndEmptyGroups(t *testing.T) {
	ResetForTest()
	if _, err := GetProxy("Missing", "task-a"); err == nil {
		t.Fatal("expected invalid group")
	}
	SetProxies(map[string][]Proxy{"Empty": {}})
	if _, err := GetProxy("Empty", "task-a"); err == nil {
		t.Fatal("expected empty group error")
	}
}
