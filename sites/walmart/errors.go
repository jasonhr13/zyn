package walmart

import (
	"log"
	"runtime/debug"
	"strings"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"
	"zynbot.app/engine/bot-base/alert"
	"zynbot.app/engine/bot-base/task/constants"
)

func catchError(t *WalmartTask) {
	if a := recover(); a != nil {
		stack := debug.Stack()
		id := ""
		if t != nil {
			id = t.ID
		}
		log.Printf("[ID:'%s'] panic in walmart task: %v\n%s", id, a, stack)
		alert.Panic("walmart task", a, stack)
		if t != nil {
			t.StopTask("unhandled error", constants.Colors.RED)
		}
	}
}

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

func (t *WalmartTask) handleChallengeError(errText string) {
	if !isContextCanceledError(t.Error) {
		t.UpdateStatus("Challenge Failed", constants.Colors.RED)
		t.Requests.AddCookie("tmx_guid", "deleted", "drfdisvc.walmart.com")
		t.Requests.AddCookie("thx_guid", "deleted", "drfdisvc.walmart.com")
		t.TMXDeviceID = GenerateDeviceProfileRefID(36)
		t.SleepTask(t.ErrorDelay)
	}
	t.SwapProxy("Walmart")
	t.NextStep = "solve-tmx"
}

func (t *WalmartTask) HandleErrors(step string) bool {
	if t.Error == nil {
		return false
	}

	errText := strings.ToLower(strings.TrimSpace(t.Error.Error()))
	switch {
	case step == "set-address" && containsAnyText(errText, "unauthorized", "unauthenticated"):
		t.UpdateStatus("Session Expired, Restarting", constants.Colors.RED)
		t.restartTask()
		return true
	case containsAnyText(errText, "px blocked"):
		t.StepAfterSolve = step
		t.NextStep = "solve-hc"
		return true
	case containsAnyText(errText, "challenge failed", "something went wrong with your request"):
		t.handleChallengeError(errText)
		return true
	case containsAnyText(errText, "invalid card details"):
		t.StopTask("Invalid Card Details", constants.Colors.RED)
		return true
	case containsAnyText(errText, "phone 2fa required"):
		t.StopTask("Phone 2FA Required", constants.Colors.RED)
		return true
	case containsAnyText(errText, "invalid code", "invaild code"):
		if step == "submit-reset-code" {
			t.NextStep = "get-reset-code"
		} else {
			t.NextStep = "request-code"
		}
	case containsAnyText(errText, "456"):
		c := cases.Title(language.English)
		t.UpdateStatus(c.String(errText), constants.Colors.RED)
		t.SleepTask(t.ErrorDelay)
		t.SwapProxy("Walmart")
	case containsAnyText(errText, "px init failed"):
		t.SwapProxy("Walmart")

	case containsAnyText(errText, "queue found at cart"):
		t.NextStep = "get-queue"
	case containsAnyText(errText, "password invaild"):
		t.UpdateStatus("Password Invaild", constants.Colors.RED)
		t.NextStep = "get-reset-code"
	case containsAnyText(errText, "proxy blocked"):
		t.UpdateStatus("Proxy Blocked", constants.Colors.RED)
		t.SwapProxy("Walmart")
		t.SleepTask(t.ErrorDelay)
	default:
		if !containsAnyText(errText, "context canceled") {
			c := cases.Title(language.English)
			t.UpdateStatus(c.String(errText), constants.Colors.RED)
			t.SleepTask(t.ErrorDelay)
		}
	}

	return true
}

func (t *WalmartMonitorTask) HandleMonitorErrors(step string) bool {
	if t.Error == nil {
		return false
	}

	errText := strings.ToLower(strings.TrimSpace(t.Error.Error()))
	if isContextCanceledError(t.Error) {
		return true
	}
	if containsAnyText(errText, "403") {
		t.UpdateStatus("Proxy Blocked (403)", constants.Colors.RED)
		t.SleepTask(t.ErrorDelay)
	} else if containsAnyText(errText, "429") {
		t.UpdateStatus("Rate Limited (429)", constants.Colors.RED)
		t.SleepTask(t.ErrorDelay)
	} else if !containsAnyText(errText, "no connection") {
		c := cases.Title(language.English)
		t.UpdateStatus(c.String(errText), constants.Colors.RED)
		t.SleepTask(t.ErrorDelay)
	}
	if err := t.BaseTask.EnsureTLSClient(true); err != nil {
		t.UpdateStatus("Error Building Client", constants.Colors.RED)
		t.SleepTask(t.ErrorDelay)
		return true
	}
	_ = t.BaseTask.SwapProxy("Walmart")
	return true
}

func CatchMonitorError(t *WalmartMonitorTask) {
	if a := recover(); a != nil {
		stack := debug.Stack()
		log.Printf("[ID:'%s'] panic in walmart monitor: %v\n%s", t.ID, a, stack)
		alert.Panic("walmart monitor", a, stack)
		t.StopTask("unhandled error", constants.Colors.RED)
	}
}
