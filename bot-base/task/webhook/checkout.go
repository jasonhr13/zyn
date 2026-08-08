package webhook

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/PolarAIO/Polar-AIO/backend/bot-base/alert"
	"github.com/PolarAIO/Polar-AIO/backend/bot-base/task"
)

var (
	CheckoutURL string
	DeclineURL  string
)

var httpClient = &http.Client{
	Timeout:   10 * time.Second,
	Transport: &http.Transport{Proxy: nil},
}

func alertWebhookError(reason string) {
	alert.Send(fmt.Sprintf(":warning: Product webhook error: %s", reason))
}

func SetURLs(checkout, decline string) {
	CheckoutURL = checkout
	DeclineURL = decline
}

func SendProductCheckout(data task.ProductWebhookData) {
	webhookURL := DeclineURL
	if data.Success {
		webhookURL = CheckoutURL
	}
	if webhookURL == "" {
		kind := "decline"
		if data.Success {
			kind = "checkout"
		}
		log.Printf("webhook: skip send (empty %s URL)", kind)
		return
	}

	webhookTitle := "Payment Declined!"
	webhookColor := 16728642
	if data.Success {
		webhookTitle = "Successful Checkout :tada:"
		webhookColor = 5276158
	}

	lineTotal := func(p task.ProductWebhookItem) float64 {
		qty := p.Quantity
		if qty <= 0 {
			qty = 1
		}
		return p.Price * float64(qty)
	}

	p0 := data.CheckoutProducts[0]
	productLine := fmt.Sprintf("- %dx [%s](%s) - %s\n", p0.Quantity, p0.Name, p0.ProductLink, p0.Size)
	priceLine := lineTotal(p0)
	sizeLine := p0.Size
	for i := 1; i < len(data.CheckoutProducts); i++ {
		p := data.CheckoutProducts[i]
		productLine += fmt.Sprintf("- %dx [%s](%s) - %s\n", p.Quantity, p.Name, p.ProductLink, p.Size)
		priceLine += lineTotal(p)
		sizeLine = "Multicart"
	}

	if data.GrandTotal > 0 {
		priceLine = data.GrandTotal
	}

	emailLine := data.Email

	description := ""

	if data.DeclineReason != "" {
		description = data.DeclineReason
	}

	fields := []map[string]interface{}{
		{
			"name":  "Product",
			"value": productLine,
		},
		{
			"name":   "Price",
			"value":  fmt.Sprintf("$%.2f", priceLine),
			"inline": true,
		},
		{
			"name":   "Size",
			"value":  sizeLine,
			"inline": true,
		},
		{
			"name":   "Site",
			"value":  data.Site,
			"inline": true,
		},
		{
			"name":   "Profile",
			"value":  fmt.Sprintf("||%s||", data.ProfileName),
			"inline": true,
		},
	}
	if data.OrderLink != "" {
		fields = append(fields, map[string]interface{}{
			"name":   "Order Number",
			"value":  fmt.Sprintf("||[%s](%s)||", data.OrderNumber, data.OrderLink),
			"inline": true,
		})
	} else {
		fields = append(fields, map[string]interface{}{
			"name":   "Order Number",
			"value":  fmt.Sprintf("||%s||", data.OrderNumber),
			"inline": true,
		})
	}

	//append email under order number
	fields = append(fields, map[string]interface{}{
		"name":   "Email",
		"value":  fmt.Sprintf("||%s||", emailLine),
		"inline": true,
	})

	if data.Proxy != "" {
		fields = append(fields, map[string]interface{}{
			"name":   "Proxy",
			"value":  fmt.Sprintf("||%s||", data.Proxy),
			"inline": true,
		})
	}
	for name, value := range data.ExtraFeilds {
		if value != "" {
			fields = append(fields, map[string]interface{}{"name": name, "value": value, "inline": true})
		}
	}

	webhookData := map[string]interface{}{
		"content": nil,
		"embeds": []map[string]interface{}{
			{
				"title":       webhookTitle,
				"color":       webhookColor,
				"fields":      fields,
				"description": description,
				"footer": map[string]interface{}{
					"text":     "Polar AIO",
					"icon_url": "https://media.discordapp.net/attachments/1443088896396361731/1487029472778518558/Adobe_Express_-_file.png",
				},
				"timestamp": time.Now().UTC().Format(time.RFC3339),
				"thumbnail": map[string]interface{}{
					"url": data.CheckoutProducts[0].Image,
				},
			},
		},
		"username":    "Polar AIO",
		"avatar_url":  "https://media.discordapp.net/attachments/1443088896396361731/1487029472778518558/Adobe_Express_-_file.png",
		"attachments": []interface{}{},
	}

	jsonData, err := json.Marshal(webhookData)
	if err != nil {
		log.Printf("webhook: marshal error: %v", err)
		alertWebhookError(fmt.Sprintf("marshal error (task_id=%q): %v", data.TaskID, err))
		return
	}

	req, err := http.NewRequest("POST", webhookURL, bytes.NewBuffer(jsonData))
	if err != nil {
		log.Printf("webhook: new request: %v", err)
		alertWebhookError(fmt.Sprintf("new request error (task_id=%q): %v", data.TaskID, err))
		return
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := httpClient.Do(req)
	if err != nil {
		log.Printf("webhook: request failed: %v", err)
		alertWebhookError(fmt.Sprintf("request failed (task_id=%q): %v", data.TaskID, err))
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		log.Printf("webhook: unexpected status %s", resp.Status)
		alertWebhookError(fmt.Sprintf("unexpected status %s (task_id=%q)", resp.Status, data.TaskID))
	}
}
