# Native Tango and Wiki Deployment

Cloud-derived sidecars for EDMORE, without Slurm, Apptainer, Docker, sudo,
system services, or a sibling source checkout. This directory belongs to the
Harness repository. It does not deploy anything to the cloud.

## One Command

From the EDMORE repository root:

```sh
bash deployment/native/deploy.sh up
```

First run downloads isolated toolchains and dependencies, builds WeKnora Lite,
initializes private storage, starts Tango and Wiki, and checks HTTP and MCP
readiness. Subsequent `up` calls reuse the installation and data. Initial
compilation needs Internet access, several GB of free disk, and several minutes.
The script must remain in this checkout while its managed processes are running.

Prerequisites: macOS or Linux, Python 3.9+, Git, and a C/C++ compiler. On macOS,
install the Command Line Tools with `xcode-select --install`; on Debian/Ubuntu,
the administrator supplies `build-essential`, `git`, `pkg-config`, `python3`,
and `python3-venv`. Windows requires WSL2. No packages are installed into the
system Python. `uv` provisions Python 3.12 for Tango; Node and Go downloads are
version-pinned and SHA-256 checked against their official release manifests.
`requirements.lock` pins the resolved Python dependency tree; WeKnora retains
its upstream Go module and frontend npm lockfiles.

| Service | Default local endpoint | Storage / dependencies |
| --- | --- | --- |
| WeKnora Lite | http://127.0.0.1:8080 | Go/CGO, SQLite FTS/vector support, local files, in-memory queues |
| Tango database | 127.0.0.1:10000 | PyTango 10.3.1, SQLite; no separate MySQL |
| Tango MCP gateway | http://127.0.0.1:8767/mcp | FastMCP 2, administrator-owned device allowlist |

All listeners are local-only. Do not forward raw Tango/MCP ports to a public
network: loopback access is not per-user authentication. Harness approvals and
authorization remain necessary. Installation does not enable arbitrary tools,
discover physical instruments, execute workflows, or expose cloud credentials.

Existing ports are never taken over. If your current Wiki already owns 8080:

```sh
bash deployment/native/deploy.sh up --home "$HOME/.local/share/edmore-native-demo" --offset 10000
```

This uses Wiki 18080, Tango DB 20000, MCP 18767. Pass the same `--home` to every
lifecycle command, or export `EDMORE_NATIVE_HOME` once. Port and service choices
are recorded on first installation; choose another home to change them.

## Lifecycle And Storage

```sh
bash deployment/native/deploy.sh status
bash deployment/native/deploy.sh stop
bash deployment/native/deploy.sh start
bash deployment/native/deploy.sh doctor
```

`stop` authenticates to this deployment's owner and stops only its children.
It does not kill a PID inferred from a port or touch an independently started
service. A sidecar failure stops the other owned sidecars and is recorded in
`last-error.json`. No automatic restart can replay a microscope operation.
Shutdown preserves databases, credentials, files and synchronization checkpoints.
An in-flight Wiki task is not a guaranteed durable queue item in Lite mode;
check/retry incomplete ingestion after an interrupted shutdown.

Default data root: `~/.local/share/edmore-native`, outside Git:

```text
settings.json            Installed versions, ports and service selection
endpoints.env            Local connection URLs and import paths; no API keys
tools/                   Private Node and Go toolchains
venv/                    Private Tango Python environment
sources/                 Pinned upstream Wiki + cloud Tango source snapshot
wiki/environment.json    Private backend settings, generated encryption/JWT keys
wiki/runtime/            Built server, frontend, migrations and dictionaries
wiki/data/               Wiki SQLite database and uploaded files
tango/                   Tango SQLite database and explicit device maps
wiki-sync/imports/       Public research documents, after sync is configured
wiki-sync/harness/       Generated public Harness documentation, kept separate
wiki-sync/checkpoints/   Synchronization state
logs/                    Private per-service and owner logs
```

Do not commit this data root. Back it up with services stopped. Preserve
`wiki/environment.json` with the Wiki database: changing `SYSTEM_AES_KEY`
invalidates decryption of saved credentials. Private files are mode 600 and new
deployment directories are mode 700. No existing `WeKnora-local`, `~/.dsh`,
installed Desktop app, or cloud database is modified or migrated.

Install only one sidecar with `--services wiki` or `--services tango`. `install`
prepares/builds without starting. Run `stop`, then `install`, then `start` when
updating this package; changed source hashes block silent reuse of an old build.
Compiled toolchains and dependency caches remain reusable.

## Devices And Optional TEM Twin

The default Tango service is deliberately empty: `list_devices` returns `[]`
until an administrator configures a device. Edit `tango/devices.json` in the
private data root while stopped. Keys are explicit `domain/family/member`
identities, values are Tango URLs. Targets must implement the EDMORE
`DescribeTools` protocol; this is not a universal adapter for arbitrary devices.
Startup validates registered descriptors but does not execute alignment calls.

For the cloud-equivalent simulated TEM, supply your licensed AutoScript SDK
wheels separately. They are not distributed in this Git repository:

```sh
bash deployment/native/deploy.sh stop
bash deployment/native/deploy.sh install --with-twin --autoscript-wheels /private/path/to/sdk-wheels
bash deployment/native/deploy.sh start
```

This explicitly starts `edmore/tem/twin`, its AutoScript endpoint (7521), Tango
device (10001), viewer (8768), and native stream (8769), with the same offset.
`tango/http-nodes.json` remains empty unless the owner supplies approved node
URLs and tokens. No real microscope is auto-enrolled. The source snapshot also
contains the cloud registration/admin modules, but this baseline does not start
their network enrollment portal or import its accounts. It is not a replacement
for the separate Harness per-user pairing/authorization work.

## Wiki Setup And Harness Connection

Backend deployment and model/account provisioning are separate. Open the local
Wiki URL, create your local account, configure embedding, synthesis and optional
vision/reranking models, and create the libraries you need. Models run remotely
unless you explicitly configure a local provider; no weights are downloaded by
this installer. Existing cloud accounts, model keys and private content are not
copied. The frontend defaults to English, and includes the deployed Shared
visibility and upload-default fixes; image defaults still require a valid model
configured on each knowledge base.
This installer does not create public/private libraries or enable automatic
knowledge synchronization; those remain the Wiki plugin's provisioning duties.

For platform-wide models, the built server includes
`wiki/runtime/config/builtin_models.yaml.example`. Keep your configured copy
outside `runtime/` and set `BUILTIN_MODELS_CONFIG` to its absolute path in
`wiki/environment.json`. Provider keys may also be supplied in that private
environment file. The generated runtime directory is replaceable build output.
For internal HU model hosts, configure only the exact trusted hosts in WeKnora's
`SSRF_WHITELIST_EXTRA`; do not disable SSRF protection globally. Full PDF/office/audio
parsing may require an additional document-reader service; this Lite bundle
does not provision that service or speech models.

To configure a source-launched, single-user Harness, load `endpoints.env` in
the same shell before starting the client. It contains `EDMORE_TANGO_MCP_URL`,
`WEKNORA_BASE_URL`, `WEKNORA_IMPORT_DIR` and `WEKNORA_SYNC_DIR`. The existing
Tango feature package consumes the MCP URL. Wiki additionally needs scoped API
keys and knowledge-base IDs; use the Wiki plugin's account provisioning rather
than a shared administrator key in user workers. See
[feature package boundaries](../../client/docs/feature-plugins.md).

Public `Harness` documentation and public `Research` documents remain separate;
private custom capabilities, runs, conversations and documents remain per user.
Creating the sync folders alone does **not** enable a file watcher. The existing
Wiki plugin owns synchronization once credentials, library IDs and its sync
service are configured. The native manager owns backend processes only.

The existing Desktop app still has its previous Wiki launcher. Do not start two
owners on the same port; use this script's `stop` for services it started.
Installing an npm feature package does not silently run this deployment script.

## Source Provenance And Validation

`versions.json` pins WeKnora upstream. `weknora.patch` contains the deployed
English locale, Shared visibility, upload-default, SQLite Wiki reference/move
fixes and their tests. `tem-twin-source.tar.gz` is a source-only snapshot read
from the deployed cloud source; `PROVENANCE.json` records its SHA-256 and key
file hashes. It excludes SDK wheels, databases, tokens, Python bytecode and
`node_modules`. Existing source license notices are preserved. The snapshot is
an internal deployment component; review redistribution rights before publishing
it outside the EDMORE project.

```sh
python3 -m unittest discover -s deployment/native/tests -v
```

For an explicitly disposable, already-installed Wiki+Tango deployment, run
`python3 deployment/native/tests/smoke.py --home /path/to/test-deployment`.
This creates a test account, checks MCP and HTTP, restarts services, verifies
account/key persistence, and leaves the test services stopped. Do not point it
at a deployment serving real users.

Verified on 2026-10-06, macOS arm64: fresh combined install, repeat install,
HTTP health, English default, empty MCP registry, repeated `up`, authenticated
lifecycle control, immediate stop/start, and account/key persistence. The smoke
test finishes with every test sidecar stopped. Also passed: 18 deployment unit
tests, four frontend patch tests, and both targeted Go SQLite patch tests.

Linux uses the same native commands but requires a separate Linux smoke test.
The optional licensed Twin and model-backed ingestion were not exercised.
Upstream frontend dependencies retain the cloud
lockfile, including its npm audit warnings; this bundle is local-only, not a
security-hardened public hosting release.
