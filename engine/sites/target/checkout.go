package target

import (
	"context"
	"fmt"
	"runtime"
	"strconv"
	"strings"
	"time"

	"zynbot.app/engine/antibots/tmx"
	"zynbot.app/engine/bot-base/datadog"
	"zynbot.app/engine/bot-base/imapcode"
	"zynbot.app/engine/bot-base/proxy"
	"zynbot.app/engine/bot-base/safego"
	"zynbot.app/engine/bot-base/task"
	"zynbot.app/engine/bot-base/task/constants"
)

var FillerItem = "84704409"

// checkoutProxy is the line that actually carted / submitted: the Shape
// cookie's harvest proxy. The task-group assignment is only a fallback when
// the cookie did not carry one (local harvest, empty proxy field).
func (t *TargetTask) checkoutProxy() string {
	if t == nil {
		return ""
	}
	if p := strings.TrimSpace(t.ShapeProxy); p != "" {
		return p
	}
	if t.BaseTask != nil && t.Requests != nil && t.Requests.Client != nil {
		if p := strings.TrimSpace(t.Requests.Client.GetProxy()); p != "" {
			return p
		}
	}
	if t.BaseTask == nil {
		return ""
	}
	return proxy.AssignedProxyURL(t.ProxyGroup, t.ID)
}

func (t *TargetTask) HandleTask() {
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
			t.applyWatchListSelectionChange()
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
				if t.Account.Username == "" || t.Account.Password == "" {
					t.StopTask("Module Requires Account", constants.Colors.RED)
					return
				}
				t.UpdateStatus("Getting Session", constants.Colors.BLUE)
				t.GetSession()
				if t.HandleErrors("get-session") {
					break
				}
				if t.Account.Cookie != "" {
					t.NextStep = "refresh-login"
				} else {
					t.NextStep = "get-login-session"
				}

			case "get-login-session":
				t.UpdateStatus("Logging In (1)", constants.Colors.BLUE)
				t.GetLoginSession()
				if t.HandleErrors("get-login-session") {
					break
				}
				if t.UseOtpLogin {
					t.StepAfterSolve = "otp-login"
				} else {
					t.StepAfterSolve = "login"
				}
				t.NextStep = "get-shape"

			case "get-shape":
				if t.StepAfterSolve == "add-to-cart" && t.maybeBailRestock() {
					break
				}
				t.UpdateStatus("Waiting For Shape", constants.Colors.YELLOW)
				t.GetShape(t.shapeCookieType())
				if t.HandleErrors("get-shape") {
					break
				}
				if t.shapeOK() {
					if t.StepAfterSolve != "" {
						t.NextStep = t.StepAfterSolve
					}
					break
				}
				t.ShapeHeaders = ShapeHeaders{}
				t.ShapeMethod = ""
				t.SleepTask(300)

			case "login":
				if !t.shapeOK() {
					t.StepAfterSolve = "login"
					t.NextStep = "get-shape"
					break
				}
				t.SetProxy(t.ShapeProxy)
				t.UpdateStatus("Logging In (3)", constants.Colors.BLUE)
				t.Login()
				if t.HandleErrors("login") {
					if t.NextStep != "get-shape" && t.NextStep != "reset-password" {
						t.StepAfterSolve = "login"
						t.NextStep = "get-shape"
					}
					break
				}
				t.NextStep = "get-auth-codes"

			case "otp-login":
				if !t.shapeOK() {
					t.StepAfterSolve = "otp-login"
					t.NextStep = "get-shape"
					break
				}
				t.SetProxy(t.ShapeProxy)
				if err := t.prepareEmailCodeWaiter(); err != nil {
					t.Error = err
					t.UpdateStatus("Code Wait Failed", constants.Colors.RED)
					t.SleepTask(t.ErrorDelay)
					break
				}
				t.UpdateStatus("Logging In Via OTP", constants.Colors.BLUE)
				t.LoginOTP()
				if t.Error != nil {
					t.cancelEmailCodeWaiter()
				}
				if t.HandleErrors("login") {
					if t.NextStep != "get-shape" {
						t.StepAfterSolve = "otp-login"
						t.NextStep = "get-shape"
					}
					break
				}
				t.NextStep = "get-code"

			case "request-code":
				if !t.shapeOK() {
					t.StepAfterSolve = "request-code"
					t.NextStep = "get-shape"
					break
				}
				t.UpdateStatus("Requesting Login Code", constants.Colors.BLUE)
				t.SetProxy(t.ShapeProxy)
				if err := t.prepareEmailCodeWaiter(); err != nil {
					t.Error = err
					t.UpdateStatus("Code Wait Failed", constants.Colors.RED)
					t.SleepTask(t.ErrorDelay)
					break
				}
				t.Get2faCode()
				if err := t.Error; err != nil {
					t.cancelEmailCodeWaiter()
					errText := strings.ToLower(err.Error())
					t.HandleErrors("request-code")
					if strings.Contains(errText, "shape") {
						t.StepAfterSolve = "request-code"
						t.NextStep = "get-shape"
					}
					break
				}
				t.NextStep = "get-code"

			case "get-code":
				t.UpdateStatus("Waiting For Code", constants.Colors.YELLOW)
				waitCtx, cancel := context.WithTimeout(t.TaskContext.CTX, 15*time.Minute)
				code, err := t.waitForEmailCode(waitCtx)
				cancel()
				if err != nil {
					if isContextCanceledError(t.TaskContext.CTX.Err()) {
						t.Error = err
						break
					}
					t.UpdateStatus("Code Timed Out", constants.Colors.RED)
					t.NextStep = "request-code"
					break
				}
				t.TwoFACode = code
				t.StepAfterSolve = "submit-code"
				t.NextStep = "get-shape"

			case "submit-code":
				t.UpdateStatus("Submitting Code", constants.Colors.BLUE)
				t.Submit2faCode()
				if err := t.Error; err != nil {
					errText := strings.ToLower(err.Error())
					t.HandleErrors("submit-code")
					if strings.Contains(errText, "shape") {
						t.StepAfterSolve = "submit-code"
					} else {
						t.StepAfterSolve = "request-code"
					}
					t.NextStep = "get-shape"
					break
				}
				if t.NeedsPasswordReset {
					t.StopTask("Locked Account", constants.Colors.RED)
					break
				}
				t.NextStep = "get-auth-codes"

			// case "set-new-password":
			// 	if !t.shapeOK() {
			// 		t.StepAfterSolve = "set-new-password"
			// 		t.NextStep = "get-shape"
			// 		break
			// 	}
			// 	t.SetProxy(t.ShapeProxy)
			// 	t.UpdateStatus("Setting New Password", constants.Colors.BLUE)
			// 	t.ResetPassword()
			// 	if t.HandleErrors("set-new-password") {
			// 		if t.NextStep != "get-shape" {
			// 			t.StepAfterSolve = "reset-password"
			// 			t.NextStep = "get-shape"
			// 		}
			// 		break
			// 	}
			// 	fmt.Println(t.NewPassword)
			// 	t.Account.Password = t.NewPassword
			// 	safego.Go(func() { t.UpdatePassword(t.NewPassword, t.Account.Id) })
			// 	t.UpdateStatus("Password Reset - Retrying Login", constants.Colors.GREEN)
			// 	t.NextStep = "get-login-session"
			// 	t.UseOtpLogin = false

			// case "validate-token":
			// 	t.UpdateStatus("Validating Token", constants.Colors.BLUE)
			// 	t.ValidateToken()
			// 	if t.HandleErrors("validate-token") {
			// 		break
			// 	}
			// 	t.NextStep = "get-payments"

			case "get-auth-codes":
				t.UpdateStatus("Logging In (4)", constants.Colors.BLUE)
				t.GetAuthCodes()
				if t.HandleErrors("get-auth-codes") {
					break
				}
				t.NextStep = "get-auth-redirect"

			case "get-auth-redirect":
				t.UpdateStatus("Logging In (5)", constants.Colors.BLUE)
				t.GetAuthRedirect()
				if t.HandleErrors("get-auth-redirect") {
					break
				}
				t.NextStep = "get-address-book"

			case "refresh-login":
				t.UpdateStatus("Validating Login", constants.Colors.BLUE)
				t.RefreshLogin()
				if t.HandleErrors("refresh-login") {
					break
				}
				if t.StepAfterSolve != "" {
					t.NextStep = t.StepAfterSolve
					t.StepAfterSolve = ""
				} else {
					t.NextStep = "get-address-book"
				}

			// case "get-payments":
			// 	t.UpdateStatus("Getting Payments", constants.Colors.BLUE)
			// 	t.GetPayments()
			// 	if t.HandleErrors("get-payments") {
			// 		break
			// 	}
			// 	t.NextStep = "clear-payments"
			// case "clear-payments":
			// 	if len(t.AccountPaymentCards) == 0 {
			// 		t.NextStep = "get-address-book"
			// 		break
			// 	}
			// 	t.UpdateStatus("Removing Payment Method", constants.Colors.BLUE)
			// 	t.DeletePaymentCard(t.AccountPaymentCards[0].CardID)
			// 	if t.HandleErrors("clear-payments") {
			// 		break
			// 	}
			// 	t.AccountPaymentCards = t.AccountPaymentCards[1:]

			case "get-address-book":
				t.UpdateStatus("Getting Details", constants.Colors.BLUE)
				t.GetAddresses()
				if t.HandleErrors("get-address-book") {
					break
				}
				t.ShippingAddressID = ""
				for i := range t.AccountAddresses {
					if strings.EqualFold(t.AccountAddresses[i].Address1, t.Profile.ShippingAddress1) &&
						strings.EqualFold(t.AccountAddresses[i].City, t.Profile.ShippingCity) &&
						strings.EqualFold(t.AccountAddresses[i].FirstName, t.Profile.ShippingFirstName) &&
						strings.EqualFold(t.AccountAddresses[i].LastName, t.Profile.ShippingLastName) {
						t.ShippingAddressID = t.AccountAddresses[i].AddressID
						break
					}
				}
				if t.ShippingAddressID == "" {
					t.NextStep = "set-address"
					break
				}
				t.NextStep = "preload-atc"

			case "set-address":
				t.UpdateStatus("Setting Details", constants.Colors.BLUE)
				t.SetAddress()
				if t.HandleErrors("set-address") {
					break
				}
				t.NextStep = "get-address-book"

			// case "clear-addresses":
			// 	extraIndex := -1
			// 	for i := range t.AccountAddresses {
			// 		if t.AccountAddresses[i].AddressID != t.ShippingAddressID {
			// 			extraIndex = i
			// 			break
			// 		}
			// 	}
			// 	if extraIndex == -1 {
			// 		t.NextStep = "get-cart-info"
			// 		break
			// 	}
			// 	t.UpdateStatus("Removing Address", constants.Colors.BLUE)
			// 	t.DeleteAddress(t.AccountAddresses[extraIndex].AddressID)
			// 	if t.HandleErrors("clear-addresses") {
			// 		break
			// 	}
			// 	t.AccountAddresses = append(t.AccountAddresses[:extraIndex], t.AccountAddresses[extraIndex+1:]...)

			case "get-cart-info":
				t.UpdateStatus("Getting Cart Info", constants.Colors.BLUE)
				t.GetCart()
				if t.HandleErrors("get-cart-info") {
					break
				}
				t.NextStep = "clear-cart"

			case "preload-atc":
				t.UsedAlternateCartFlow = false
				t.UpdateStatus("Getting Cart Info", constants.Colors.BLUE)
				t.AddToCart("94644445", 1, true)
				if t.HandleErrors("preload-atc") {
					break
				}
				t.NextStep = "prepare-checkout"

			case "prepare-checkout":
				t.PrepareCheckout()
				if t.HandleErrors("prepare-checkout") {
					break
				}
				t.NextStep = "clear-cart"

			case "clear-cart":
				if len(t.CartedItems) > 0 {
					t.RemoveFromCart(t.CartedItems[0].CartItemId)
				}
				if t.HandleErrors("clear-cart") {
					break
				}
				if len(t.CartedItems) == 0 {
					if t.UseFillerItem {
						t.NextStep = "atc-filler-item"
					} else {
						t.NextStep = "wait-for-restock"
					}
				}

			case "atc-filler-item":
				t.UpdateStatus("Carting Filler Item", constants.Colors.BLUE)
				t.AddToCart(FillerItem, 1, true)
				if t.HandleErrors("atc-filler-item") {
					break
				} else {
					t.NextStep = "wait-for-restock"
				}
			case "wait-for-restock":
				t.UpdateStatus("Waiting For Restock", constants.Colors.BLUE)
				if len(t.matchKeys()) == 0 {
					t.UpdateStatus("No valid TCIN inputs", constants.Colors.RED)
					t.SleepTask(t.ErrorDelay)
					break
				}
				ping, ok := t.waitForStockPing()
				if !ok {
					break
				}
				qty := t.monitorQtyForTCIN(ping.ProductKey)
				if qty <= 0 {
					qty = ping.Quantity
				}
				if qty <= 0 {
					qty = 1
				}
				maxPrice := t.monitorMaxPriceForTCIN(ping.ProductKey)
				if !targetPingMeetsControls(ping, maxPrice, t.IgnoreLowStock) {
					// Don't rematch the same over-budget or low-confidence ping in a tight loop.
					t.stockWaitAfter = ping.At
					t.SleepTask(t.MonitorDelay)
					break
				}
				t.RestockQty = qty
				t.RestockTCIN = ping.ProductKey
				t.StockPing = ping
				if ping.Raw != "" {
					t.AddLog(ping.Raw)
				}
				t.stockWaitAfter = ping.At
				t.UpdateInputValue(ping.Name, "Default")
				statusLine := fmt.Sprintf("Product Found: %s From: %s", ping.Name, ping.From)
				t.UpdateStatus(statusLine, constants.Colors.YELLOW)
				t.SendProductNoti(ping.Name, ping.Image)
				t.ShapeBlockCount = 0
				t.CheckoutRateLimitCount = 0
				t.StepAfterSolve = "add-to-cart"
				t.NextStep = "get-shape"

			case "add-to-cart":
				if t.maybeBailRestock() {
					break
				}
				if !t.shapeOK() {
					t.StepAfterSolve = "add-to-cart"
					t.NextStep = "get-shape"
					break
				}
				t.resetCheckoutState()
				t.SetProxy(t.ShapeProxy)
				t.UpdateStatus("Adding To Cart", constants.Colors.BLUE)
				t.AddToCart(t.RestockTCIN, t.RestockQty, false)
				if t.HandleErrors("add-to-cart") {
					if t.NextStep == "add-to-cart" && !keepShapeAfterATCError(t) {
						t.StepAfterSolve = "add-to-cart"
						t.NextStep = "get-shape"
						t.CheckoutRateLimitCount = 0
					}
					break
				}
				t.TaskState = constants.StatusSteps.Carted

				productName := t.CartData.Attributes.Description
				if productName == "" {
					productName = t.StockPing.Name
				}
				productImage := t.CartData.Attributes.Image
				if productImage == "" {
					productImage = t.StockPing.Image
				}
				productPrice := t.CartData.ItemSummary.Price
				if productPrice <= 0 {
					productPrice = t.StockPing.Price
				}
				productTcin := t.CartData.Tcin
				if productTcin == "" {
					productTcin = t.RestockTCIN
				}
				productQty := t.CartData.Quantity
				if productQty <= 0 {
					productQty = t.RestockQty
				}
				t.CartToalPrice = productPrice * float64(productQty)

				t.Products = []Product{{
					ProductName:  productName,
					ProductImage: productImage,
					ProductPrice: productPrice,
					ProductLink:  fmt.Sprintf("https://www.target.com/p/-/A-%s", productTcin),
					ProductSize:  "Default",
					Quantity:     productQty,
				}}
				task.SendCartedAnalytics(task.ProductWebhookData{
					CheckoutProducts: t.BuildProductWebhookItems(),
					Site:             "Target",
					ProfileName:      t.Profile.ProfileName,
					ProxyGroup:       t.ProxyGroup,
					TaskID:           t.RunID,
					ClientTaskID:     t.ID,
					RunID:            t.RunID,
					GrandTotal:       t.CartToalPrice,
				})
				t.AddLog(fmt.Sprintf("Carted %dx %s - $%.2f w shape: %s", productQty, productName, t.CartToalPrice, t.ShapeMethod))
				datadog.Info("Carted", map[string]interface{}{"event": "carted", "site": "Target", "task_id": t.RunID, "shapeMethod": t.ShapeMethod})
				t.PassedCartErrors = 0
				t.CheckoutRateLimitCount = 0
				t.NextStep = "submit-payment"

			case "get-cart":
				t.UpdateStatus("Getting Cart", constants.Colors.BLUE)
				t.GetCart()
				if t.HandleErrors("get-cart") {
					break
				}
				t.NextStep = "submit-payment"

			case "submit-payment":
				t.UpdateStatus("Getting Cart", constants.Colors.BLUE)
				t.UpdateStatus("Submitting Payment", constants.Colors.BLUE)
				t.UpdateStatus("Submitting CVV", constants.Colors.BLUE)

				if !t.tmxStartedForCheckout {
					t.tmxStartedForCheckout = true
					tmxConfig := &tmx.TMXConfig{
						SessionID:  t.PrepCheckoutData.ReferanceID,
						SiteID:     "9p00aymw",
						Domain:     "img9.target.com",
						Client:     t.Requests.Client,
						CurrentUrl: "https://www.target.com/checkout",
						PrevUrl:    "https://www.target.com/cart",
						UserAgent:  t.Requests.UserAgent.Useragent,
						IPv4:       t.Requests.IPv4,
						SendM1M2:   true,
						SendKClear: true,
						SendJF:     true,
					}
					safego.Go(func() { tmx.SolveTMX(tmxConfig) })
				}
				if t.UsedAlternateCartFlow {
					go t.PrepareCheckout()
				}
				t.SubmitPayment(false)
				t.recoverExistingPaymentInstruction()
				if t.UseFillerItem && t.Error != nil && strings.Contains(t.Error.Error(), "400") && t.PaymentInstId != "" {
					t.Error = nil
					t.SubmitPayment(true)
				}
				if t.HandleErrors("submit-payment") {
					if t.PassedCartErrors >= 3 {
						t.NextStep = "preload-atc"
					}
					break
				}
				t.NextStep = "submit-order"

			case "submit-order":
				t.UpdateStatus("Submitting Order", constants.Colors.YELLOW)
				t.SubmitOrder()
				if t.HandleErrors("submit-order") {
					break
				}
				if t.Decline && strings.EqualFold(t.FraudStatus, "OUT_OF_STOCK") {
					t.NextStep = "oos-check-cart"
				} else if t.Decline {
					t.NextStep = "decline"
				} else {
					t.NextStep = "wait-to-check"
				}

			case "oos-check-cart":
				t.UpdateStatus("Out Of Stock, Checking Cart", constants.Colors.YELLOW)
				t.GetCart()
				if t.HandleErrors("oos-check-cart") {
					break
				}
				if (len(t.CartedItems) > 0 && !t.UseFillerItem) || (len(t.CartedItems) > 1 && t.UseFillerItem) {
					t.Decline = false
					t.FraudStatus = ""
					t.NextStep = "submit-order"
				} else {
					t.NextStep = "remove-payment"
				}

			case "remove-payment":
				// t.UpdateStatus("Releasing Payment Hold", constants.Colors.YELLOW)
				t.RemovePaymentMethod()
				t.bailToRestock()

			case "wait-to-check":
				t.UpdateStatus("Waiting For Order", constants.Colors.BLUE)
				t.SleepTask(5000)
				t.NextStep = "check-order"

			case "check-order":
				t.UpdateStatus("Getting Order Status", constants.Colors.YELLOW)
				t.CheckOrder(t.CheckoutData.ReferenceId, false)
				if t.Error != nil {
					if t.shouldAssumeCheckout(t.Error) {
						t.assumeCheckout()
						t.NextStep = "checkout"
						break
					}
					if t.HandleErrors("check-order") {
						break
					}
				} else {
					t.CheckOrderAttempts = 0
				}
				fillerCheckFailed := false
				for _, fo := range t.FillerOrders {
					if fo.Canceled || fo.OrderLineId != "" {
						continue
					}
					t.CheckOrder(fo.ReferenceId, true)
					if t.Error == nil {
						continue
					}
					if t.Checkout {
						t.Error = nil
						break
					}
					if t.shouldAssumeCheckout(t.Error) {
						t.assumeCheckout()
						break
					}
					if t.HandleErrors("check-order") {
						fillerCheckFailed = true
						break
					}
				}
				if fillerCheckFailed {
					break
				}
				if t.NeedCancelFiller {
					t.NextStep = "cancel-filler"
					break
				}
				if t.Checkout {
					t.NextStep = "checkout"
				} else if t.Decline {
					t.NextStep = "decline"
				}

			case "cancel-filler":
				t.UpdateStatus("Removing Filler Item", constants.Colors.BLUE)
				t.RemoveFillerItem()
				if t.Checkout {
					t.NextStep = "checkout"
				} else if t.Decline {
					t.NextStep = "decline"
				}

			case "checkout":
				t.TaskState = constants.StatusSteps.CheckedOut
				t.UpdateStatus("Successful", constants.Colors.GREEN)
				if len(t.Products) > 0 {
					t.SendCheckoutDeclineNoti(t.Products[0].ProductName, t.Products[0].ProductImage, true, t.notificationDetails())
				}
				extraFields := map[string]string{
					"Fraud Status": t.FraudStatus,
					"Cookie Type":  t.ShapeMethod,
				}
				if t.UseFillerItem {
					extraFields["Canceled Filler Item"] = strconv.FormatBool(t.CanceledFillerItem)
				}

				task.SendProductWebhook(task.ProductWebhookData{
					Success:          true,
					CheckoutProducts: t.BuildProductWebhookItems(),
					Email:            t.Account.Username,
					Site:             "Target",
					ProfileName:      t.Profile.ProfileName,
					Proxy:            t.checkoutProxy(),
					ProxyGroup:       t.ProxyGroup,
					OrderNumber:      t.OrderNumber,
					TaskID:           t.RunID,
					ClientTaskID:     t.ID,
					RunID:            t.RunID,
					GrandTotal:       t.CartToalPrice,
					ExtraFeilds:      extraFields,
				})
				if t.Endless {
					t.Products = []Product{}
					t.resetCheckoutState()
					t.TaskState = constants.StatusSteps.Running
					t.NextStep = "preload-atc"
				} else {
					t.NextStep = "stop"
				}

			case "decline":
				t.OrderNumber = "9999999999"
				t.TaskState = constants.StatusSteps.Declined
				t.UpdateStatus("Payment Declined", constants.Colors.RED)
				if len(t.Products) > 0 {
					t.SendCheckoutDeclineNoti(t.Products[0].ProductName, t.Products[0].ProductImage, false, t.notificationDetails())
				}
				webhookData := task.ProductWebhookData{
					Success:          false,
					CheckoutProducts: t.BuildProductWebhookItems(),
					Email:            t.Account.Username,
					Site:             "Target",
					ProfileName:      t.Profile.ProfileName,
					Proxy:            t.checkoutProxy(),
					ProxyGroup:       t.ProxyGroup,
					OrderNumber:      t.OrderNumber,
					TaskID:           t.RunID,
					ClientTaskID:     t.ID,
					RunID:            t.RunID,
					DeclineReason:    t.DeclineReason,
				}
				declineExtraFields := map[string]string{
					"Cookie Type": t.ShapeMethod,
				}
				if t.FraudStatus != "" {
					declineExtraFields["Fraud Status"] = t.FraudStatus
				}
				webhookData.ExtraFeilds = declineExtraFields
				task.SendProductWebhook(webhookData)
				if t.Endless {
					t.Products = []Product{}
					t.resetCheckoutState()
					t.TaskState = constants.StatusSteps.Running
					t.NextStep = "preload-atc"
				} else {
					t.NextStep = "stop"
				}
			}
			runtime.Gosched()
		}
	}
}

func (t *TargetTask) prepareEmailCodeWaiter() error {
	t.cancelEmailCodeWaiter()
	waiter, err := imapcode.PrepareWait(t.Account.Username)
	if err != nil {
		return err
	}
	t.emailCodeWaiter = waiter
	waiter.Arm()
	return nil
}

func (t *TargetTask) cancelEmailCodeWaiter() {
	if t.emailCodeWaiter == nil {
		return
	}
	t.emailCodeWaiter.Cancel()
	t.emailCodeWaiter = nil
}

func (t *TargetTask) waitForEmailCode(ctx context.Context) (string, error) {
	if t.emailCodeWaiter == nil {
		return "", fmt.Errorf("imapcode: wait not prepared")
	}
	waiter := t.emailCodeWaiter
	code, err := waiter.Wait(ctx)
	t.emailCodeWaiter = nil
	return code, err
}
