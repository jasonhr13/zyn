package main

import (
	"flag"
	"log"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"zynbot.app/engine/analytics"
	"zynbot.app/engine/bot-base/alert"
	"zynbot.app/engine/bot-base/datadog"
	"zynbot.app/engine/bot-base/safego"
	"zynbot.app/engine/bot-base/siteconfig"
	"zynbot.app/engine/bot-base/task"
	"zynbot.app/engine/frontend"
	monitorhub "zynbot.app/engine/monitor-hub"
	"zynbot.app/engine/security"
	serverclient "zynbot.app/engine/server-client"
)

var port = flag.String("port", envOrDefault("POLAR_FRONTEND_PORT", "8000"), "frontend WebSocket port")
var key = flag.String("key", os.Getenv("POLAR_BACKEND_KEY"), "Polar API/license key")
var devMode = flag.Bool("dev", envBool("POLAR_DEV_MODE"), "run without cloud authentication, telemetry, or security monitoring")

const backendUsernameEnv = "POLAR_BACKEND_USERNAME"

func main() {
	flag.Parse()
	resolvedKey := strings.TrimSpace(*key)
	configureIdentity(resolvedKey)
	configureOptionalServices(*devMode)

	if !*devMode {
		if resolvedKey == "" {
			log.Fatal("missing Polar API/license key; pass -key, set POLAR_BACKEND_KEY, or use -dev")
		}
		if !security.SafeEnv() {
			log.Fatal("security environment check failed")
		}
		security.StartMonitor(30 * time.Second)
	}

	if *devMode {
		// Local monitor workers do not need the Polar cloud. This also prevents
		// development runs from persisting events intended for production.
		task.SetCloudConnectedCheck(func() bool { return true })
		log.Printf("development mode enabled: Polar cloud, telemetry, and security monitoring are disabled")
	} else {
		task.SetServerEventSender(serverclient.SendEvent)
		task.SetCloudConnectedCheck(serverclient.IsConnected)
		monitorhub.SetStockPingSender(serverclient.SendStockPing)
		analytics.SetSender(serverclient.SendPresence)
		task.SetTaskChangeHandler(analytics.SyncTask)
		task.SetTaskRemoveHandler(analytics.RemoveTask)
		safego.Go(analytics.Start)
		safego.Go(func() { serverclient.ConnectToServer(&resolvedKey) })
	}

	safego.Go(task.StartTaskServices)
	safego.Go(waitForShutdown)
	safego.Go(watchParentAlive)

	frontend.ConnectFrontend(*port)
}

func configureIdentity(key string) {
	siteconfig.SetLicenseKey(key)
	siteconfig.SetUsername(os.Getenv(backendUsernameEnv))
}

func configureOptionalServices(development bool) {
	if development {
		datadog.Init("", "")
		alert.SetWebhookURL("")
		security.SetAlertWebhookURL("")
	} else {
		datadog.Init(os.Getenv("POLAR_DATADOG_TOKEN"), envOrDefault("POLAR_DATADOG_SITE", "us5.datadoghq.com"))
		alert.SetWebhookURL(strings.TrimSpace(os.Getenv("POLAR_ALERT_WEBHOOK_URL")))
		security.SetAlertWebhookURL(strings.TrimSpace(os.Getenv("POLAR_SECURITY_WEBHOOK_URL")))
	}
	if cloudURL := strings.TrimSpace(os.Getenv("POLAR_CLOUD_URL")); cloudURL != "" {
		if err := serverclient.SetServerURL(cloudURL); err != nil {
			log.Fatalf("invalid POLAR_CLOUD_URL: %v", err)
		}
	}
}

func envOrDefault(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func envBool(name string) bool {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return false
	}
	enabled, err := strconv.ParseBool(value)
	return err == nil && enabled
}

func waitForShutdown() {
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	shutdown()
}

func watchParentAlive() {
	buf := make([]byte, 1)
	if _, err := os.Stdin.Read(buf); err != nil {
		shutdown()
	}
}

func shutdown() {
	analytics.Stop()
	serverclient.CloseConnection()
	os.Exit(0)
}
