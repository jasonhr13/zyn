//go:build zyn

package frontend

import (
	"log"
	"strings"

	"github.com/PolarAIO/Polar-AIO/backend/sites"
	"github.com/PolarAIO/Polar-AIO/backend/sites/target"
)

func dispatchStartTask(siteName string, input sites.TaskInput) {
	if strings.EqualFold(strings.TrimSpace(siteName), "Target") {
		target.StartTask(input)
		return
	}
	log.Printf("unsupported site in Zyn engine: %q", siteName)
}
