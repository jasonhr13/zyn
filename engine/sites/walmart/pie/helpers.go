package pie

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

var alphabet = []string{"0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z"}

func precompF(e aes, t int, n string, r int) []int{
	var a []int
	i := len(n)
	a = append(a, jsNum(16908544 | ((r >> 16) & 255)))
	a = append(a, (r >> 8 & 255) << 24 | (255 & r) << 16 | 2560 | 255 & int(math.Floor(float64(t) / 2)))
	a = append(a, t)
	a = append(a, i)
	res := e.encrypt(a)
	return res
}
func precompb(e, t int) int{
	r := 0
	a := 1
	for n := int(math.Ceil(float64(t) / 2)); n > 0; {
		n--
		a *= e
		if a >= 256{
			a /= 256
			r++
		}
	}
	if a > 1{
		r++
	}
	return r
}
func bnMultiply(e []int, t, n int) []int{
	var r int
	a := 0
	for r = len(e) - 1; r >= 0; r--{
		i := e[r] * n + a
		e[r] = i % t
		a = (i - e[r]) / t
	}
	return e
}
func bnAdd(e []int, t, n int) []int{
	r := len(e) - 1
	for a := n; r >= 0 && a > 0; {
		var i = e[r] + a
		e[r] = i % t
		a = (i - e[r]) / t
		r--
	}
	return e
}
func convertRadix(e []int, t, n, r, a int) []int{
	var i int
	var c []int
	for i = 0; i < r; i++ {
		c = append(c, 0)
	}
	for u := 0; u < t; u++{
		c = bnMultiply(c, a, n);
		c = bnAdd(c, a, e[u]);
	}
	return c
}
func cbcmacqByte(t []int, i int) int {
	if i < 0 || i >= len(t) {
		return 0
	}
	return t[i]
}
func cbcmacq(e, t []int, n int, r aes) []int{
	var a []int
	for i := 0; i < 4; i++{
		a = append(a, e[i])
	}
	for o := 0; 4 * o < n; {
		for i := 0; i < 4; i++{
			base := 4 * (o + i)
			a[i] = a[i] ^ jsNum(jsNum(cbcmacqByte(t, base)<<24)|jsNum(cbcmacqByte(t, base+1)<<16)|jsNum(cbcmacqByte(t, base+2)<<8)|jsNum(cbcmacqByte(t, base+3)))
		}
		a = r.encrypt(a)
		o += 4
	}
	return a
}
func F(e aes, t int, n string, r []int, a, i int, c []int, u int, s int) []int{
	d := int(math.Ceil(float64(s)/4) + 1)
	g := (len(n) + s + 1) & 15
	if g > 0 {
		g = 16 - g
	}
	p := make([]int, len(n)+g+s+1)
	for f := 0; f < len(n); f++ {
		p[f] = int(n[f])
	}
	p[len(p)-s-1] = t
	m := convertRadix(r, a, u, s, 256)
	for E := 0; E < s; E++ {
		p[len(p)-s+E] = m[E]
	}
	h := cbcmacq(c, p, len(p), e)
	sb := h
	var v []int
	for f := 0; f < d; f++ {
		if f > 0 && (3&f) == 0 {
			round := f >> 2
			xor := round | round<<8 | round<<16 | round<<24
			sb = e.encrypt([]int{h[0] ^ xor, h[1] ^ xor, h[2] ^ xor, h[3] ^ xor})
		}
		v = append(v, jsUNum(jsUNum(sb[3&f])>>16))
		v = append(v, jsNum(65535&sb[3&f]))
	}
	return convertRadix(v, 2*d, 65536, i, u)
}
func DigitToVal(e string, t int, n int) []int {
	var r []int
	for i := 0; i < t; i++ {
		parsed, err := strconv.ParseInt(fmt.Sprintf("%c", e[i]), n, 64)
		if err != nil {
			panic(err)
		}
		o := int(parsed)
		if !(o < n) {
			return nil
		}
		r = append(r, o)
	}
	return r
}
func ValToDigit(e []int, t int) string {
	var r strings.Builder
	for n := 0; n < len(e); n++ {
		r.WriteString(alphabet[e[n]])
	}
	return r.String()
}
func encryptWithCipher(e, t string, r int, n aes) string{
	a := len(e)
	i := a / 2
	c := precompF(n, a, t, r)
	u := precompb(r, a)
	s := DigitToVal(e, i, r)
	d := DigitToVal(e[i:], a - i, r)
	if len(s) == 0 || len(d) == 0 {
		return ""
	}
	for l := 0; l < 5; l++{
		p := F(n, 2 * l, t, d, len(d), len(s), c, r, u)
		f := 0
		for m := len(s) - 1; m >= 0; m--{
			E := s[m] + p[m] + f
			if (s[m] + p[m] + f) < r{
				s[m] = E
				f = 0
			}else{
				s[m] = E - r
				f = 1
			}
		}
		p = F(n, 2 * l + 1, t, s, len(s), len(d), c, r, u)
		f = 0
		for m := len(d) - 1; m >= 0; m-- {
			E := d[m] + p[m] + f
			if (d[m] + p[m] + f) < r{
				d[m] = E
				f = 0
			}else
			{
				d[m] = E - r
				f = 1
			}
		}
	}
	return ValToDigit(s, r) + ValToDigit(d, r)
}
func encrypt(e, t, n string, r int) string{
	i := HexToKey(n)
	if len(i.tables) == 0{
		return ""
	}else{
		return encryptWithCipher(e, t, r, i)
	}
}