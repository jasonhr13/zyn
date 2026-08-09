package target

import (
	crand "crypto/rand"
	"math/big"
	"math/rand"
	randv2 "math/rand/v2"
	"strings"
	"time"

	"github.com/PolarAIO/Polar-AIO/backend/bot-base/task"
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
	t.NeedCancelFiller = false
	t.CanceledFillerItem = false
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

func (t *TargetTask) BuildProductWebhookItems() []task.ProductWebhookItem {
	items := make([]task.ProductWebhookItem, 0, len(t.Products))
	for i := range t.Products {
		items = append(items, task.ProductWebhookItem{
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
			Quantity:    1,
			Name:        t.Product.Name,
			Price:       t.Product.Price,
			ProductLink: t.Product.ProductLink,
			Size:        t.Product.Size,
		}}
	}
	return nil
}
