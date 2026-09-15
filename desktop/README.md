# EDMORE Desktop

The Mac desktop application controls the EDMORE client in `../client`.
It launches that installation's `start.mjs` and uses the fixed `edmore-client`
profile. The previous Harness checkout and its CLI are not supported launch targets.

Install the client first (`cd ../client` then `npm ci`). In this directory:

```sh
npm ci
npm start
npm test
node tests/profile-smoke.mjs
npm run package:mac -- --arm64
```

The app keeps its menu-bar control, workspace window, MCP status, plugin controls,
and English/Chinese language selection. Closing the interface keeps the client
running; Quit Completely gracefully stops the client owned by this app.

Configuration is stored as `client.json` in Electron's user data directory.
On first launch, old `harness.json` settings are migrated to the sibling EDMORE
client installation. Endpoint, Node path, language preferences and plugin overrides
are retained. The original configuration remains as a backup. For another layout,
set `EDMORE_CLIENT_DIR` or select the EDMORE client directory in Settings.

The application does not bundle Node or the client. Installers are written to
`release/`. Mac development builds are ad-hoc signed, not notarized releases.
The lifecycle smoke test uses isolated data and an offline instrument address.
