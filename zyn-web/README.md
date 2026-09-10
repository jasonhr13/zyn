# Zyn Full Engine (web)

Linux host for **checkout only**. Desktop Zyn stays the harvester.

A fleet of harvest-only desktop apps (and the Chrome extension / companion) feed cookies into this process through the existing harvest room. That includes **login cookies**, not only ATC: this host publishes remaining login room, remotes mint them, and the Linux engine pulls them from the shared bank. Operators control Target and Pokémon Center from a browser after signing in with the same Zyn account email and password used on desktop. Walmart JSON is stored the same way as desktop; starting Walmart tasks is not in this cut.

Desktop packaging, `engine-runtime.json` `1.2.8`, and the Windows/Mac apps are unchanged.

## Layout

```
zyn-web/
  server/     HTTP + WS control plane, loopback engine bridge, cookie bank, license + harvest room
  deploy is fly.toml + Dockerfile at this folder
```

JSON files are the **same names** as desktop `userData`:

`task-groups.json`, `profiles.json`, `accounts.json`, `proxies.json`, `settings.json`, `pokemon-center-tasks.json`, `walmart-tasks.json`, and the rest listed in `server/data-store.js`.

Copy those files onto the instance data directory (`ZYN_DATA_DIR`, `/data` on Fly). Account passwords stored with Electron `enc:` will not decrypt here — re-save them as `b64:` or paste them again through the API.

## Run locally

```bash
cd zyn-web
npm install
ZYN_DATA_DIR=./data node server/index.js
```

Open `http://127.0.0.1:8080` and sign in with your Zyn email and password (the same credentials as the desktop app). This process is Full Engine; it takes a Full Engine seat.

The web UI is the operator surface for this host, not a clone of every desktop page. It covers Target groups (create/edit/start/stop), profiles, Target accounts, proxy lists, OTP, the cookie bank, and **encrypted backup restore** (cloud list + recovery key, or a desktop `.json` / `.rcb` file). Pokémon Center can start from restored JSON; Walmart is stored only. IMAP, account generator, analytics, and harvester configuration stay on desktop harvest-only machines.

After sign-in: Backup → paste the desktop recovery key (`RCART1.…`) → List cloud backups → Restore (merge or replace). That writes the same `profiles.json` / `accounts.json` / `proxies.json` / `task-groups.json` files checkout uses. Account passwords in a backup are re-saved as `b64:` on this host (`enc:` Electron blobs will not decrypt here).

On a Mac this uses `native-backend/darwin-arm64/backend` (or x64). Linux production uses `native-backend/linux-x64/backend`:

```bash
./scripts/build-native-target-engine.sh linux-x64
```

Loopback only: engine WS `:8727` and cookie bank `:4727`. `ZYN_WEB_TOKEN` is an optional extra lock in front of the account login; leave it empty unless you want that.

## Fly

Pick a region close to the residential proxy gateway, not “close to Target.” Persistent volume holds the JSON files.

```bash
./scripts/build-native-target-engine.sh linux-x64
fly apps create zyn-web
fly volumes create zyn_data --region sjc --size 1 --config fly.zyn-web.toml
fly deploy --config fly.zyn-web.toml
```

Do not expose `:4727` or `:8727`. Harvest-only desktops never dial the Fly machine for cookies; they join the harvest room the same way they join a Full Engine desktop today.

## Desktop harvesters

On each harvest machine, run Zyn as **harvest-only** (not Full Engine) so this host owns the engine session. Pair them the same way you pair a remote harvester to Full Engine today. This host is Full Engine.

Harvest-only machines mint **login and ATC** cookies from user-created harvesters (Start/Stop, same as ATC). Create a Target Login harvester on the Mac when this host needs sign-in Shape cookies. Those cookies drain into the harvest room and land in this process’s bank, which the Linux engine reads on loopback.

## Scope

| Site | JSON | Start/stop |
|---|---|---|
| Target | `task-groups.json` | yes |
| Pokémon Center | `pokemon-center-tasks.json` | yes |
| Walmart | `walmart-tasks.json` | stored only |

When Target asks for a login code, this host polls the **profile IMAP mailbox** (same `imap-client` as desktop) and submits `received-code` automatically. Pending lookups show on the Run tab; you can still paste a code. Restore a backup that already has IMAP on the profile, or enter host / user / app password on the Profiles tab. AYCD Inbox is not used here — that client has to run on a desktop.
