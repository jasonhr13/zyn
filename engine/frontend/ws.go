package frontend

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"zynbot.app/engine/bot-base/accounts"
	"zynbot.app/engine/bot-base/captcha"
	"zynbot.app/engine/bot-base/hyperbroker"
	"zynbot.app/engine/bot-base/imapcode"
	"zynbot.app/engine/bot-base/profiles"
	"zynbot.app/engine/bot-base/proxy"
	"zynbot.app/engine/bot-base/safego"
	"zynbot.app/engine/bot-base/siteconfig"
	"zynbot.app/engine/bot-base/task"
	"zynbot.app/engine/bot-base/task/webhook"
	monitorhub "zynbot.app/engine/monitor-hub"
)

var (
	errNoFrontendConnection = errors.New("frontend websocket is not connected")
	frontendConn            *websocket.Conn
	frontendConnMu          sync.Mutex
	frontendWriteMu         sync.Mutex
	watcherReadyMu          sync.Mutex
	watcherReady            = map[string]chan struct{}{}
	watcherSequence         atomic.Uint64
	hyperPendingMu          sync.Mutex
	hyperPending            = map[string]hyperWaiter{}
	hyperSequence           atomic.Uint64
)

type hyperWaiter struct {
	taskID string
	ch     chan HyperResponseMessage
}

func ConnectFrontend(port string) {
	task.SetMessageSender(SendMessage)
	captcha.SetMessageSender(SendMessage)
	hyperbroker.SetRequester(RequestHyper)
	task.SetProductWebhookSender(webhook.SendProductCheckout)
	imapcode.SetCodeRequester(RequestCode)
	for {
		connectAndLog(port)
		time.Sleep(time.Second)
	}
}

func RequestHyper(ctx context.Context, taskID, operation string, payload any) (hyperbroker.Result, error) {
	switch operation {
	case "reese84", "datadome-tags", "datadome-interstitial", "datadome-slider", "incapsula-utmvc":
	default:
		return hyperbroker.Result{}, errors.New("hyperbroker: unsupported operation")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()

	requestID := "hyper-" + strconv.FormatUint(hyperSequence.Add(1), 10)
	waiter := hyperWaiter{taskID: strings.TrimSpace(taskID), ch: make(chan HyperResponseMessage, 1)}
	if waiter.taskID == "" {
		return hyperbroker.Result{}, errors.New("hyperbroker: task ID is required")
	}
	hyperPendingMu.Lock()
	hyperPending[requestID] = waiter
	hyperPendingMu.Unlock()
	defer func() {
		hyperPendingMu.Lock()
		if current, ok := hyperPending[requestID]; ok && current.ch == waiter.ch {
			delete(hyperPending, requestID)
		}
		hyperPendingMu.Unlock()
	}()

	err := SendMessage(SentMessage{Type: "hyper-request", Messages: []any{map[string]any{
		"requestId": requestID,
		"taskId":    waiter.taskID,
		"site":      "Pokemon Center US",
		"operation": operation,
		"payload":   payload,
	}}})
	if err != nil {
		return hyperbroker.Result{}, err
	}

	select {
	case response := <-waiter.ch:
		result := hyperbroker.Result{Status: response.Status, Body: []byte(response.Body)}
		if response.Status <= 0 {
			if strings.TrimSpace(response.Error) == "" {
				response.Error = "Hyper service request failed"
			}
			return result, errors.New(response.Error)
		}
		return result, nil
	case <-ctx.Done():
		return hyperbroker.Result{}, ctx.Err()
	}
}

func deliverHyperResponse(response HyperResponseMessage) {
	if !strings.EqualFold(strings.TrimSpace(response.Site), "Pokemon Center US") {
		return
	}
	hyperPendingMu.Lock()
	waiter, ok := hyperPending[strings.TrimSpace(response.RequestID)]
	hyperPendingMu.Unlock()
	if !ok || strings.TrimSpace(response.TaskID) != waiter.taskID {
		return
	}
	select {
	case waiter.ch <- response:
	default:
	}
}

func failPendingHyper(reason string) {
	hyperPendingMu.Lock()
	waiters := hyperPending
	hyperPending = map[string]hyperWaiter{}
	hyperPendingMu.Unlock()
	for requestID, waiter := range waiters {
		select {
		case waiter.ch <- HyperResponseMessage{RequestID: requestID, TaskID: waiter.taskID, Error: reason}:
		default:
		}
	}
}

func RequestCode(email string) {
	requestID := strconv.FormatUint(watcherSequence.Add(1), 10)
	ready := make(chan struct{}, 1)
	watcherReadyMu.Lock()
	watcherReady[requestID] = ready
	watcherReadyMu.Unlock()
	defer func() {
		watcherReadyMu.Lock()
		delete(watcherReady, requestID)
		watcherReadyMu.Unlock()
	}()
	message := SentMessage{
		Type: "request-code",
		Messages: []any{
			map[string]any{"email": email, "requestId": requestID},
		},
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if err := SendMessage(message); err == nil {
			break
		} else if time.Now().After(deadline) {
			log.Printf("RequestCode send failed for %s: %v", email, err)
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	select {
	case <-ready:
	case <-time.After(15 * time.Second):
		log.Printf("RequestCode watcher readiness timed out for %s", email)
	}
}

func deliverWatcherReady(requestID string) {
	watcherReadyMu.Lock()
	ready := watcherReady[requestID]
	watcherReadyMu.Unlock()
	if ready == nil {
		return
	}
	select {
	case ready <- struct{}{}:
	default:
	}
}

func connectAndLog(port string) {
	url := "ws://127.0.0.1:" + port + "/"
	headers := http.Header{}
	if token := strings.TrimSpace(os.Getenv("ZYN_SHAPE_TOKEN")); token != "" {
		headers.Set("x-zyn-token", token)
	}
	c, _, err := websocket.DefaultDialer.Dial(url, headers)
	if err != nil {
		log.Printf("ConnectFrontend: dial %s: %v", url, err)
		return
	}
	defer c.Close()
	frontendConnMu.Lock()
	frontendConn = c
	frontendConnMu.Unlock()
	defer func() {
		frontendConnMu.Lock()
		if frontendConn == c {
			frontendConn = nil
			failPendingHyper("frontend connection closed")
		}
		frontendConnMu.Unlock()
	}()
	log.Printf("ConnectFrontend: connected %s", url)
	for {
		if err := readMessage(c); err != nil {
			log.Printf("ConnectFrontend: read: %v", err)
			return
		}
	}
}

func readMessage(c *websocket.Conn) error {
	_, data, err := c.ReadMessage()
	if err != nil {
		return err
	}
	msg := MessageEnvelope{}
	if err := json.Unmarshal(data, &msg); err != nil {
		log.Printf("ConnectFrontend: invalid JSON: %v", err)
		return nil
	}
	switch msg.Type {
	//configs
	case "send-configs":
		var configMessage ConfigsStruct
		if err := json.Unmarshal(msg.Messages[0], &configMessage); err != nil {
			log.Printf("ConnectFrontend config: %v", err)
			return nil
		}
		var s SettingsPayload
		_ = json.Unmarshal([]byte(configMessage.Settings), &s)
		Webhooks = s.Webhooks
		webhook.SetURLs(s.Webhooks.Checkout, s.Webhooks.Decline)
		siteconfig.SetLucaAPIKey(s.LucaApiKey)
		siteconfig.SetShapeMethod(s.ShapeMethod)
		siteconfig.SetThrottleFallbackGroup(s.ThrottleFallbackGroup)

		profiles.SetProfilesFromJSON([]byte(configMessage.ProfileList))
		proxy.SetProxiesFromJSON([]byte(configMessage.ProxyListRaw))
		accounts.SetAccountsFromJSON([]byte(configMessage.AccountList))
	//task controls
	case "start-tasks":
		for i, raw := range msg.Messages {
			var taskMessage StartTaskMessage
			if err := json.Unmarshal(raw, &taskMessage); err != nil {
				log.Printf("ConnectFrontend: start-tasks [%d] decode: %v", i, err)
				continue
			}
			safego.Go(func() { StartTask(taskMessage) })
		}
	case "start-monitors":
		for i, raw := range msg.Messages {
			var monitorMessage StartMonitorMessage
			if err := json.Unmarshal(raw, &monitorMessage); err != nil {
				log.Printf("ConnectFrontend: start-monitors [%d] decode: %v", i, err)
				continue
			}
			safego.Go(func() { StartMonitor(monitorMessage) })
		}
	case "stop-tasks":
		taskIDs := make([]string, 0, len(msg.Messages))
		for i, raw := range msg.Messages {
			var taskMessage StopTaskMessage
			if err := json.Unmarshal(raw, &taskMessage); err != nil {
				log.Printf("ConnectFrontend: stop-tasks [%d] decode: %v", i, err)
				continue
			}
			taskIDs = append(taskIDs, taskMessage.Id)
		}
		safego.Go(func() { StopTasks(taskIDs) })
	case "edit-tasks":
		for i, raw := range msg.Messages {
			var taskMessage StartTaskMessage
			if err := json.Unmarshal(raw, &taskMessage); err != nil {
				log.Printf("ConnectFrontend: edit-tasks [%d] decode: %v", i, err)
				continue
			}
			safego.Go(func() { EditTask(taskMessage) })
		}
	case "stock-ping":
		for i, raw := range msg.Messages {
			var incoming StockPingMessage
			if err := json.Unmarshal(raw, &incoming); err != nil {
				log.Printf("ConnectFrontend: stock-ping [%d] decode: %v", i, err)
				continue
			}
			ping, ok := normalizeStockPing(incoming)
			if ok {
				monitorhub.Default.Publish(ping)
			}
		}
	case "set-task-proxy":
		for i, raw := range msg.Messages {
			var incoming SetTaskProxyMessage
			if err := json.Unmarshal(raw, &incoming); err != nil {
				log.Printf("ConnectFrontend: set-task-proxy [%d] decode: %v", i, err)
				continue
			}
			group := strings.TrimSpace(incoming.ProxyGroup)
			if group == "" || strings.EqualFold(group, "Local") {
				group = "Local"
			}
			if !task.EnqueueRuntimeEdit(strings.TrimSpace(incoming.ID), task.RuntimeEditPayload{
				ProxyGroup:   &group,
				ProxySources: incoming.ProxySources,
			}) {
				log.Printf("ConnectFrontend: set-task-proxy [%d] task unavailable", i)
			}
		}

	//captcha sovles
	case "received-token":
		var captchaMessage CaptchaSolvePayload
		if err := json.Unmarshal(msg.Messages[0], &captchaMessage); err != nil {
			log.Printf("ConnectFrontend captcha: %v", err)
			return nil
		}
		captcha.DeliverToken(captchaMessage.TaskId, captchaMessage.Token)

	//imap
	case "received-code":
		var imapMessage ImapCodeResponse
		if err := json.Unmarshal(msg.Messages[0], &imapMessage); err != nil {
			log.Printf("ConnectFrontend imap: %v", err)
			return nil
		}
		imapcode.DeliverCode(imapMessage.Email, imapMessage.Code)
	case "code-watcher-ready":
		var readyMessage struct {
			RequestID string `json:"requestId"`
		}
		if len(msg.Messages) == 0 {
			return nil
		}
		if err := json.Unmarshal(msg.Messages[0], &readyMessage); err != nil {
			return nil
		}
		deliverWatcherReady(readyMessage.RequestID)
	case "hyper-response":
		for i, raw := range msg.Messages {
			var response HyperResponseMessage
			if err := json.Unmarshal(raw, &response); err != nil {
				log.Printf("ConnectFrontend: hyper-response [%d] decode: %v", i, err)
				continue
			}
			deliverHyperResponse(response)
		}
	default:
		log.Printf("ConnectFrontend: unknown type %q", msg.Type)
	}
	return nil
}

func normalizeStockPing(in StockPingMessage) (monitorhub.StockPing, bool) {
	productKey := strings.TrimSpace(in.ProductKey)
	if productKey == "" {
		return monitorhub.StockPing{}, false
	}
	site := strings.TrimSpace(in.Site)
	if site == "" || strings.EqualFold(site, "Target") {
		site = "Target"
	}
	return monitorhub.StockPing{
		Site:       site,
		ProductKey: productKey,
		Name:       in.Name,
		Image:      in.Image,
		Price:      in.Price,
		StockLevel: in.StockLevel,
		InStock:    in.InStock,
		From:       in.From,
		At:         time.Now(),
	}, true
}

func SendMessage(v any) error {
	frontendConnMu.Lock()
	c := frontendConn
	frontendConnMu.Unlock()
	if c == nil {
		return errNoFrontendConnection
	}
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	frontendWriteMu.Lock()
	defer frontendWriteMu.Unlock()
	if err := c.WriteMessage(websocket.TextMessage, data); err != nil {
		frontendConnMu.Lock()
		if frontendConn == c {
			frontendConn = nil
		}
		frontendConnMu.Unlock()
		_ = c.Close()
		return err
	}
	return nil
}
