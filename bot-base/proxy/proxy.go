package proxy

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"net/url"
	"strings"
	"sync"
)

type pool struct {
	mu          sync.Mutex
	groups      map[string][]Proxy
	byTask      map[string]map[string]string // group -> taskID -> proxyKey
	inUseByKey  map[string]map[string]string // group -> proxyKey -> taskID
}

var state = pool{
	groups:     map[string][]Proxy{},
	byTask:     map[string]map[string]string{},
	inUseByKey: map[string]map[string]string{},
}

func proxyKey(p Proxy) string {
	return strings.ToLower(strings.TrimSpace(p.Address)) + ":" +
		strings.TrimSpace(p.Port) + ":" +
		strings.TrimSpace(p.Username) + ":" +
		strings.TrimSpace(p.Password)
}

func normalizeProxy(p Proxy) Proxy {
	return Proxy{
		Address:  strings.TrimSpace(p.Address),
		Port:     strings.TrimSpace(p.Port),
		Username: url.QueryEscape(strings.TrimSpace(p.Username)),
		Password: url.QueryEscape(strings.TrimSpace(p.Password)),
	}
}

func AssignedProxyURL(group, taskID string) string {
	if group == "" || group == "Local" || taskID == "" {
		return ""
	}

	state.mu.Lock()
	defer state.mu.Unlock()

	byTask, ok := state.byTask[group]
	if !ok {
		return ""
	}
	key, ok := byTask[taskID]
	if !ok {
		return ""
	}

	for _, p := range state.groups[group] {
		if proxyKey(p) != key {
			continue
		}
		p = normalizeProxy(p)
		if p.Username != "" {
			return fmt.Sprintf("http://%s:%s@%s:%s", p.Username, p.Password, p.Address, p.Port)
		}
		return fmt.Sprintf("http://%s:%s", p.Address, p.Port)
	}
	return ""
}

func ReleaseProxy(group, taskID string) {
	if taskID == "" || group == "" || group == "Local" {
		return
	}

	state.mu.Lock()
	defer state.mu.Unlock()

	byTask, ok := state.byTask[group]
	if !ok {
		return
	}
	key, ok := byTask[taskID]
	if !ok {
		return
	}
	delete(byTask, taskID)
	if len(byTask) == 0 {
		delete(state.byTask, group)
	}
	if inUse, ok := state.inUseByKey[group]; ok {
		delete(inUse, key)
		if len(inUse) == 0 {
			delete(state.inUseByKey, group)
		}
	}
}

func GetProxy(group, taskID string) (*Proxy, error) {
	if taskID == "" {
		return nil, errors.New("missing task ID")
	}

	state.mu.Lock()
	defer state.mu.Unlock()

	proxyGroup, ok := state.groups[group]
	if !ok {
		return nil, errors.New("invalid group")
	}
	if len(proxyGroup) == 0 {
		return nil, errors.New("proxy group has 0 proxies")
	}

	inUse := state.inUseByKey[group]
	if inUse == nil {
		inUse = map[string]string{}
		state.inUseByKey[group] = inUse
	}

	unique := dedupeProxies(proxyGroup)
	available := make([]Proxy, 0, len(unique))
	for _, p := range unique {
		if _, taken := inUse[proxyKey(p)]; taken {
			continue
		}
		available = append(available, p)
	}
	if len(available) == 0 {
		available = unique
	}

	pick := available[rand.IntN(len(available))]
	key := proxyKey(pick)
	if _, taken := inUse[key]; !taken {
		inUse[key] = taskID
	}

	byTask := state.byTask[group]
	if byTask == nil {
		byTask = map[string]string{}
		state.byTask[group] = byTask
	}
	byTask[taskID] = key

	out := normalizeProxy(pick)
	return &out, nil
}

func dedupeProxies(proxyGroup []Proxy) []Proxy {
	out := make([]Proxy, 0, len(proxyGroup))
	seen := make(map[string]struct{}, len(proxyGroup))
	for _, p := range proxyGroup {
		key := proxyKey(p)
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, p)
	}
	return out
}

func SetProxies(proxiesIn map[string][]Proxy) {
	state.mu.Lock()
	defer state.mu.Unlock()

	state.groups = make(map[string][]Proxy, len(proxiesIn))
	for group, proxyArr := range proxiesIn {
		state.groups[group] = proxyArr
	}

	for group, byTask := range state.byTask {
		validKeys := make(map[string]struct{}, len(state.groups[group]))
		for _, p := range state.groups[group] {
			validKeys[proxyKey(p)] = struct{}{}
		}
		for taskID, key := range byTask {
			if _, ok := validKeys[key]; ok {
				continue
			}
			delete(byTask, taskID)
			if inUse := state.inUseByKey[group]; inUse != nil {
				delete(inUse, key)
			}
		}
		if len(byTask) == 0 {
			delete(state.byTask, group)
			delete(state.inUseByKey, group)
		}
	}
}

func SetProxiesFromJSON(raw []byte) {
	var proxies map[string][]Proxy
	_ = json.Unmarshal(raw, &proxies)

	if proxies != nil {
		SetProxies(proxies)
	}
}
