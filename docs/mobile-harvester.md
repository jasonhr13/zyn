# Zyn mobile Shape companion

The phone app pairs to a signed-in Zyn desktop through `license.zynbot.app` and deposits Target ATC Shape headers into the existing cookie bank on `127.0.0.1:4727`.

```
Android WebView -> CDP Fetch.requestPaused on cart POST
iOS WKWebView   -> JS fetch/XHR hook on cart POST (Mode B)
phone JS        -> wss://license.zynbot.app/api/mobile/ws  (join token)
desktop         -> same room (license bearer)
desktop         -> POST /saveCookies  (x-zyn-token, source: mobile)
```

The Durable Object is a live pipe. It does not store Shape headers. Managed proxies and the license token never go to the phone. The phone picks which user-owned proxy lists to use. Android is 1 harvester; iOS Mode B is 1–6 in-process WKWebViews.

Pairing UI is Settings → Target — Mobile Harvesters. Generate a pairing code, then scan the QR (`zyn://pair?room=&token=&origin=`). Android APK: `https://updates.zynbot.app/download/android`. iOS is a development / ad-hoc / TestFlight IPA, not App Store.

## iOS Mode B

v1 uses TestFlight-safe APIs only: `WKWebView` + `WKWebsiteDataStore.proxyConfigurations` HTTP CONNECT to a loopback auth proxy (no custom CA, no Network Extension). Cart POSTs are aborted in JS after the Shape headers are posted to the native module. Low Data Mode reverse-bypasses Shape hosts and blocks images/fonts. Requires iOS 17+.

First launch of a developer-signed build: Settings → General → VPN & Device Management → trust the Apple Development certificate, then open Zyn.
