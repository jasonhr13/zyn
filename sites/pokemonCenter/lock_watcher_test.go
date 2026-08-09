package pokemoncenter

import (
	"testing"
	"time"
)

func TestStatusPingsPublishesQueueProtection(t *testing.T) {
	at := time.Unix(123, 0)
	pings := statusPings(CheckStatusResponse{QueueUp: true}, at)
	if len(pings) != 1 {
		t.Fatalf("expected one queue ping, got %d", len(pings))
	}
	ping := pings[0]
	if ping.Site != "PokemonCenter" || ping.ProductKey != "queue" || !ping.InStock {
		t.Fatalf("unexpected queue ping: %#v", ping)
	}
	if ping.From != "Railway" || !ping.At.Equal(at) {
		t.Fatalf("queue ping lost its source or timestamp: %#v", ping)
	}
}

func TestStatusPingsPublishesQueueAndUnlockIndependently(t *testing.T) {
	pings := statusPings(CheckStatusResponse{QueueUp: true, Unlocked: true}, time.Now())
	if len(pings) != 2 {
		t.Fatalf("expected queue and unlock pings, got %d", len(pings))
	}
	if pings[0].ProductKey != "queue" || pings[1].ProductKey != unlockProductKey {
		t.Fatalf("unexpected status ping ordering: %#v", pings)
	}
}

func TestStatusWatcherHealthTracksFailureAndRecovery(t *testing.T) {
	statusWatcherState.Lock()
	statusWatcherState.value = statusWatcherHealth{}
	statusWatcherState.Unlock()

	attempt := time.Unix(500, 0)
	setStatusWatcherAttempt(attempt)
	setStatusWatcherFailure()
	failed := getStatusWatcherHealth()
	if !failed.Failed || !failed.LastAttempt.Equal(attempt) || !failed.LastSuccess.IsZero() {
		t.Fatalf("unexpected failed watcher health: %#v", failed)
	}

	recoveredAt := time.Unix(503, 0)
	setStatusWatcherSuccess(CheckStatusResponse{QueueUp: true, Unlocked: false}, recoveredAt)
	healthy := getStatusWatcherHealth()
	if healthy.Failed || !healthy.LastSuccess.Equal(recoveredAt) || !healthy.QueueUp || healthy.Unlocked {
		t.Fatalf("unexpected recovered watcher health: %#v", healthy)
	}
}
