//go:build zyn

package frontend

import (
	"log"
	"strings"

	"zynbot.app/engine/sites"
	pokemoncenter "zynbot.app/engine/sites/pokemonCenter"
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
	default:
		log.Printf("unsupported site in Zyn engine: %q", siteName)
	}
}
