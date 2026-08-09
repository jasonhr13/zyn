package main

import (
	"flag"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/PolarAIO/Polar-AIO/backend/bot-base/alert"
	"github.com/PolarAIO/Polar-AIO/backend/bot-base/datadog"
	"github.com/PolarAIO/Polar-AIO/backend/bot-base/safego"
	"github.com/PolarAIO/Polar-AIO/backend/bot-base/siteconfig"
	"github.com/PolarAIO/Polar-AIO/backend/bot-base/task"
	"github.com/PolarAIO/Polar-AIO/backend/frontend"
)

var (
	port = flag.String("port", "8000", "Zyn frontend WebSocket port")
	_    = flag.String("key", "", "deprecated compatibility flag")
)

func main() {
	flag.Parse()
	if strings.TrimSpace(os.Getenv("HOPE_SHAPE_TOKEN")) == "" {
		log.Fatal("missing HOPE_SHAPE_TOKEN")
	}

	// Zyn owns authentication, configuration, monitoring, and the local Shape
	// broker. The native child runs no Polar cloud, telemetry, or security
	// services and does not embed credentials for them.
	siteconfig.SetLicenseKey("")
	siteconfig.SetUsername("")
	datadog.Init("", "")
	alert.SetWebhookURL("")
	task.SetCloudConnectedCheck(func() bool { return true })

	safego.Go(task.StartTaskServices)
	safego.Go(waitForShutdown)
	if os.Getenv("HOPE_PARENT_WATCH") == "1" {
		safego.Go(watchParentAlive)
	}

	frontend.ConnectFrontend(*port)
}

func waitForShutdown() {
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	<-signals
	os.Exit(0)
}

func watchParentAlive() {
	buffer := make([]byte, 1)
	if _, err := os.Stdin.Read(buffer); err != nil {
		os.Exit(0)
	}
}
