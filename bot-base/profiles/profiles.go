package profiles

import (
	"encoding/json"
	"math/rand"
	"sync"
)

type safeProfiles struct {
	mu    sync.RWMutex
	value map[string]Profile
}

func (s *safeProfiles) get(id string) (Profile, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	p, ok := s.value[id]
	return p, ok
}

var profileStore = safeProfiles{value: map[string]Profile{}}

type usedTracker struct {
	mu    sync.Mutex
	value map[string]map[string]bool
}

var usedProfiles = usedTracker{value: map[string]map[string]bool{}}

func rotationKey(site, profileGroup string) string {
	return site + "|" + profileGroup
}

func (u *usedTracker) selectAfterCheckout(site, profileGroup, currentProfileID string, inGroup []Profile) (Profile, bool, bool) {
	key := rotationKey(site, profileGroup)
	u.mu.Lock()
	defer u.mu.Unlock()

	if u.value[key] == nil {
		u.value[key] = map[string]bool{}
	}
	used := u.value[key]
	used[currentProfileID] = true

	var pool []Profile
	for _, p := range inGroup {
		if !used[p.Id] {
			pool = append(pool, p)
		}
	}

	reset := false
	if len(pool) == 0 {
		reset = true
		used = map[string]bool{currentProfileID: true}
		u.value[key] = used
		for _, p := range inGroup {
			if p.Id != currentProfileID {
				pool = append(pool, p)
			}
		}
	}
	if len(pool) == 0 {
		pool = inGroup
	}

	return pool[rand.Intn(len(pool))], true, reset
}

func GetProfile(profileID string) (Profile, bool) {
	return profileStore.get(profileID)
}

func IsProfileUsed(site, profileGroup, profileID string) bool {
	if profileGroup == "" {
		return false
	}
	key := rotationKey(site, profileGroup)
	usedProfiles.mu.Lock()
	defer usedProfiles.mu.Unlock()
	return usedProfiles.value[key][profileID]
}

func MarkProfileUsed(site, profileGroup, profileID string) {
	if profileGroup == "" || profileID == "" {
		return
	}
	key := rotationKey(site, profileGroup)
	usedProfiles.mu.Lock()
	defer usedProfiles.mu.Unlock()
	if usedProfiles.value[key] == nil {
		usedProfiles.value[key] = map[string]bool{}
	}
	usedProfiles.value[key][profileID] = true
}

func PickProfile(currentProfileID, profileGroup string) (Profile, bool) {
	if profileGroup == "" {
		return Profile{}, false
	}

	profileStore.mu.RLock()
	var pool []Profile
	for _, p := range profileStore.value {
		if p.ProfileGroup == profileGroup && p.Id != currentProfileID {
			pool = append(pool, p)
		}
	}
	profileStore.mu.RUnlock()

	if len(pool) == 0 {
		return Profile{}, false
	}
	return pool[rand.Intn(len(pool))], true
}

func RotateProfile(currentProfileID, profileGroup, site string) (Profile, bool, bool) {
	if profileGroup == "" {
		return Profile{}, false, false
	}

	profileStore.mu.RLock()
	var inGroup []Profile
	for _, p := range profileStore.value {
		if p.ProfileGroup == profileGroup {
			inGroup = append(inGroup, p)
		}
	}
	profileStore.mu.RUnlock()

	if len(inGroup) == 0 {
		return Profile{}, false, false
	}

	return usedProfiles.selectAfterCheckout(site, profileGroup, currentProfileID, inGroup)
}

func SetProfiles(in map[string]Profile) {
	if in == nil {
		return
	}
	profileStore.mu.Lock()
	defer profileStore.mu.Unlock()
	next := make(map[string]Profile, len(in))
	for k, v := range in {
		next[k] = v
	}
	profileStore.value = next
}

func SetProfilesFromJSON(raw []byte) error {
	if len(raw) == 0 {
		return nil
	}
	var m map[string]Profile
	if err := json.Unmarshal(raw, &m); err != nil {
		return err
	}
	if len(m) > 0 {
		SetProfiles(m)
	}
	return nil
}
