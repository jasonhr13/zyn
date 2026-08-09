//go:build !zyn

package frontend

import (
	"log"

	"github.com/PolarAIO/Polar-AIO/backend/sites"
	pokemoncenter "github.com/PolarAIO/Polar-AIO/backend/sites/pokemonCenter"
	"github.com/PolarAIO/Polar-AIO/backend/sites/target"
	"github.com/PolarAIO/Polar-AIO/backend/sites/walmart"
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
