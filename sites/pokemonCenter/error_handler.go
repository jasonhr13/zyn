package pokemoncenter

import (
	"runtime/debug"
	"strings"

	"zynbot.app/engine/bot-base/alert"
	"zynbot.app/engine/bot-base/task/constants"
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

func catchError(t *PokemonCenterTask) {
	if a := recover(); a != nil {
		alert.Panic("pokemonCenter task", a, debug.Stack())
		t.StopTask("Unhandled Error", constants.Colors.RED)
	}
}

func (t *PokemonCenterTask) HandleErrors(step string) bool {
	if t.Error == nil {
		return false
	}

	errText := strings.ToLower(strings.TrimSpace(t.Error.Error()))
	if !strings.Contains(step, "interstitial") {
		t.LastStep = step
	}

	switch {
	case containsAnyText(errText, "datadome-"):
		t.StepAfterSolve = step
		if containsAnyText(errText, "captcha") {
			t.NextStep = "get-captcha"
		} else {
			t.NextStep = "get-interstitial"
		}
	case containsAnyText(errText, "incap-challenge"):
		t.StepAfterSolve = step
		t.PassedQueue = false
		t.InQueue = false
		t.QueueTime = nil
		t.NextStep = "get-incap-challenge"
	case containsAnyText(errText, "ip banned"):
		t.NextStep = "dd-hardblock"
	case containsAnyText(errText, "incap block"):
		t.NextStep = "incap-hardblock"
	case containsAnyText(errText, "no connection"):
		t.BaseTask.SwapProxy("PokemonCenter")
	case containsAnyText(errText, "(403)"):
		t.UpdateStatus("Proxy Block", constants.Colors.RED)
		//unkown 403 rotate prob proxy block
		t.SleepTask(t.ErrorDelay)
		t.BaseTask.SwapProxy("PokemonCenter")
	case containsAnyText(errText, "queue not found"):
		t.SleepTask(t.ErrorDelay)
		if !t.InQueue {
			// t.BaseTask.SwapProxy("PokemonCenter")
			t.NextStep = "get-homepage"
		}
	case step == "get-homepage" && t.WaitForQueue && !t.PassedQueue && !t.FoundQueue:
		if !isContextCanceledError(t.Error) {
			t.UpdateStatus(strings.Title(errText), constants.Colors.RED)
			t.SleepTask(t.ErrorDelay)
		}
		t.NextStep = "wait-for-queue"
	case step == "handle-queue" && (containsAnyText(errText, "proxy failed") || containsAnyText(errText, "failed to respond")):
		if !isContextCanceledError(t.Error) {
			t.UpdateStatus(strings.Title(errText), constants.Colors.RED)
			t.SleepTask(t.ErrorDelay)
		}
		t.NextStep = "handle-queue"
	case containsAnyText(errText, "tokenize card error"):
		if t.LoopCheckout {
			t.BaseTask.SwitchProfile()
			t.NextStep = "get-payment-key"
		} else {
			t.UpdateStatus(strings.Title(errText), constants.Colors.RED)
			t.SleepTask(t.ErrorDelay)
		}
	default:
		if !isContextCanceledError(t.Error) {
			t.UpdateStatus(strings.Title(errText), constants.Colors.RED)
			t.SleepTask(t.ErrorDelay)
		}
	}
	return true
}

func (t *PokemonCenterTask) HandleMultiCartError(step string) (breakLoop bool, retrySame bool) {
	if t.Error == nil {
		return false, false
	}

	errText := strings.ToLower(strings.TrimSpace(t.Error.Error()))
	t.LastStep = step

	switch {
	case containsAnyText(errText, "datadome-"):
		t.StepAfterSolve = step
		if containsAnyText(errText, "captcha") {
			t.NextStep = "get-captcha"
		} else {
			t.NextStep = "get-interstitial"
		}
		return true, false
	case errText == "incap block":
		t.StepAfterSolve = step
		t.NextStep = "incap-hardblock"
		return true, false
	case containsAnyText(errText, "no connection"):
		t.BaseTask.SwapProxy("PokemonCenter")
		t.Error = nil
		return false, true // retry SAME item
	}

	return false, false
}
