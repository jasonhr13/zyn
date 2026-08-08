package captcha

import (
	"context"
	"errors"
	"sync"
)

var sendMessage func(any) error

func SetMessageSender(sender func(any) error) {
	sendMessage = sender
}

var (
	pendingMu sync.Mutex
	pending   = map[string]chan string{}
)

func DeliverToken(taskID, token string) {
	pendingMu.Lock()
	ch := pending[taskID]
	pendingMu.Unlock()
	if ch == nil {
		return
	}
	select {
	case ch <- token:
	default:
	}
}

func SolveCaptcha(ctx context.Context, solve CaptchaSolve) (string, error) {
	if sendMessage == nil {
		return "", errors.New("captcha: message sender not set")
	}
	if ctx == nil {
		ctx = context.Background()
	}

	pendingMu.Lock()
	if _, exists := pending[solve.TaskID]; exists {
		pendingMu.Unlock()
		return "", errors.New("captcha: solve already pending for task")
	}
	ch := make(chan string, 1)
	pending[solve.TaskID] = ch
	pendingMu.Unlock()

	defer func() {
		pendingMu.Lock()
		delete(pending, solve.TaskID)
		pendingMu.Unlock()
	}()

	_ = sendMessage(map[string]any{
		"type": "solve-captcha",
		"messages": []any{
			map[string]any{
				"taskId":      solve.TaskID,
				"groupId":     solve.GroupID,
				"siteKey":     solve.SiteKey,
				"siteUrl":     solve.SiteURL,
				"hcapData":    solve.HcapData,
				"proxy":       solve.Proxy,
				"cookies":     solve.Cookies,
				"headers":     solve.Headers,
				"captchaType": solve.CaptchaType,
			},
		},
	})

	select {
	case tok := <-ch:
		if tok == "" {
			return "", errors.New("captcha: empty token received")
		}
		return tok, nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}
