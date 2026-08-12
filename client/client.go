package client

import (
	tls_client "github.com/bogdanfinn/tls-client"
)

func CreateNewTLSClient(proxy string) (tls_client.HttpClient, error) {
	return createNewTLSClient(proxy, false)
}

// CreateNewMonitorTLSClient enables tls-client's connection-level bandwidth
// tracker. Keep this separate from CreateNewTLSClient so checkout, anti-bot,
// webhook, and service traffic is not accidentally reported as monitor usage.
func CreateNewMonitorTLSClient(proxy string) (tls_client.HttpClient, error) {
	return createNewTLSClient(proxy, true)
}

func createNewTLSClient(proxy string, trackBandwidth bool) (tls_client.HttpClient, error) {

	jar := tls_client.NewCookieJar()
	options := []tls_client.HttpClientOption{
		tls_client.WithTimeoutSeconds(40),
		tls_client.WithClientProfile(Chrome_150_PSK),
		tls_client.WithNotFollowRedirects(),
		tls_client.WithCookieJar(jar),
		tls_client.WithCatchPanics(),
		tls_client.WithRandomTLSExtensionOrder(),
		tls_client.WithProxyUrl(proxy),
		// tls_client.WithInsecureSkipVerify(),
		// tls_client.WithCharlesProxy("127.0.0.1", "8888"),
	}
	if trackBandwidth {
		options = append(options, tls_client.WithBandwidthTracker())
	}

	client, err := tls_client.NewHttpClient(tls_client.NewNoopLogger(), options...)
	return client, err
}
