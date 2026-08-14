package task

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"log"
	"math"
	"net/url"
	"strings"
	"sync"
	"time"

	http "github.com/bogdanfinn/fhttp"
	tls_client "github.com/bogdanfinn/tls-client"
	"zynbot.app/engine/bot-base/accounts"
	"zynbot.app/engine/bot-base/datadog"
	"zynbot.app/engine/bot-base/profiles"
	"zynbot.app/engine/bot-base/proxy"
	"zynbot.app/engine/bot-base/safego"
	"zynbot.app/engine/bot-base/task/constants"
	"zynbot.app/engine/client"
)

var safeTaskStatuses = safeStatuses{
	value: []taskStatus{},
}

var UserTasks = safeTaskChannels{value: map[string]Task{}}

var sendMessage func(any) error

var sendProductWebhook func(ProductWebhookData)

var sendServerEvent func(ServerEventData)

var cloudConnected func() bool

var (
	sentProductsMu sync.Mutex
	sentProducts   = []string{}
)

func SetProductWebhookSender(fn func(ProductWebhookData)) {
	sendProductWebhook = fn
}

func SetServerEventSender(fn func(ServerEventData)) {
	sendServerEvent = fn
}

func SetCloudConnectedCheck(fn func() bool) {
	cloudConnected = fn
}

func IsCloudConnected() bool {
	if cloudConnected == nil {
		return false
	}
	return cloudConnected()
}

func SendProductWebhook(data ProductWebhookData) {
	if data.Success {
		proxy.RecordProxyResult(proxyResultTaskID(data), true)
	}
	eventName, message := "checkout_decline", "Declined"
	if data.Success {
		eventName, message = "checkout_success", "Successful Checkout"
	}
	datadog.Info(message, map[string]interface{}{
		"event":        eventName,
		"site":         data.Site,
		"task_id":      data.TaskID,
		"order_number": data.OrderNumber,
		"grand_total":  data.GrandTotal,
		"name":         data.ProfileName,
	})

	if fn := sendProductWebhook; fn != nil {
		safego.Go(func() { fn(data) })
	}
	emitAnalyticsEvent(analyticsOutcomeType(data), data)
	// Persist/send server events synchronously so a process exit cannot
	// race past an in-flight goroutine before the durable queue write.
	sendServerEvents(data)
}

func analyticsOutcomeType(data ProductWebhookData) string {
	if data.Success {
		return "checkout"
	}
	return "decline"
}

func moneyCents(value float64) int64 {
	return int64(math.Round(value * 100))
}

func newAnalyticsEventID() string {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err == nil {
		return hex.EncodeToString(buffer)
	}
	return fmt.Sprintf("evt-%d", time.Now().UnixNano())
}

func emitAnalyticsEvent(eventType string, data ProductWebhookData) {
	if sendMessage == nil {
		return
	}

	items := make([]AnalyticsProductItem, 0, len(data.CheckoutProducts))
	var calculatedTotal int64
	for _, product := range data.CheckoutProducts {
		quantity := product.Quantity
		if quantity <= 0 {
			quantity = 1
		}
		unitPriceCents := moneyCents(product.Price)
		calculatedTotal += unitPriceCents * int64(quantity)
		items = append(items, AnalyticsProductItem{
			SKU:            product.SKU,
			Name:           product.Name,
			Image:          product.Image,
			ProductURL:     product.ProductLink,
			Size:           product.Size,
			UnitPriceCents: unitPriceCents,
			Quantity:       quantity,
		})
	}

	totalCents := moneyCents(data.GrandTotal)
	if totalCents <= 0 {
		totalCents = calculatedTotal
	}
	taskID := data.ClientTaskID
	if taskID == "" {
		taskID = data.TaskID
	}
	runID := data.RunID
	if runID == "" {
		runID = data.TaskID
	}
	event := AnalyticsEventMessage{
		EventID:     newAnalyticsEventID(),
		EventType:   eventType,
		Site:        data.Site,
		TaskID:      taskID,
		RunID:       runID,
		OrderNumber: data.OrderNumber,
		TotalCents:  totalCents,
		Items:       items,
		OccurredAt:  time.Now().UnixMilli(),
	}
	_ = sendMessage(statusMessage{Type: "analytics-event", Messages: []AnalyticsEventMessage{event}})
}

func SendCartedAnalytics(data ProductWebhookData) {
	proxy.RecordProxyResult(proxyResultTaskID(data), true)
	emitAnalyticsEvent("carted", data)
	SendCartedEvent(data.TaskID)
}

func proxyResultTaskID(data ProductWebhookData) string {
	if id := strings.TrimSpace(data.ClientTaskID); id != "" {
		return id
	}
	return strings.TrimSpace(data.TaskID)
}

func sendServerEvents(data ProductWebhookData) {
	fn := sendServerEvent
	if fn == nil {
		return
	}

	eventType := "decline"
	if data.Success {
		eventType = "checkout"
	}

	taskID := data.TaskID
	if taskID == "" {
		taskID = data.OrderNumber
	}
	if taskID == "" {
		taskID = fmt.Sprintf("evt-%d", time.Now().UnixMilli())
	}

	products := data.CheckoutProducts
	if len(products) == 0 {
		// Still report the success/decline so Datadog and polar-ws stay aligned
		// even when product details failed to populate.
		products = []ProductWebhookItem{{}}
	}

	for _, product := range products {
		fn(ServerEventData{
			EventType:       eventType,
			ProductName:     product.Name,
			ProductPrice:    product.Price,
			OrderNumber:     data.OrderNumber,
			ProductQuantity: product.Quantity,
			ProductImage:    product.Image,
			Site:            data.Site,
			Size:            product.Size,
			TaskID:          taskID,
			ProfileName:     data.ProfileName,
			ProxyGroup:      data.ProxyGroup,
		})
	}
}

func SendCartedEvent(TaskId string) {
	fn := sendServerEvent
	if fn == nil {
		return
	}
	event := ServerEventData{
		EventType: "stuckInCart",
		TaskID:    TaskId,
	}
	safego.Go(func() { fn(event) })
}

func SetMessageSender(sender func(any) error) {
	sendMessage = sender
}

func (t *BaseTask) StartTask() {
	_, ok := UserTasks.Get(t.ID)
	if !ok {
		return
	}

}
func SendStatuses() {
	for {
		safeTaskStatuses.mu.Lock()

		if len(safeTaskStatuses.value) > 0 {
			var newStatuses []taskStatus

			for _, ts := range safeTaskStatuses.value {
				newStatuses = append(newStatuses, taskStatus{
					TaskID:  ts.TaskID,
					Status:  ts.Status,
					Color:   ts.Color,
					State:   ts.State,
					Running: ts.Running,
				})
			}

			safeTaskStatuses.value = nil

			message := statusMessage{
				Type:     "update-status",
				Messages: newStatuses,
			}
			if sendMessage != nil {
				_ = sendMessage(message)
			}
		}

		safeTaskStatuses.mu.Unlock()

		time.Sleep(50 * time.Millisecond)
	}
}

func StartStatusHeartbeat() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		bases := UserTasks.GetAllBases()
		if len(bases) == 0 {
			continue
		}

		safeTaskStatuses.mu.Lock()
		for id, t := range bases {
			if t.Status == nil || !t.Running {
				continue
			}
			safeTaskStatuses.value = append(safeTaskStatuses.value, taskStatus{
				TaskID:  id,
				Status:  t.Status.Status,
				Color:   t.Status.Color,
				State:   t.TaskState,
				Running: t.Running,
			})
		}
		safeTaskStatuses.mu.Unlock()
	}
}

// Sleep the task but stop the sleep if the task is stopped
func (t *BaseTask) StopTask(finalStatus string, finalColor string, statusStep ...int) {
	if t == nil {
		return
	}
	t.stopOnce.Do(func() {
		log.Printf("StopTask called for task %s", t.ID)

		t.Running = false
		if t.TaskContext != nil && t.TaskContext.Cancel != nil {
			log.Printf("Cancelling context for task %s", t.ID)
			t.TaskContext.Cancel()
		} else {
			log.Printf("No context to cancel for task %s", t.ID)
		}

		if t.Status != nil {
			t.Status.Status = finalStatus
		}
		log.Printf("[ID:'%s' - %s]", t.ID, finalStatus)

		if len(statusStep) > 0 {
			t.TaskState = statusStep[0]
		} else if t.TaskState != constants.StatusSteps.CheckedOut && t.TaskState != constants.StatusSteps.Declined {
			t.TaskState = constants.StatusSteps.Idle
		}

		safeTaskStatuses.mu.Lock()
		safeTaskStatuses.value = append(safeTaskStatuses.value, taskStatus{
			TaskID:  t.ID,
			Status:  finalStatus,
			Color:   finalColor,
			State:   t.TaskState,
			Running: t.Running,
		})
		safeTaskStatuses.mu.Unlock()

		proxy.ReleaseProxy(t.ProxyGroup, t.ID)
		if t.siteSlotReserved {
			t.siteSlotReserved = false
			releaseSiteSlot(t.Site)
		}
		UserTasks.Delete(t.ID)
		emitTaskRemove(t.ID)
	})
}

func (t *BaseTask) UpdateStatus(status string, color string) {
	if t == nil || !t.Running {
		return
	}
	if t.Status == nil {
		t.Status = new(BaseStatus)
	}
	if strings.EqualFold(t.Status.Status, "idle") {
		log.Print("Task already stopped")
		return
	}
	if t.Status.Status == status {
		return
	}
	t.Status.Status = status
	t.Status.Color = color
	log.Printf("[ID:'%s' - %s]", t.ID, status)
	safeTaskStatuses.mu.Lock()
	// Initialize the TaskStatuses update
	safeTaskStatuses.value = append(safeTaskStatuses.value, taskStatus{
		TaskID:  t.ID,
		Status:  status,
		Color:   color,
		State:   t.TaskState,
		Running: t.Running,
	})

	safeTaskStatuses.mu.Unlock()

	emitTaskChange(t)
}

func (t *BaseTask) UpdateCookie(cookie string, accountID string) {
	accounts.UpdateCookie(accountID, cookie)
	_ = sendMessage(statusMessage{
		Type: "account-cookie",
		Messages: []UpdateCookieMessage{{
			Cookie:    cookie,
			AccountID: accountID,
		}},
	})
}

func (t *BaseTask) UpdatePassword(password string, accountID string) {
	accounts.UpdatePassword(accountID, password)
	_ = sendMessage(statusMessage{
		Type: "account-password",
		Messages: []UpdatePasswordMessage{{
			Password:  password,
			AccountID: accountID,
		}},
	})
}

const logCipherKey = "Zyn-Task-Log-v1"

func encodeLog(msg string) string {
	key := []byte(logCipherKey)
	data := []byte(msg)
	out := make([]byte, len(data))
	for i := range data {
		out[i] = data[i] ^ key[i%len(key)]
	}
	return base64.StdEncoding.EncodeToString(out)
}

func (t *BaseTask) AddLog(msg string) {
	if t == nil || sendMessage == nil {
		return
	}
	_ = sendMessage(statusMessage{
		Type: "task-log",
		Messages: []LogMessage{{
			TaskID: t.ID,
			Data:   encodeLog(msg),
		}},
	})
}

func (t *BaseTask) AddUnkownResponse(requestUrl string, response http.Response, body string) {
	log := fmt.Sprintf("Unkown Response: {\"requestUrl\": \"%s\", \"responseStatus\": \"%s\", \"responseBody\": \"%s\"}", requestUrl, response.Status, body)
	if t == nil || sendMessage == nil {
		return
	}
	_ = sendMessage(statusMessage{
		Type: "task-log",
		Messages: []LogMessage{{
			TaskID: t.ID,
			Data:   encodeLog(log),
		}},
	})
}

func (t *BaseTask) UpdateInputValue(name string, size string) {
	log.Print("Updating input value for task ", t.ID, " to product: ", name, " size: ", size)
	t.InputProduct = name
	t.InputSize = size
	if sendMessage == nil {
		return
	}
	_ = sendMessage(statusMessage{
		Type: "update-input",
		Messages: []taskStatus{
			{
				TaskID:      t.ID,
				ProductName: name,
				ProductSize: size,
			},
		},
	})
}

func productAlreadySent(name string) bool {
	sentProductsMu.Lock()
	defer sentProductsMu.Unlock()
	for _, p := range sentProducts {
		if strings.EqualFold(p, name) {
			return true
		}
	}
	return false
}

func markProductSent(name string) {
	sentProductsMu.Lock()
	sentProducts = append(sentProducts, name)
	sentProductsMu.Unlock()
}

func (t *BaseTask) SendProductNoti(productName, productImage string) {
	if productAlreadySent(productName) {
		return
	}
	if sendMessage == nil {
		return
	}
	_ = sendMessage(statusMessage{
		Type: "task-notification",
		Messages: []NotificationMessage{{
			Type:         "product",
			ProductName:  productName,
			ProductImage: productImage,
			ProfileName:  t.Profile.ProfileName,
			GroupID:      t.GroupID,
			TaskID:       t.ID,
		}},
	})
	markProductSent(productName)

}

func (t *BaseTask) SendCheckoutDeclineNoti(productName, productImage string, checkout bool, details ...NotificationDetails) {
	if sendMessage == nil {
		return
	}
	notiType := "declined"
	if checkout {
		notiType = "checkout"
	}
	message := NotificationMessage{
		Type:         notiType,
		ProductName:  productName,
		ProductImage: productImage,
		ProfileName:  t.Profile.ProfileName,
		GroupID:      t.GroupID,
		TaskID:       t.ID,
	}
	if len(details) > 0 {
		detail := details[0]
		message.TaskID = detail.TaskID
		message.SKU = detail.SKU
		message.Price = detail.Price
		message.OrderNumber = detail.OrderNumber
		message.AccountID = detail.AccountID
		message.Source = detail.Source
	}
	_ = sendMessage(statusMessage{
		Type:     "task-notification",
		Messages: []NotificationMessage{message},
	})
	markProductSent(productName)

}

func SendProductTitles(titles map[string]string, missing []string) {
	if sendMessage == nil || (len(titles) == 0 && len(missing) == 0) {
		return
	}
	_ = sendMessage(statusMessage{
		Type: "product-titles",
		Messages: []any{map[string]any{
			"titles":  titles,
			"missing": missing,
		}},
	})
}

// Sleep the task but stop the sleep if the task is stopped or edited.
func (t *BaseTask) SleepTask(delay int) {
	if delay <= 0 {
		return
	}
	if t.TaskContext == nil || t.TaskContext.CTX == nil {
		time.Sleep(time.Duration(delay) * time.Millisecond)
		return
	}
	timer := time.NewTimer(time.Duration(delay) * time.Millisecond)
	defer timer.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-t.TaskContext.CTX.Done():
			return
		case <-timer.C:
			return
		case <-ticker.C:
			if t.HasPendingRuntimeEdit() {
				return
			}
		}
	}
}

func (t *BaseTask) EnsureTLSClient(force bool) error {
	if t == nil {
		return fmt.Errorf("nil task")
	}
	if t.Requests == nil {
		t.Requests = new(BaseRequestsInfo)
		t.Requests.Extras = make(map[string]interface{})
	}
	if !force && t.Requests.Client != nil {
		return nil
	}
	// Settle the old tracker's final bytes before replacing it. Some monitor
	// implementations deliberately rebuild their client between polls.
	if t.Requests.Client != nil {
		t.captureMonitorBandwidth()
	}
	var (
		c   tls_client.HttpClient
		err error
	)
	if t.monitorBandwidthEnabled() {
		c, err = client.CreateNewMonitorTLSClient("")
	} else {
		c, err = client.CreateNewTLSClient("")
	}
	if err != nil {
		return err
	}
	if c == nil {
		return fmt.Errorf("tls client create returned nil")
	}
	t.Requests.Client = c
	return nil
}

func (t *BaseTask) SwapProxy(rotator string) error {
	_ = rotator
	if t.ProxyGroup == "Local" {
		if err := t.EnsureTLSClient(false); err != nil {
			return err
		}
		t.Requests.IPv4 = ""
		// tls-client rebuilds its transport on every SetProxy call. Preserve the
		// direct keep-alive pool when this poll is already using Local.
		if strings.TrimSpace(t.Requests.Client.GetProxy()) == "" {
			return nil
		}
		return t.setHTTPClientProxy("")
	}

	if err := t.EnsureTLSClient(false); err != nil {
		return err
	}

	t.UpdateStatus("Rotating Proxy", constants.Colors.BLUE)

	proxy.RecordProxyResult(t.ID, false)
	proxy.ReleaseProxy(t.ProxyGroup, t.ID)

	var lastErr error
	sources := t.ProxySources
	if len(sources) == 0 && t.ProxyGroup != "" && !strings.EqualFold(t.ProxyGroup, "Local") {
		sources = []string{t.ProxyGroup}
	}
	for attempt := 0; attempt < 5; attempt++ {
		newProxy, err := proxy.GetProxyFrom(sources, t.ID)
		if err != nil {
			log.Printf("[SwapProxy] Failed to get proxy from %v: %v", sources, err)
			lastErr = err
			break
		}

		var proxyUrl string
		if newProxy.Username != "" {
			proxyUrl = "http://" + newProxy.Username + ":" + newProxy.Password + "@" + newProxy.Address + ":" + newProxy.Port
		} else {
			proxyUrl = "http://" + newProxy.Address + ":" + newProxy.Port
		}

		if err := t.setHTTPClientProxy(proxyUrl); err != nil {
			log.Printf("[SwapProxy] Failed to set proxy '%s': %v", proxyUrl, err)
			lastErr = err
			proxy.ReleaseProxy(t.ProxyGroup, t.ID)
			continue
		}

		t.Requests.IPv4 = newProxy.Address
		return nil
	}

	if lastErr == nil {
		lastErr = fmt.Errorf("no proxy assigned for group %q", t.ProxyGroup)
	}
	log.Printf("[SwapProxy] giving up after retries: %v", lastErr)
	return lastErr
}

func (t *BaseTask) SetProxy(proxyStr string) error {
	if err := t.EnsureTLSClient(false); err != nil {
		return err
	}
	if proxyStr == "" {
		t.Requests.IPv4 = ""
		return t.setHTTPClientProxy("")
	}

	t.UpdateStatus("Setting Proxy", constants.Colors.BLUE)

	parts := strings.Split(proxyStr, ":")

	var proxyURL string

	switch len(parts) {
	case 2:
		proxyURL = "http://" + parts[0] + ":" + parts[1]
		t.Requests.IPv4 = parts[0]

	case 4:
		proxyURL = "http://" + parts[2] + ":" + parts[3] + "@" + parts[0] + ":" + parts[1]
		t.Requests.IPv4 = parts[0]

	default:
		return fmt.Errorf("invalid proxy format: %s", proxyStr)
	}

	if err := t.setHTTPClientProxy(proxyURL); err != nil {
		log.Printf("[SetProxy] Failed to set proxy '%s': %v", proxyURL, err)
		return err
	}

	return nil
}

func (t *BaseTask) setHTTPClientProxy(proxyURL string) error {
	// Attribute all bytes already observed to the route that actually carried
	// them, then rebase route attribution after tls-client applies (or rolls
	// back) the requested proxy.
	t.captureMonitorBandwidth()
	err := t.Requests.Client.SetProxy(proxyURL)
	t.captureMonitorBandwidth()
	return err
}

func ShouldRotateProxy(err error) bool {
	if err == nil {
		return false
	}

	errMsg := strings.ToLower(err.Error())

	// Transient request stalls should not burn proxies.
	if strings.Contains(errMsg, "timeout") ||
		strings.Contains(errMsg, "deadline exceeded") ||
		strings.Contains(errMsg, "context canceled") {
		return false
	}

	return strings.Contains(errMsg, "proxy") ||
		strings.Contains(errMsg, "connect") ||
		strings.Contains(errMsg, "connection refused") ||
		strings.Contains(errMsg, "reset by peer") ||
		strings.Contains(errMsg, "tls") ||
		strings.Contains(errMsg, "eof") ||
		strings.Contains(errMsg, "no such host")
}

func (t *BaseTask) MaybeRotateProxy(rotator string, err error) bool {
	if !ShouldRotateProxy(err) {
		return false
	}
	t.SwapProxy(rotator)
	return true
}

func (t *BaseTask) SwapProfile() bool {
	t.UpdateStatus("Rotating Profile", constants.Colors.BLUE)
	group := t.Profile.ProfileGroup
	if group == "" {
		log.Printf("[ID:'%s' - SwapProfile: empty profileGroup on current profile]", t.ID)
		return false
	}

	p, ok, _ := profiles.RotateProfile(t.ProfileId, group, t.Site)
	if !ok {
		log.Printf("[ID:'%s' - SwapProfile: no other profile in group %q]", t.ID, group)
		return false
	}

	t.Profile = ProfileFromStore(p)
	status := fmt.Sprintf("Rotated Profile To: %s", t.Profile.ProfileName)
	t.UpdateStatus(status, constants.Colors.YELLOW)
	t.ProfileId = p.Id
	return true
}

func (t *BaseTask) SwitchProfile() bool {
	t.UpdateStatus("Rotating Profile", constants.Colors.BLUE)
	group := t.Profile.ProfileGroup
	if group == "" {
		log.Printf("[ID:'%s' - SwitchProfile: empty profileGroup on current profile]", t.ID)
		return false
	}

	p, ok := profiles.PickProfile(t.ProfileId, group)
	if !ok {
		log.Printf("[ID:'%s' - SwitchProfile: no other profile in group %q]", t.ID, group)
		return false
	}

	t.Profile = ProfileFromStore(p)
	status := fmt.Sprintf("Rotated Profile To: %s", t.Profile.ProfileName)
	t.UpdateStatus(status, constants.Colors.YELLOW)
	t.ProfileId = p.Id
	return true
}

func (t *BaseRequestsInfo) AddCookie(name, value string, host string) {
	if t == nil || t.Client == nil {
		return
	}
	if name != "reese84" {
		if idx := strings.Index(value, "="); idx != -1 {
			value = value[idx+1:]
		}
		if idx := strings.Index(value, ";"); idx != -1 {
			value = value[:idx]
		}
	}
	cookie := &http.Cookie{
		Name:   name,
		Value:  value,
		Path:   "/",
		Domain: host,
	}

	if value == "deleted" {
		cookie.MaxAge = -1
		cookie.Value = "deleted"
	}

	requestHost := strings.TrimPrefix(strings.TrimSpace(host), ".")
	if requestHost == "" {
		return
	}

	var cookies []*http.Cookie
	cookies = append(cookies, cookie)
	u, _ := url.Parse("https://" + requestHost)
	t.Client.SetCookies(u, cookies)
}
