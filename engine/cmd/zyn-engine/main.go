//go:build zyn && !polar

package main

import (
	"flag"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"zynbot.app/engine/bot-base/alert"
	"zynbot.app/engine/bot-base/safego"
	"zynbot.app/engine/bot-base/siteconfig"
	"zynbot.app/engine/bot-base/task"
	"zynbot.app/engine/frontend"
	"zynbot.app/engine/sites/target"
)

var (
	port = flag.String("port", "8000", "Zyn frontend WebSocket port")
	_    = flag.String("key", "", "deprecated compatibility flag")
)

func main() {
	if os.Getenv("ZYN_SHAPE_CANARY") == "1" || (len(os.Args) > 1 && os.Args[1] == "shape-canary") {
		os.Exit(target.RunShapeCanaryCLI())
	}
	flag.Parse()
	if strings.TrimSpace(os.Getenv("ZYN_SHAPE_TOKEN")) == "" {
		log.Fatal("missing ZYN_SHAPE_TOKEN")
	}

	// Zyn owns authentication, configuration, monitoring, and the local Shape
	// broker. The native child runs no external cloud, telemetry, or security
	// services and does not embed credentials for them.
	siteconfig.SetLicenseKey("")
	siteconfig.SetUsername("")
	alert.SetWebhookURL("")
	task.SetCloudConnectedCheck(func() bool { return true })

	safego.Go(task.StartTaskServices)
	safego.Go(waitForShutdown)
	if os.Getenv("ZYN_PARENT_WATCH") == "1" {
		safego.Go(watchParentAlive)
	}

	frontend.ConnectFrontend(*port)
}

func waitForShutdown() {
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	<-signals
	task.FlushTelemetry()
	os.Exit(0)
}

func watchParentAlive() {
	buffer := make([]byte, 1)
	if _, err := os.Stdin.Read(buffer); err != nil {
		task.FlushTelemetry()
		os.Exit(0)
	}
}
