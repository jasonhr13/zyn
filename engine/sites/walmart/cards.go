package walmart

import (
	"fmt"
	"strconv"
	"strings"
)

func cardDigits(number string) string {
	var digits strings.Builder
	for _, r := range number {
		if r >= '0' && r <= '9' {
			digits.WriteRune(r)
		}
	}
	return digits.String()
}

func walmartCardType(number string) string {
	digits := cardDigits(number)
	if digits == "" {
		return ""
	}

	switch {
	case strings.HasPrefix(digits, "4"):
		return "VISA"
	case len(digits) >= 2 && digits[:2] >= "51" && digits[:2] <= "55":
		return "MASTERCARD"
	case len(digits) >= 4 && digits[:4] >= "2221" && digits[:4] <= "2720":
		return "MASTERCARD"
	case len(digits) >= 2 && (digits[:2] == "34" || digits[:2] == "37"):
		return "AMEX"
	case strings.HasPrefix(digits, "6011") || strings.HasPrefix(digits, "65") ||
		(len(digits) >= 6 && digits[:6] >= "622126" && digits[:6] <= "622925"):
		return "DISCOVER"
	default:
		return "MASTERCARD"
	}
}

func parseCardExpiryYear(raw string) (int, error) {
	year := strings.TrimSpace(raw)
	if year == "" {
		return 0, fmt.Errorf("invalid expiry year")
	}

	switch len(year) {
	case 2:
		v, err := strconv.Atoi(year)
		if err != nil {
			return 0, fmt.Errorf("invalid expiry year")
		}
		return 2000 + v, nil
	case 4:
		v, err := strconv.Atoi(year)
		if err != nil {
			return 0, fmt.Errorf("invalid expiry year")
		}
		return v, nil
	default:
		return 0, fmt.Errorf("invalid expiry year")
	}
}
