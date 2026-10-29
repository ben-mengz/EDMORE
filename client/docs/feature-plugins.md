# EDMORE Feature Packages

## Scope

Packaging was introduced locally using the cloud deployment as the behavior
baseline. Cloud rollout is a separate, explicit operation; see the
non-Tango rollout record in `deployment/private/` (kept out of git).
No server restart, deployment, model request, device operation or knowledge-base
migration is part of package installation itself.
The installed macOS app is not overwritten by the source build.

Authentication, sessions, credential isolation, model-proxy authorization,
workflow approval, execution and auditing remain host responsibilities.
Feature packages consume those contracts; a package manifest does not grant
users additional permissions.

## Dependency Boundaries

| Package | Owns | Host / external prerequisites |
| --- | --- | --- |
| `@edmore/plugin-host` | Manifest validation, ordering, private JSON storage | Node 22.19+ (22.x) or 24+ as required by Harness |
| `@edmore/plugin-wiki` | Native Wiki accounts, scoped browser proxy, local portal, lifecycle adapter, public sync, migration commands, desktop Wiki adapter, Cordis bundle | plugin-host; EDMORE Core and optional-feature loader; weknora-sync; Tencent retrieval plugin; WeKnora 0.8.2-lite with cloud SQLite move fix |
| `@deepseek-ai/dsh-edmore-weknora-sync` | Capability, history and reference synchronization and retrieval | Cordis, Skills, Tools and schema API; Wiki credentials supplied at runtime |
| `@edmore/plugin-remote` | Cloud connection, isolated browser session identity, explicitly requested local MCP sharing | Desktop connection/configuration interfaces, authenticated Harness server and VPN for sharing |
| `@edmore/plugin-hu` | HU model defaults and concurrency contribution | Host credential store and authenticated model proxy; HU API |
| `@edmore/plugin-bonsai` | Bonsai model contribution | Host model proxy; administrator-configured OpenAI-compatible endpoint |
| `@edmore/plugin-strata` | Optional Strata contribution and concurrency limit | Host model proxy; only enabled as a provider when its profile exists |
| `@edmore/plugin-tango` | Optional Tango MCP connection bundle and endpoint validation | MCP client and EDMORE MCP bridge; separately deployed Tango MCP gateway |

Wiki does not depend on HU or Strata: its models are deployment configuration.
Remote connection does not depend on Wiki or Tango. Model plugins do not depend
on each other. Inter-feature requirements are declared in `plugin.json`;
ordinary JavaScript dependencies are declared in `package.json`. Cyclic,
missing and disabled prerequisites are rejected rather than silently enabled.

Existing Workflow Engine, Jev decisions and other Cordis packages remain their
existing plugin packages. This change does not duplicate their implementations
or replace their approval and dependency checks.

## Local Installation And Build

From the existing EDMORE `client` directory:

```sh
npm ci --ignore-scripts
node scripts/features.mjs doctor
node scripts/package-features.mjs
node --import tsx/esm --test packages/plugin-host/tests/features.test.mjs
```

The source workspace installs the feature packages using npm workspaces.
`../plugin-dist/` contains standard npm `.tgz` packages plus `feature-kit.json`
with SHA-256 hashes and dependency inventories. These archives target a
compatible EDMORE host, not an empty Node project. Host-owned private packages
are supplied by the host workspace; third-party dependencies are supplied by
its lockfile. Neither model weights, vendor AutoScript wheels, WeKnora binaries,
Tango databases nor credentials are embedded in JavaScript packages.

For an existing compatible deployment host, install the selected EDMORE feature
packages and their declared dependencies from the matching kit. Installing all
archives with `npm install --ignore-scripts /path/to/kit/*.tgz` selects the full
kit; it is not an inter-feature requirement. Keep internal exact-version
dependencies available, including packages required directly by the host.
This command was dry-run validated against the local host; it is not a command
to run on the current cloud server. The source checkout should normally keep
its workspace dependencies instead of replacing them with archive dependencies.

Desktop `npm run package:mac` and `package:win` prepare package contributions
before electron-builder. The generated `desktop/feature-packages` directory
is build output, not a second source of truth. Canonical source is under
`client/packages/plugin-*`. Compatibility re-exports preserve old imports.

## Configuration And Lifecycle

All six feature packages belong to EDMORE and use `@edmore/plugin-*` names.
The default source distribution selects all six. A deployment that deliberately
omits packages must declare its installed selection with `EDMORE_FEATURE_PACKAGES`.
For example, the non-Tango server selection is:

```sh
export EDMORE_FEATURE_PACKAGES='["@edmore/plugin-wiki","@edmore/plugin-remote","@edmore/plugin-hu","@edmore/plugin-bonsai","@edmore/plugin-strata"]'
```

The server forwards this selection to authenticated workers. Only selected
feature manifests are loaded; missing selected packages or declared dependencies
remain errors. This does not remove ordinary host package dependencies or alter
existing manually configured Tango MCP connections. Feature disabling below is
separate from selecting which packages a deployment installs.

```sh
node scripts/features.mjs list
node scripts/features.mjs disable strata
node scripts/features.mjs enable strata
```

Configuration is `$DSH_HOME/edmore/features.json` (default `~/.dsh`), or an
explicit `EDMORE_FEATURE_CONFIG`. Changes take effect on the next local restart.
Commands do not restart or kill processes. Auth workers receive a copy of the
server feature policy, never administrator credentials. Model proxy routes
accept only configured provider IDs and worker tokens.

Use existing per-user Wiki and Cordis feature switches for user-level control.
The package switch is deployment-level. Missing external prerequisites must be
configured explicitly; `doctor` resolves code dependencies without contacting
devices or models. The current Desktop npm plugin installer remains for Cordis
plugins; these cross-process feature packages are installed through the host
workspace/build, not an arbitrary tarball-upload UI.

Tango remains disconnected unless `EDMORE_TANGO_MCP_URL` is set. The new bundle
is disabled in authenticated workers: they use administrator-configured MCP
entries and never inherit a deployment-wide Tango token. Existing manually
configured MCP entries are not deleted or rewritten by this package switch.
Device ownership, pairing approvals and per-user Tango authorization are a
separate next change and are not claimed by this packaging release.

The host repository now includes [native backend deployment](../../deployment/native/README.md).
Run `bash deployment/native/deploy.sh up` from the repository root to install
and own local Tango/Wiki sidecars without Slurm or containers. This is an
explicit deployment operation, not an npm install hook; feature packages still
own only their declared host contributions. Backend deployment does not copy
cloud accounts, model credentials or device enrollments.

## Wiki Data And Migration

Cloud-native account provisioning, public editor/viewer rules and the two
public/four private library boundaries are retained. The local deployment has
not been automatically migrated. Moving references or removing exact generated
duplicates requires an explicit administrator migration after backup.

Migration supports `DSH_HOME`, `EDMORE_WIKI_PROVISION_CONFIG`,
`WEKNORA_DATA_DIR` and `WEKNORA_SYNC_DIR`; the original cloud paths remain
defaults for deployment compatibility. Omitting `--apply` is a dry run.
Use the existing `scripts/migrate-wiki-boundaries.mjs` compatibility entry.
The native local Wiki portal uses a one-use IPC-issued entry token, a loopback
listener and an HttpOnly cookie; native Wiki bearer tokens never enter the page.

Disabling or uninstalling code does not delete user databases, credentials,
conversation evidence or pairing records. Preserve the previous package kit
for code rollback. Data migrations are explicit and are not automatically
reversed when rolling back code.
