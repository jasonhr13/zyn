# Zyn native checkout engine

This directory is the Go module for Zyn's native Target and Pokémon Center US checkout
engine. The Electron app builds `./cmd/zyn-engine` with `-tags zyn` and packages the
resulting binaries in `native-backend/`.

The recovered Polar entrypoint in `main.go` is not used by Zyn. It remains for diffs
against the original backend and is excluded from tagged Zyn builds.

## Build and test

From the Zyn repository root:

```sh
./scripts/build-native-target-engine.sh all
```

That runs `go test ./...` and `go test -tags zyn ./...` in this module, then cross-compiles
Apple silicon, Intel, and Windows binaries.

From this directory:

```sh
go test ./...
go test -tags zyn ./...
go build -tags zyn -trimpath -o ../native-backend/darwin-arm64/backend ./cmd/zyn-engine
```

Zyn production builds set `CGO_ENABLED=0` and strip symbols with `-ldflags "-s -w"`.
The app contract pins each packaged binary's SHA-256 in `config/runtime-contract.json`.

Override the source tree only when testing an alternate checkout:

```sh
ZYN_ENGINE_SOURCE=/path/to/engine ./scripts/build-native-target-engine.sh arm64
```

## Runtime

The Zyn child process does not talk to Polar cloud, Datadog, or the recovered
anti-tamper monitor. Electron owns authentication and the local Shape broker. The
engine requires `ZYN_SHAPE_TOKEN` and connects to the frontend WebSocket port passed
as `-port`.

See `docs/native-engine-protocol.md` for the wire contract.
