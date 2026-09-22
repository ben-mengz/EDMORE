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

Tests use isolated data and never operate real hardware or call external model
providers. The smoke suite runs the native Harness loop against a local mock
OpenAI-compatible HTTP server, including cancellation and session restoration.

## Core and Optional Features

`edmore-core` is the mandatory entry. It initializes events, action receipts,
tasks, policy/connection registries, capability diagnostics and the internal
`packages/runtime` module. That module adapts native Harness agents, models,
sessions and skills; it is not a replacement agent loop. The upstream code in
`client/runtime` is unchanged by this refactor.

Optional profile entries retain independent lifecycle boundaries:

- `edmore-plan-judge`: owns workflow creation, planning, judging and execution policy.
- `edmore-session-state`: workflow evidence; `edmore-session-state-api`: its HTTP view.
- `edmore-mcp-bridge`: MCP discovery, tool registration and connection lifecycle.
- `edmore-workspace`: project/conversation metadata; `edmore-workspace-api`: HTTP access.
- `edmore-conversation-title`: model-generated titles.
- `edmore-backend`: HTTP commands, queries and SSE, with no agent ownership.
- `edmore-webui`: the page and assets, now in `packages/webui/static`.

The profile wraps optional entries with `edmore-optional-feature`. Failed starts
are isolated through Cordis and reported by `/api/edmore/capabilities`. Missing
workflow policy blocks controlled MCP execution, while disabling workflow does
not disable ordinary native agent conversations. Desktop changes are applied on
restart, with dependency previews and mandatory-Core protection.

Core model settings are under `edmore-core.config.runtime`; workflow settings
are under the plan-judge feature's `config.options`. Existing data paths and HTTP
paths are preserved. Evidence migration creates `before-core-refs` and
`before-evidence` backups before replacing duplicate records with references.
Keep Core event logs and workflow evidence together when moving or restoring data.

See [the refactoring plan and verification record](../docs/plugin-decoupling-plan.zh.md)
for current deployment status and real-hardware acceptance limits.
