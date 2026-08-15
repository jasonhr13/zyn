package tmx

import (
	"fmt"
	"math"
	"math/rand/v2"
	"strconv"
)

func randomShit() int {
	a := rand.Float64()
	a = 2742745743359.0 * a
	a = math.Floor(a)
	return int(a)
}

func toString(e int) string {
	return strconv.FormatInt(int64(e+78364164096), 36)
}

func getRandomStr() string {
	return toString(randomShit())
}

func (t *TMXConfig) BuildUrl(kind string) string {
	switch kind {
	case "m2":
		return fmt.Sprintf("https://%s/fp/clear.png?org_id=%s&m=2&session_id=%s", t.Domain, t.SiteID, t.SessionID)
	case "m1":
		return fmt.Sprintf("https://%s/fp/clear.png?org_id=%s&m=1&session_id=%s", t.Domain, t.SiteID, t.SessionID)
	case "init":
		c := randomShit()
		b := getRandomStr() + toString(c)
		return fmt.Sprintf("https://%s/fp/%s.js?%s%s=%s&%s%s=%s", t.Domain, b, getRandomStr(), getRandomStr(), t.SiteID, getRandomStr(), getRandomStr(), t.SessionID)
	case "initWM":
		c := randomShit()
		b := getRandomStr() + toString(c)
		return fmt.Sprintf("https://%s/%s.js?%s%s=%s&%s%s=%s&%s%s=", t.Domain, b, getRandomStr(), getRandomStr(), t.SiteID, getRandomStr(), getRandomStr(), t.SessionID, getRandomStr(), getRandomStr())
	case "kClear":
		return fmt.Sprintf("https://%s/fp/clear.png?org_id=%s&session_id=%s&k=1", t.Domain, t.SiteID, t.SessionID)
	default:
		return ""
	}
}
