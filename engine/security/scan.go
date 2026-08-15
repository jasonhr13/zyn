package security

import (
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type Threat struct {
	Kind   string
	Detail string
}

func (t Threat) String() string {
	return fmt.Sprintf("%s: %s", t.Kind, t.Detail)
}

func Scan() []Threat {
	var threats []Threat

	threats = append(threats, scanSuspiciousEnv()...)
	threats = append(threats, scanSuspiciousProcesses()...)
	threats = append(threats, scanFridaPorts()...)
	threats = append(threats, scanFridaArtifacts()...)

	if attached, detail := debuggerAttached(); attached {
		threats = append(threats, Threat{Kind: "debugger", Detail: detail})
	}

	return threats
}

func scanSuspiciousEnv() []Threat {
	var threats []Threat
	for _, name := range SuspiciousEnvVars {
		if val := strings.TrimSpace(os.Getenv(name)); val != "" {
			threats = append(threats, Threat{
				Kind:   "environment",
				Detail: fmt.Sprintf("%s is set", name),
			})
		}
	}
	return threats
}

func scanSuspiciousProcesses() []Threat {
	names, err := listProcessNames()
	if err != nil {
		log.Printf("security: process scan failed: %v", err)
		return nil
	}

	seen := make(map[string]struct{})
	var threats []Threat
	for _, proc := range names {
		base := strings.ToLower(filepath.Base(proc))
		for _, suspicious := range SuspiciousProcessNames {
			if strings.Contains(base, suspicious) {
				key := suspicious + ":" + proc
				if _, ok := seen[key]; ok {
					continue
				}
				seen[key] = struct{}{}
				threats = append(threats, Threat{
					Kind:   "process",
					Detail: proc,
				})
			}
		}
	}
	return threats
}

// scanFridaArtifacts looks for frida-server independently of the process
// list: known install locations on disk, and a running/registered launchd
// service. This catches frida-server started on a non-default port (the
// port probe in scanFridaPorts only checks 27042-27045) or renamed to dodge
// the process-name check.
func scanFridaArtifacts() []Threat {
	var threats []Threat

	for _, path := range FridaArtifactPaths {
		if _, err := os.Stat(path); err == nil {
			threats = append(threats, Threat{
				Kind:   "frida",
				Detail: fmt.Sprintf("artifact present: %s", path),
			})
		}
	}

	out, err := exec.Command("launchctl", "list").Output()
	if err != nil {
		return threats
	}
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		label := fields[len(fields)-1]
		if strings.Contains(strings.ToLower(label), "frida") {
			threats = append(threats, Threat{
				Kind:   "frida",
				Detail: fmt.Sprintf("launchd service: %s", label),
			})
		}
	}
	return threats
}

func scanFridaPorts() []Threat {
	var threats []Threat
	for _, port := range FridaDefaultPorts {
		addr := fmt.Sprintf("127.0.0.1:%d", port)
		conn, err := net.DialTimeout("tcp", addr, 150*time.Millisecond)
		if err != nil {
			continue
		}
		_ = conn.Close()
		threats = append(threats, Threat{
			Kind:   "frida",
			Detail: fmt.Sprintf("listener on %s", addr),
		})
	}
	return threats
}
