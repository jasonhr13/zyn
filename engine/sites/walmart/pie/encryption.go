package pie

func protectPANandCVV(pan, cvv string, keys Keys) ([]string, bool) {
	digits := n.Distill(pan)
	cvvDigits := n.Distill(cvv)
	if len(digits) < 13 || len(digits) > 19 || len(cvvDigits) > 4 || len(cvvDigits) == 1 || len(cvvDigits) == 2 {
		return nil, false
	}

	tweak := digits[:keys.L] + digits[len(digits)-keys.E:]
	checksum := n.Luhn(digits)
	middle := digits[keys.L+1 : len(digits)-keys.E]
	encrypted := encrypt(middle+cvvDigits, tweak, keys.K, 10)
	if encrypted == "" {
		return nil, false
	}

	panWithZero := digits[:keys.L] + "0" + encrypted[:len(encrypted)-len(cvvDigits)] + digits[len(digits)-keys.E:]
	encPan := n.Reformat(n.FixLuhn(panWithZero, keys.L, checksum), pan)
	encCVV := n.Reformat(encrypted[len(encrypted)-len(cvvDigits):], cvv)
	return []string{encPan, encCVV, n.Integrity(keys.K, encPan, encCVV)}, true
}
