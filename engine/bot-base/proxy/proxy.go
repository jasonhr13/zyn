package proxy

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	exploreRate       = 0.30
	lineQuarantine    = 30 * time.Second
	unusedSourcePrior = 1
)

type assignment struct {
	source string
	key    string
}

type sourceScore struct {
	successes int
	fails     int
}

type proxyCandidate struct {
	source string
	line   Proxy
	free   bool
}

type pool struct {
	mu         sync.Mutex
	groups     map[string][]Proxy
	assigned   map[string]assignment          // taskID -> current line
	inUseByKey map[string]map[string]string   // source -> proxyKey -> taskID
	scores     map[string]sourceScore         // source -> score
	cooldown   map[string]time.Time           // proxyKey -> until
}

var (
	state = pool{
		groups:     map[string][]Proxy{},
		assigned:   map[string]assignment{},
		inUseByKey: map[string]map[string]string{},
		scores:     map[string]sourceScore{},
		cooldown:   map[string]time.Time{},
	}
	nowFn  = time.Now
	randN  = func(n int) int { return rand.IntN(n) }
	randF  = func() float64 { return rand.Float64() }
)

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

func proxyURL(p Proxy) string {
	p = normalizeProxy(p)
	if p.Username != "" {
		return fmt.Sprintf("http://%s:%s@%s:%s", p.Username, p.Password, p.Address, p.Port)
	}
	return fmt.Sprintf("http://%s:%s", p.Address, p.Port)
}

func AssignedProxyURL(group, taskID string) string {
	if taskID == "" {
		return ""
	}

	state.mu.Lock()
	defer state.mu.Unlock()

	asg, ok := state.assigned[taskID]
	if !ok {
		return ""
	}
	source := asg.source
	if group != "" && group != "Local" && source == "" {
		source = group
	}
	for _, p := range state.groups[source] {
		if proxyKey(p) != asg.key {
			continue
		}
		return proxyURL(p)
	}
	return ""
}

func ReleaseProxy(group, taskID string) {
	if taskID == "" {
		return
	}

	state.mu.Lock()
	defer state.mu.Unlock()
	releaseLocked(taskID)
}

func releaseLocked(taskID string) {
	asg, ok := state.assigned[taskID]
	if !ok {
		return
	}
	delete(state.assigned, taskID)
	if inUse, ok := state.inUseByKey[asg.source]; ok {
		if owner, exists := inUse[asg.key]; exists && owner == taskID {
			delete(inUse, asg.key)
		}
		if len(inUse) == 0 {
			delete(state.inUseByKey, asg.source)
		}
	}
}

func GetProxy(group, taskID string) (*Proxy, error) {
	return GetProxyFrom([]string{group}, taskID)
}

func GetProxyFrom(sources []string, taskID string) (*Proxy, error) {
	if taskID == "" {
		return nil, errors.New("missing task ID")
	}
	cleaned := cleanSources(sources)
	if len(cleaned) == 0 {
		return nil, errors.New("invalid group")
	}

	state.mu.Lock()
	defer state.mu.Unlock()

	releaseLocked(taskID)
	now := nowFn()
	cleanCooldownsLocked(now)

	bySource := make(map[string][]proxyCandidate, len(cleaned))
	for _, source := range cleaned {
		lines, ok := state.groups[source]
		if !ok {
			continue
		}
		unique := dedupeProxies(lines)
		if len(unique) == 0 {
			continue
		}
		inUse := state.inUseByKey[source]
		for _, p := range unique {
			key := proxyKey(p)
			if until, cooling := state.cooldown[key]; cooling && until.After(now) {
				continue
			}
			_, taken := inUse[key]
			bySource[source] = append(bySource[source], proxyCandidate{source: source, line: p, free: !taken})
		}
		if _, ok := bySource[source]; !ok {
			// Every line is cooling; still allow reuse so a task can start.
			for _, p := range unique {
				_, taken := inUse[proxyKey(p)]
				bySource[source] = append(bySource[source], proxyCandidate{source: source, line: p, free: !taken})
			}
		}
	}
	if len(bySource) == 0 {
		if len(cleaned) == 1 {
			if _, ok := state.groups[cleaned[0]]; !ok {
				return nil, errors.New("invalid group")
			}
			return nil, errors.New("proxy group has 0 proxies")
		}
		return nil, errors.New("invalid group")
	}

	sourceOrder := make([]string, 0, len(cleaned))
	for _, source := range cleaned {
		if _, ok := bySource[source]; ok {
			sourceOrder = append(sourceOrder, source)
		}
	}
	pickedSource := pickSourceLocked(sourceOrder, bySource)
	choices := bySource[pickedSource]
	free := make([]proxyCandidate, 0, len(choices))
	for _, c := range choices {
		if c.free {
			free = append(free, c)
		}
	}
	if len(free) > 0 {
		choices = free
	}
	pick := choices[randN(len(choices))].line
	key := proxyKey(pick)
	if state.inUseByKey[pickedSource] == nil {
		state.inUseByKey[pickedSource] = map[string]string{}
	}
	if _, taken := state.inUseByKey[pickedSource][key]; !taken {
		state.inUseByKey[pickedSource][key] = taskID
	}
	state.assigned[taskID] = assignment{source: pickedSource, key: key}
	out := normalizeProxy(pick)
	return &out, nil
}

func pickSourceLocked(order []string, bySource map[string][]proxyCandidate) string {
	if len(order) == 1 {
		return order[0]
	}
	freeSources := make([]string, 0, len(order))
	for _, source := range order {
		for _, c := range bySource[source] {
			if c.free {
				freeSources = append(freeSources, source)
				break
			}
		}
	}
	pool := order
	if len(freeSources) > 0 {
		pool = freeSources
	}
	if randF() < exploreRate {
		return pool[randN(len(pool))]
	}
	best := pool[0]
	bestScore := sourceWeight(state.scores[best])
	for _, source := range pool[1:] {
		score := sourceWeight(state.scores[source])
		if score > bestScore {
			best = source
			bestScore = score
		}
	}
	return best
}

func sourceWeight(score sourceScore) float64 {
	return float64(score.successes+unusedSourcePrior) / float64(score.successes+score.fails+unusedSourcePrior*2)
}

func RecordProxyResult(taskID string, success bool) {
	if taskID == "" {
		return
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	asg, ok := state.assigned[taskID]
	if !ok {
		return
	}
	score := state.scores[asg.source]
	if success {
		score.successes++
	} else {
		score.fails++
		state.cooldown[asg.key] = nowFn().Add(lineQuarantine)
	}
	state.scores[asg.source] = score
}

func AssignedSource(taskID string) string {
	if taskID == "" {
		return ""
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	return state.assigned[taskID].source
}

func cleanSources(sources []string) []string {
	out := make([]string, 0, len(sources))
	seen := map[string]struct{}{}
	for _, raw := range sources {
		source := strings.TrimSpace(raw)
		if source == "" || strings.EqualFold(source, "Local") {
			continue
		}
		if _, dup := seen[source]; dup {
			continue
		}
		seen[source] = struct{}{}
		out = append(out, source)
	}
	return out
}

func cleanCooldownsLocked(now time.Time) {
	for key, until := range state.cooldown {
		if !until.After(now) {
			delete(state.cooldown, key)
		}
	}
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

	valid := map[string]map[string]struct{}{}
	for group, lines := range state.groups {
		keys := make(map[string]struct{}, len(lines))
		for _, p := range lines {
			keys[proxyKey(p)] = struct{}{}
		}
		valid[group] = keys
	}
	for taskID, asg := range state.assigned {
		if keys, ok := valid[asg.source]; ok {
			if _, found := keys[asg.key]; found {
				continue
			}
		}
		releaseLocked(taskID)
	}
}

func SetProxiesFromJSON(raw []byte) {
	var proxies map[string][]Proxy
	_ = json.Unmarshal(raw, &proxies)

	if proxies != nil {
		SetProxies(proxies)
	}
}

func ResetForTest() {
	state.mu.Lock()
	defer state.mu.Unlock()
	state.groups = map[string][]Proxy{}
	state.assigned = map[string]assignment{}
	state.inUseByKey = map[string]map[string]string{}
	state.scores = map[string]sourceScore{}
	state.cooldown = map[string]time.Time{}
	nowFn = time.Now
	randN = func(n int) int { return rand.IntN(n) }
	randF = func() float64 { return rand.Float64() }
}
