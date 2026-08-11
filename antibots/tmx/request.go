package tmx

import (
	"encoding/json"
	"fmt"
	"log"

	"github.com/PolarAIO/Polar-AIO/backend/client"
)

func (t *TMXConfig) MakeTMXRequest(url string) (string, error) {
	Request := client.RequestStruct{
		Req: client.ReqStruct{
			Method: "GET",
			URL:    url,
		},
		Headers: map[string][]string{
			"connection":         {"keep-alive"},
			"sec-ch-ua-platform": {"\"macOS\""},
			"user-agent":         {t.userAgent()},
			"sec-ch-ua":          {"\"Google Chrome\";v=\"149\", \"Chromium\";v=\"149\", \"Not)A;Brand\";v=\"24\""},
			"sec-ch-ua-mobile":   {"?0"},
			"accept":             {"*/*"},
			"sec-fetch-site":     {"same-site"},
			"sec-fetch-mode":     {"no-cors"},
			"sec-fetch-dest":     {"script"},
			"accept-encoding":    {"gzip, deflate, br, zstd"},
			"accept-language":    {"en-US,en;q=0.9"},
			"header-order":       {"host", "connection", "sec-ch-ua-platform", "user-agent", "sec-ch-ua", "sec-ch-ua-mobile", "accept", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding", "accept-language"},
		},
	}
	requestType := "tmx"
	response, body, err := client.MakeRequest(Request, t.Client, &requestType)
	if err != nil {
		log.Printf("[TMX] ERROR: %s", err)
		return "", err
	} else {
		log.Printf("[ID:'%s' | Request Status: %s]", "TMX", response.Status)
		return body, nil
	}
}

type ipResponse struct {
	Ip string `json:"ip"`
}

func (t *TMXConfig) GetIPv4() (string, error) {
	Request := client.RequestStruct{
		Req: client.ReqStruct{
			Method: "GET",
			URL:    "https://api.ipify.org/?format=json",
		},
		Headers: map[string][]string{},
	}
	requestType := "tmx"
	response, body, err := client.MakeRequest(Request, t.Client, &requestType)
	if err != nil {
		log.Printf("[TMX] ERROR getting IP: %s", err)
		return "", err
	}
	if response.StatusCode != 200 {
		return "", fmt.Errorf("get ip failed (%d)", response.StatusCode)
	}
	var ipInfo ipResponse
	if err := json.Unmarshal([]byte(body), &ipInfo); err != nil {
		log.Printf("[TMX] ERROR parsing IP response: %s", err)
		return "", err
	}
	return ipInfo.Ip, nil
}
