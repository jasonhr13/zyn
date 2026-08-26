# Zyn mobile Shape companion

Sideloaded Android / iOS app that pairs to a running Zyn desktop over `license.zynbot.app` and harvests Target ATC Shape headers into the local cookie bank.

This is **not** an App Store or Play Store app. Android: install the APK from Settings → Target — Mobile Harvesters, or `https://updates.zynbot.app/download/android`. iOS: development / ad-hoc / TestFlight IPA.

## Pairing

1. Sign in to Zyn on the desktop.
2. Settings → Enable mobile harvesting → Generate pairing code.
3. Scan the pairing QR in this app (`zyn://pair?room=&token=&origin=`).

The phone never receives the Zyn license token or managed-proxy credentials. User-owned proxy lists are sent over the live room. Headers never persist in Cloudflare.

## Platform harvest

- **Android:** 1 in-process WebView, Chromium CDP Fetch abort on cart POST, local CONNECT proxy.
- **iOS Mode B:** 1–6 in-process WKWebViews, JS fetch/XHR hook on cart POST, loopback CONNECT proxy (`WKWebsiteDataStore.proxyConfigurations`, iOS 17+). No custom CA / MITM / Network Extension.

## First iOS launch

Developer-signed builds need a one-time trust on the phone:

1. Settings → Privacy & Security → Developer Mode → On (if asked).
2. Settings → General → VPN & Device Management → **Jason Storey** → Trust.

Then open **Zyn**, scan the QR, pick a proxy list, set Harvesters 1–6, Start.

## Build

```bash
cd mobile
npm install
npx expo prebuild --platform android
npx expo run:android

# iOS (Release embeds JS; Debug needs Metro)
npx expo prebuild --platform ios
npx expo run:ios --device --configuration Release
```

Android native code lives in `native/harvester/` and is copied by `plugins/withZynHarvester.js`. iOS Mode B lives in `modules/zyn-harvester/`.

## v1 scope

Target ATC only. Captures are `{ type, headers, proxy }` frames; the desktop allowlists `x-gyjwza5z-*` + client hints before `POST /saveCookies`.
