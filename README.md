# EDMORE

Event-Driven Multi-agent Orchestration for Research Microscopy.

Authors: Meng Zhao, Anton Gladyshev, Sherjeel Shabih, Christoph T. Koch.

## Architecture

EDMORE contains a Python MCP server and a Node/TypeScript MCP client.
The client is the resident backend for the NionSwift interface.

```text
NionSwift UI <-> EDMORE client <-> EDMORE MCP server <-> microscope tools
                                                       |
                                                   ptycho-sem
```

- `src/edmore_mcp/server/`: existing FastMCP tool/resource registration and event forwarding.
- `client/packages/`: the current Harness-based EDMORE implementation: agents, planning,
  review, execution, projects, conversations, event replay, and UI APIs.
- `client/skills/`: microscopy workflow definitions.
- `client/runtime/`: pinned upstream runtime packages, with source and built artifacts.
  See `client/runtime/provenance.json` for their origin.
- NionSwift's separate plugin provides its UI and application-local tools.
- The separate ptycho-sem project owns SEM hardware control and acquisition.

The former Python `edmore_mcp.client` implementation has been removed. The client
does not require a sibling `deepseek-harness` checkout, Python Agents SDK, or a
second orchestration runtime.

## Install and Start

Install the Python MCP server from this directory:

```sh
pip install -e .
```

Install the client with Node.js 22.19+ (22.x) or 24+:

```sh
cd client
npm ci
npm start
```

The client listens on `http://127.0.0.1:7380` and serves its UI at `/edmore/`.
It discovers the NionSwift MCP server at `http://127.0.0.1:7300`.
After editable Python installation, `edmore-client` launches the same Node client.
Python wheels do not bundle the Node client; set `EDMORE_CLIENT_DIR` when installed separately.

NionSwift's start button launches `EDMORE/client/start.mjs`. In a different directory
layout, set `EDMORE_CLIENT_DIR` to the client directory before starting NionSwift.

## Configuration and Existing Data

| Variable | Purpose |
| --- | --- |
| `EDMORE_CLIENT_DIR` | Client installation location for Python/NionSwift launchers |
| `EDMORE_CLIENT_URL` | Client address used by NionSwift and event forwarding |
| `EDMORE_CLIENT_HOST` / `EDMORE_CLIENT_PORT` | Client bind address; defaults to 127.0.0.1:7380 |
| `EDMORE_NIONSWIFT_BASE_URL` | MCP server address; defaults to http://127.0.0.1:7300 |
| `EDMORE_WORKSPACE` | Initial project directory; defaults to the launch working directory |
| `DSH_HOME` | Existing data/configuration home; defaults to ~/.dsh |
| `EDMORE_CLIENT_EVENT_URL` | Optional explicit event ingestion URL |

Existing data stays in `~/.dsh/edmore`: sessions, workspace.json, events.jsonl,
plan-judge-state.json, provider/role settings, and credentials. No data-copy migration
is needed. Startup creates a separate `edmore-client` launch profile while retaining
the existing data paths. Stop the former backend before starting this client against
the same data directory. The old `EDMORE_HARNESS_URL` and event URL variables remain
accepted as compatibility aliases; the old checkout path is no longer used.

## APIs

```text
GET  /api/edmore/health
GET  /api/edmore/ui/state
GET  /api/edmore/ui/stream
GET  /api/edmore/events
POST /api/edmore/events
POST /api/edmore/actions/trigger
POST /api/edmore/actions/approve
POST /api/edmore/actions/reject
POST /api/edmore/actions/resume
GET  /api/edmore/skills
GET  /api/edmore/nionswift/tools
GET  /api/edmore-workspace/projects
GET  /api/edmore-workspace/conversations
```

`examples/demo_server.py` demonstrates Python MCP tool registration.
`examples/demo_client.py "your request"` submits a request to the running client.
`debug_agents.py` inspects the client's roles and tool registry.

## Verification

From `client/`:

```sh
npm test
npm run test:smoke
npm run test:portable
```

The smoke test uses temporary data and an offline instrument URL, checks startup,
skills, UI, conversation persistence, restart and shutdown. It does not run an LLM
or operate microscope hardware.

The portable test copies the client outside the workspace, runs a fresh `npm ci`,
then repeats the smoke test with no sibling repositories present.
