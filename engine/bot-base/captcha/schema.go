package captcha

type CaptchaSolve struct {
	TaskID      string   `json:"taskID,omitempty"`
	GroupID     string   `json:"groupID,omitempty"`
	SiteKey     string   `json:"siteKey,omitempty"`
	SiteURL     string   `json:"siteURL,omitempty"`
	HcapData    string   `json:"hcapData,omitempty"`
	Proxy       string   `json:"proxy,omitempty"`
	Cookies     []string `json:"cookies,omitempty"`
	Headers     []string `json:"headers,omitempty"`
	CaptchaType string   `json:"captchaType,omitempty"`
}
