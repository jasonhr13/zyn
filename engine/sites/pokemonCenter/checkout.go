package pokemoncenter

import (
	"fmt"
	"net/url"
	"strings"
	"time"

	"zynbot.app/engine/bot-base/captcha"
	"zynbot.app/engine/bot-base/profiles"
	"zynbot.app/engine/bot-base/proxy"
	"zynbot.app/engine/bot-base/task"
	"zynbot.app/engine/bot-base/task/constants"
	"zynbot.app/engine/client"
	monitorhub "zynbot.app/engine/monitor-hub"
)

// handleTask handles the task requests
func (t *PokemonCenterTask) HandleTask() {
	defer catchError(t)
	for {
		select {
		case <-t.TaskContext.CTX.Done():
			return
		default:
			t.Error = nil
			t.DrainPendingRuntimeEdits(func(p task.RuntimeEditPayload) {
				t.applyRuntimeEdit(p)
			})
			switch t.NextStep {
			case "stop":
				if t.Checkout {
					t.StopTask("Successful", constants.Colors.GREEN)
				} else if t.Decline {
					t.StopTask("Payment Declined", constants.Colors.RED)
				} else {
					t.StopTask("Idle", constants.Colors.DEFAULT)
				}
			case "check-status":
				t.UpdateStatus("Checking status", constants.Colors.BLUE)
				t.CheckStatus()
				if t.HandleErrors("check-queue-server") {
					break
				}
				if t.FoundQueue {
					t.NextStep = "get-homepage"
				} else if t.WaitForQueue {
					t.NextStep = "wait-for-queue"
				} else if t.Unlocked {
					t.NextStep = "get-homepage"
				} else {
					t.NextStep = "wait-for-unlock"
				}

			case "wait-for-unlock":
				t.UpdateStatus("Waiting For Unlock", constants.Colors.YELLOW)
				if t.awaitUnlock() {
					return
				}

			case "wait-for-queue":
				t.UpdateStatus("Waiting For Queue", constants.Colors.YELLOW)
				if t.awaitQueue() {
					return
				}

			case "get-homepage":
				t.UpdateStatus("Getting Session", constants.Colors.BLUE)
				t.GetHomepage()
				if t.HandleErrors("get-homepage") {
					break
				}
				if t.DynamicIncapSolving && !t.DynamicIncapSolved {
					t.StepAfterSolve = "get-homepage"
					t.NextStep = "get-incap"
					break
				}
				if t.DynamicIncapSolved {
					t.DynamicIncapSolved = false
					t.DynamicIncapSolving = false
				}
				if t.InterBlockOnHome {
					t.InterBlockOnHome = false
				}
				if t.ReeseSolved || t.hasReese84Cookie() {
					t.ReeseSolved = true
					t.StepAfterSolve = "get-cart"
					t.NextStep = "solve-datadome-ch"
					break
				}

				t.StepAfterSolve = "solve-datadome-ch"
				t.NextStep = "get-incap"

			case "get-incap":
				t.UpdateStatus("Solving Incapsula (1)", constants.Colors.BLUE)
				t.GetIncapScript()
				if t.HandleErrors("get-incap") {
					break
				}
				t.NextStep = "get-ip"

			case "get-ip":
				t.UpdateStatus("Getting IP Info", constants.Colors.BLUE)
				t.GetIpInfo()
				if t.HandleErrors("get-ip") {
					break
				}
				if t.StepAfterIP != "" {
					t.NextStep = t.StepAfterIP
					t.StepAfterIP = ""
				} else {
					t.NextStep = "get-incap-sensor"
				}

			case "get-incap-sensor":
				t.UpdateStatus("Solving Incapsula (2)", constants.Colors.BLUE)
				t.GetIncapSensor()
				if t.HandleErrors("get-incap-sensor") {
					break
				}
				t.NextStep = "post-reese84"

			case "post-reese84":
				t.UpdateStatus("Solving Incapsula (3)", constants.Colors.BLUE)
				t.PostReese84()
				if t.HandleErrors("post-reese84") {
					break
				}
				t.RenewIncapHanlder()
				if t.DynamicIncapSolving {
					t.DynamicIncapSolved = true
					t.NextStep = "get-homepage"
				} else {
					t.NextStep = t.StepAfterSolve
					t.StepAfterSolve = "get-cart"
				}

			case "solve-datadome-ch":
				if t.requireIP("solve-datadome-ch") {
					break
				}
				t.UpdateStatus("Solving Datadome (1)", constants.Colors.BLUE)
				t.GetTagsSensor("ch")
				if t.HandleErrors("solve-datadome-ch") {
					break
				}
				t.NextStep = "post-datadome-ch"

			case "post-datadome-ch":
				t.UpdateStatus("Solving Datadome (2)", constants.Colors.BLUE)
				t.PostDatadomeTags()
				if t.HandleErrors("post-datadome-ch") {
					break
				}
				t.NextStep = "solve-datadome-le"

			case "solve-datadome-le":
				t.UpdateStatus("Solving Datadome (3)", constants.Colors.BLUE)
				t.GetTagsSensor("le")
				if t.HandleErrors("solve-datadome-le") {
					break
				}
				t.NextStep = "post-datadome-le"

			case "post-datadome-le":
				t.UpdateStatus("Solving Datadome (4)", constants.Colors.BLUE)
				t.PostDatadomeTags()
				if t.HandleErrors("post-datadome-le") {
					break
				}
				t.TagsSolved = true
				if t.StepAfterSolve != "" {
					t.NextStep = t.StepAfterSolve
				} else {
					t.NextStep = "get-cart"
				}

			case "get-cart":
				t.UpdateStatus("Getting Cart", constants.Colors.BLUE)
				t.GetCart()
				if t.HandleErrors("get-cart") {
					break
				}
				t.NextStep = "get-product"

			case "get-releases":
				t.UpdateStatus("Getting Releases", constants.Colors.BLUE)
				t.GetReleases()
				if t.HandleErrors("get-releases") {
					break
				}
				t.NextStep = "get-product"

			case "get-product":
				if len(t.Inputs) > 0 && strings.EqualFold(strings.ToLower(t.Inputs[0].Input), "placeholder") {
					t.UpdateStatus("Waiting for Input", constants.Colors.BLUE)
					t.SleepTask(100)
					break
				}

				for i := range t.Inputs {
					t.Inputs[i].Found = false
				}
				if t.LoopCheckout {
					t.Products = []Product{}
				}

				for i := 0; i < len(t.Inputs); {

					if t.Inputs[i].Found {
						i++
						continue
					}
					status := "Getting Product"
					if i > 0 {
						status = fmt.Sprintf("Getting Product %d", i+1)
					}

					t.UpdateStatus(status, constants.Colors.BLUE)

					productsBefore := len(t.Products)
					t.GetProduct(t.Inputs[i])

					breakLoop, retrySame := t.HandleMultiCartError("get-product")

					if breakLoop {
						break
					}

					if retrySame {
						continue // retry SAME item
					}

					if t.Error != nil && t.Error.Error() == "product not found" {
						t.Error = nil
					}

					// Mark Found only if this input actually appended a product.
					if t.Error == nil && len(t.Products) > productsBefore {
						t.Inputs[i].Found = true
					}

					i++ // move to next input
				}
				if len(t.Products) > 0 && !t.AllInstock {
					t.UpdateInputValue(t.Products[0].ProductName, "Default")
					t.SendProductNoti(t.Products[0].ProductName, t.Products[0].ProductImage)
					t.NextStep = "add-to-cart"
					break
				}

				if t.AllInstock && len(t.Products) == len(t.Inputs) {
					t.NextStep = "add-to-cart"
					break
				}

				if t.HandleErrors("get-product") {
					break
				}

				t.UpdateStatus("Waiting for Product", constants.Colors.BLUE)
				t.SleepTask(t.MonitorDelay)

			case "get-availability":

				for i := 0; i < len(t.Products); {

					statusText := "Getting Availability"
					if i > 0 {
						statusText = fmt.Sprintf("Getting Availability %d", i+1)
					}

					t.UpdateStatus(statusText, constants.Colors.BLUE)

					t.GetAvailability(t.Products[i])

					breakLoop, retrySame := t.HandleMultiCartError("get-availability")

					if breakLoop {
						break
					}

					if retrySame {
						continue // retry same item
					}

					i++
				}

				atleastOneInStock := false
				allInstock := true
				for i := range t.Products {
					if t.Products[i].Available {
						atleastOneInStock = true
						break
					} else {
						allInstock = false
					}
				}

				if atleastOneInStock && !t.AllInstock {
					t.NextStep = "add-to-cart"
					break
				}

				if t.AllInstock && allInstock {
					t.NextStep = "add-to-cart"
					break
				}

				if t.HandleErrors("get-availability") {
					break
				}

				t.UpdateStatus("Waiting for Product", constants.Colors.BLUE)
				t.SleepTask(t.MonitorDelay)

			case "add-to-cart":

				for i := 0; i < len(t.Products); {

					statusText := "Adding To Cart"
					if i > 0 {
						statusText = fmt.Sprintf("Adding To Cart %d", i+1)
					}

					t.UpdateStatus(statusText, constants.Colors.BLUE)

					t.AddToCart(t.Products[i])
					if t.Error != nil {
						errorTxt := t.Error.Error()
						if errorTxt == "out of stock" {
							t.Error = nil
							i++
							continue
						}

						breakLoop, retrySame := t.HandleMultiCartError("add-to-cart")

						if breakLoop {
							break
						}

						if retrySame {
							continue // retry same item
						}
						break
					}
					t.Products[i].Carted = true
					i++
				}

				atleastOneCarted := false
				allCarted := true
				for i := range t.Products {
					if t.Products[i].Carted {
						atleastOneCarted = true
					} else {
						allCarted = false
					}
				}

				if atleastOneCarted && !t.AllInstock {
					t.TaskState = constants.StatusSteps.Carted
					task.SendCartedAnalytics(task.ProductWebhookData{
						CheckoutProducts: t.BuildProductWebhookItems(), Site: t.Site,
						Email: t.Profile.Email, ProfileName: t.Profile.ProfileName, ProxyGroup: t.ProxyGroup,
						TaskID: t.RunID, ClientTaskID: t.ID, RunID: t.RunID,
					})
					task.Telemetry(task.TaskTelemetryEvent{Event: task.TelemetryCarted, Site: t.Site, Step: "add-to-cart", TaskID: t.ID, RunID: t.RunID})
					t.NextStep = "submit-email"
					break
				}

				if t.AllInstock && allCarted {
					t.TaskState = constants.StatusSteps.Carted
					task.SendCartedAnalytics(task.ProductWebhookData{
						CheckoutProducts: t.BuildProductWebhookItems(), Site: t.Site,
						Email: t.Profile.Email, ProfileName: t.Profile.ProfileName, ProxyGroup: t.ProxyGroup,
						TaskID: t.RunID, ClientTaskID: t.ID, RunID: t.RunID,
					})
					task.Telemetry(task.TaskTelemetryEvent{Event: task.TelemetryCarted, Site: t.Site, Step: "add-to-cart", TaskID: t.ID, RunID: t.RunID})
					t.NextStep = "submit-email"
					break
				}

				if t.HandleErrors("add-to-cart") {
					break
				}

				t.UpdateStatus("Out Of Stock", constants.Colors.RED)
				t.SleepTask(t.MonitorDelay)

			case "submit-email":
				if t.LoopCheckout && profiles.IsProfileUsed(t.Site, t.Profile.ProfileGroup, t.ProfileId) {
					t.BaseTask.SwapProfile()
				}
				t.UpdateStatus("Submitting Email", constants.Colors.BLUE)
				t.SubmitEmail()
				if t.HandleErrors("submit-email") {
					break
				}
				t.NextStep = "submit-shipping"

			case "submit-shipping":
				t.UpdateStatus("Submitting Shipping", constants.Colors.BLUE)
				t.SubmitShipping()
				if t.HandleErrors("submit-shipping") {
					break
				}
				t.NextStep = "get-payment-key"

			case "get-payment-key":
				t.UpdateStatus("Getting Payment Key", constants.Colors.BLUE)
				t.GetPaymentKey()
				if t.HandleErrors("get-payment-key") {
					break
				}
				t.NextStep = "submit-payment"

			case "submit-payment":
				t.UpdateStatus("Submitting Payment", constants.Colors.BLUE)
				t.SubmitPayment()
				if t.HandleErrors("submit-payment") {
					break
				}
				t.NextStep = "submit-order"

			case "submit-order":
				t.UpdateStatus("Submitting Order", constants.Colors.YELLOW)
				t.SubmitOrder()
				if t.HandleErrors("submit-order") {
					break
				}
				if t.Checkout {
					t.NextStep = "success"
				} else if t.Decline {
					t.NextStep = "declined"
				}

			case "success":
				t.TaskState = constants.StatusSteps.CheckedOut
				t.UpdateStatus("Successful", constants.Colors.GREEN)
				for i := range t.Products {
					if t.Products[i].Carted {
						t.SendCheckoutDeclineNoti(t.Products[i].ProductName, t.Products[i].ProductImage, true)
						break
					}
				}
				task.SendProductWebhook(task.ProductWebhookData{
					Success:          true,
					CheckoutProducts: t.BuildProductWebhookItems(),
					Email:            t.Profile.Email,
					Site:             t.Site,
					ProfileName:      t.Profile.ProfileName,
					Proxy:            proxy.AssignedProxyURL(t.ProxyGroup, t.ID),
					ProxyGroup:       t.ProxyGroup,
					OrderNumber:      t.OrderNumber,
					OrderLink:        fmt.Sprintf("https://www.pokemoncenter.com/orders/%s?postalCode=%s", t.OrderNumber, t.Profile.ShippingZip),
					TaskID:           t.RunID,
					ClientTaskID:     t.ID,
					RunID:            t.RunID,
				})
				if t.LoopCheckout {
					profiles.MarkProfileUsed(t.Site, t.Profile.ProfileGroup, t.ProfileId)
					t.BaseTask.SwapProfile()
					t.TaskState = constants.StatusSteps.Running
					t.Products = []Product{}
					t.NextStep = "get-product"
					t.DeclineReason = ""
					t.Checkout = false
					t.OrderNumber = ""
				} else {
					t.NextStep = "stop"
				}
			case "declined":
				t.OrderNumber = "9999999999"
				t.TaskState = constants.StatusSteps.Declined
				t.UpdateStatus("Payment Declined", constants.Colors.RED)
				for i := range t.Products {
					if t.Products[i].Carted {
						t.SendCheckoutDeclineNoti(t.Products[i].ProductName, t.Products[i].ProductImage, false)
						break
					}
				}
				task.SendProductWebhook(task.ProductWebhookData{
					Success:          false,
					CheckoutProducts: t.BuildProductWebhookItems(),
					Email:            t.Profile.Email,
					Site:             t.Site,
					ProfileName:      t.Profile.ProfileName,
					ProxyGroup:       t.ProxyGroup,
					Proxy:            proxy.AssignedProxyURL(t.ProxyGroup, t.ID),
					OrderNumber:      t.OrderNumber,
					TaskID:           t.RunID,
					ClientTaskID:     t.ID,
					RunID:            t.RunID,
					DeclineReason:    t.DeclineReason,
				})
				if t.LoopCheckout {
					profiles.MarkProfileUsed(t.Site, t.Profile.ProfileGroup, t.ProfileId)
					t.SleepTask(t.ErrorDelay)
					t.BaseTask.SwapProfile()
					t.TaskState = constants.StatusSteps.Running
					t.Products = []Product{}
					t.NextStep = "get-product"
					t.DeclineReason = ""
					t.Checkout = false
					t.OrderNumber = ""
					t.NextStep = "submit-email"
				} else {
					t.NextStep = "stop"
				}

			case "get-interstitial":
				t.UpdateStatus("Solving Challenge (1)", constants.Colors.BLUE)
				t.GetDatadomeScript()
				if t.HandleErrors("get-interstitial") {
					break
				}
				if t.requireIP("solve-interstitial") {
					break
				}
				t.NextStep = "solve-interstitial"

			case "solve-interstitial":
				t.UpdateStatus("Solving Challenge (2)", constants.Colors.BLUE)
				t.GetInterstitialSensor()
				if t.HandleErrors("solve-interstitial") {
					break
				}
				t.NextStep = "post-interstitial"

			case "post-interstitial":
				t.UpdateStatus("Solving Challenge (3)", constants.Colors.BLUE)
				t.PostInterstitial()
				if t.HandleErrors("post-interstitial") {
					break
				}
				t.NextStep = t.StepAfterSolve

			case "get-captcha":
				//handle isIpBanned rotate and remove cookie and go back and resolve dd
				parsedUrl, err := url.Parse(t.DatadomeUrl)
				if (err == nil && parsedUrl.Query().Get("t") == "bv") || t.DDHardBlocked {
					t.NextStep = "dd-hardblock"
					break
				}

				t.UpdateStatus("Solving Slider (1)", constants.Colors.BLUE)
				t.GetDatadomeScript()
				if t.HandleErrors("get-captcha") {
					break
				}
				t.NextStep = "get-puzzle"

			case "get-puzzle":
				t.UpdateStatus("Solving Slider (2)", constants.Colors.BLUE)
				t.GetDatadomeScript()
				if t.HandleErrors("get-puzzle") {
					break
				}
				t.NextStep = "get-peice"

			case "get-peice":
				t.UpdateStatus("Solving Slider (3)", constants.Colors.BLUE)
				t.GetDatadomeScript()
				if t.Error != nil {
					errText := t.Error.Error()
					errTitle := strings.Title(errText)
					if strings.Contains(errTitle, "No Connection") {
						t.BaseTask.SwapProxy("PokemonCenter")
					} else {
						if !strings.Contains(errTitle, "Context Canceled") {
							t.UpdateStatus(errTitle, constants.Colors.RED)
							t.SleepTask(t.ErrorDelay)
						}
					}
				} else {
					t.NextStep = "get-captcha-sensor"
				}

			case "get-captcha-sensor":
				t.UpdateStatus("Solving Slider (4)", constants.Colors.BLUE)
				t.GetSliderSensor()
				if t.HandleErrors("get-captcha-sensor") {
					break
				}
				t.NextStep = "post-captcha-sensor"

			case "post-captcha-sensor":
				t.UpdateStatus("Solving Slider (5)", constants.Colors.BLUE)
				t.GetSlider()
				if t.HandleErrors("post-captcha-sensor") {
					break
				}
				t.NextStep = t.StepAfterSolve

			case "get-incap-challenge":
				t.UpdateStatus("Solving Incapsula", constants.Colors.BLUE)
				t.GetIncapChallenge()
				if t.HandleErrors("get-incap-challenge") {
					break
				}
				switch t.ChallengeType {
				case "captcha":
					t.FoundQueue = true
					t.NextStep = "solve-hcaptcha"
				case "waiting_room":
					t.FoundQueue = true
					t.PassedQueue = false
					t.InQueue = false
					t.QueueTime = nil
					t.NextStep = "handle-queue"
				case "utmvc":
					t.NextStep = "solve-utmvc"
				default:
					t.Error = fmt.Errorf("unknown incap challenge (%s)", t.ChallengeType)
				}
				if t.HandleErrors("get-incap-challenge") {
					break
				}

			case "handle-queue":
				if t.QueueTime == nil {
					t.UpdateStatus("In Queue", constants.Colors.BLUE)
				}
				t.CheckQueue()
				if t.HandleErrors("handle-queue") {
					break
				}
				if t.PassedQueue {
					task.Telemetry(task.TaskTelemetryEvent{Event: task.TelemetryPassedQueue, Site: t.Site, Step: "poll-queue", TaskID: t.ID, RunID: t.RunID})
					t.NextStep = t.StepAfterSolve
				} else {
					t.InQueue = true
					queueMins := 0
					if t.QueueTime != nil {
						queueMins = *t.QueueTime
					}
					t.UpdateStatus(fmt.Sprintf("In Queue (%dm)", queueMins), constants.Colors.YELLOW)
					t.SleepTask(3000)
				}

			case "solve-hcaptcha":
				t.UpdateStatus("Waiting For Captcha", constants.Colors.BLUE)
				token, err := captcha.SolveCaptcha(t.TaskContext.CTX, captcha.CaptchaSolve{
					TaskID:      t.ID,
					GroupID:     t.GroupID,
					SiteKey:     "dd6e16a7-972e-47d2-93d0-96642fb6d8de",
					SiteURL:     "https://www.pokemoncenter.com/",
					CaptchaType: "hcaptcha-PokemonCenter",
					Proxy:       proxy.AssignedProxyURL(t.ProxyGroup, t.ID),
				})
				if err != nil {
					t.Error = err
					t.SleepTask(t.ErrorDelay)
					break
				}
				t.HcapToken = token
				t.NextStep = "post-incap-captcha"

			case "post-incap-captcha":
				t.UpdateStatus("Submitting Captcha", constants.Colors.BLUE)
				t.PostIncapCaptcha()
				if t.HandleErrors("get-incap-challenge") {
					break
				}
				t.PassedQueue = false
				t.InQueue = false
				t.QueueTime = nil
				t.NextStep = t.StepAfterSolve

			case "solve-utmvc":
				t.UpdateStatus("Solving UTMVC (1)", constants.Colors.BLUE)
				t.GetUTMVCSensor()
				if t.Error != nil {
					errText := t.Error.Error()
					errTitle := strings.Title(errText)
					if strings.Contains(errTitle, "No Connection") {
						t.BaseTask.SwapProxy("PokemonCenter")
					}
					if !strings.Contains(errTitle, "Context Canceled") {
						t.UpdateStatus(errTitle, constants.Colors.RED)
						t.SleepTask(t.ErrorDelay)
					}
				} else {
					t.NextStep = "get-utmvc"
				}
			case "get-utmvc":
				t.UpdateStatus("Solving UTMVC (2)", constants.Colors.BLUE)
				t.GetUTMVC()
				if t.HandleErrors("get-incap-challenge") {
					break
				}
				t.NextStep = t.StepAfterSolve

			case "dd-hardblock":
				if t.DDHardBlockCount == 5 {
					t.NextStep = "restart"
					break
				} else {
					t.DDHardBlockCount = t.DDHardBlockCount + 1
				}
				t.UpdateStatus("Datadome Block", constants.Colors.RED)
				t.SleepTask(t.ErrorDelay)
				t.BaseTask.SwapProxy("PokemonCenter")
				t.Requests.AddCookie("datadome", "deleted", "www.pokemoncenter.com")
				t.NextStep = "solve-datadome-ch"
				t.StepAfterSolve = t.LastStep

			case "incap-hardblock":
				t.UpdateStatus("Incap Block", constants.Colors.RED)
				t.SleepTask(t.ErrorDelay)
				t.NextStep = "restart"

			case "restart":
				t.TaskState = constants.StatusSteps.Running
				t.BaseTask.SwapProxy("PokemonCenter")
				t.Requests.Client, _ = client.CreateNewTLSClient("")
				t.resetSessionState()
				t.NextStep = "get-homepage"
			}
		}
	}
}

func (t *PokemonCenterTask) awaitQueue() bool {
	t.UpdateStatus("Waiting For Queue", constants.Colors.YELLOW)
	ensureStatusWatcher()
	lastHealthState := ""
	lastHealthLog := time.Time{}
	logWatcherHealth := func(force bool) {
		health := getStatusWatcherHealth()
		state := "connecting"
		message := "[queue-monitor] HTTPS polling active (every 3s); waiting for the first response"
		if health.Failed {
			state = "failed"
			message = fmt.Sprintf("[queue-monitor] HTTPS status poll failed at %s; retrying every 3s", health.LastAttempt.Format("15:04:05"))
		} else if !health.LastSuccess.IsZero() {
			state = "healthy"
			message = fmt.Sprintf("[queue-monitor] HTTPS poll healthy at %s (queue=%t, unlocked=%t)",
				health.LastSuccess.Format("15:04:05"), health.QueueUp, health.Unlocked)
		}
		if !force && state == lastHealthState && time.Since(lastHealthLog) < 30*time.Second {
			return
		}
		t.AddLog(message)
		lastHealthState = state
		lastHealthLog = time.Now()
	}
	logWatcherHealth(true)
	queueKeys := []string{"queue"}
	since := time.Now()
	matches := func(ping monitorhub.StockPing) bool {
		return strings.EqualFold(ping.Site, "PokemonCenter") &&
			ping.ProductKey == "queue" &&
			ping.At.After(since)
	}
	enterQueue := func() {
		t.AddLog("[queue-monitor] queue or site protection detected; entering the queue flow")
		t.FoundQueue = true
		t.NextStep = "get-homepage"
		if t.QueueEntryDelay != 0 {
			status := fmt.Sprintf("Waiting (%d ms) to Enter Queue", t.QueueEntryDelay)
			t.UpdateStatus(status, constants.Colors.BLUE)
			t.SleepTask(t.QueueEntryDelay)
		}
	}
	sub := monitorhub.Default.Subscribe()
	defer sub.Close()
	poll := time.NewTicker(2 * time.Second)
	defer poll.Stop()
	for t.NextStep == "wait-for-queue" {
		t.DrainPendingRuntimeEdits(func(p task.RuntimeEditPayload) {
			t.applyRuntimeEdit(p)
		})
		if !t.WaitForQueue {
			t.NextStep = "check-status"
			return false
		}
		if ping, ok := monitorhub.Default.Match("PokemonCenter", queueKeys, since); ok && matches(ping) {
			enterQueue()
			return false
		}
		select {
		case ping := <-sub.C:
			if matches(ping) {
				enterQueue()
				return false
			}
		case <-poll.C:
			// Wake periodically so runtime edits (including disabling Wait For Queue) are applied.
			logWatcherHealth(false)
		case <-t.TaskContext.CTX.Done():
			return true
		}
	}
	return false
}
func (t *PokemonCenterTask) awaitUnlock() bool {
	ensureStatusWatcher()
	unlockKeys := []string{unlockProductKey}
	since := time.Now()
	matches := func(ping monitorhub.StockPing) bool {
		return strings.EqualFold(ping.Site, "PokemonCenter") &&
			ping.ProductKey == unlockProductKey &&
			ping.At.After(since)
	}
	sub := monitorhub.Default.Subscribe()
	defer sub.Close()
	poll := time.NewTicker(2 * time.Second)
	defer poll.Stop()
	for t.NextStep == "wait-for-unlock" {
		t.DrainPendingRuntimeEdits(func(p task.RuntimeEditPayload) {
			t.applyRuntimeEdit(p)
		})
		if ping, ok := monitorhub.Default.Match("PokemonCenter", unlockKeys, since); ok && matches(ping) {
			t.Unlocked = true
			t.NextStep = "check-status"
			return false
		}
		select {
		case ping := <-sub.C:
			if matches(ping) {
				t.Unlocked = true
				t.NextStep = "check-status"
				return false
			}
		case <-poll.C:
		case <-t.TaskContext.CTX.Done():
			return true
		}
	}
	return false
}
