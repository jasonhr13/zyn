package main

import (
	"log"
	"strings"
	"sync"
	"time"
)

const (
	proxyFailThreshold = 3
	proxyCooldown      = 10 * time.Minute
)

type proxyPool struct {
	mu      sync.Mutex
	entries []proxyEntry
	i       int
}

type proxyEntry struct {
	url          string
	fails        int
	benchedUntil time.Time
}

func newProxyPool(urls []string) *proxyPool {
	p := &proxyPool{}
	for _, u := range urls {
		u = normalizeProxy(strings.TrimSpace(u))
		if u == "" {
			continue
		}
		p.entries = append(p.entries, proxyEntry{url: u})
	}
	if len(p.entries) == 0 {
		log.Printf("no PROXY_URLS — using direct connection")
	} else {
		log.Printf("proxy pool ready (%d)", len(p.entries))
	}
	return p
}

func (p *proxyPool) current() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.entries) == 0 {
		return ""
	}
	now := time.Now()
	for n := 0; n < len(p.entries); n++ {
		e := &p.entries[p.i%len(p.entries)]
		if e.benchedUntil.Before(now) || e.benchedUntil.IsZero() {
			return e.url
		}
		p.i++
	}
	return p.entries[p.i%len(p.entries)].url
}

func (p *proxyPool) mark(ok bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.entries) == 0 {
		return
	}
	e := &p.entries[p.i%len(p.entries)]
	if ok {
		e.fails = 0
		return
	}
	e.fails++
	if e.fails >= proxyFailThreshold {
		e.benchedUntil = time.Now().Add(proxyCooldown)
		e.fails = 0
		log.Printf("proxy benched for %s (index %d)", proxyCooldown, p.i%len(p.entries))
		p.i++
	}
}

func (p *proxyPool) rotate() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.entries) == 0 {
		return
	}
	e := &p.entries[p.i%len(p.entries)]
	e.benchedUntil = time.Now().Add(proxyCooldown)
	e.fails = 0
	p.i++
	log.Printf("proxy rotated (captcha/hard fail); now index %d/%d", p.i%len(p.entries), len(p.entries))
}

func (p *proxyPool) status() (total, benched, index int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := time.Now()
	for i := range p.entries {
		if !p.entries[i].benchedUntil.IsZero() && p.entries[i].benchedUntil.After(now) {
			benched++
		}
	}
	return len(p.entries), benched, p.i
}
