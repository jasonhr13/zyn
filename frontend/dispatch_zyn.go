//go:build zyn

package frontend

import (
	"log"
	"strings"

	"github.com/PolarAIO/Polar-AIO/backend/sites"
	pokemoncenter "github.com/PolarAIO/Polar-AIO/backend/sites/pokemonCenter"
	"github.com/PolarAIO/Polar-AIO/backend/sites/target"
)

func dispatchStartTask(siteName string, input sites.TaskInput) {
	switch {
	case strings.EqualFold(strings.TrimSpace(siteName), "Target"):
		target.StartTask(input)
	case strings.EqualFold(strings.TrimSpace(siteName), "Pokemon Center US"):
		pokemoncenter.StartTask(input)
	default:
		log.Printf("unsupported site in Zyn engine: %q", siteName)
	}
}
