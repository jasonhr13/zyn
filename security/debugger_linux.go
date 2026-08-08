//go:build linux

package security

import (
	"os"
	"strings"
)

func debuggerAttached() (bool, string) {
	data, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return false, ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		if !strings.HasPrefix(line, "TracerPid:") {
			continue
		}
		if strings.TrimSpace(strings.TrimPrefix(line, "TracerPid:")) != "0" {
			return true, "process has a non-zero TracerPid"
		}
		return false, ""
	}
	return false, ""
}
