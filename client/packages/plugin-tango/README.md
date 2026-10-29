# Tango Device Access

The plugin owns pairing, sharing, the Devices page and the authenticated MCP
proxy. The Harness auth host owns accounts, sessions, worker credentials and
Workflow approval. The matching `edmore_windows_node` gateway owns enforcement;
Tango itself is not given a separate password for every Harness account.

## Dependencies

- EDMORE plugin-host API 1 and the auth host adapter in this checkout.
- Existing MCP client and EDMORE MCP bridge (declared in package.json).
- Matching Windows Node Python source with device_access, device_pairing and
  device_middleware; aiohttp, FastMCP 2 and Tango remain external services.
- Existing registration service, relay, protected management token, and reload
  supervisor. No second execution engine is introduced.

The signing key stays in the Harness auth host and gateway, never a browser,
user worker, Windows Node, skill or Wiki. A worker receives only a random
revocable credential for the host's loopback proxy. Accounts are checked on
every request. Password changes preserve ownership; deleting/recreating an
account does not inherit it.

## Prepare a Deployment

This creates configuration only; it does not restart or change any service.
Use a new directory and the actual registration state path. HTTP endpoints
are accepted only on loopback; use HTTPS across hosts and `--ca-file` for a
private CA. Never disable certificate verification.

```sh
node packages/plugin-tango/src/configure.mjs \
  --directory /absolute/private/tango-access \
  --issuer edmore-local \
  --registration-url http://127.0.0.1:8780 \
  --mcp-url http://127.0.0.1:8767/mcp \
  --registration-state /absolute/private/registration-state.json
```

1. Set `EDMORE_TANGO_ACCESS_FILE` to harness-access.json in the auth host.
2. Add `device_access_file` pointing to gateway-access.json in registration
   config (which must also have admin_auth_file configured).
3. Set `TEM_DEVICE_ACCESS_FILE` to gateway-access.json for the Tango stack and
   its reload supervisor. Alternatively pass `--access-config` to tango_mcp.
4. Keep raw Tango, management, relay-internal and node HTTP endpoints private.
   Binding only a UI is NOT isolation. Same-OS malicious processes require
   separate OS/container boundaries; this plugin is application authorization.
5. After planned reload, sign in and open Account > Devices. Local authenticated
   Harness and cloud Harness use the same code. An anonymous standalone local
   worker does not invent a cloud identity; use the authenticated Harness.

Use separate issuer names/keys for independent local and cloud account stores.
An issuer can be trusted by both gateways deliberately, but copying account
names alone must never grant access. Paths in Slurm must be inside persistent
bind mounts; bind configuration, policy and registration state, not just source.

## Ownership and Sharing

- Windows Node Register issues a one-use, 10-minute pairing code in its Cloud
  tab. The user enters it in Harness and approves connection. No password goes
  to the Node. If the code expires, re-submit registration to issue a fresh one.
- Claiming ownership reuses existing admission, quiesce and reload. A failed
  reload is shown as pending, not success; Retry registration is explicit.
- Only the owner requests a share to an active Harness username. An admin
  approves it. Read access permits list/select/status plus the explicitly
  configured read_tools allowlist; operate still requires Workflow approvals.
- Admins can inventory and assign previously unclaimed devices. They do not
  implicitly get execution authority over other owners' devices.
- Revocation/blocking is checked on every new call. It is not an emergency stop
  and does not prove an in-flight physical action was cancelled.
- Legacy system devices start unclaimed/invisible; assign them deliberately.
  Existing registration admission rules and protected-system devices remain.
- After a new pairing or sharing grant, the recipient uses Refresh Harness
  tools to rebuild its cached MCP catalog. This explicitly restarts only that
  user's idle worker, using the host's active-response guard. Permission
  revocation does not wait for this refresh; every new call is still checked.
- Policy is stored atomically with a full audit in device-policy.json. Preserve
  this file across restart/uninstall. Do not publish it or pairing receipts to Wiki.

The secure gateway CLI refuses missing access config. `--legacy-local` is an
explicit loopback-only development mode, never a multi-user deployment mode.
The current changes are local source/package changes, not a cloud rollout.
# Conversation Instruments

The package owns `static/panel.js`, `static/panel.css`, inventory and selection
storage. Harness only exposes the generic conversation-extension registry and
sidebar slot. No Tango import, markup or stylesheet is required by the host UI.
Uninstalled/disabled extensions return no descriptor and their assets are not served.

When this plugin is enabled, the Harness sidebar shows an Instruments checkbox
list below Conversations. Inventory comes from the current user's authenticated
Tango `list_devices` endpoint. No instrument is selected automatically.

Selections are stored per conversation in the worker's
`$DSH_HOME/edmore/tango-conversations.json`. Disabling the plugin hides the panel
and preserves this file. Restart Harness after changing plugin enablement.
Refresh the instrument list after connecting devices or finishing a workflow.

Every Tango device tool requires an explicit selected `device`; the agent receives
the current selection in its context and a runtime guard rejects other targets.
Selection never grants access or replaces workflow approval. The gateway still
checks user permissions on every invocation. Changes are blocked during a response
or a pending, active, or paused workflow. Finish or cancel it before changing targets.
