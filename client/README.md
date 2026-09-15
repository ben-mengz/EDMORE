# EDMORE Client

This directory is the resident MCP client and NionSwift backend. Start with
`npm ci` and `npm start` using Node 22.19+ (22.x) or 24+.
See [the EDMORE README](../README.md) for configuration, data paths and APIs.

## Ownership

- `packages/` and `skills/` are the editable EDMORE implementation, migrated from
  the previously separate Harness checkout. TypeScript is loaded through tsx.
- `runtime/` contains the selected upstream runtime packages, including their
  sources, prebuilt JavaScript, manifests and license notices. Versions and source
  locations are recorded in `runtime/provenance.json`.
- `package-lock.json` pins registry dependencies. The native system package uses
  the published version 0.1.2; its platform binaries are installed by npm.

Runtime manifests use concrete versions instead of workspace protocol references.
The CLI manifest contains only the dependencies used by its profile launcher;
unrelated app presets are not included. Optional peer integrations outside this
profile are omitted. `.npmrc` disables automatic peer installation because the
required peers are explicit local workspaces, including their dependency cycles.

The runtime snapshot is deliberately checked in, so normal installation and startup
never read the original checkout or require its build tools. To update it, review
upstream source and generated artifacts together. `scripts/import-runtime.py` records
the original import procedure and refuses to overwrite existing directories; it is
not a build or installation step. EDMORE's profile path edits and source entrypoints
must also be retained when importing a future version.

## Checks

```sh
npm test
npm run test:smoke
npm run test:portable
```

Tests use isolated data and do not operate real hardware or send LLM requests.
