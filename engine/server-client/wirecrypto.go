package serverclient

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
)

// wireKeyHex must match the WIRE_KEY used by polar-ws's wireCrypto module.
const wireKeyHex = "7011fb72b65c75f8212859f17b895cc76613b093eff302f79a27eda1b51d4ebb"

var wireGCM cipher.AEAD

func init() {
	key, err := hex.DecodeString(wireKeyHex)
	if err != nil || len(key) != 32 {
		panic("server-client: invalid wire key")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		panic(err)
	}
	wireGCM, err = cipher.NewGCM(block)
	if err != nil {
		panic(err)
	}
}

func encodeWireMessage(plaintext []byte) ([]byte, error) {
	nonce := make([]byte, wireGCM.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return wireGCM.Seal(nonce, nonce, plaintext, nil), nil
}

func decodeWireMessage(data []byte) ([]byte, error) {
	nonceSize := wireGCM.NonceSize()
	if len(data) < nonceSize {
		return nil, errors.New("wire message too short")
	}
	nonce, ciphertext := data[:nonceSize], data[nonceSize:]
	return wireGCM.Open(nil, nonce, ciphertext, nil)
}
