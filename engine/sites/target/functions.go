package target

import (
	crand "crypto/rand"
	"fmt"
	"math/big"
	"math/rand"
	randv2 "math/rand/v2"
	"strings"
	"time"

	"zynbot.app/engine/bot-base/task"
)

func CreateVisitorId() string {
	const (
		INTEGER_MAX    = int64(9e15)
		DEC_VISITOR_ID = 1
		SOURCE_NA      = 0
		BYTE_HEX       = 255
		BYTE_MAX       = 256
	)

	toBytes := func(num int64, length int) []byte {
		arr := make([]byte, length)
		for i := length - 1; i >= 0; i-- {
			r := num & BYTE_HEX
			arr[i] = byte(r)
			num = (num - r) / BYTE_MAX
		}
		return arr
	}

	toHex := func(b *strings.Builder, n byte) {
		const hex = "0123456789ABCDEF"
		b.WriteByte(hex[(n>>4)&15])
		b.WriteByte(hex[n&15])
	}

	source := SOURCE_NA

	timeBytes := toBytes(time.Now().UnixMilli(), 6)

	r := rand.New(rand.NewSource(time.Now().UnixNano()))
	randBytes := append(
		toBytes(r.Int63n(INTEGER_MAX), 2),
		toBytes(r.Int63n(INTEGER_MAX), 6)...,
	)

	all := append(timeBytes, byte(DEC_VISITOR_ID), byte(source))
	all = append(all, randBytes...)

	var b strings.Builder
	b.Grow(len(all) * 2)
	for _, x := range all {
		toHex(&b, x)
	}

	return b.String()
}

func parseTcinFromInput(input string) string {
	input = strings.TrimSpace(input)
	if input == "" {
		return ""
	}
	upper := strings.ToUpper(input)
	if idx := strings.LastIndex(upper, "A-"); idx >= 0 {
		rest := input[idx+2:]
		var b strings.Builder
		for _, r := range rest {
			if r >= '0' && r <= '9' {
				b.WriteRune(r)
			} else {
				break
			}
		}
		if b.Len() > 0 {
			return b.String()
		}
	}
	for _, r := range input {
		if r < '0' || r > '9' {
			return ""
		}
	}
	return input
}

func parseMissingTcinsFromErrors(errors []ProductStockError) []string {
	const prefix = "No product found with tcin "
	out := make([]string, 0, len(errors))
	seen := make(map[string]struct{}, len(errors))
	for _, e := range errors {
		idx := strings.Index(e.Message, prefix)
		if idx < 0 {
			continue
		}
		rest := e.Message[idx+len(prefix):]
		var b strings.Builder
		for _, r := range rest {
			if r < '0' || r > '9' {
				break
			}
			b.WriteRune(r)
		}
		tcin := b.String()
		if tcin == "" {
			continue
		}
		if _, ok := seen[tcin]; ok {
			continue
		}
		seen[tcin] = struct{}{}
		out = append(out, tcin)
	}
	return out
}

func filterMonitorInputs(inputs []MonitorInput, exclude map[string]struct{}) []MonitorInput {
	if len(exclude) == 0 {
		return inputs
	}
	out := make([]MonitorInput, 0, len(inputs))
	for _, in := range inputs {
		if _, skip := exclude[in.Tcin]; skip {
			continue
		}
		out = append(out, in)
	}
	return out
}

func (t *TargetMonitorTask) markMissingTcins(tcins []string) {
	if len(tcins) == 0 {
		return
	}
	if t.missingTcins == nil {
		t.missingTcins = make(map[string]struct{})
	}
	for _, tcin := range tcins {
		if tcin == "" {
			continue
		}
		t.missingTcins[tcin] = struct{}{}
	}
}

func (t *TargetMonitorTask) inputsForStockCheck() []MonitorInput {
	active := make([]MonitorInput, 0, len(t.MonitorInputs))
	missing := make([]MonitorInput, 0)
	for _, in := range t.MonitorInputs {
		if _, skip := t.missingTcins[in.Tcin]; skip {
			missing = append(missing, in)
			continue
		}
		active = append(active, in)
	}
	if len(missing) == 0 {
		return active
	}
	// Always re-check at least one when nothing else is active; otherwise randomly probe.
	if len(active) == 0 || randv2.IntN(5) == 0 {
		active = append(active, missing[randv2.IntN(len(missing))])
	}
	return active
}

func randomPassword(length int) string {
	const lower = "abcdefghijklmnopqrstuvwxyz"
	const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
	const numSpecial = "0123456789!@#$%^&*"
	const all = lower + upper + numSpecial

	randChar := func(chars string) byte {
		n, _ := crand.Int(crand.Reader, big.NewInt(int64(len(chars))))
		return chars[n.Int64()]
	}

	password := []byte{randChar(lower), randChar(upper), randChar(numSpecial)}
	for len(password) < length {
		password = append(password, randChar(all))
	}
	for i := range password {
		j, _ := crand.Int(crand.Reader, big.NewInt(int64(len(password))))
		password[i], password[j.Int64()] = password[j.Int64()], password[i]
	}
	return string(password)
}

func navigatorAppVersionFromUA(ua string) string {
	const prefix = "Mozilla/"
	if i := strings.Index(ua, prefix); i >= 0 {
		return ua[i+len(prefix):]
	}
	return ua
}

func (t *TargetTask) resetCheckoutState() {
	t.Checkout = false
	t.Decline = false
	t.DeclineReason = ""
	t.FraudStatus = ""
	t.OrderNumber = ""
	t.Products = []Product{}
	t.CartedItems = []CartItem{}
	t.FillerOrders = nil
	t.FillerOrderRefs = nil
	t.OrderHistory = nil
	t.FillerOrderRetries = 0
	t.FillerNeedsRetry = false
	t.NeedCancelFiller = false
	t.CanceledFillerItem = false
	t.FillerCancelNote = ""
	t.CheckOrderAttempts = 0
	t.tmxStartedForCheckout = false
}

func (t *TargetTask) notificationDetails() task.NotificationDetails {
	sku := strings.TrimSpace(t.RestockTCIN)
	if sku == "" {
		sku = strings.TrimSpace(t.CartData.Tcin)
	}
	if sku == "" {
		sku = strings.TrimSpace(t.StockPing.ProductKey)
	}
	return task.NotificationDetails{
		TaskID:      t.ID,
		SKU:         sku,
		Price:       t.CartToalPrice,
		OrderNumber: t.OrderNumber,
		AccountID:   t.AccountID,
		Source:      t.ShapeMethod,
	}
}

func isCardPaymentExistsError(err error) bool {
	return err != nil && strings.Contains(strings.ToUpper(err.Error()), "CARD_PAYMENT_EXISTS")
}

func paymentInstructionID(instructions []PaymentInstructionsBlock) string {
	for _, instruction := range instructions {
		if id := strings.TrimSpace(instruction.PaymentInstId); id != "" {
			return id
		}
	}
	return ""
}

func (t *TargetTask) recoverExistingPaymentInstruction() {
	if !isCardPaymentExistsError(t.Error) {
		return
	}

	originalErr := t.Error
	if strings.TrimSpace(t.PaymentInstId) == "" {
		t.Error = nil
		t.GetCart()
		if t.Error != nil {
			t.Error = originalErr
			return
		}
	}

	if strings.TrimSpace(t.PaymentInstId) == "" {
		t.Error = originalErr
		return
	}

	t.Error = nil
	t.SubmitPayment(true)
}

func (t *TargetTask) fraudStatusIsSuccess(status string) bool {
	switch strings.TrimSpace(strings.ToUpper(status)) {
	case "SUCCESS", "REVIEW_HOLD":
		return true
	default:
		return false
	}
}

const checkOrderVerifyRetries = 6
const fillerOrderRetryLimit = 20
const fillerOrderRetryDelayMs = 3000
const fillerPendingError = "cancel-filler order not finished processing"

func fillerStatusCanceled(key string) bool {
	switch strings.ToLower(strings.TrimSpace(key)) {
	case "canceled", "cancelled":
		return true
	default:
		return false
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if s := strings.TrimSpace(value); s != "" {
			return s
		}
	}
	return ""
}

func (e OrderHistoryEntry) number() string {
	return firstNonEmpty(e.OrderNumber, e.OrderNumberCamel, e.OrderID, e.OrderIDCamel)
}

func (e OrderHistoryEntry) lines() []OrderHistoryLine {
	if len(e.OrderLines) > 0 {
		return e.OrderLines
	}
	return e.OrderLinesCamel
}

func (line OrderHistoryLine) lineID() string {
	return firstNonEmpty(line.OrderLineID, line.OrderLineIDCamel)
}

func (line OrderHistoryLine) lineKey() string {
	return firstNonEmpty(line.OrderLineKey, line.OrderLineKeyCamel)
}

func (line OrderHistoryLine) tcin() string {
	return firstNonEmpty(line.Item.TCIN, line.Item.TCINUpper)
}

func (line OrderHistoryLine) qty() int {
	if line.OriginalQuantity > 0 {
		return line.OriginalQuantity
	}
	return line.Quantity
}

func (line OrderHistoryLine) fulfillment() OrderHistoryFulfillment {
	if line.FulfillmentSpec.Status.Key != "" || line.FulfillmentSpec.Status.Operations.cancellable() {
		return line.FulfillmentSpec
	}
	return line.FulfillmentCamel
}

func (ops OrderHistoryStatusOps) cancellable() bool {
	return ops.IsCancellable || ops.IsCancellableCamel
}

func (t *TargetTask) fillerLog(msg string) {
	if t == nil || strings.TrimSpace(msg) == "" {
		return
	}
	t.AddLog("[filler] " + msg)
}

func (t *TargetTask) hasCancellableFiller() bool {
	for _, fo := range t.FillerOrders {
		if fo == nil || fo.Canceled {
			continue
		}
		id := strings.TrimSpace(fo.OrderLineId)
		if id != "" && id != strings.TrimSpace(fo.OrderLineKey) {
			return true
		}
	}
	return false
}

func (t *TargetTask) refreshFillerOrderDetails() {
	t.rememberFillerRef(t.OrderNumber)
	t.rememberFillerRef(t.CheckoutData.ReferenceId)
	t.rememberFillerRef(t.CheckoutData.OrderID)
	for _, fo := range t.FillerOrders {
		if fo == nil || fo.Canceled || strings.TrimSpace(fo.OrderLineId) != "" {
			continue
		}
		t.CheckOrder(fo.ReferenceId, true)
	}
}

func (t *TargetTask) rememberFillerRef(id string) {
	id = strings.TrimSpace(id)
	if t == nil || id == "" {
		return
	}
	for _, existing := range t.FillerOrderRefs {
		if strings.EqualFold(existing, id) {
			return
		}
	}
	t.FillerOrderRefs = append(t.FillerOrderRefs, id)
}

func (t *TargetTask) checkoutOrderRefs() []string {
	if t == nil {
		return nil
	}
	seen := make(map[string]struct{})
	add := func(id string) {
		id = strings.ToLower(strings.TrimSpace(id))
		if id == "" {
			return
		}
		seen[id] = struct{}{}
	}
	add(t.CheckoutData.ReferenceId)
	add(t.CheckoutData.OrderID)
	add(t.OrderNumber)
	for _, id := range t.FillerOrderRefs {
		add(id)
	}
	for _, fo := range t.FillerOrders {
		if fo != nil {
			add(fo.ReferenceId)
			add(fo.OrderNumber)
		}
	}
	out := make([]string, 0, len(seen))
	for id := range seen {
		out = append(out, id)
	}
	return out
}

func (t *TargetTask) historyOrderInCheckout(order OrderHistoryEntry) bool {
	num := strings.ToLower(order.number())
	if num == "" {
		return false
	}
	for _, ref := range t.checkoutOrderRefs() {
		if num == ref {
			return true
		}
	}
	return false
}

func (t *TargetTask) historyOrderHasThisProduct(order OrderHistoryEntry) bool {
	sku := strings.TrimSpace(t.RestockTCIN)
	if sku == "" {
		return false
	}
	for _, line := range order.lines() {
		if strings.TrimSpace(line.tcin()) == sku {
			return true
		}
	}
	return false
}

func (t *TargetTask) scopedHistoryOrders() []OrderHistoryEntry {
	matched := make([]OrderHistoryEntry, 0, len(t.OrderHistory))
	for _, order := range t.OrderHistory {
		if t.historyOrderInCheckout(order) {
			matched = append(matched, order)
		}
	}
	if len(matched) > 0 {
		return matched
	}
	for _, order := range t.OrderHistory {
		if t.historyOrderHasThisProduct(order) {
			matched = append(matched, order)
		}
	}
	if len(matched) > 0 {
		t.fillerLog("order history did not match submit-order ids; matching filler by purchased SKU " + strings.TrimSpace(t.RestockTCIN))
	}
	return matched
}

func (t *TargetTask) markFillerCanceled(orderNumber string) {
	orderNumber = strings.TrimSpace(orderNumber)
	for _, fo := range t.FillerOrders {
		if fo != nil && (strings.EqualFold(fo.ReferenceId, orderNumber) || strings.EqualFold(fo.OrderNumber, orderNumber)) {
			fo.Canceled = true
		}
	}
}

// FindFillerOrder inspects the latest order-history page for this checkout's
// filler SKU. Polar waited until Target marked the line cancellable; we do the
// same, but only on order numbers captured from this task's submit-order /
// check-order path so another in-flight checkout on the same account cannot
// be selected.
func (t *TargetTask) FindFillerOrder() bool {
	if t == nil {
		return false
	}
	t.FillerNeedsRetry = false
	t.NeedCancelFiller = false

	cancellable := []*FillerOrderState{}
	pending := false
	foundAny := false
	foundActive := false
	scoped := t.scopedHistoryOrders()
	t.fillerLog(fmt.Sprintf("order history has %d orders, %d match this checkout", len(t.OrderHistory), len(scoped)))

	for _, order := range scoped {
		t.rememberFillerRef(order.number())
		for _, line := range order.lines() {
			if strings.TrimSpace(line.tcin()) != FillerItem {
				continue
			}
			foundAny = true
			status := line.fulfillment().Status
			if fillerStatusCanceled(status.Key) {
				t.markFillerCanceled(order.number())
				continue
			}
			foundActive = true
			if status.Operations.cancellable() && strings.TrimSpace(line.lineID()) != "" {
				cancellable = append(cancellable, &FillerOrderState{
					ReferenceId:  order.number(),
					OrderNumber:  order.number(),
					ItemQty:      line.qty(),
					OrderLineId:  line.lineID(),
					OrderLineKey: line.lineKey(),
				})
				continue
			}
			pending = true
		}
	}

	if len(cancellable) > 0 {
		t.FillerOrders = cancellable
		t.NeedCancelFiller = true
		t.FillerNeedsRetry = pending
		t.fillerLog(fmt.Sprintf("found %d cancellable filler line(s)", len(cancellable)))
		return true
	}
	if foundAny && !foundActive {
		t.CanceledFillerItem = true
		t.FillerCancelNote = "already canceled in order history"
		t.fillerLog(t.FillerCancelNote)
		return false
	}
	if pending {
		t.fillerLog("filler is in this checkout but Target has not marked it cancellable yet")
	} else if len(scoped) == 0 {
		t.fillerLog("no order-history row matched this checkout's submit-order ids or purchased SKU")
	} else {
		t.fillerLog("matched checkout in order history but no filler SKU " + FillerItem + " yet")
	}
	t.FillerNeedsRetry = t.UseFillerItem || pending
	return false
}

func (t *TargetTask) pendingFillerRetry() {
	if t == nil {
		return
	}
	t.FillerOrderRetries++
	if t.FillerOrderRetries >= fillerOrderRetryLimit {
		t.FillerCancelNote = fmt.Sprintf("gave up after %d order-history checks", fillerOrderRetryLimit)
		t.fillerLog(t.FillerCancelNote)
		t.Error = nil
		t.NextStep = "checkout"
		return
	}
	t.Error = fmt.Errorf("%s", fillerPendingError)
	t.NextStep = "get-orders"
}

func isCheckOrderVerifyFailure(err error) bool {
	if err == nil {
		return false
	}
	return containsAnyText(err.Error(),
		"check-order",
		"proxy failed",
		"status not found",
		"dco_rate_limited",
		"out of stock (check)",
		"timeout",
		"deadline exceeded",
	)
}

func (t *TargetTask) submittedOrderPending() bool {
	return t != nil && strings.TrimSpace(t.CheckoutData.ReferenceId) != ""
}

func (t *TargetTask) checkOrderAlreadyDeclined() bool {
	if t == nil || !t.Decline {
		return false
	}
	status := strings.TrimSpace(t.FraudStatus)
	return status != "" && !t.fraudStatusIsSuccess(status)
}

// shouldAssumeCheckout is true when submit-order already created an order
// but Target's post_orders status API will not confirm it. Retry a few times
// first; then treat it as an unverified success so the webhook is not swallowed.
func (t *TargetTask) shouldAssumeCheckout(err error) bool {
	if t == nil || err == nil || !t.submittedOrderPending() || t.checkOrderAlreadyDeclined() {
		return false
	}
	t.CheckOrderAttempts++
	return t.CheckOrderAttempts >= checkOrderVerifyRetries
}

func (t *TargetTask) assumeCheckout() {
	t.Error = nil
	t.Checkout = true
	t.Decline = false
	if strings.TrimSpace(t.FraudStatus) == "" {
		t.FraudStatus = "UNVERIFIED"
	}
	if strings.TrimSpace(t.OrderNumber) == "" {
		t.OrderNumber = strings.TrimSpace(t.CheckoutData.OrderID)
	}
	if strings.TrimSpace(t.OrderNumber) == "" {
		t.OrderNumber = strings.TrimSpace(t.CheckoutData.ReferenceId)
	}
}

func (t *TargetTask) BuildProductWebhookItems() []task.ProductWebhookItem {
	sku := t.notificationDetails().SKU
	items := make([]task.ProductWebhookItem, 0, len(t.Products))
	for i := range t.Products {
		items = append(items, task.ProductWebhookItem{
			SKU:         sku,
			Quantity:    t.Products[i].Quantity,
			Image:       t.Products[i].ProductImage,
			Name:        t.Products[i].ProductName,
			Price:       t.Products[i].ProductPrice,
			ProductLink: t.Products[i].ProductLink,
			Size:        t.Products[i].ProductSize,
		})
	}
	if len(items) > 0 {
		return items
	}
	if t.Product.Name != "" {
		return []task.ProductWebhookItem{{
			SKU:         sku,
			Quantity:    1,
			Name:        t.Product.Name,
			Price:       t.Product.Price,
			ProductLink: t.Product.ProductLink,
			Size:        t.Product.Size,
		}}
	}
	return nil
}
