package tmx

import (
	"os"
	"strconv"
	"strings"
	"time"
)

func jsGetTimezoneOffsetMinutes(t time.Time) int {
	_, offsetSec := t.Zone()
	return -offsetSec / 60
}

func GetTimezone() (c, z, tzd string) {
	loc := time.Now().Location()
	year := time.Now().Year()

	june := -jsGetTimezoneOffsetMinutes(time.Date(year, time.June, 1, 0, 0, 0, 0, loc))
	dec := -jsGetTimezoneOffsetMinutes(time.Date(year, time.December, 1, 0, 0, 0, 0, loc))

	cVal := june
	if dec < cVal {
		cVal = dec
	}

	zVal := june - dec
	if zVal < 0 {
		zVal = -zVal
	}

	return strconv.Itoa(cVal), strconv.Itoa(zVal), localTimezoneName()
}

func localTimezoneName() string {
	if tz := strings.TrimSpace(os.Getenv("TZ")); tz != "" {
		if strings.HasPrefix(tz, ":") {
			tz = tz[1:]
		}
		if tz != "" {
			return tz
		}
	}

	name := time.Now().Location().String()
	if name != "" && name != "Local" && name != "UTC" {
		return name
	}

	return ""
}

func (t *TMXConfig) ApplyTimezoneFields() {
	c, z, tzd := GetTimezone()
	t.Device.C = c
	t.Device.Z = z
	if tzd != "" {
		t.Device.TZD = tzd
	}
}
