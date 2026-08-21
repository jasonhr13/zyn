# Zyn Harvester (browser extension)

Cookie harvester companion for **Zyn**. It drives a real Chromium browser against Target, captures
Shape-signed login/ATC headers, and banks them into Zyn over the local compatibility bridge.

## Install

Download the current ZIP from <https://updates.zynbot.app/download/extension>, then:

1. Create a permanent folder named `Zyn-Harvester` and extract the ZIP contents into it.
   `manifest.json` must be directly inside that folder.
2. Open Chrome → `chrome://extensions`, or Brave → `brave://extensions`
3. Enable **Developer mode**
4. **Load unpacked** → select the permanent `Zyn-Harvester` folder

When updating, extract the new ZIP over that same folder and click **Reload** on the extension card.
Do not load each version from a newly named folder: Chromium derives an unpacked extension's ID from
its directory, and changing it would require reconnecting the new ID in Zyn. A repository checkout
can instead load `chrome-extension/harvester` directly and keep using that path.

## Connect to Zyn

1. Open Zyn and sign in
2. On each browser's extensions page, copy the 32-character ID shown for **Zyn Harvester**
3. In Zyn **Settings** → **Target — Browser Extension Harvesters**, turn extension harvesting on,
   paste one extension ID per line, and save.
4. Open this extension’s popup → **Connection** should show **Live**

Extension harvesting is additive. It can run alongside Zyn’s in-app harvesters, and both sources feed
the same Target cookie bank.

### Ports

| Port | Role |
|------|------|
| `127.0.0.1:4312` | Extension ↔ Zyn bridge (status / save / proxies) |
| `127.0.0.1:4727` | Zyn cookie bank (bridge translates; extension never dials this) |

If another local app already owns **4312**, quit it first.

## Proxies

Choose **Local IP** to use the browser's direct internet connection, or choose **Proxy list** to rotate
through the selected list while harvesting. Local IP is the default, and saved proxy lists remain
available when switching between routes. An empty or invalid selected list falls back to Local IP.

Paste your own proxy lines into the extension textarea (`host:port` or `host:port:user:pass`).
**Import** copies user-owned proxy lists from Zyn (the same lists on the Proxies page). Managed/provider lists stay in Zyn and are not exported.

## Harvest

1. Choose **Local IP** or **Proxy list** under **Network route**
2. Click **Start Harvesting**
3. Watch Zyn’s Target cookie bank for login/ATC counts

Banked cookies are tagged `source: extension` and use Zyn’s **Cookie TTL** setting.
Zyn’s **ATC cookies per task** setting is the only cookie-count authority; the extension follows the
exact deficit reported by Zyn and does not expose a separate per-task multiplier. The extension’s
expiry value is a requested lifetime in minutes and is capped by Zyn’s configured Cookie TTL.

## Notes

- The local protocol remains backward compatible. This build also sends optional `clientId` and
  `browser` attribution fields that older Zyn builds safely ignore.
- UI settings use `zynHarvesterState`. The stable per-browser installation ID uses
  `chrome.storage.local` key `zynHarvesterClientId`.
- Permissions (`debugger`, `proxy`, `<all_urls>`, etc.) are required for the harvest flow.

## Release workflow

Extension versioning, packaging, and publishing are deliberately separate. For a new release:

```sh
node scripts/bump-zyn-extension-version.cjs
# Review, test, and commit the extension changes and manifest bump.
node scripts/release-zyn-extension.cjs
node scripts/upload-zyn-extension-release.cjs
```

The bump command advances only the three-part patch version in `manifest.json`. Run it once per
release. Packaging and upload retries never change the version; rerun those commands directly if a
build, upload, or Discord notification needs to be retried. Use
`ZYN_OVERWRITE_RELEASE=1 node scripts/release-zyn-extension.cjs` only after inspecting an existing
local staging directory that should be replaced.

The release command packages only committed files under `chrome-extension/harvester`, with
`manifest.json` at the ZIP root, into `release/dist/extension`. It writes strict `latest.json`
metadata and verifies every archived byte before handoff. The upload command retrieves the existing
`zyn-updates` R2 credential from macOS Keychain, uploads the versioned ZIP, asks the update Worker to
finalize metadata and send Discord, and then verifies the stable, versioned, and artifact download
routes. The Discord webhook credential stays in Cloudflare and is never present in the extension
archive or local uploader.
