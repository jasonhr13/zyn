package queueit

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
)

type EnqueueResponse struct {
	QueueID                    string `json:"queueId"`
	RedirectURL                string `json:"redirectUrl"`
	ChallengeFailed            bool   `json:"challengeFailed"`
	ChallengeRequired          bool   `json:"challengeRequired"`
	InvalidQueueitEnqueueToken bool   `json:"invalidQueueitEnqueueToken"`
	ServerIsBusy               bool   `json:"serverIsBusy"`
	IsRedirectToTarget         bool   `json:"isRedirectToTarget"`
	SessionID                  string `json:"sessionId"`
}

type StatusResponse struct {
	PageID             string       `json:"pageId"`
	QueueState         int          `json:"QueueState"`
	IsBeforeOrIdle     bool         `json:"isBeforeOrIdle"`
	RedirectURL        string       `json:"redirectUrl"`
	IsRedirectToTarget bool         `json:"isRedirectToTarget"`
	UpdateInterval     int          `json:"updateInterval"`
	Ticket             StatusTicket `json:"ticket"`
}

type StatusTicket struct {
	QueueNumber           *int     `json:"queueNumber"`
	UsersInLineAheadOfYou *int     `json:"usersInLineAheadOfYou"`
	Progress              *float64 `json:"progress"`
	QueuePaused           bool     `json:"queuePaused"`
	WhichIsIn             string   `json:"whichIsIn"`
	UsersInQueue          int      `json:"usersInQueue"`
	RedirectURL           string   `json:"redirectUrl"`
}

type powChallengeResponse struct {
	SessionID        string        `json:"sessionId"`
	ChallengeDetails string        `json:"challengeDetails"`
	Parameters       powParameters `json:"parameters"`
	Input            string        `json:"input"`
	ZeroCount        int           `json:"zeroCount"`
	Complexity       int           `json:"complexity"`
	Runs             int           `json:"runs"`
}

type powParameters struct {
	Type       string `json:"type"`
	Input      string `json:"input"`
	Runs       int    `json:"runs"`
	Complexity int    `json:"complexity"`
	ZeroCount  int    `json:"zeroCount"`
}

func (s *httpSession) enqueue(cfg RoomConfig) (*EnqueueResponse, error) {
	q := url.Values{}
	q.Set("culture", cfg.Culture)
	if cfg.Layout != "" {
		q.Set("layoutName", cfg.Layout)
	}
	if cfg.TargetURL != "" {
		q.Set("targetUrl", cfg.TargetURL)
	}
	rawURL := cfg.spaBase() + "/enqueue?" + q.Encode()
	referer := cfg.Origin + "/"
	payload := map[string]any{
		"challengeSessions": []any{},
		"layoutName":        cfg.Layout,
		"customUrlParams":   "",
		"targetUrl":         cfg.TargetURL,
		"Referrer":          "",
	}
	resp, body, err := s.postJSON(rawURL, cfg.Origin, referer, payload)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("enqueue %d", resp.StatusCode)
	}
	var out EnqueueResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("enqueue json: %w", err)
	}
	return &out, nil
}

func (s *httpSession) poll(cfg RoomConfig, queueID string) (*StatusResponse, error) {
	q := url.Values{}
	q.Set("culture", cfg.Culture)
	if cfg.Layout != "" {
		q.Set("layoutName", cfg.Layout)
	}
	rawURL := cfg.spaBase() + "/" + queueID + "/status?" + q.Encode()
	resp, body, err := s.postJSON(rawURL, cfg.Origin, cfg.Origin+"/", map[string]any{})
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("status %d", resp.StatusCode)
	}
	var out StatusResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("status json: %w", err)
	}
	return &out, nil
}

func (s *httpSession) solvePowIfNeeded(cfg RoomConfig, enq *EnqueueResponse) (*EnqueueResponse, error) {
	if enq == nil || !enq.ChallengeRequired {
		return enq, nil
	}
	ch, err := s.fetchPow(cfg, enq.SessionID)
	if err != nil {
		return nil, err
	}
	input := firstNonEmpty(ch.Parameters.Input, ch.Input, ch.SessionID)
	if input == "" {
		return nil, fmt.Errorf("pow missing input")
	}
	zero := ch.Parameters.ZeroCount
	if zero == 0 {
		zero = ch.ZeroCount
	}
	if zero == 0 {
		zero = ch.Parameters.Complexity
	}
	if zero == 0 {
		zero = ch.Complexity
	}
	runs := ch.Parameters.Runs
	if runs == 0 {
		runs = ch.Runs
	}
	sol, err := SolvePow(input, zero, runs)
	if err != nil {
		return nil, err
	}
	verifyURL := cfg.ChallengeVerifyEndpoint
	if !strings.HasPrefix(verifyURL, "http") {
		verifyURL = cfg.Origin + verifyURL
	}
	payload := map[string]any{
		"sessionId":        firstNonEmpty(ch.SessionID, input),
		"challengeDetails": ch.ChallengeDetails,
		"solution":         sol,
		"stats":            map[string]any{"tries": 1, "userAgent": s.ua.Useragent},
	}
	resp, body, err := s.postJSON(verifyURL, cfg.Origin, cfg.Origin+"/", payload)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("pow verify %d %s", resp.StatusCode, truncate(string(body), 160))
	}
	return s.enqueue(cfg)
}

func (s *httpSession) fetchPow(cfg RoomConfig, sessionID string) (*powChallengeResponse, error) {
	path := "/challengeapi/pow/challenge/"
	if sessionID != "" {
		path = "/challengeapi/pow/challenge/session/" + sessionID
	}
	rawURL := cfg.powOrigin() + strings.TrimSuffix(cfg.QueuePathPrefix, "/") + path
	resp, body, err := s.postJSON(rawURL, cfg.Origin, cfg.Origin+"/", map[string]any{})
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("pow challenge %d", resp.StatusCode)
	}
	var out powChallengeResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("pow json: %w", err)
	}
	return &out, nil
}

func passURL(cfg RoomConfig, enq *EnqueueResponse, st *StatusResponse) (string, bool) {
	candidates := []struct {
		raw      string
		toTarget bool
	}{}
	if enq != nil {
		candidates = append(candidates, struct {
			raw      string
			toTarget bool
		}{enq.RedirectURL, enq.IsRedirectToTarget})
	}
	if st != nil {
		candidates = append(candidates, struct {
			raw      string
			toTarget bool
		}{st.RedirectURL, st.IsRedirectToTarget})
		candidates = append(candidates, struct {
			raw      string
			toTarget bool
		}{st.Ticket.RedirectURL, st.IsRedirectToTarget})
	}
	for _, c := range candidates {
		if c.raw == "" {
			continue
		}
		abs := absURL(cfg.Origin, c.raw)
		if c.toTarget || looksLikePassURL(abs) {
			return abs, true
		}
	}
	return "", false
}

func statusLine(st *StatusResponse) string {
	if st == nil {
		return "Waiting"
	}
	parts := []string{queuePhase(st)}
	if st.Ticket.QueueNumber != nil {
		parts = append(parts, fmt.Sprintf("#%d", *st.Ticket.QueueNumber))
	}
	if st.Ticket.UsersInLineAheadOfYou != nil {
		n := *st.Ticket.UsersInLineAheadOfYou
		switch {
		case n <= 0:
			parts = append(parts, "at the front")
		case n == 1:
			parts = append(parts, "1 ahead")
		default:
			parts = append(parts, fmt.Sprintf("%d ahead", n))
		}
	}
	if eta := strings.TrimSpace(st.Ticket.WhichIsIn); eta != "" {
		parts = append(parts, eta)
	} else if st.Ticket.Progress != nil {
		if pct := progressPercent(*st.Ticket.Progress); pct >= 0 {
			parts = append(parts, fmt.Sprintf("%d%%", pct))
		}
	}
	return strings.Join(parts, " · ")
}

func queuePhase(st *StatusResponse) string {
	if st.Ticket.QueuePaused {
		return "Queue paused"
	}
	if st.IsBeforeOrIdle {
		return "Waiting room"
	}
	switch strings.ToLower(strings.TrimSpace(st.PageID)) {
	case "before", "idle":
		return "Waiting room"
	case "after", "afterevent", "postqueue":
		return "After queue"
	case "error":
		return "Queue error"
	case "queue":
		return "In queue"
	}
	switch st.QueueState {
	case 1:
		return "Waiting room"
	case 3:
		return "Almost through"
	case 4:
		return "Passing through"
	default:
		return "In queue"
	}
}

func progressPercent(progress float64) int {
	if progress < 0 {
		return -1
	}
	if progress <= 1 {
		return int(progress*100 + 0.5)
	}
	if progress <= 100 {
		return int(progress + 0.5)
	}
	return -1
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

func isTransportError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	for _, frag := range []string{"proxy", "timeout", "connection", "tls", "eof", "reset", "dial"} {
		if strings.Contains(msg, frag) {
			return true
		}
	}
	return false
}
