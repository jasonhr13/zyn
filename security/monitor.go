package security

import (
	"log"
	"os"
	"strings"
	"time"
)

// Monitor periodically re-scans and exits the process when a threat is found.
func Monitor(interval time.Duration) {
	if interval <= 0 {
		interval = 30 * time.Second
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for range ticker.C {
		if threats := Scan(); len(threats) > 0 {
			details := make([]string, len(threats))
			for i, t := range threats {
				details[i] = t.String()
			}
			log.Printf("security monitor: threat(s) detected: %s", strings.Join(details, " | "))
			alertThreat(threats)
			os.Exit(1)
		}
	}
}
