package walmart

import (
	"context"
	"fmt"
	"strings"
	"time"

	"zynbot.app/engine/antibots/tmx"
	"zynbot.app/engine/bot-base/datadog"
	"zynbot.app/engine/bot-base/imapcode"
	"zynbot.app/engine/bot-base/proxy"
	"zynbot.app/engine/bot-base/safego"
	"zynbot.app/engine/bot-base/task"
	"zynbot.app/engine/bot-base/task/constants"
	monitorhub "zynbot.app/engine/monitor-hub"
)

func (t *WalmartTask) HandleTask() {
	defer catchError(t)
	defer t.cancelEmailCodeWaiter()
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

			case "get-session":
				if t.Account.Username == "" {
					t.StopTask("Module Requires Account", constants.Colors.RED)
					break
				}
				t.UpdateStatus("Getting Session", constants.Colors.BLUE)
				t.GetHomePage()
				if t.HandleErrors("get-session") {
					break
				}
				if proxy.AssignedProxyURL(t.ProxyGroup, t.ID) != "" && !t.SkipPx {
					t.NextStep = "solve-px"
				} else {
					t.NextStep = "get-cart"
				}
			case "solve-px":
				t.UpdateStatus("Solving PX", constants.Colors.BLUE)
				t.SolvePXInit()
				if t.HandleErrors("solve-px") {
					break
				}
				t.PxGenerated = true
				t.NextStep = "get-cart"

			case "get-login-session":
				t.UpdateStatus("Getting Login Page", constants.Colors.BLUE)
				t.GetSignInPage()
				t.GetLoginPage()
				if t.HandleErrors("get-login-session") {
					break
				}
				t.NextStep = "solve-tmx"

			case "solve-tmx":
				t.UpdateStatus("Solving Challenge", constants.Colors.BLUE)
				if t.Requests == nil || t.Requests.Client == nil || t.Requests.UserAgent == nil {
					t.Error = fmt.Errorf("client not initialized")
					if t.HandleErrors("solve-tmx") {
						break
					}
					break
				}
				successful, _ := tmx.SolveTMX(&tmx.TMXConfig{
					SessionID:     t.TMXDeviceID,
					SiteID:        "hgy2n0ks",
					Domain:        "drfdisvc.walmart.com",
					Client:        t.Requests.Client,
					CurrentUrl:    fmt.Sprintf("https://identity.walmart.com/account/login?client_id=5f3fb121-076a-45f6-9587-249f0bc160ff&redirect_uri=https%%3A%%2F%%2Fwww.walmart.com%%2Faccount%%2FverifyToken&scope=openid+email+offline_access&tenant_id=elh9ie&state=%%2F&code_challenge=%s", t.ChallengeCode),
					PrevUrl:       "https://www.walmart.com/account/login",
					UserAgent:     t.Requests.UserAgent.Useragent,
					IPv4:          t.Requests.IPv4,
					InitSuffix:    "921205550",
					SendPortCheck: true,
					SendSig:       true,
				})
				if !successful {
					t.SwapProxy("Walmart")
					t.Error = fmt.Errorf("failed to solve")
				}
				if t.HandleErrors("solve-tmx") {
					break
				}
				t.NextStep = "submit-email"
			case "submit-email":
				t.UpdateStatus("Submitting Email", constants.Colors.BLUE)
				t.SubmitEmail()
				if t.HandleErrors("submit-email") {
					break
				}
				t.NextStep = "get-signin-options"

			case "get-signin-options":
				t.UpdateStatus("Getting Options", constants.Colors.BLUE)
				t.GetSigninOptions()
				if t.HandleErrors("get-signin-options") {
					break
				}
				t.NextStep = "get-otp-module"
			case "get-otp-module":
				t.UpdateStatus("Getting OTP Page", constants.Colors.BLUE)
				t.GetSignInOTPModule()
				if t.HandleErrors("get-password-module") {
					break
				}
				t.NextStep = "request-code"
			case "request-code":
				if err := t.prepareEmailCodeWaiter(); err != nil {
					t.Error = err
					t.UpdateStatus("Code Wait Failed", constants.Colors.RED)
					t.SleepTask(t.ErrorDelay)
					break
				}
				t.UpdateStatus("Requesting 2FA Code", constants.Colors.BLUE)
				t.RequestCode("OTP_EMAIL_SIGN_IN")
				if t.Error != nil {
					t.cancelEmailCodeWaiter()
				}
				if t.HandleErrors("request-code") {
					break
				}
				t.NextStep = "wait-for-code"

			case "wait-for-code":
				t.UpdateStatus("Waiting for 2FA Code", constants.Colors.YELLOW)
				waitCtx, cancel := context.WithTimeout(t.TaskContext.CTX, 15*time.Minute)
				code, err := t.waitForEmailCode(waitCtx)
				cancel()
				if err != nil {
					if isContextCanceledError(t.TaskContext.CTX.Err()) {
						t.Error = err
						break
					}
					t.UpdateStatus("2FA Code Timed Out", constants.Colors.RED)
					t.NextStep = "request-code"
					break
				}
				t.TwoFACode = code
				t.NextStep = "submit-code"

			case "submit-code":
				t.UpdateStatus("Submitting 2FA Code", constants.Colors.BLUE)
				t.SubmitCode("OTP_EMAIL_SIGN_IN")
				if t.HandleErrors("submit-code") {
					break
				}
				if t.NeedsStepUp {
					t.NeedsStepUp = false
					t.NextStep = "submit-password"
				} else {
					t.NextStep = "verify-token"
				}

			case "submit-password":
				t.UpdateStatus("Submitting Password", constants.Colors.BLUE)
				t.SubmitPassword()
				if t.HandleErrors("submit-password") {
					break
				}
				t.NextStep = "verify-token"

			case "get-reset-code":
				if err := t.prepareEmailCodeWaiter(); err != nil {
					t.Error = err
					t.UpdateStatus("Code Wait Failed", constants.Colors.RED)
					t.SleepTask(t.ErrorDelay)
					break
				}
				t.UpdateStatus("Resetting Password (1)", constants.Colors.BLUE)
				t.RequestCode("OTP_EMAIL_RESET")
				if t.Error != nil {
					t.cancelEmailCodeWaiter()
				}
				if t.HandleErrors("get-reset-code") {
					break
				}
				t.NextStep = "wait-reset-code"

			case "wait-reset-code":
				t.UpdateStatus("Waiting for Reset Code", constants.Colors.YELLOW)
				waitCtx, cancel := context.WithTimeout(t.TaskContext.CTX, 15*time.Minute)
				code, err := t.waitForEmailCode(waitCtx)
				cancel()
				if err != nil {
					if isContextCanceledError(t.TaskContext.CTX.Err()) {
						t.Error = err
						break
					}
					t.UpdateStatus("Reset Code Timed Out", constants.Colors.RED)
					t.NextStep = "get-reset-code"
					break
				}
				t.TwoFACode = code
				t.NextStep = "submit-reset-code"

			case "submit-reset-code":
				t.UpdateStatus("Resetting Password (2)", constants.Colors.BLUE)
				t.SubmitCode("OTP_EMAIL_RESET")
				if t.HandleErrors("submit-reset-code") {
					break
				}
				t.NextStep = "reset-password"

			case "reset-password":
				t.UpdateStatus("Resetting Password (3)", constants.Colors.BLUE)
				t.ResetPassword()
				if t.HandleErrors("reset-password") {
					break
				}
				t.NextStep = "verify-token"

			case "verify-token":
				t.UpdateStatus("Verifying Login", constants.Colors.BLUE)
				t.VerifyToken()
				if t.HandleErrors("verify-token") {
					break
				}
				t.SaveSessionCookies()
				t.NextStep = "get-cart"

			case "get-cart":
				t.UpdateStatus("Getting Cart Info", constants.Colors.BLUE)
				t.GetCart()
				if t.HandleErrors("get-cart") {
					break
				}
				if !t.LoggedIn {
					t.NextStep = "get-login-session"
				} else if len(t.CartData.LineItems) > 0 {
					t.NextStep = "clear-cart"
				} else {
					t.NextStep = "get-shipping"
				}

			case "clear-cart":
				t.UpdateStatus("Clearing Cart", constants.Colors.BLUE)
				t.ClearCart()
				if t.HandleErrors("clear-cart") || len(t.CartData.LineItems) > 0 {
					break
				}
				t.NextStep = "get-shipping"

			case "get-shipping":
				t.UpdateStatus("Getting Details", constants.Colors.BLUE)
				t.GetAddresses()
				if t.HandleErrors("get-shipping") {
					break
				}
				for i := range t.SetAddresses {
					if strings.EqualFold(t.SetAddresses[i].AddressLineOne, t.Profile.ShippingAddress1) &&
						strings.EqualFold(t.SetAddresses[i].City, t.Profile.ShippingCity) &&
						strings.EqualFold(t.SetAddresses[i].FirstName, t.Profile.ShippingFirstName) &&
						strings.EqualFold(t.SetAddresses[i].LastName, t.Profile.ShippingLastName) &&
						t.SetAddresses[i].IsDefault {
						t.ShippingAddressID = t.SetAddresses[i].Id
						break
					}
				}
				if t.ShippingAddressID != "" {
					t.NextStep = "get-payments"
				} else {
					t.NextStep = "set-address"
				}

			case "set-address":
				t.UpdateStatus("Setting Address", constants.Colors.BLUE)
				t.SetAddress()
				if t.HandleErrors("set-address") {
					break
				}
				t.NextStep = "get-payments"

			case "get-payments":
				t.UpdateStatus("Getting Payments", constants.Colors.BLUE)
				t.GetPaymentMethods()
				if t.HandleErrors("get-payments") {
					break
				}
				profileLastFour := cardLastFour(t.Profile.CardNumber)
				for i := range t.PaymentCards {
					if strings.EqualFold(t.PaymentCards[i].AddressLineOne, t.Profile.BillingAddress1) &&
						strings.EqualFold(t.PaymentCards[i].City, t.Profile.BillingCity) &&
						strings.EqualFold(t.PaymentCards[i].FirstName, t.Profile.BillingFirstName) &&
						strings.EqualFold(t.PaymentCards[i].LastName, t.Profile.BillingLastName) &&
						t.PaymentCards[i].LastFour == profileLastFour &&
						t.PaymentCards[i].IsDefault {
						t.PaymentID = t.PaymentCards[i].Id
						break
					}
				}
				t.NextStep = "fetch-pie-keys"
			case "fetch-pie-keys":
				t.UpdateStatus("Fetching Card Encryption", constants.Colors.BLUE)
				t.GetPieKeys()
				if t.HandleErrors("fetch-pie-keys") {
					break
				}
				if t.PaymentID == "" {
					t.NextStep = "set-payment"
				} else if t.hasDirectOfferInput() {
					t.NextStep = "add-to-cart"
				} else {
					t.NextStep = "wait-for-restock"
				}
			case "set-payment":
				t.UpdateStatus("Setting Payment", constants.Colors.BLUE)
				if t.SetCardAttempts >= 3 {
					t.StopTask("Max Card Attempts", constants.Colors.RED)
					break
				}
				t.SetCardAttempts++
				t.SetPaymentMethod()
				if t.HandleErrors("set-payment") {
					break
				}
				if t.hasDirectOfferInput() {
					t.NextStep = "add-to-cart"
				} else {
					t.NextStep = "wait-for-restock"
				}
			case "wait-for-restock":
				if t.hasDirectOfferInput() {
					t.NextStep = "add-to-cart"
					break
				}
				t.AddCookiesToQueue()
				t.UpdateStatus("Waiting for Restock/Queue", constants.Colors.BLUE)
				if len(t.matchKeys()) == 0 {
					t.UpdateStatus("No valid product input", constants.Colors.RED)
					t.SleepTask(t.ErrorDelay)
					break
				}

				ping, ok := t.waitForStockPing()
				if !ok {
					break
				}
				if !t.pingWithinPriceRange(ping) {
					break
				}
				t.pingAt = ping.At
				t.UsItemID = ping.ProductKey
				t.OfferID = ping.OfferId
				t.Product.Name = ping.Name
				t.Product.ProductImage = ping.Image
				t.Product.Price = ping.Price
				t.Product.Sku = ping.ProductKey
				t.Product.ProductLink = walmartProductPageURL(ping.ProductKey)
				if ping.Quantity > 0 && t.Quantity > ping.Quantity {
					t.Quantity = ping.Quantity
				}
				t.SendProductNoti(ping.Name, ping.Image)
				statusLine := fmt.Sprintf("Product Found: %s From: %s", ping.Name, ping.From)
				t.UpdateStatus(statusLine, constants.Colors.YELLOW)
				if ping.QueueId != "" {
					t.QueueID = ping.QueueId
					t.NextStep = "join-queue"
				} else {
					t.NextStep = "add-to-cart"
				}

			case "join-queue":
				t.UpdateStatus("Joining Queue", constants.Colors.BLUE)
				go t.MakeInSyncRequest(fmt.Sprintf("https://www.walmart.com/ip/-/%s", t.UsItemID))
				t.IssueTicket()
				if t.HandleErrors("join-queue") {
					break
				}
				t.NextStep = "poll-queue"

			case "poll-queue":
				t.ValidateTicket()
				if t.HandleErrors("poll-queue") {
					break
				}
				if t.QueuePassed {
					datadog.Info("Passed_Queue", map[string]interface{}{"event": "passed_queue", "site": "Walmart", "task_id": t.ID, "name": t.Profile.ProfileName})
					t.NextStep = "add-to-cart"
				} else {
					status, color := queueStatusWithETA(t.ExpectedQueueTime)
					t.UpdateStatus(status, color)
					pollDelay := 5000
					if t.NextQueuePoll > 0 {
						pollDelay = t.NextQueuePoll
					}
					t.SleepTask(pollDelay)
				}

			case "add-to-cart":
				if keys := t.matchKeys(); len(keys) > 0 {
					if ping, ok := monitorhub.Default.Match("Walmart", keys, t.pingAt); ok && ping.QueueId != "" && !t.QueuePassed {
						t.QueueID = ping.QueueId
						t.pingAt = ping.At
						t.NextStep = "join-queue"
						break
					}
				}
				t.UpdateStatus("Adding To Cart", constants.Colors.BLUE)
				go t.MakeInSyncRequest(fmt.Sprintf("https://www.walmart.com/ip/-/%s", t.UsItemID))
				t.AddToCart()
				if t.HandleErrors("add-to-cart") {
					break
				}
				t.TaskState = constants.StatusSteps.Carted
				safego.Go(func() { task.SendCartedEvent(t.RunID) })
				datadog.Info("Carted", map[string]interface{}{"event": "carted", "site": "Walmart", "task_id": t.RunID, "name": t.Profile.ProfileName})
				t.NextStep = "get-cart-checkout"

			case "get-cart-checkout":
				t.UpdateStatus("Preparing Checkout", constants.Colors.BLUE)
				t.GetCartPage()
				go t.MakeInSyncRequest("https://www.walmart.com/cart")
				go t.MakeInSyncRequest(fmt.Sprintf("https://www.walmart.com/checkout/review-order?cartId=%s", t.CartData.Id))
				if t.HandleErrors("get-cart-checkout") {
					break
				}
				t.NextStep = "create-contact"

			case "create-contact":
				t.UpdateStatus("Creating Checkout", constants.Colors.BLUE)
				t.CreateContract()
				if t.HandleErrors("create-contact") {
					break
				}
				t.NextStep = "set-contract-address"

			case "set-contract-address":
				t.UpdateStatus("Setting Address", constants.Colors.BLUE)
				t.SetContractAddress()
				if t.HandleErrors("set-contract-address") {
					break
				}
				t.NextStep = "submit-order"

			case "submit-order":
				t.UpdateStatus("Submitting Order", constants.Colors.BLUE)
				t.SubmitOrder()
				if t.HandleErrors("submit-order") {
					break
				}
				if t.Decline {
					t.NextStep = "decline"
				} else if t.Checkout {
					t.NextStep = "checkout"
				}

			case "solve-hc":
				t.UpdateStatus("Solving HoldCaptcha", constants.Colors.BLUE)
				t.SolvePXHoldCaptcha()
				if t.Error != nil && strings.Contains(strings.ToLower(t.Error.Error()), "px hc failed") {
					t.HoldCaptchaFailCount++
					if t.HoldCaptchaFailCount >= 3 {
						t.UpdateStatus("HoldCaptcha failed, restarting", constants.Colors.RED)
						t.restartTask()
						break
					}
				} else {
					t.HoldCaptchaFailCount = 0
				}
				if t.HandleErrors("solve-hc") {
					break
				}
				t.NextStep = t.StepAfterSolve
				t.StepAfterSolve = ""

			case "get-queue":
				t.UpdateStatus("Getting Queue Info", constants.Colors.BLUE)
				t.GetQueue()
				if t.HandleErrors("get-queue") {
					break
				}
				t.NextStep = "join-queue"
			case "checkout":
				t.TaskState = constants.StatusSteps.CheckedOut
				t.UpdateStatus("Successful", constants.Colors.GREEN)
				if t.Product.Name != "" {
					t.SendCheckoutDeclineNoti(t.Product.Name, t.Product.ProductImage, true)
				}
				task.SendProductWebhook(task.ProductWebhookData{
					Success:          true,
					CheckoutProducts: t.BuildProductWebhookItems(),
					Email:            t.Account.Username,
					Site:             "Walmart",
					ProfileName:      t.Profile.ProfileName,
					Proxy:            proxy.AssignedProxyURL(t.ProxyGroup, t.ID),
					ProxyGroup:       t.ProxyGroup,
					OrderNumber:      t.OrderNumber,
					TaskID:           t.RunID,
					GrandTotal:       t.GrandTotal,
				})

				t.NextStep = "stop"

			case "decline":
				t.OrderNumber = "9999999999"
				t.TaskState = constants.StatusSteps.Declined
				t.UpdateStatus("Payment Declined", constants.Colors.RED)
				if t.Product.Name != "" {
					t.SendCheckoutDeclineNoti(t.Product.Name, t.Product.ProductImage, false)
				}
				task.SendProductWebhook(task.ProductWebhookData{
					Success:          false,
					CheckoutProducts: t.BuildProductWebhookItems(),
					Email:            t.Account.Username,
					Site:             "Walmart",
					ProfileName:      t.Profile.ProfileName,
					ProxyGroup:       t.ProxyGroup,
					OrderNumber:      t.OrderNumber,
					TaskID:           t.RunID,
					GrandTotal:       t.GrandTotal,
				})
				t.NextStep = "stop"
			}
		}
	}
}

func (t *WalmartTask) prepareEmailCodeWaiter() error {
	t.cancelEmailCodeWaiter()
	waiter, err := imapcode.PrepareWait(t.Account.Username)
	if err != nil {
		return err
	}
	t.emailCodeWaiter = waiter
	waiter.Arm()
	return nil
}

func (t *WalmartTask) cancelEmailCodeWaiter() {
	if t.emailCodeWaiter == nil {
		return
	}
	t.emailCodeWaiter.Cancel()
	t.emailCodeWaiter = nil
}

func (t *WalmartTask) waitForEmailCode(ctx context.Context) (string, error) {
	if t.emailCodeWaiter == nil {
		return "", fmt.Errorf("imapcode: wait not prepared")
	}
	waiter := t.emailCodeWaiter
	code, err := waiter.Wait(ctx)
	t.emailCodeWaiter = nil
	return code, err
}
