# Zyn for Windows

Zyn supports Windows 10 and 11 on x64. The app packages Electron, a Windows Node runtime, and the
native Target and Pokémon Center US checkout backend. Chromium is not bundled in the installer: the
same signed, resumable runtime channel used by macOS downloads it only after a valid Zyn sign-in.

## Build

```bash
POLAR_BACKEND_SOURCE=../polar-backend-source ./scripts/build-native-target-engine.sh windows-x64
node ./scripts/create-zyn-windows-icon.cjs
node ./scripts/prepare-zyn-windows-electron.cjs
./scripts/build-zyn-windows.sh
```

The unpacked output is `dist/Zyn-win32-x64`. The Electron runtime is downloaded from the official
Electron release, checked against the pinned SHA-256 in `vendor/electron-v43.3.0-SHASUMS256.txt`,
and cached under the ignored `vendor/electron-v43.3.0-win32-x64` directory.

## Runtime channel

Prepare and publish Windows Chromium together with the existing Mac artifacts:

```bash
node ./scripts/prepare-zyn-runtime-artifacts.cjs windows-x64
node ./scripts/create-zyn-runtime-manifest.cjs
node ./scripts/upload-zyn-runtime-artifacts.cjs
node ./scripts/verify-zyn-runtime-channel.cjs
```

The signed manifest contains `darwin-arm64`, `darwin-x64`, and `win32-x64`. On Windows, Zyn uses
the system `tar.exe` to install the archive under its user-data directory after login and verifies
the archive SHA-256 and Chromium PE header before marking it ready.

## Unsigned release

```bash
node ./scripts/release-zyn-windows.cjs
node ./scripts/upload-zyn-windows-release.cjs
node ./scripts/verify-zyn-public-release.cjs
```

The output is an unsigned per-user NSIS installer plus its blockmap and `latest.yml` under
`release/dist/windows-x64`. Windows SmartScreen may show “Windows protected your PC”; this is
expected until a Windows code-signing identity is configured. The production download route is
`https://updates.rcart.app/download/windows`.
