# Native Target backend

The architecture-specific `backend` executables in this directory are built from the
`zyn-native-backend` branch of `polar-backend-source`. They use the `zyn` build tag, which links the
Target module only and starts without Polar cloud, Railway, Luca, Hyper, PKC, or security services.

Rebuild both checked-in artifacts from the sibling source repository with:

```bash
POLAR_BACKEND_SOURCE=../polar-backend-source ./scripts/build-native-target-engine.sh all
```

`scripts/build-zyn.sh` selects `darwin-arm64/backend` or `darwin-x64/backend` to match the Electron
application architecture and verifies that the Mach-O slice is correct before packaging it.
