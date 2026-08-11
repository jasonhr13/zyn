package hyperbroker

import (
	"context"
	"errors"
	"sync"
)

type Result struct {
	Status int
	Body   []byte
}

type Requester func(ctx context.Context, taskID, operation string, payload any) (Result, error)

var (
	requesterMu sync.RWMutex
	requester   Requester
)

func SetRequester(fn Requester) {
	requesterMu.Lock()
	requester = fn
	requesterMu.Unlock()
}

func Request(ctx context.Context, taskID, operation string, payload any) (Result, error) {
	requesterMu.RLock()
	request := requester
	requesterMu.RUnlock()
	if request == nil {
		return Result{}, errors.New("hyperbroker: requester not configured")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	return request(ctx, taskID, operation, payload)
}
