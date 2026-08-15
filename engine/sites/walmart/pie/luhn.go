package pie

import (
	"fmt"
	"strings"
)

type luhnObj struct {
	base10 string
}

var n = luhnObj{
	base10: "0123456789",
}

func (obj *luhnObj) Luhn(e string) int {
	t := len(e) - 1
	var inc int
	for t >= 0 {
		inc += int(e[t] - '0')
		t -= 2
	}
	for t = len(e) - 2; t >= 0; {
		r := int(e[t]-'0') * 2
		if r < 10 {
			inc += r
		} else {
			inc += r - 9
		}
		t -= 2
	}
	return inc % 10
}

func (obj *luhnObj) FixLuhn(e string, t, r int) string {
	a := obj.Luhn(e)
	if a < r {
		a += 10 - r
	} else {
		a -= r
	}

	if a != 0 {
		if (len(e)-t)%2 != 0 {
			a = 10 - a
		} else if a%2 == 0 {
			a = 5 - a/2
		} else {
			a = (9-a)/2 + 5
		}
		return e[:t] + fmt.Sprint(a) + e[t+1:]
	}
	return e
}

func (obj *luhnObj) Distill(e string) string {
	var t strings.Builder
	for r := 0; r < len(e); r++ {
		if strings.IndexByte(obj.base10, e[r]) >= 0 {
			t.WriteByte(e[r])
		}
	}
	return t.String()
}

func (obj *luhnObj) Reformat(e, t string) string {
	var r strings.Builder
	a := 0
	for i := 0; i < len(t); i++ {
		if a < len(e) && strings.IndexByte(obj.base10, t[i]) >= 0 {
			r.WriteByte(e[a])
			a++
		} else {
			r.WriteByte(t[i])
		}
	}
	return r.String()
}

func (obj *luhnObj) Integrity(key, pan, cvv string) string {
	msg := string(rune(0)) + string(rune(len(pan))) + pan + string(rune(0)) + string(rune(len(cvv))) + cvv
	words := HexToWords(key)
	words[3] ^= 1
	var cipher aes
	cipher.SetAes(words)
	mac := compute(cipher, msg)
	return WordToHex(mac[0]) + WordToHex(mac[1])
}
