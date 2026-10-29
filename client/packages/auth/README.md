# EDMORE Auth

Optional multiuser host plugin for the EDMORE REST frontend. Enable with
`EDMORE_AUTH=1 npm start`; omit it (or use `0`) to keep the existing default-user
Harness and its existing data. Authentication failures never fall back to that
default account. Enabling/disabling requires a service restart.

## Design and research

Uses the published MIT `@islibaodong/dsh-login@0.2.4` UserStore (scrypt password
hashing) and SessionStore/cookie primitives. Its native Typert/UI integration is
not installed: EDMORE uses `/api/edmore`, not the native Web transport. Account
mutations are serialized and the storage adapter rejects corrupt account data.

Research:
- https://github.com/islibaodong/dsh-login: reusable auth primitives; its README
  explicitly requires additional isolation composition and lacks per-user plugin
  activation for third-party plugins.
- https://github.com/lzyuan549/dsh-plugin-auth: authentication gate, shared runtime.
- https://github.com/king-bcolor/dsh-multi-tenant-projects: soft workspace isolation.
- https://github.com/vocsong/deepseek-harness-portal: independent runtime/container
  architecture; Podman deployment is not directly reusable in this Slurm job.
- Official DSH 0.1.7-rc.2 browser authentication does not provide a named-user
  directory or per-user plugin settings for EDMORE's REST endpoints.

## Accounts and concurrent use

Bootstrap from the client directory, inside the same Apptainer binds as the job:

```sh
DSH_HOME=/data node --import tsx/esm packages/auth/src/cli.mjs bootstrap zhaomeng
```

The generated administrator credentials are written to
`$DSH_HOME/auth/initial-admin.txt` with mode 600. There is no public first-visitor
setup endpoint. Change the password after first login; delete the initial file
after recording it securely. Admins create/disable users and reset passwords at
`/account`; users can change their own password. Password resets and disabling
revoke all that user's sessions and disconnect streams. Logout revokes only that
device's session. Login sessions last 12 hours and are invalidated on restart.

Each user receives an independent Harness process, home, event log, workspace,
OpenAI credentials, conversations and plugin configuration. Multiple browsers
can use one account; different accounts never share a runtime. Admin status
grants account management, not access to another user's conversations.

When server Wiki is enabled, every account is provisioned with a separate native
WeKnora identity and tenant. Each tenant owns independent Capabilities, Runs and
Conversations knowledge bases and scoped keys. The public Wiki is shared read-only.
Startup backfills older EDMORE accounts before accepting logins; new accounts are
provisioned during creation. Wiki is enabled by default, while a user may disable
the plugin for their current runtime without deleting the isolated Wiki account.

`EDMORE_MAX_USERS` defaults to four concurrent active Harness processes. Login
itself does not reserve a process. Idle workers without open requests are stopped
after 30 minutes; requests beyond capacity return 503. Closing browser tabs
allows their event streams to close and starts the idle timer.

Only preinstalled Plan/Judge and conversation-title plugins are user-switchable
in this release. Changes restart only that user's worker. Installation of new
code remains an administrator operation. File and Bash tools, Mac Computer Use,
and NionSwift are disabled in authenticated workers. Process separation is NOT
an OS sandbox: arbitrary code execution/plugins must not be enabled until a
separate OS/container execution boundary has been provided.

## Shared and personal models

Configure the default home with `llm3-hu` and `bonsai-local` before enabling auth.
The gateway reads their endpoint and credential references from the existing
`edmore/llm-providers.json` and `edmore/.credentials.yaml`. Upstream keys stay in
the gateway. Workers receive only a per-process model-proxy token. Shared model
configuration cannot be edited or deleted by users, including admins through
their personal model page. Administrator source configuration changes take
effect after restart.

Bonsai generation is serialized (one active upstream request); HU permits four.
Both queues allow up to 32 waiting requests and up to two outstanding requests
per user per model. Cancelled waiting HTTP requests are removed. `/auth/me`
reports queue counts. OpenAI credentials are empty for new users and must be
entered individually. User-supplied OpenAI base URLs/credential refs are not
accepted; requests go to the official OpenAI endpoint.

Jev is a personal paid service for non-administrator cloud users. Each user
stores their own TypeSafe API key on `/account`; it is written only to that
user's mode-600 credentials file and their worker calls TypeSafe directly. The
administrator uses the server key configured in `/admin`. Without a personal
key, a non-administrator's Jev provider is disabled and Plan/Judge falls back to
the configured LLM. Non-administrator worker tokens cannot access the
administrator's Jev proxy.

## Network and storage

`EDMORE_PUBLIC_URL` must be the exact browser origin when listening on the network,
for example `http://edmore.example.org:7380`. Requests with other Host
headers and cross-origin mutations are rejected. No CORS is enabled. Sessions
use HttpOnly/SameSite=Strict cookies. Optional HTTPS uses `EDMORE_TLS_CERT_FILE`
and `EDMORE_TLS_KEY_FILE`, plus an HTTPS public URL; Secure cookies then apply.
HTTP inside a VPN is still HTTP at the application layer; use an administrator
provided certificate for encrypted browser-to-service traffic.

Storage below the existing home:

```text
edmore/                  existing default user's data (preserved)
auth/accounts.json       password hashes and account metadata
auth/users/<username>/   private Harness home, worker log, plugin preferences
```

Personal workspaces live under `$EDMORE_WORKSPACE/<username>`. Shared application
code is still bind-mounted; SIF rebuilds are not required for source changes.
This plugin does not provide a remote Electron-app login flow yet.

Tests: `node --import tsx/esm --test packages/auth/tests/auth.test.mjs`.

## Administrator console

`/admin` and every `/api/admin/*` endpoint require an authenticated administrator.
Account links to Server settings only for administrators. Settings are kept in
`$DSH_HOME/auth/admin`, with mode-600 configuration backups in `history`.
Secrets are write-only in the UI. Saving creates a revision; Apply settings
restarts idle workers and refuses while conversations or mutations are active.
Existing sessions stay logged in. Workers restart on the next workspace request.

Skills reuse the desktop SkillManager and native SKILL.md/workflow validation.
Built-ins are read-only; custom support/workflow skills can be created, edited,
duplicated and removed. SKILL.md import accepts support skills. Custom skills
are shared through per-worker snapshots, not live mutable directories.

MCP connections use the native dsh-mcp-client (Streamable HTTP or stdio) and are
loaded only in administrator runtimes. Stdio commands have the server OS user's
permissions; they are not a sandbox. Normal users never receive these tools or
credentials. Inspect runtime lists registered tools, not a connectivity guarantee
for endpoints that expose no tools. MCP source changes apply after restart.

Plan/Judge and title generation have global enable gates. Jev also has a global
gate. The administrator key stays in the gateway and is available only to admin
workers through a bounded local proxy; ordinary users call TypeSafe with their
own private key. Missing/invalid keys or decision failures keep the existing
Judge fallback.
Arbitrary npm installation, Core/auth disabling, and OS/hardware permissions are
not exposed in this console.
## Personal and Shared MCP Connections

`/account` manages the authenticated user's HTTP MCP connections through
`GET/POST /auth/mcp`. Identity is always derived from the login session, never
from the submitted configuration. Personal settings are isolated per account;
stdio commands are administrator-only. Updates refuse active conversations or
mutating requests, stop only the user's idle worker, and apply at its next start.

`/admin` supports `administrators` (the backwards-compatible default) and `shared`
MCP scopes. Shared names are reserved and override colliding personal entries,
including disabled shared entries. Ordinary users see shared names and status,
not their addresses, commands or credentials. Admin saves require Apply settings.

Personal HTTP traffic uses a token-bound MCP proxy with per-connection DNS/IP
validation, pinned public destination addresses, no redirects, and no forwarded
worker credentials. Localhost, private networks and metadata endpoints must be
configured by the administrator instead. A cloud URL must be reachable from the
server, not just the user's browser. Standard MCP uses a full `/mcp` endpoint;
EDMORE multi-agent uses the service root and the reserved `nionswift` identity.
