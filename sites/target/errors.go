package target

import (
	"math/rand/v2"
	"runtime/debug"
	"strings"

	"github.com/PolarAIO/Polar-AIO/backend/bot-base/alert"
	"github.com/PolarAIO/Polar-AIO/backend/bot-base/datadog"
	"github.com/PolarAIO/Polar-AIO/backend/bot-base/task/constants"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

func containsAnyText(text string, fragments ...string) bool {
	searchText := strings.ToLower(strings.TrimSpace(text))
	for _, fragment := range fragments {
		if strings.Contains(searchText, strings.ToLower(strings.TrimSpace(fragment))) {
			return true
		}
	}
	return false
}

func isContextCanceledError(err error) bool {
	if err == nil {
		return false
	}
	return containsAnyText(err.Error(), "context canceled")
}

func catchError(t *TargetTask) {
	if a := recover(); a != nil {
		alert.Panic("target task", a, debug.Stack())
		t.StopTask("unhandled error", constants.Colors.RED)
	}
}

func (t *TargetTask) HandleErrors(step string) bool {
	if t.Error == nil {
		return false
	}

	errText := strings.ToLower(strings.TrimSpace(t.Error.Error()))
	if !containsAnyText(errText, "shape block") {
		t.ShapeBlockCount = 0
	}

	switch {
	case containsAnyText(errText, "no connection"):
		t.BaseTask.SwapProxy("Target")
	case errText == "2fa needed":
		t.Error = nil
		t.StepAfterSolve = "request-code"
		t.NextStep = "get-shape"
		return true
	case errText == "out of stock":
		t.UpdateStatus("Out Of Stock", constants.Colors.RED)
		t.NextStep = "oos-check-cart"
	case errText == "out of stock (check)":
		t.UpdateStatus("Out Of Stock", constants.Colors.RED)
		t.bailToRestock()
	case containsAnyText(errText, "cancel-filler order not finished processing"):
		t.UpdateStatus("Order Not Finished Processing", constants.Colors.YELLOW)
		t.SleepTask(5000)
	case containsAnyText(errText, "dco_rate_limited"):
		t.UpdateStatus("DCO Rate Limited", constants.Colors.YELLOW)
		datadog.Info("DCO_Rate_Limited", map[string]interface{}{"event": "dco_rate_limited", "site": "Target", "step": step, "task_id": t.ID, "name": t.Profile.ProfileName})
		t.tryThrottleFallback()
		randomMs := rand.IntN(1501)
		t.SleepTask(randomMs)
	case containsAnyText(errText, "shape-block-ccart", "precart"):
		// // ignore since clear cart doesnt need shape
	case containsAnyText(errText, "invalid_credentials"):
		t.StopTask("Invaild Credentials", constants.Colors.RED)
	case containsAnyText(errText, "locked_account"):
		t.StopTask("Locked Account", constants.Colors.RED)
	case errText == "bad session":
		if t.SessionRefreshAttempts >= 3 {
			t.StopTask("Bad Session", constants.Colors.RED)
			return true
		}
		t.SessionRefreshAttempts++
		t.UpdateStatus("Bad Session - Refreshing Login", constants.Colors.RED)
		t.Account.Cookie = ""
		if err := t.BaseTask.EnsureTLSClient(true); err != nil {
			t.UpdateStatus("Error Building Client", constants.Colors.RED)
			t.SleepTask(t.ErrorDelay)
			return true
		}
		t.NextStep = "get-session"
	case containsAnyText(errText, "429"):
		t.UpdateStatus("Ratelimited (429)", constants.Colors.RED)
		t.BaseTask.SwapProxy("Target")
		t.SleepTask(t.ErrorDelay)
	case containsAnyText(errText, "Shape Block (Login)"):
		t.StepAfterSolve = step
		t.NextStep = "get-shape"
		if t.ShapeBlockCount >= 3 {
			t.UpdateStatus("Shape Soft Block", constants.Colors.RED)
			t.SleepTask(60000)
		} else {
			t.ShapeBlockCount = t.ShapeBlockCount + 1
			c := cases.Title(language.English)
			t.UpdateStatus(c.String(errText), constants.Colors.RED)
			t.SleepTask(t.ErrorDelay)
		}
	case containsAnyText(errText, "Shape Block (Cart)"):
		t.StepAfterSolve = step
		if t.ShapeBlockCount >= 3 {
			t.UpdateStatus("Shape Soft Block", constants.Colors.RED)
			t.SleepTask(60000)
			if step == "add-to-cart" {
				t.bailToRestockKeepSignal()
			} else {
				t.NextStep = "wait-for-restock"
			}
		} else {
			t.ShapeBlockCount = t.ShapeBlockCount + 1
			c := cases.Title(language.English)
			t.UpdateStatus(c.String(errText), constants.Colors.RED)
			t.SleepTask(t.ErrorDelay)
		}
	case containsAnyText(errText, "403"):
		c := cases.Title(language.English)
		t.UpdateStatus(c.String(errText), constants.Colors.RED)
		t.SleepTask(t.ErrorDelay)
		t.SwapProxy("Target")
	case errText == "proxy block":
		t.UpdateStatus("Proxy Block", constants.Colors.RED)
		t.SwapProxy("Target")
		t.SleepTask(t.ErrorDelay)
	case containsAnyText(errText, "submit-payment ("):
		c := cases.Title(language.English)
		t.UpdateStatus(c.String(errText), constants.Colors.RED)
		t.SleepTask(t.ErrorDelay)
		t.PassedCartErrors++
	case containsAnyText(errText, "product not found"):
		t.UpdateStatus("Product Not Found", constants.Colors.RED)
		t.SleepTask(t.ErrorDelay)
		t.bailToRestock()
	case containsAnyText(errText, "Shape Block (Precart)"):
		t.PreCartShapeBlockCount++
		if t.PreCartShapeBlockCount >= 3 {
			t.UpdateStatus("Using Alternate Cart Flow", constants.Colors.RED)
			t.PreCartShapeBlockCount = 0
			t.NextStep = "get-cart-info"
			t.UsedAlternateCartFlow = true
		}
	default:
		if !isContextCanceledError(t.Error) {
			c := cases.Title(language.English)
			t.UpdateStatus(c.String(errText), constants.Colors.RED)
			t.SleepTask(t.ErrorDelay)
		}
	}
	return true
}

func (t *TargetMonitorTask) HandleMonitorErrors(step string) bool {
	if t.Error == nil {
		return false
	}

	errText := strings.ToLower(strings.TrimSpace(t.Error.Error()))
	if isContextCanceledError(t.Error) {
		return true
	}
	if containsAnyText(errText, "404") {
		// Missing-SKU 404s are handled by dropping the tcin and retrying; stay silent.
		t.SleepTask(t.ErrorDelay)
	} else if containsAnyText(errText, "403") {
		t.UpdateStatus("Proxy Blocked (403)", constants.Colors.RED)
		t.SleepTask(t.ErrorDelay)
		if err := t.BaseTask.EnsureTLSClient(true); err != nil {
			t.UpdateStatus("Error Building Client", constants.Colors.RED)
			t.SleepTask(t.ErrorDelay)
			return true
		}
	} else if containsAnyText(errText, "429") {
		t.UpdateStatus("Rate Limited (429)", constants.Colors.RED)
		t.SleepTask(t.ErrorDelay)
	} else if !containsAnyText(errText, "no connection") {
		c := cases.Title(language.English)
		t.UpdateStatus(c.String(errText), constants.Colors.RED)
		t.SleepTask(t.ErrorDelay)
	}
	_ = t.BaseTask.SwapProxy("Target")
	return true
}

func CatchMonitorError(t *TargetMonitorTask) {
	if a := recover(); a != nil {
		alert.Panic("target monitor", a, debug.Stack())
		if t != nil {
			t.StopTask("unhandled error", constants.Colors.RED)
		}
	}
}
