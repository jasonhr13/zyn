package security

import (
	"os/exec"
	"strings"
)

func listProcessNames() ([]string, error) {
	out, err := exec.Command("tasklist", "/FO", "CSV", "/NH").Output()
	if err != nil {
		return nil, err
	}

	lines := strings.Split(string(out), "\n")
	names := make([]string, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, `"`) {
			end := strings.Index(line[1:], `"`)
			if end >= 0 {
				names = append(names, line[1:1+end])
				continue
			}
		}
		names = append(names, line)
	}
	return names, nil
}
