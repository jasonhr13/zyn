package main

import (
	"log"

	"github.com/PolarAIO/Polar-AIO/backend/antibots/tmx"
	"github.com/PolarAIO/Polar-AIO/backend/client"
)

func main() {
	httpClient, err := client.CreateNewTLSClient("")
	if err != nil {
		log.Fatal(err)
	}

	cfg := &tmx.TMXConfig{
		SessionID:     "jqioaenbvfh3bglyklm5hmsnhsfhaljonlvs",
		SiteID:        "hgy2n0ks",
		Domain:        "drfdisvc.walmart.com",
		UserAgent:     "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
		Client:        httpClient,
		InitSuffix:    "921205550",
		SendPortCheck: true,
		SendSig:       true,
	}

	ok, err := tmx.SolveTMX(cfg)
	if err != nil {
		log.Fatal(err)
	}
	if !ok {
		log.Fatal("solve failed")
	}
}
