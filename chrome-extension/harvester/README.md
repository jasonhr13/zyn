# Zyn Harvester (Chrome extension)

Cookie harvester companion for **Zyn**. It drives real Chrome against Target, captures Shape-signed login/ATC headers, and banks them into Zyn over the local compatibility bridge.

## Install

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this folder (`chrome-extension/harvester`)

## Connect to Zyn

1. Open Zyn and sign in
2. On `chrome://extensions`, copy the 32-character ID shown for **Zyn Harvester**
3. In Zyn **Settings** → **Target — Chrome Extension Harvester**, turn **Chrome extension
   harvesting** on, paste the ID, and save
4. Open this extension’s popup → **Connection** should show **Live**

Extension harvesting is additive. It can run alongside Zyn’s in-app harvesters, and both sources feed
the same Target cookie bank.

### Ports

| Port | Role |
|------|------|
| `127.0.0.1:4312` | Extension ↔ Zyn bridge (status / save / proxies) |
| `127.0.0.1:4727` | Zyn cookie bank (bridge translates; extension never dials this) |

If something else already owns **4312** (old Polar AIO, another bot), quit it first.

## Proxies

Choose **Local IP** to use Chrome's direct internet connection, or choose **Proxy list** to rotate
through the selected list while harvesting. Local IP is the default, and saved proxy lists remain
available when switching between routes. An empty or invalid selected list falls back to Local IP.

Paste your own proxy lines into the extension textarea (`host:port` or `host:port:user:pass`).
**Import** talks to Zyn’s `/proxies` endpoint, but Zyn does not export proxy credentials to the extension by design — paste them here.

## Harvest

1. Choose **Local IP** or **Proxy list** under **Network route**
2. Click **Start Harvesting**
3. Watch Zyn’s Target cookie bank for login/ATC counts

Banked cookies are tagged `source: extension` / `harvesterId: chrome-extension` and use Zyn’s **Cookie TTL** setting.

## Notes

- Protocol is unchanged from the Polar-era companion; only branding and packaging live here.
- Storage key is `zynHarvesterState` (renamed from Polar). Reloading this build starts with a fresh extension settings store.
- Permissions (`debugger`, `proxy`, `<all_urls>`, etc.) are required for the harvest flow.
