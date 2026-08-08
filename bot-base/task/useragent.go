package task

import (
	"math/rand"
	"runtime"
)

var MacUserAgents = &UserAgent{
	UserAgentInfo: []*BaseUserAgentInfo{
		{
			Useragent:   "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
			Sec_ua:      "\"Not;A=Brand\";v=\"8\", \"Chromium\";v=\"150\", \"Google Chrome\";v=\"150\"",
			Platform:    "\"macOS\"",
			VersionList: "\"Not;A=Brand\";v=\"8.0.0.0\", \"Chromium\";v=\"150.0.7871.49\", \"Google Chrome\";v=\"150.0.7871.49\"",
			Arch:        "\"arm\"",
		},
	},
}

var WindowsUserAgents = &UserAgent{
	UserAgentInfo: []*BaseUserAgentInfo{
		{
			Useragent:   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
			Sec_ua:      "\"Not;A=Brand\";v=\"8\", \"Chromium\";v=\"150\", \"Google Chrome\";v=\"150\"",
			Platform:    "\"Windows\"",
			VersionList: "\"Not;A=Brand\";v=\"8.0.0.0\", \"Chromium\";v=\"150.0.7871.101\", \"Google Chrome\";v=\"150.0.7871.101\"",
			Arch:        "\"x86\"",
		},
	},
}

func ChooseUseragent() *BaseUserAgentInfo {
	if runtime.GOOS == "darwin" {
		randomIndex := rand.Intn(len(MacUserAgents.UserAgentInfo))
		return MacUserAgents.UserAgentInfo[randomIndex]
	} else {
		randomIndex := rand.Intn(len(WindowsUserAgents.UserAgentInfo))
		return WindowsUserAgents.UserAgentInfo[randomIndex]
	}
}
