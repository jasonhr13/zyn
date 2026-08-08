//go:build darwin || linux

package security

import (
	"bytes"
	"os/exec"
	"strings"
)

func listProcessNames() ([]string, error) {
	out, err := exec.Command("ps", "-eo", "comm=").Output()
	if err != nil {
		return nil, err
	}

	lines := strings.Split(string(out), "\n")
	names := make([]string, 0, len(lines))
	for _, line := range lines {
		name := strings.TrimSpace(line)
		if name == "" {
			continue
		}
		names = append(names, name)
	}

	cmdOut, err := exec.Command("ps", "-eo", "args=").Output()
	if err == nil {
		for _, line := range bytes.Split(cmdOut, []byte("\n")) {
			line = bytes.TrimSpace(line)
			if len(line) == 0 {
				continue
			}
			names = append(names, string(line))
		}
	}

	return names, nil
}
