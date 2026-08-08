package imapcode

import (
	"context"
	"errors"
	"strings"
	"sync"
)

var (
	pendingMu sync.Mutex
	pending   = map[string]chan string{}
)

type Waiter struct {
	email       string
	ch          chan string
	cleanupOnce sync.Once
	requestOnce sync.Once
}

type CodeRequester func(email string)

var (
	requesterMu sync.RWMutex
	requester   CodeRequester
)

func SetCodeRequester(fn CodeRequester) {
	requesterMu.Lock()
	requester = fn
	requesterMu.Unlock()
}

func DeliverCode(email, code string) {
	email = normalizeEmail(email)
	if email == "" || code == "" {
		return
	}
	pendingMu.Lock()
	ch := pending[email]
	pendingMu.Unlock()
	if ch == nil {
		return
	}
	select {
	case ch <- code:
	default:
	}
}

func PrepareWait(email string) (*Waiter, error) {
	email = normalizeEmail(email)
	if email == "" {
		return nil, errors.New("imapcode: empty email")
	}

	pendingMu.Lock()
	if _, exists := pending[email]; exists {
		pendingMu.Unlock()
		return nil, errors.New("imapcode: wait already pending for email")
	}
	ch := make(chan string, 1)
	pending[email] = ch
	pendingMu.Unlock()

	return &Waiter{email: email, ch: ch}, nil
}

func (w *Waiter) Cancel() {
	if w == nil {
		return
	}
	w.cleanupOnce.Do(func() {
		pendingMu.Lock()
		if pending[w.email] == w.ch {
			delete(pending, w.email)
		}
		pendingMu.Unlock()
	})
}

func (w *Waiter) Arm() {
	if w == nil {
		return
	}
	requesterMu.RLock()
	request := requester
	requesterMu.RUnlock()
	if request == nil {
		return
	}
	w.requestOnce.Do(func() {
		request(w.email)
	})
}

func (w *Waiter) Wait(ctx context.Context) (string, error) {
	if w == nil || w.ch == nil {
		return "", errors.New("imapcode: wait not prepared")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	defer w.Cancel()

	select {
	case code := <-w.ch:
		if code == "" {
			return "", errors.New("imapcode: empty code received")
		}
		return code, nil
	default:
	}

	w.Arm()

	select {
	case code := <-w.ch:
		if code == "" {
			return "", errors.New("imapcode: empty code received")
		}
		return code, nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

func WaitForCode(ctx context.Context, email string) (string, error) {
	waiter, err := PrepareWait(email)
	if err != nil {
		return "", err
	}
	return waiter.Wait(ctx)
}

func normalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}
