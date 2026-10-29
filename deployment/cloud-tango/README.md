# Cloud Tango Migration

The host has a generic conversation-extension slot. Tango owns its UI assets,
state, context contribution and tool guard. Model switches are per-user in Account;
the model proxy enforces them as well as administrator policy. Switching a plugin
restarts only that user's idle worker, not the shared model service.

`files.txt` is the reviewed Harness overlay, not a full repository synchronization.
Retain the cloud package manifests and add the Tango workspace/dependency, then
regenerate the lockfile and install in staging before switching the live source.

Back up the source, launch scripts, auth settings and registration configuration.
Check for active responses/workflows and quiesce the device gateway before stopping
services. The migration requires the matching `device_access`, `device_pairing`,
`device_middleware`, and secured Tango MCP modules. Preserve cloud-specific
registration status repairs when merging the registration server/admin changes.

Run `prepare-access.py` once after the services stop. It refuses an existing access
directory, generates a fresh issuer key, trusts the existing registration TLS
certificate, removes the old shared MCP connection and grants no device rights.
Bind the access directory read-only into Harness as `/tango-access`; the registration
service needs write access to its policy. The gateway binds MCP to loopback and
requires a signed Harness identity on every request. Keep `tem_twin` as the MCP
server name for existing Skills. Devices must be assigned by an administrator or
paired by their owners before appearing in the conversation instrument picker.

On failure, stop the new services and restore the backed-up source, launch scripts
and configuration together. Do not overwrite Wiki databases or user conversations.
Never claim a restart or revoked permission has stopped an in-flight hardware action.
