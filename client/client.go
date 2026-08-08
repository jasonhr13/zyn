package client

import (
	tls_client "github.com/bogdanfinn/tls-client"
)

func CreateNewTLSClient(proxy string) (tls_client.HttpClient, error) {

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

	client, err := tls_client.NewHttpClient(tls_client.NewNoopLogger(), options...)
	return client, err
}
