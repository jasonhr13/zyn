# Zyn UI refresh

Branch: `codex/zyn-ui-refresh`

This direction pairs graphite surfaces with a warm coral accent. Light mode uses cool white surfaces and a darker coral for readable controls. Success, warnings, errors, and informational states have distinct colors. Native system fonts replace the remote display/body fonts.

The shared shell keeps Zyn branding in the title bar and uses a single sidebar for page navigation, filtered by module permissions. Settings has one navigation entry; the account footer shows the signed-in identity.

The dashboard shows summary metrics, a full-width activity chart, and checkout history. Its chart sizes to the available space, uses readable tick intervals, and retains real analytics filters, search, pagination, and export. Task groups, account/profile rows, forms, and dialogs share the refreshed type and surface treatment. Reduced-motion preferences are respected.

The desktop window remembers its position and normal size when moved, resized, or closed. It restores before appearing, including reopening from the macOS Dock. Existing size-only preferences migrate automatically. If the saved position is outside the available monitors, Zyn centers on the primary display; partially off-screen bounds are brought into the monitor's usable area.

## Try the preview

Build the renderer from the repository root:

```sh
(cd frontend && node --openssl-legacy-provider node_modules/react-scripts/scripts/build.js)
node scripts/preview-zyn-ui.cjs
```

Open `http://127.0.0.1:4173`. The preview serves the compiled application with an isolated browser bridge and sample data. It does not load your desktop data, authenticate, start tasks, or connect external services. Group/settings edits live only in that browser tab and reset on reload. The sample bridge is not included in the application bundle.

Useful variants:

- `/?empty=1` — empty dashboard and workspaces
- `/?locked=1` — sign-in screen
- `/?targetOnly=1` — navigation without optional modules

## Verification

```sh
node scripts/zyn-ui-refresh-smoke.cjs
node scripts/analytics-dashboard-smoke-test.js
node scripts/target-only-ui-smoke-test.js
node scripts/profile-group-workspace-smoke-test.js
node scripts/account-group-workspace-smoke-test.js
node scripts/proxy-group-workspace-smoke-test.js
node scripts/zyn-brand-smoke-test.js
node scripts/window-size-state-smoke-test.js
node scripts/window-position-electron-smoke.cjs
```

The UI smoke test uses the existing Playwright dependency and bundled Chromium where available. It checks eight routes, analytics controls and export, keyboard navigation, license-filtered navigation, theme persistence, dialogs, dashboard loading and empty/sign-in states, and the 1100×700 default and 900×600 minimum layouts. Screenshots are written to `.local/ui-refresh/`.

The window-state checks cover saved coordinates, monitor fallback, legacy preferences, and move/close events. The native Electron check uses the bundled macOS runtime with temporary preferences to verify relaunch and window recreation; an optional first argument selects a packaged `window-size-state.js` to test.

The production renderer build passes with existing `no-mixed-operators` warnings in `profiles.js` and `task-groups.js`. Checkout engines, live services, and packaged OS window controls require a separate desktop runtime test; the UI preview does not exercise those integrations.
