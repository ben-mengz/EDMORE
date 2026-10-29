# EDMORE Client

This directory is the resident MCP client and NionSwift backend. Start with
`npm ci` and `npm start` using Node 22.19+ (22.x) or 24+.
See [the EDMORE README](../README.md) for configuration, data paths and APIs.

## Ownership

- `packages/` and `skills/` are the editable EDMORE implementation, migrated from
  the previously separate Harness checkout. TypeScript is loaded through tsx.
- `package-lock.json` pins the published DeepSeek Harness runtime and plugins,
  currently `0.1.7-rc.2`. Startup resolves the CLI from `@deepseek-ai/dsh`.
- `runtime/` is the inactive `0.1.5-rc.1` source snapshot retained for provenance
  and rollback reference. It is not a workspace and is not loaded at runtime.

Published Harness dependencies use concrete versions. `.npmrc` disables automatic
peer installation, so the peers required by this profile are declared explicitly.
The retained snapshot's origin is recorded in `runtime/provenance.json`; the old
`scripts/import-runtime.py` documents its import procedure but is no longer the
normal upgrade path.

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
sessions and skills; it is not a replacement agent loop. Upstream Harness code is
consumed from the npm packages locked by `package-lock.json`.

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

### Structured Workflow Planning

New plans whose leaf Skills all define complete, unambiguous structured steps are
compiled from their pinned contracts. The model selects the Skill; it does not
rewrite the step list. If a contract has user-overridable `default` or
`tool_default` parameters, a parameter-only model call supplies a validated
override map. Fixed values, result bindings, confirmation gates, transitions and
loop bounds remain contract-owned. With no overridable parameters, step
generation makes no model call. Compiler-produced plans run structural/schema
validation only, without LLM plan review or automatic LLM plan rewriting. Invalid
plans remain blocked. Approval and runtime completion judging (Jev with LLM
fallback) are unchanged; this optimization never skips judging measured results.

Legacy contracts, optional-action/recovery-loop contracts, ambiguous child step
IDs, and revisions or child-plan recovery keep the existing planner and LLM plan
review path for now.
Malformed parameter output or provider failure blocks planning; it never silently
falls back to an invented plan. Existing approved plans are unchanged. Restart
Harness to load code changes; assess latency on a fresh plan, not a resumed one.

See [the refactoring plan and verification record](../docs/plugin-decoupling-plan.zh.md)
for current deployment status and real-hardware acceptance limits.
# Workflow And Skill Terminology

Executable EDMORE definitions are **Workflows**, including single-step and
compound workflows. Knowledge and guidance documents are **Skills**. The
optional execution plugin is displayed as **Workflow Engine**.

A Workflow has two uses. With Workflow Engine enabled, it provides the reviewed
execution contract, parameter bindings, transitions and completion conditions.
With the engine disabled, it remains readable through the ordinary skill
registry for explanation and reference only. The LLM must not emulate execution
or bypass approval; Core blocks MCP execution without a registered policy.
The skill registry must remain enabled for reference access.

Compatibility identifiers (`edmore-plan-judge`, `skill`, `contract_skill`,
`supporting_skills`), API routes, directories and `SKILL.md` filenames are
unchanged. Renaming the displayed concepts does not migrate approved snapshots
or change the six TEM calibration tools.
