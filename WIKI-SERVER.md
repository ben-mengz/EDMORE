# Wiki in the EDMORE Slurm Job

The combined image contains both the Node Harness and the Linux WeKnora Lite
binary. `client/scripts/run-services.mjs` waits for Wiki readiness, starts Harness,
and propagates termination to both process groups. An unexpected service exit
fails the job. Separate file locks protect the Harness and Wiki data directories.

| Server directory | Container directory | Contents |
| --- | --- | --- |
| `$EDMORE_WIKI_DATA_DIR` | `/wiki-data` | SQLite database, uploaded files, private server and Harness settings |
| `$EDMORE_WIKI_SYNC_DIR` | `/wiki-sync` | `imports`, `capabilities`, `runs`, `conversations`, `events`, `checkpoints` |
| `$EDMORE_DATA_DIR` | `/data` | Existing Harness accounts and journals |
| `$EDMORE_WORKSPACE_DIR` | `/workspace` | Existing workspaces |

The plugin polls `/wiki-sync/imports` every 30 seconds for Markdown/TXT files,
including subfolders. New files are ingested; edits update fingerprinted sources;
removals retract owned sources after five minutes. Native indexing and Wiki
synthesis are asynchronous. Common secrets are filtered on a best-effort basis.
Hidden files, symbolic links, and other formats are excluded. Each file is
limited to 512 KB. `capabilities`, `runs`, `conversations`, `events` and
`checkpoints` are reserved for structured synchronization rather than indiscriminate
raw-log ingestion. The capability plugin also uses the WeKnora API. Personal
cloud history is synchronized only for users who enable Wiki memory (GPT).
Never point multiple users at a shared private-conversation KB.

For the authenticated cloud gateway, `cloud-wiki-sync.mjs` runs under the same
supervisor and allocation, without requiring a logged-in user worker. Its scoped
key stays in the server process; its submission checkpoint is written to
`/wiki-sync/checkpoints/imports.json`. Enabled user workers receive one read-only
key for shared and personal references, and a separate retrieval/ingestion key
restricted to their own Capabilities, Runs and Conversations KBs. Neither key
permits chat. `UserWiki` provisions these scopes and persists credentials under
`/data/auth/wiki`, while admin provisioning credentials stay out of worker envs.
The registered tools cover shared Wiki, personal capabilities, run history and
conversation history. Each user's history checkpoint remains in their own
Harness home. New accounts created by the gateway or bootstrap CLI have Wiki
enabled automatically; provisioning happens when their worker first starts.
Existing users retain their settings, and users can disable Wiki in Account.
An administrator can disallow Wiki globally. With `nativeAccounts` enabled in
the private provisioning file, each Harness identity owns a native WeKnora
account and a separate tenant. Public Wiki sharing uses an organization with
viewer membership and viewer KB permission; personal sources are never shared.
Account's Open My Wiki entry uses an authenticated Harness proxy: native
passwords and JWTs stay server-side, and disabled Harness accounts lose access
on the next request. The proxy excludes platform administration, alternate
login, tenant mutation, chat and agent execution. The local App uses a loopback
portal with a one-use entry ticket and an HttpOnly session cookie.
Existing sources are copied into the personal tenant, leaving the old records
untouched. Wiki pages regenerate from those sources; manually edited old Wiki
pages remain in the archive and are not automatically merged. Native history
uses a separate checkpoint so prior uploads cannot suppress the new backfill.
Platform Wiki models are supplied by a private built-in-model configuration,
not by publishing provider credentials to browser clients.
GPT synthesis sends sanitized reference text to OpenAI; secret filtering
is best-effort, not a guarantee that arbitrary private text is safe to publish.
KB authorization is enforced at the API boundary, not an OS sandbox for scripts.
The initial integration is verified on port 7381 before replacing port 7380.

Build the Linux binary with `build-weknora.slurm.sh`; the source archive and Go
toolchain are staged under `$WEKNORA_ROOT`. Run
`build-wiki-image.slurm.sh` to produce `edmore-wiki.sif` from the existing image.
The script uses rootless SquashFS/SIF assembly because this cluster's older
Apptainer fakeroot builder does not work with its NFS build directory.
`weknora-overlay.def` records the equivalent image recipe.
Private credentials and data are never part of the image.

Server paths, Slurm placement and public URLs come from
`~/.config/edmore/deploy.env` on the cluster (template:
`edmore.deploy.env.example`; `sync-server.sh` installs your local
`edmore.deploy.env` there). Submit from the login node:

```bash
bash "$EDMORE_BASE/source/edmore-slurm.sh"
```

The script submits itself with the configured partition, node and log paths.
Set `EDMORE_CONTAINER` in the configuration to choose the image.

Use `EDMORE_WIKI_ENABLED=0` and the original `edmore.sif` for a Harness-only rollback.
Only one job can own each data directory. Stop the previous job before replacing
the live service. Back up Wiki server settings and SQLite data together while
the job is stopped. The application AES key is required to decrypt model keys.

Wiki synthesis uses `gpt-4.1-mini`, embedding uses `text-embedding-3-small`.
The deployment uses English for both the UI and document processing.
`/wiki-data/server.env` sets `WEKNORA_LANGUAGE=en-US`; KB-level extraction and
content instructions also specify English. The Slurm launcher binds
`/wiki-data/frontend-config.js` over the image's frontend runtime configuration,
so the default locale also applies when opening WeKnora directly.
When migrating an existing SQLite deployment, stop the backend and run
`client/scripts/configure-wiki-runtime-language.mjs <deployment-directory>`.
It backs up the database and updates the language on queued Wiki ingest work.
`configure-wiki-english.mjs` updates active KB instructions, and
`translate-wiki-english.mjs` migrates generated pages while retaining native
revisions, source evidence, protected literals and an incremental checkpoint.
The scoped Harness API key permits retrieval and ingestion, not chat. Original
Skill/MCP contracts and journals remain authoritative for execution and outcomes.
