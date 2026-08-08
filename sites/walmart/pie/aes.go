package pie

import (
	"log"
)

type aes struct{
	tables [][][]int
	key [][]int
}

func (ae *aes) SetAes(e []int){
	if len(ae.tables) == 0{
		ae.tables = [][][]int{
			{
				{0},
				{0},
				{0},
				{0},
				{0},
			},
			{
				{0},
				{0},
				{0},
				{0},
				{0},
			},
		}
		ae.precompute()
	}
	var t, n, a int
	var i, o []int
	c := ae.tables[0][4]
	u := ae.tables[1]
	s := len(e)
	d := 1
	if 4 != s && 6 != s && 8 != s {
		log.Println("invalid aes size")
		return
	}
	i = e
	o = []int{}
	for t = s; t < 4 * s + 28; t++ {
		a = i[t - 1]
		if t % s == 0 || 8 == s && t % s == 4{
			a = jsNum(jsNum(c[jsUNum(jsUNum(a) >> 24)] << 24) ^ jsNum(c[a >> 16 & 255] << 16) ^ jsNum(c[a >> 8 & 255] << 8) ^ jsNum(c[255 & a]))
			if t % s == 0 {
				a = jsNum(jsNum(a << 8) ^ jsUNum(jsUNum(a) >> 24) ^ jsNum(d << 24))
				d = jsNum(jsNum(d << 1) ^ jsNum(283 * (d >> 7)))
			}
		}
		i = append(i, jsNum(jsNum(i[t - s]) ^ a))
	}
	for n = 0; t != 0; n, t = n+1, t-1 {
		if (3 & n) != 0{
			a = i[t]
		}else{
			a = i[t - 4]
		}
		if t <= 4 || n < 4 {
			o = append(o, a)
		}else{
			o = append(o, u[0][c[jsUNum(jsUNum(a) >> 24)]] ^ u[1][c[a >> 16 & 255]] ^ u[2][c[a >> 8 & 255]] ^ u[3][c[255 & a]])
		}
	}
	ae.key = [][]int{i, o}
}

func (ae *aes) encrypt(e []int) []int{
		res := ae.crypt(e, 0)
		return res
}
func (ae *aes) precompute(){
	var e, t, n, r, a, i, o, c int
	f := []int{}
	p := []int{}
	for e = 0; e < 256; e++{
		f = append(f, e << 1 ^ 283 * (e >> 7))
		for len(p)-1 < f[e] ^ e{
			p = append(p, 0)
		}
		p[f[e] ^ e] = e
	}
	n = 0
	for t = 0; ae.tables[0][4][t] == 0; {
		i = jsNum(n) ^ jsNum(jsNum(n) << jsNum(1)) ^ jsNum(jsNum(n) << jsNum(2)) ^ jsNum(jsNum(n) << jsNum(3)) ^ jsNum(jsNum(n) << jsNum(4))
		i = jsNum(jsNum(i) >> jsNum(8)) ^ jsNum(jsNum(255) & jsNum(i)) ^ 99
		for len(ae.tables[0][4]) - 1 < t{
			ae.tables[0][4] = append(ae.tables[0][4], 0)
		}
		for len(ae.tables[1][4]) - 1 < i{
			ae.tables[1][4] = append(ae.tables[1][4], 0)
		}
		ae.tables[0][4][t] = i
		ae.tables[1][4][i] = t
		r = f[t]
		a = f[r]
		c = jsNum(jsNum(16843009 * f[a]) ^ jsNum(65537 * a) ^ jsNum(257 * r) ^ jsNum(16843008 * t))
		o = jsNum(jsNum(257 * f[i]) ^ jsNum(16843008 * i))
		for e = 0; e < 4; e++ {
			o = jsNum(jsNum(o) << jsNum(24)) ^ jsUNum(jsUNum(o) >> 8)
			for len(ae.tables[0])-1 < e{
				ae.tables[0] = append(ae.tables[0], []int{})
			}
			for len(ae.tables[0][e])-1 < t{
				ae.tables[0][e] = append(ae.tables[0][e], 0)
			}
			ae.tables[0][e][t] = o
			c = jsNum(jsNum(c) << jsNum(24)) ^ jsUNum(jsUNum(c) >> 8)
			for len(ae.tables[1])-1 < e{
				ae.tables[1] = append(ae.tables[1], []int{})
			}
			for len(ae.tables[1][e])-1 < i{
				ae.tables[1][e] = append(ae.tables[1][e], 0)
			}
			ae.tables[1][e][i] = c
		}
		if 0 == r {
			t ^= 1
		}else{
			t ^= r
		}
		if (0 == p[n]){
			n = 1
		}else{
			n = p[n]
		}
		for len(ae.tables[0][4])-1 < t{
			ae.tables[0][4] = append(ae.tables[0][4], 0)
		}
	}
}
func (ae *aes) crypt(e []int, t int) []int{
	if 4 != len(e){
		log.Println("invalid aes block size")
		return nil
	}
	var n, a, i, o, s, l int
	c := ae.key[t]
	u := jsNum(jsNum(e[0]) ^ jsNum(c[0]))
	if t != 0{
		s = jsNum(jsNum(e[3]) ^ jsNum(c[1]))
	}else{
		s = jsNum(jsNum(e[1]) ^ jsNum(c[1]))
	}
	d := jsNum(jsNum(e[2]) ^ jsNum(c[2]))
	if t != 0{
		l = jsNum(jsNum(e[1]) ^ jsNum(c[3]))
	}else{
		l = jsNum(jsNum(e[3]) ^ jsNum(c[3]))
	}
	f := len(c) / 4 - 2
	p := 4
	m := []int{0, 0, 0, 0}
	b := ae.tables[t][0]
	h := ae.tables[t][1]
	sb := ae.tables[t][2]
	v := ae.tables[t][3]
	y := ae.tables[t][4]
		for o = 0; o < f; o++{
				n = jsNum(b[jsUNum(jsUNum(u) >> 24)] ^ h[jsNum(jsNum(s) >> 16) & 255] ^ sb[jsNum(jsNum(d) >> 8) & 255] ^ v[255 & l] ^ c[p])
		a = jsNum(b[jsUNum(jsUNum(s) >> 24)] ^ h[jsNum(jsNum(d) >> 16) & 255] ^ sb[jsNum(jsNum(l) >> 8) & 255] ^ v[255 & u] ^ c[p + 1])
		i = jsNum(b[jsUNum(jsUNum(d) >> 24)] ^ h[jsNum(jsNum(l) >> 16) & 255] ^ sb[jsNum(jsNum(u) >> 8) & 255] ^ v[255 & s] ^ c[p + 2])
		l = jsNum(b[jsUNum(jsUNum(l) >> 24)] ^ h[jsNum(jsNum(u) >> 16) & 255] ^ sb[jsNum(jsNum(s) >> 8) & 255] ^ v[255 & d] ^ c[p + 3])
		p += 4
		u = n
		s = a
		d = i
	}
	for o = 0; o < 4; o++ {
		if t == 1{
			m[3 & -o] = jsNum(jsNum(y[jsUNum(jsUNum(u) >> 24)]) << 24) ^ jsNum(jsNum(y[jsNum(jsNum(s) >> 16) & 255]) << 16) ^ jsNum(jsNum(y[jsNum(jsNum(d) >> 8) & 255]) << 8) ^ jsNum(y[255 & l]) ^ c[p]
		}else{
			m[o] = jsNum(jsNum(y[jsUNum(jsUNum(u) >> 24)]) << 24) ^ jsNum(jsNum(y[jsNum(jsNum(s) >> 16) & 255]) << 16) ^ jsNum(jsNum(y[jsNum(jsNum(d) >> 8) & 255]) << 8) ^ jsNum(y[255 & l]) ^ c[p]
		}
		p++
		n = u
		u = s
		s = d
		d = l
		l = n
	}
	return m
}
func jsNum(x int) int{
	return int(int32(x))
}
func jsUNum(x int) int {
	return int(uint32(x))
}
