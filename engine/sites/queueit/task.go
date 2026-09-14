package queueit

import (
	"fmt"
	"log"
	"runtime/debug"
	"strings"

	"zynbot.app/engine/bot-base/alert"
	"zynbot.app/engine/bot-base/proxy"
	"zynbot.app/engine/bot-base/task"
	"zynbot.app/engine/bot-base/task/constants"
	"zynbot.app/engine/bot-base/task/webhook"
)

type QueueItTask struct {
	*task.BaseTask
	StartURL string
	Config   RoomConfig
	QueueID  string
	PassURL  string
	session  *httpSession
}

func catchError(t *QueueItTask) {
	if a := recover(); a != nil {
		stack := debug.Stack()
		id := ""
		if t != nil {
			id = t.ID
		}
		log.Printf("[ID:'%s'] panic in queueit task: %v\n%s", id, a, stack)
		alert.Panic("queueit task", a, stack)
		if t != nil {
			t.StopTask("unhandled error", constants.Colors.RED)
		}
	}
}

func (t *QueueItTask) probeWaitingRoom() error {
	if t.Config.CustomerID == "" {
		landed, html, err := t.session.land(t.StartURL)
		if err != nil {
			return err
		}
		t.Config = MergeHTMLConfig(t.Config, html, landed)
	}
	if t.Config.TargetURL == "" {
		t.Config.TargetURL = t.StartURL
	}
	connector := jsConnectorURL(t.Config.CustomerID)
	if connector == "" {
		return nil
	}
	body, err := t.session.fetchText(connector)
	if err != nil {
		return err
	}
	if js, ok := parseClientSideConfig(body); ok {
		t.Config = t.Config.applyClientSide(js, firstNonEmpty(t.Config.TargetURL, t.StartURL))
	}
	return nil
}

func (t *QueueItTask) bindSession() {
	t.session = &httpSession{
		ctx:    t.TaskContext.CTX,
		client: t.Requests.Client,
		ua:     t.Requests.UserAgent,
		taskID: &t.ClientID,
	}
}

func (t *QueueItTask) pollDelay() int {
	if t.MonitorDelay > 0 {
		return t.MonitorDelay
	}
	if t.Config.UpdateIntervalMS > 0 {
		return t.Config.UpdateIntervalMS
	}
	return 2000
}

func (t *QueueItTask) retryDelay() int {
	if t.ErrorDelay > 0 {
		return t.ErrorDelay
	}
	return 2000
}

func (t *QueueItTask) handleErrors(step string) bool {
	if t.Error == nil {
		return false
	}
	msg := strings.TrimSpace(t.Error.Error())
	t.UpdateStatus(msg, constants.Colors.YELLOW)
	if isTransportError(t.Error) {
		_ = t.BaseTask.SwapProxy(t.Site)
		t.bindSession()
	}
	t.SleepTask(t.retryDelay())
	t.NextStep = step
	t.Error = nil
	return true
}

func (t *QueueItTask) HandleTask() {
	defer catchError(t)
	t.bindSession()
	for {
		select {
		case <-t.TaskContext.CTX.Done():
			return
		default:
			t.Error = nil
			t.DrainPendingRuntimeEdits(func(p task.RuntimeEditPayload) {})
			switch t.NextStep {
			case "stop":
				if t.PassURL != "" {
					t.StopTask("Queue Pass", constants.Colors.GREEN, constants.StatusSteps.CheckedOut)
				} else {
					t.StopTask("Idle", constants.Colors.DEFAULT)
				}

			case "land":
				if !t.Config.Ready() {
					t.UpdateStatus("Waiting For Waiting Room", constants.Colors.YELLOW)
					if err := t.probeWaitingRoom(); err != nil {
						t.Error = err
						if t.handleErrors("land") {
							break
						}
					}
					if !t.Config.Ready() {
						t.SleepTask(t.pollDelay())
						t.NextStep = "land"
						break
					}
				}
				join := t.Config.JoinURL()
				if join == "" {
					join = t.StartURL
				}
				t.UpdateStatus("Joining Queue", constants.Colors.BLUE)
				landed, html, err := t.session.land(join)
				if err != nil {
					t.Error = err
					if t.handleErrors("land") {
						break
					}
				}
				t.Config = MergeHTMLConfig(t.Config, html, landed)
				if !t.Config.Ready() {
					t.UpdateStatus("Waiting For Waiting Room", constants.Colors.YELLOW)
					t.SleepTask(t.pollDelay())
					t.NextStep = "land"
					break
				}
				t.NextStep = "enqueue"

			case "enqueue":
				t.UpdateStatus("Getting Queue ID", constants.Colors.BLUE)
				enq, err := t.session.enqueue(t.Config)
				if err != nil {
					t.Error = err
					if t.handleErrors("enqueue") {
						break
					}
				}
				enq, err = t.session.solvePowIfNeeded(t.Config, enq)
				if err != nil {
					t.Error = err
					if t.handleErrors("enqueue") {
						break
					}
				}
				if enq.InvalidQueueitEnqueueToken {
					t.Error = fmt.Errorf("invalid enqueue token")
					if t.handleErrors("land") {
						break
					}
				}
				if enq.ServerIsBusy {
					t.UpdateStatus("Queue Busy", constants.Colors.YELLOW)
					t.SleepTask(t.retryDelay())
					break
				}
				if url, ok := passURL(t.Config, enq, nil); ok {
					t.finishPass(enq.QueueID, url)
					t.NextStep = "stop"
					break
				}
				if enq.QueueID == "" {
					t.Error = fmt.Errorf("enqueue returned no queue id")
					if t.handleErrors("enqueue") {
						break
					}
				}
				t.QueueID = enq.QueueID
				t.NextStep = "poll"

			case "poll":
				st, err := t.session.poll(t.Config, t.QueueID)
				if err != nil {
					t.Error = err
					if t.handleErrors("poll") {
						break
					}
				}
				t.UpdateStatus(statusLine(st), constants.Colors.BLUE)
				if url, ok := passURL(t.Config, nil, st); ok {
					t.finishPass(t.QueueID, url)
					t.NextStep = "stop"
					break
				}
				delay := t.pollDelay()
				if st != nil && st.UpdateInterval > 0 {
					delay = st.UpdateInterval
				}
				t.SleepTask(delay)

			default:
				t.StopTask("Unknown Step", constants.Colors.RED)
			}
		}
	}
}

func (t *QueueItTask) finishPass(queueID, redirectURL string) {
	t.QueueID = queueID
	t.PassURL = redirectURL
	t.Product.Name = "Queue Pass"
	t.Product.ProductLink = redirectURL
	t.Product.Sku = queueID
	t.UpdateStatus("Queue Pass", constants.Colors.GREEN)
	t.SendCheckoutDeclineNoti("Queue Pass", "", true, task.NotificationDetails{
		TaskID:      t.ID,
		SKU:         queueID,
		OrderNumber: queueID,
		Source:      redirectURL,
	})
	cookies := dumpCookiesJSON(t.Requests.Client, t.Config.Origin, t.StartURL, redirectURL)
	t.SendQueuePass(task.QueuePassMessage{
		QueueID:     queueID,
		RedirectURL: redirectURL,
		Cookies:     cookies,
		Proxy:       proxy.AssignedProxyURL(t.ProxyGroup, t.ID),
		Origin:      t.Config.Origin,
	})
	webhook.SendProductCheckout(task.ProductWebhookData{
		Success: true,
		CheckoutProducts: []task.ProductWebhookItem{{
			SKU:         queueID,
			Quantity:    1,
			Name:        "Queue Pass",
			ProductLink: redirectURL,
		}},
		Site:         t.Site,
		TaskID:       t.ID,
		ClientTaskID: t.ID,
		RunID:        t.RunID,
		ProxyGroup:   t.ProxyGroup,
		Proxy:        proxy.AssignedProxyURL(t.ProxyGroup, t.ID),
		OrderLink:    redirectURL,
		ExtraFeilds: map[string]string{
			"queueId": queueID,
		},
	})
}
