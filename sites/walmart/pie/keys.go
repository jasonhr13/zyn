package pie

import (
	"fmt"
	"regexp"
	"strconv"
)

var (
	rePieK     = regexp.MustCompile(`PIE\.K = "(.*?)";`)
	rePieL     = regexp.MustCompile(`PIE\.L = (\d+);`)
	rePieE     = regexp.MustCompile(`PIE\.E = (\d+);`)
	rePieKeyID = regexp.MustCompile(`PIE\.key_id = "(.*?)";`)
	rePiePhase = regexp.MustCompile(`PIE\.phase = (\d+);`)
)

type Keys struct {
	L     int
	E     int
	K     string
	KeyID string
	Phase int
}

type EncryptedCard struct {
	EncryptedPan   string
	EncryptedCVV   string
	IntegrityCheck string
	KeyID          string
	Phase          string
}

func ParseKeys(body string) (Keys, error) {
	kMatch := rePieK.FindStringSubmatch(body)
	lMatch := rePieL.FindStringSubmatch(body)
	eMatch := rePieE.FindStringSubmatch(body)
	keyMatch := rePieKeyID.FindStringSubmatch(body)
	phaseMatch := rePiePhase.FindStringSubmatch(body)
	if len(kMatch) < 2 || len(lMatch) < 2 || len(eMatch) < 2 || len(keyMatch) < 2 || len(phaseMatch) < 2 {
		return Keys{}, fmt.Errorf("pie keys parse failed")
	}

	l, _ := strconv.Atoi(lMatch[1])
	e, _ := strconv.Atoi(eMatch[1])
	phase, _ := strconv.Atoi(phaseMatch[1])

	return Keys{
		L:     l,
		E:     e,
		K:     kMatch[1],
		KeyID: keyMatch[1],
		Phase: phase,
	}, nil
}

func EncryptCard(pan, cvv string, keys Keys) (EncryptedCard, error) {
	result, ok := protectPANandCVV(pan, cvv, keys)
	if !ok {
		return EncryptedCard{}, fmt.Errorf("card encryption failed")
	}
	return EncryptedCard{
		EncryptedPan:   result[0],
		EncryptedCVV:   result[1],
		IntegrityCheck: result[2],
		KeyID:          keys.KeyID,
		Phase:          strconv.Itoa(keys.Phase),
	}, nil
}
