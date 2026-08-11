//go:build !zyn

package frontend

import (
	"log"

	"zynbot.app/engine/sites"
	pokemoncenter "zynbot.app/engine/sites/pokemonCenter"
	"zynbot.app/engine/sites/target"
	"zynbot.app/engine/sites/walmart"
)

func dispatchStartTask(siteName string, input sites.TaskInput) {
	switch siteName {
	case "Pokemon Center", "Pokemon Center US", "Pokemon Center CA", "Pokemon Center DE", "Pokemon Center UK":
		pokemoncenter.StartTask(input)
	case "Target":
		target.StartTask(input)
	case "Walmart":
		walmart.StartTask(input)
	default:
		log.Printf("unsupported site: %q", siteName)
	}
}
