package pie

import (
	"encoding/hex"
)

func HexToKey(e string) aes{
	outobj := aes{}
	outobj.SetAes(HexToWords(e))
	return outobj
}

func HexToWords(e string)(arrout []int){
	for i := 0; i < 4; i++{
		decoded, err := hex.DecodeString(e[8*i:8*(i+1)])
		if err != nil{
			panic(err)
		}
		arrout = append(arrout, int(decoded[0])<<24 | int(decoded[1])<<16 | int(decoded[2])<<8| int(decoded[3]))
	}
	return
}

func WordToHex(e int) (n string){
	t := 24
	for n = ""; t >= 0; t -= 8{
		n += hex.EncodeToString([]byte{byte(e >> t & 255)})
	}
	return n
}