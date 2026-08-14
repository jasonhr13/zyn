# Zyn application runtime

This is the canonical Electron main-process source packed into `app-original.asar`. It replaces the
ignored `extracted/asar` build input recovered from the former runtime-base application.

`public/electron.js` and its helpers preserve the current data formats and IPC surface while making
the code reviewable and reproducible. Helpers that already have a canonical source in `launcher/`
or `native-farmer/` are copied into the staged application by the build instead of being maintained
twice here.

Generated frontend output and `node_modules` are not committed.
