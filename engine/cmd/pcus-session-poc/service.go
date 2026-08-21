package main

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

type monitorStats struct {
	mu         sync.Mutex
	startedAt  time.Time
	state      string
	lastPoll   time.Time
	polls      int
	errors     int
	failovers  int
	queueUps   int
	lastXIinfo string
	lastBytes  int
	proxyIdx   int
	proxyTotal int
	proxyBench int
	hasReese   bool
}

func (s *monitorStats) snapshot() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	lastAge := any(nil)
	if !s.lastPoll.IsZero() {
		lastAge = int(time.Since(s.lastPoll).Seconds())
	}
	return map[string]any{
		"ok":              true,
		"uptime_s":        int(time.Since(s.startedAt).Seconds()),
		"state":           s.state,
		"polls":           s.polls,
		"errors":          s.errors,
		"failovers":       s.failovers,
		"queue_ups":       s.queueUps,
		"last_poll_age_s": lastAge,
		"last_bytes":      s.lastBytes,
		"x_iinfo":         s.lastXIinfo,
		"reese84":         s.hasReese,
		"proxies": map[string]int{
			"total":   s.proxyTotal,
			"benched": s.proxyBench,
			"index":   s.proxyIdx,
		},
	}
}

func startHealthServer(addr string, stats *monitorStats) {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(stats.snapshot())
	})
	go func() {
		log.Printf("health listening on %s", addr)
		if err := http.ListenAndServe(addr, mux); err != nil {
			log.Printf("health server: %v", err)
		}
	}()
}

func envList(key string) []string {
	return splitList(os.Getenv(key))
}

func splitList(v string) []string {
	if v == "" {
		return nil
	}
	parts := strings.FieldsFunc(v, func(r rune) bool { return r == '\n' || r == ',' })
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func envDuration(key string, fallback time.Duration) time.Duration {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	if secs, err := strconv.Atoi(raw); err == nil {
		return time.Duration(secs) * time.Second
	}
	d, err := time.ParseDuration(raw)
	if err != nil {
		return fallback
	}
	return d
}

func postJSON(url string, payload any) {
	if strings.TrimSpace(url) == "" {
		return
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return
	}
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		log.Printf("webhook: %v", err)
		return
	}
	req.Header.Set("content-type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Printf("webhook: %v", err)
		return
	}
	resp.Body.Close()
	if resp.StatusCode >= 300 {
		log.Printf("webhook status %s", resp.Status)
	}
}

func discordQueueEmbed(kind string, bytes int, xIinfo string) map[string]any {
	color := 0xC9A227
	title := "Pokémon Center queue is up"
	if kind != "waiting_room" {
		title = "Pokémon Center page changed"
		color = 0xed4245
	}
	return map[string]any{
		"username": envOr("BRAND_NAME", "Zyn"),
		"embeds": []map[string]any{{
			"title": title,
			"url":   pageURL,
			"color": color,
			"fields": []map[string]any{
				{"name": "State", "value": kind, "inline": true},
				{"name": "Bytes", "value": strconv.Itoa(bytes), "inline": true},
				{"name": "X-Iinfo", "value": clip(xIinfo, 80), "inline": false},
			},
			"footer":    map[string]any{"text": envOr("BRAND_FOOTER", "Zyn Monitors")},
			"timestamp": time.Now().UTC().Format(time.RFC3339),
		}},
	}
}

func discordHeartbeat(stats *monitorStats, degraded bool) map[string]any {
	title := "🟢 PCUS Queue Monitor Healthy"
	color := 0xC9A227
	if degraded {
		title = "⚠️ PCUS Queue Monitor Degraded"
		color = 0xed4245
	}
	snap := stats.snapshot()
	return map[string]any{
		"username": envOr("BRAND_NAME", "Zyn"),
		"embeds": []map[string]any{{
			"title": title,
			"color": color,
			"fields": []map[string]any{
				{"name": "Uptime", "value": strconv.Itoa(snap["uptime_s"].(int)) + "s", "inline": true},
				{"name": "State", "value": snap["state"].(string), "inline": true},
				{"name": "Polls", "value": strconv.Itoa(snap["polls"].(int)), "inline": true},
				{"name": "Failovers", "value": strconv.Itoa(snap["failovers"].(int)), "inline": true},
				{"name": "Errors", "value": strconv.Itoa(snap["errors"].(int)), "inline": true},
				{"name": "Queue ups", "value": strconv.Itoa(snap["queue_ups"].(int)), "inline": true},
			},
			"footer":    map[string]any{"text": envOr("BRAND_FOOTER", "Zyn Monitors")},
			"timestamp": time.Now().UTC().Format(time.RFC3339),
		}},
	}
}

func startHeartbeat(url string, interval time.Duration, stats *monitorStats) {
	if strings.TrimSpace(url) == "" {
		log.Printf("no OPS_DISCORD_WEBHOOK_URL — heartbeat disabled")
		return
	}
	beat := func() {
		stats.mu.Lock()
		stale := !stats.lastPoll.IsZero() && time.Since(stats.lastPoll) > 60*time.Second
		allBenched := stats.proxyTotal > 0 && stats.proxyBench >= stats.proxyTotal
		state := stats.state
		stats.mu.Unlock()
		degraded := stale || allBenched || state == "captcha"
		postJSON(url, discordHeartbeat(stats, degraded))
	}
	beat()
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for range t.C {
			beat()
		}
	}()
}

func clip(s string, n int) string {
	if s == "" {
		return "n/a"
	}
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
