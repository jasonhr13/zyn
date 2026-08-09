# Native checkout backend

The architecture-specific `backend` executables in this directory are built from the
`zyn-native-backend` branch of `polar-backend-source`. They use the `zyn` build tag, which links the
Target and Pokémon Center US modules. The native process starts without Polar cloud authentication,
Luca, embedded Hyper credentials, PKC, or security services. Pokémon Center retains the existing
Railway queue-status check; Hyper operations cross the authenticated local bridge to Zyn's licensed
server broker, and hCaptcha is solved manually in an isolated Electron window.

Rebuild both checked-in artifacts from the sibling source repository with:

```bash
POLAR_BACKEND_SOURCE=../polar-backend-source ./scripts/build-native-target-engine.sh all
```

`scripts/build-zyn.sh` selects `darwin-arm64/backend` or `darwin-x64/backend` to match the Electron
application architecture and verifies that the Mach-O slice is correct before packaging it.
`scripts/native-target-engine-protocol-smoke.js` also proves the checked-in host binary dispatches
both the authenticated bridge and the Pokémon Center US module without making a checkout request.
