package queueit

import (
	"context"

	"zynbot.app/engine/bot-base/task"
	"zynbot.app/engine/client"
)

type Session struct {
	s *httpSession
}

func NewSession(ctx context.Context, httpClient client.HttpClient, ua *task.BaseUserAgentInfo, taskID *string) *Session {
	if ctx == nil {
		ctx = context.Background()
	}
	return &Session{s: &httpSession{ctx: ctx, client: httpClient, ua: ua, taskID: taskID}}
}

func (s *Session) Land(startURL string) (string, string, error) {
	return s.s.land(startURL)
}

func (s *Session) Enqueue(cfg RoomConfig) (*EnqueueResponse, error) {
	return s.s.enqueue(cfg)
}

func (s *Session) Poll(cfg RoomConfig, queueID string) (*StatusResponse, error) {
	return s.s.poll(cfg, queueID)
}

func (s *Session) SolvePowIfNeeded(cfg RoomConfig, enq *EnqueueResponse) (*EnqueueResponse, error) {
	return s.s.solvePowIfNeeded(cfg, enq)
}

func PassURL(cfg RoomConfig, enq *EnqueueResponse, st *StatusResponse) (string, bool) {
	return passURL(cfg, enq, st)
}

func StatusLine(st *StatusResponse) string {
	return statusLine(st)
}
