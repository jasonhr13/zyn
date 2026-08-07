# Electron 43 / React 18 canary verification

## Outputs

- `dist/Hope.app`: Electron 19.0.10 + React 16.14 rollback
- `dist/Hope-Electron43.app`: Electron 43.3.0 + unchanged React 16.14 ASAR
- `dist/Hope-Electron43-React18.app`: Electron 43.3.0 + React 18.3.1

The React 18 canary keeps its React 16 archive as
`Contents/Resources/app-react16-original.asar`. The Windows backend is
byte-identical across the rollback and React 18 canary:
`6c381523e02af2c7e2e49be01243d65d4e95ae22c2d45a32eb23ef1b00d57ce2`.

## Automated checks

- Bundled Wine/backend self-test: exit 0
- Local development license adapter: accepted
- Electron renderer bridges: IPC, clipboard, and shell present
- All 12 application routes: rendered without an error boundary
- Stored tasks, profiles, accounts, proxies, and settings: readable over IPC
- Profile modal: identical 640 x 595 layout and field geometry
- Profile field: all 60 synthetic characters retained
- Isolated profile create/update/delete: passed and restored to zero records
- Renderer exceptions/errors during sweep: zero
- Hardware acceleration: GPU process plus zero-copy/GPU-buffer compositor active
- Bundle signature: deep strict verification passed

Profile-input frame timing from the same foreground test:

| Runtime | Average | p95 | Maximum |
| --- | ---: | ---: | ---: |
| Electron 19 + React 16 | 16.25 ms | 17.40 ms | 17.50 ms |
| Electron 43 + React 16 | 16.33 ms | 17.60 ms | 17.70 ms |
| Electron 43 + React 18 | 16.35 ms | 17.80 ms | 18.30 ms |

The Electron 43 React 16 and React 18 profile captures were byte-for-byte
identical PNGs (`5282a8d79ff89287c293502cdbfc6165ed7d71a7fe55e83c188307ec463e7d94`).

## Remaining risk

No real purchase, login, or other externally mutating workflow was executed.
Those flows retain the same main-process JavaScript and byte-identical backend,
but should receive a controlled dry-run before promoting the canary over the
rollback build. Electron 43's Node 24 runtime also reports one non-fatal
`DEP0040` warning from a legacy dependency using `punycode`.
