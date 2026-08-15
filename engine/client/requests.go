package client

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"strings"

	http "github.com/bogdanfinn/fhttp"
)

type RequestStruct struct {
	CTX            context.Context
	Req            ReqStruct
	Headers        map[string][]string
	RawData        []byte // Add support for raw bytes
	DisableCookies bool
}

type ReqStruct struct {
	Method string
	URL    string
	Data   string
}

type HttpClient interface {
	Do(req *http.Request) (*http.Response, error)
	GetCookieJar() http.CookieJar
	SetCookieJar(jar http.CookieJar)
}

func MakeRequest(Request RequestStruct, client HttpClient, taskID *string) (*http.Response, string, error) {
	if client == nil {
		return nil, "", fmt.Errorf("nil http client")
	}
	if Request.CTX == nil {
		Request.CTX = context.Background()
	}

	if Request.DisableCookies {
		savedJar := client.GetCookieJar()
		client.SetCookieJar(nil)
		defer client.SetCookieJar(savedJar)
	}

	var SendData io.Reader
	if len(Request.RawData) > 0 {
		SendData = bytes.NewReader(Request.RawData)
		log.Print("Sending raw data")
	} else if Request.Req.Data != "" && Request.Req.Data != "nil" {
		SendData = strings.NewReader(Request.Req.Data)
	}

	req, err := http.NewRequestWithContext(Request.CTX, Request.Req.Method, Request.Req.URL, SendData)
	if err != nil {
		return nil, "", err
	}

	// Create the header map
	headers := make(http.Header)
	var orderKeys []string

	headerNonEmpty := func(values []string) bool {
		return len(values) > 0 && strings.TrimSpace(values[0]) != ""
	}

	// Add all headers except host and header-order
	for key, values := range Request.Headers {
		if !headerNonEmpty(values) {
			continue
		}

		lowerKey := strings.ToLower(key)
		if Request.DisableCookies && lowerKey == "cookie" {
			continue
		}
		if lowerKey == "host" {
			req.Host = values[0]
			orderKeys = append(orderKeys, key)
			continue
		}
		if lowerKey == "header-order" {
			continue
		}

		if lowerKey == "content-length" {
			orderKeys = append(orderKeys, key)
			continue
		}

		headers[key] = values
		orderKeys = append(orderKeys, key)
	}

	// If header-order was specified, use it instead.
	// Support either multiple []string entries (e.g. {"a","b","c"}) or one comma-separated string.
	if orderVals, exists := Request.Headers["header-order"]; exists && len(orderVals) > 0 {
		if len(orderVals) == 1 && strings.Contains(orderVals[0], ",") {
			parts := strings.Split(orderVals[0], ",")
			orderKeys = orderKeys[:0]
			for _, p := range parts {
				p = strings.TrimSpace(p)
				if p == "" || (Request.DisableCookies && strings.EqualFold(p, "cookie")) {
					continue
				}
				if !headerNonEmpty(Request.Headers[p]) && !strings.EqualFold(p, "content-length") && !strings.EqualFold(p, "cookie") {
					continue
				}
				orderKeys = append(orderKeys, p)
			}
		} else {
			for _, p := range orderVals {
				if Request.DisableCookies && strings.EqualFold(p, "cookie") {
					continue
				}
				if !headerNonEmpty(Request.Headers[p]) && !strings.EqualFold(p, "content-length") && !strings.EqualFold(p, "cookie") {
					continue
				}
				orderKeys = append(orderKeys, p)
			}
		}
	}

	// Set the final header order
	headers[http.HeaderOrderKey] = orderKeys
	req.Header = headers

	resp, err := client.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()

	bodyText, err := io.ReadAll(resp.Body)
	if err != nil {
		return resp, "", err
	}

	return resp, string(bodyText), nil
}
