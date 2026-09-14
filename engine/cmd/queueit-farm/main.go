package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"time"

	"zynbot.app/engine/bot-base/task"
	"zynbot.app/engine/client"
	"zynbot.app/engine/sites/queueit"
)

func main() {
	startURL := flag.String("url", "https://queueitcom.queue-it.net/?c=queueitcom&e=wrdemoproduct", "waiting-room or protected URL")
	proxy := flag.String("proxy", "", "http proxy URL")
	probe := flag.Bool("probe", true, "enqueue + one status poll, then exit")
	flag.Parse()

	httpClient, err := client.CreateNewTLSClient(*proxy)
	if err != nil {
		log.Fatal(err)
	}
	ua := task.ChooseUseragent()
	id := "cli"
	sess := queueit.NewSession(context.Background(), httpClient, ua, &id)

	landed, html, err := sess.Land(*startURL)
	if err != nil {
		log.Fatalf("land: %v", err)
	}
	cfg, err := queueit.ParseStartURL(landed)
	if err != nil {
		cfg, _ = queueit.ParseStartURL(*startURL)
	}
	cfg = queueit.MergeHTMLConfig(cfg, html, landed)
	if !cfg.Ready() {
		log.Fatalf("not a waiting room yet: host=%s", cfg.Host)
	}
	fmt.Printf("room %s/%s host=%s\n", cfg.CustomerID, cfg.EventID, cfg.Host)

	enq, err := sess.Enqueue(cfg)
	if err != nil {
		log.Fatalf("enqueue: %v", err)
	}
	enq, err = sess.SolvePowIfNeeded(cfg, enq)
	if err != nil {
		log.Fatalf("pow: %v", err)
	}
	fmt.Printf("queueId %s challenge=%v\n", enq.QueueID, enq.ChallengeRequired)
	if pass, ok := queueit.PassURL(cfg, enq, nil); ok {
		fmt.Printf("PASS %s\n", pass)
		os.Exit(0)
	}
	if !*probe {
		deadline := time.Now().Add(10 * time.Minute)
		for time.Now().Before(deadline) {
			st, err := sess.Poll(cfg, enq.QueueID)
			if err != nil {
				log.Fatalf("poll: %v", err)
			}
			fmt.Println(queueit.StatusLine(st))
			if pass, ok := queueit.PassURL(cfg, nil, st); ok {
				fmt.Printf("PASS %s\n", pass)
				os.Exit(0)
			}
			time.Sleep(time.Duration(cfg.UpdateIntervalMS) * time.Millisecond)
		}
		log.Fatal("timeout")
	}
	st, err := sess.Poll(cfg, enq.QueueID)
	if err != nil {
		log.Fatalf("poll: %v", err)
	}
	fmt.Println(queueit.StatusLine(st))
}
