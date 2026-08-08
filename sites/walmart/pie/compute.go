package pie

var const_Rb = 135

func MSBnotZero(e int) bool{
	return 2147483647 != jsNum(2147483647 | jsNum(e))
}

func leftShift(e []int) []int{
	e[0] = (2147483647 & e[0]) << 1 | jsUNum(jsUNum(e[1]) >> 31)
	e[1] = (2147483647 & e[1]) << 1 | jsUNum(jsUNum(e[2]) >> 31)
	e[2] = (2147483647 & e[2]) << 1 | jsUNum(jsUNum(e[3]) >> 31)
	e[3] = (2147483647 & e[3]) << 1
	return e
}

func compute(e aes, t string) []int{
	n := []int{0, 0, 0, 0}
	r := e.encrypt(n)
	a := r[0]
	r = leftShift(r)
	if(MSBnotZero(a)){
		r[3] ^= const_Rb
	}
	var o int
	for o = 0; o < len(t); {
		n[o >> 2 & 3] ^= jsNum(int(255 & t[o]) << jsNum(8 * (3 - (3 & o))))
		o++
		if 0 == (15 & o){
			if o < len(t){
				n = e.encrypt(n)
			}
		}
	}
	if(0 != o){
		if(!(0 == (15 & o))){
			a = r[0]
			r = leftShift(r)
			if(MSBnotZero(a)){
				r[3] ^= const_Rb
			}
			n[o >> 2 & 3] ^= jsNum(128 << jsNum(8 * (3 - (3 & o))))
		}
	}
	n[0] ^= r[0]
	n[1] ^= r[1]
	n[2] ^= r[2]
	n[3] ^= r[3]
	return e.encrypt(n)
}