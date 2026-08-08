package accounts

import (
	"encoding/json"
	"sync"
)

type safeAccounts struct {
	mu    sync.RWMutex
	value map[string]Account
}

func (s *safeAccounts) get(id string) (Account, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	p, ok := s.value[id]
	return p, ok
}

func (s *safeAccounts) updateCookie(id string, cookie string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	account, ok := s.value[id]
	if !ok {
		return false
	}
	account.Cookie = cookie
	s.value[id] = account
	return true
}

func (s *safeAccounts) updatePassword(id string, password string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	account, ok := s.value[id]
	if !ok {
		return false
	}
	account.Password = password
	s.value[id] = account
	return true
}

var accountStore = safeAccounts{value: map[string]Account{}}

func GetAccount(AccountID string) (Account, bool) {
	return accountStore.get(AccountID)
}

func SetAccounts(in map[string]Account) {
	if in == nil {
		return
	}
	accountStore.mu.Lock()
	defer accountStore.mu.Unlock()
	next := make(map[string]Account, len(in))
	for k, v := range in {
		next[k] = v
	}
	accountStore.value = next
}

func SetAccountsFromJSON(data []byte) error {
	if len(data) == 0 {
		return nil
	}
	var m map[string]Account
	if err := json.Unmarshal(data, &m); err != nil {
		return err
	}
	if len(m) > 0 {
		SetAccounts(m)
	}
	return nil
}

func UpdateCookie(accountID string, cookie string) bool {
	return accountStore.updateCookie(accountID, cookie)
}

func UpdatePassword(accountID string, password string) bool {
	return accountStore.updatePassword(accountID, password)
}
