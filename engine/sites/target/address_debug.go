package target

import "fmt"

func clipLog(value string, limit int) string {
	if limit <= 0 || len(value) <= limit {
		return value
	}
	return value[:limit] + "…"
}

func addressFieldLog(label, line1, city, first, last string) string {
	return fmt.Sprintf("%s line1=%q city=%q first=%q last=%q", label, line1, city, first, last)
}
