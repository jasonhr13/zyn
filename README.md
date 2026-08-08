# Polar backend source

This repository contains the Go backend from the Polar desktop application. It
connects to a separately running frontend over WebSocket and contains site
modules for Target, Walmart, and Pokemon Center.

## Requirements

- Go 1.25.1 or newer (the module version is declared in `go.mod`)
- Network access to `proxy.golang.org` or another configured Go module proxy
- A frontend WebSocket server for interactive use (the backend connects to it;
  the backend does not listen for frontend connections)
- For live Target checkout only: the Shape sidecar and valid Target account,
  profile, payment, and proxy configuration

## Build and test

```sh
make deps
make test
make build
```

The development binary is written to `dist/polar-backend`. Equivalent commands
without Make are:

```sh
go mod download
go test ./...
go build -trimpath -o dist/polar-backend .
```

`make check` runs both the tests and `go vet`.

The checked-in `build.sh` is a release/cross-compilation script. It builds
macOS amd64/arm64 and Windows amd64 artifacts and uses `garble` by default:

```sh
go install mvdan.cc/garble@v0.14.2
make release
```

To use the release script without obfuscation:

```sh
USE_GARBLE=0 ./build.sh polarBackend
```

## Local development

Start the backend without a Polar license, cloud connection, Datadog, or the
anti-tamper monitor:

```sh
make dev
```

This is equivalent to:

```sh
go run . -dev -port 8000
```

The process will repeatedly try to connect to `ws://127.0.0.1:8000/`. Start the
old app/frontend WebSocket server on that port to send configuration and task
commands. Use `FRONTEND_PORT=9000 make dev` to select another port.

Development mode also allows local monitor workers to start without the Polar
cloud. It does not mock Target or the Shape sidecar, so starting an actual
Target checkout task still makes live requests.

See `.env.example` for all supported environment variables. The application
does not parse `.env` files itself.

## Production-style run

```sh
export POLAR_BACKEND_KEY='your-license-key'
./dist/polar-backend -port 8000
```

Without `-dev`, the backend requires its Polar cloud connection and performs
the original process/debugger security checks. `POLAR_CLOUD_URL` can point at a
compatible development server, but that server must implement the repository's
encrypted WebSocket protocol.

## External services

Building requires only a Go module proxy. Running the process and executing a
Target task can involve the following services:

| Service | Required when | Purpose |
| --- | --- | --- |
| Frontend WebSocket (`ws://127.0.0.1:8000/`) | Interactive use | Supplies profiles, accounts, proxies, task commands, captcha tokens, and email OTP codes; receives task status and logs. |
| Shape WebSocket (`ws://127.0.0.1:4312/ws`) | Target login/checkout | Local sidecar that returns Target anti-bot request headers and the proxy with which they were generated. Configurable with `POLAR_TARGET_SHAPE_URL`. The sidecar source is not in this repository. |
| Polar cloud (`polar-wss-production.up.railway.app`) | Non-development mode | License/auth connection, site-lock configuration, user data, cloud stock pings, presence, and checkout events. |
| Target web services | Target tasks | Login (`gsp.target.com`), cart/payment (`carts.target.com`), account/order APIs (`api.target.com`), product stock (`redsky.target.com`), site session (`www.target.com`), and TMX device signals (`img9.target.com`). |
| Device API (`device-api-production-fbca.up.railway.app`) | Target payment/TMX | Supplies a browser fingerprint used to construct Target's ThreatMetrix telemetry. This service's source is not present. |
| ipify (`api.ipify.org`) | TMX when the task has no known IPv4 | Returns the public IP included in device telemetry. |
| Datadog Logs | When configured | Optional operational events. Set `POLAR_DATADOG_TOKEN`; an empty token disables it. |
| Discord-compatible webhooks | When configured | Optional panic/security and checkout/decline notifications. URLs come from environment variables or frontend configuration. |
| User-configured proxies | Most live retailer tasks | Target-bound traffic is made through the selected proxy group. |

The other site modules call additional retailer and anti-bot services, but they
are not used merely by starting the backend or by running only Target tasks.

## Safety notes

- Development mode disables cloud authentication and anti-tamper monitoring;
  do not use it as a production security boundary.
- Target checkout is not simulated. Use test accounts/payment data and ensure
  you understand which states can submit or cancel a real order.
- The original source contained hard-coded alert/telemetry credentials. They
  are now environment-configured and disabled by default. Any previously
  committed webhook credentials should be rotated.
