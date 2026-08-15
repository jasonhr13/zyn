package pie

import (
	"strconv"
	"testing"
)

var testKeys = Keys{
	L:     6,
	E:     4,
	K:     "7035B06E9502B4892A55100F2F65C824",
	KeyID: "ba81e05b",
	Phase: 1,
}

func TestEncryptCard(t *testing.T) {
	card, err := EncryptCard("4867966923884940", "992", testKeys)
	if err != nil {
		t.Fatal(err)
	}
	if card.EncryptedPan == "" || card.EncryptedCVV == "" || card.IntegrityCheck == "" {
		t.Fatalf("missing encrypted fields: %+v", card)
	}
	if card.KeyID != testKeys.KeyID {
		t.Fatalf("key id: got %s want %s", card.KeyID, testKeys.KeyID)
	}
	if card.Phase != strconv.Itoa(testKeys.Phase) {
		t.Fatalf("phase: got %s want %d", card.Phase, testKeys.Phase)
	}
	t.Logf("encryptedPan=%s encryptedCVV=%s integrity=%s", card.EncryptedPan, card.EncryptedCVV, card.IntegrityCheck)
}

func TestEncryptCardInvalidInput(t *testing.T) {
	if _, err := EncryptCard("123", "123", testKeys); err == nil {
		t.Fatal("expected error for short pan")
	}
	if _, err := EncryptCard("4111111111111111", "12", testKeys); err == nil {
		t.Fatal("expected error for 2-digit cvv")
	}
}

func TestEncryptCardKnownVector(t *testing.T) {
	card, err := EncryptCard("4111111111111111", "123", testKeys)
	if err != nil {
		t.Fatal(err)
	}
	if card.EncryptedPan != "4111115210121111" || card.EncryptedCVV != "338" || card.IntegrityCheck != "688d52ca2d6238cd" {
		t.Fatalf("unexpected vector: %+v", card)
	}
}
