//go:build zyn

package frontend

import (
	"log"
	"strings"

	"zynbot.app/engine/sites"
	"zynbot.app/engine/sites/costco"
	pokemoncenter "zynbot.app/engine/sites/pokemonCenter"
	"zynbot.app/engine/sites/queueit"
	"zynbot.app/engine/sites/target"
	"zynbot.app/engine/sites/walmart"
)

func dispatchStartTask(siteName string, input sites.TaskInput) {
	switch {
	case strings.EqualFold(strings.TrimSpace(siteName), "Target"):
		target.StartTask(input)
	case strings.EqualFold(strings.TrimSpace(siteName), "Pokemon Center US"):
		pokemoncenter.StartTask(input)
	case strings.EqualFold(strings.TrimSpace(siteName), "Walmart"):
		walmart.StartTask(input)
	case strings.EqualFold(strings.TrimSpace(siteName), "Costco"):
		costco.StartTask(input)
	case strings.EqualFold(strings.TrimSpace(siteName), "QueueIt"),
		strings.EqualFold(strings.TrimSpace(siteName), "Queue-It"),
		strings.EqualFold(strings.TrimSpace(siteName), "Queue-it"):
		queueit.StartOrReject(input)
	default:
		log.Printf("unsupported site in Zyn engine: %q", siteName)
	}
}
