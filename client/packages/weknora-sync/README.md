# @deepseek-ai/dsh-edmore-weknora-sync

Mirrors the active EDMORE Skill definitions and model-visible `mcp__*` tool
schemas into managed WeKnora manual Markdown documents. The mirror is knowledge only:
the plugin never calls an MCP tool and does not install executable Skills in
WeKnora.

The WeKnora API key needs `retrieve` and `ingest` access to the configured knowledge base.
EDMORE remains the source of truth and the only execution authority.

The backend profile enables the integration with these environment variables:

| Variable | Purpose |
| --- | --- |
| `WEKNORA_BASE_URL` | WeKnora origin or `/api/v1` URL; enables the official retrieval plugin. |
| `WEKNORA_API_KEY` | Retrieval key used by the official plugin; needs ingest too unless a separate sync key is supplied. |
| `WEKNORA_CAPABILITIES_KB_ID` | Knowledge base receiving the generated catalog. |
| `WEKNORA_SYNC_API_KEY` | Optional separate key with `retrieve` and `ingest`; falls back to `WEKNORA_API_KEY`. |
| `WEKNORA_TENANT_ID` | Optional tenant header for platform-scoped keys. |
| `WEKNORA_KNOWLEDGE_BASE_IDS` | Optional comma-separated retrieval scope. |
| `WEKNORA_IMPORT_DIR` | Optional Markdown/TXT import directory; polled every 30 seconds. |

The EDMORE profile disables `weknora_ask`. The official list/search/read-document
tools and two read-only Wiki tools are exposed: `weknora_wiki_search` and
`weknora_wiki_read_page`. Ingestion explicitly disables document summary generation, generated
questions, graph extraction, and multimodal enrichment. An embedding model is
still used for vector indexing/search; all conversational reasoning stays in
Harness. Disable KB profile generation and auto-tagging in the server settings
as well. Wiki generation uses its own `wiki_config.synthesis_model_id`; it does
not grant chat API access or install any MCP/Skill execution capability in WeKnora.
Enable `indexing_strategy.wiki_enabled` before uploading sources. Existing
unchanged documents need explicit reprocessing if Wiki is enabled later.

On startup and after `skills/change` or `tools/change`, the plugin synchronizes
independent `[Skill:name]` and `[MCP:server]` source documents. Every 30 seconds it also checks for file edits,
retries failed synchronization, and repairs remotely deleted documents. Starting
WeKnora after Harness is supported; no manual sync command is needed.

Source SHA-256 fingerprints are checked before writing, including across Harness
restarts. They survive WeKnora's Markdown sanitization. Managed documents should
not be edited manually; change the original Skill or MCP schema instead.
Unchanged documents are not re-indexed. Failed parsing is retried. Updates wait
while the previous native document job is pending or processing. Changes are
debounced and serialized; shutdown cancels outstanding HTTP requests and timers.
Missing Skill definitions cause the snapshot to be retried rather than published
partially. A failed sync is logged and does not prevent EDMORE from starting.

Documents over 180,000 UTF-16 units are split into numbered overflow pages to
stay below WeKnora's 200,000-character limit. After replacements finish indexing,
legacy combined catalogs are deleted. Missing sources/overflow pages are deleted
only after a five-minute absence grace period; reconnecting resets the grace.
Only the exact configured title namespace and `edmore-capability-sync` channel
are owned. Native deletion asynchronously retracts Wiki source contributions.
Unrelated documents, including same-title user documents, are never changed.
Synchronization is not an atomic multi-document transaction.

Wiki tools preserve document/chunk citations, enforce the configured KB scope,
and withhold pages with missing, processing, draft, or newer cited sources.
They also verify that chunk citations still refer to live source chunks, hiding
old-only pages even if native link maintenance refreshed a page timestamp.
Superseded chunk IDs are omitted from returned citations when current evidence
for every cited source survives.
Source-free pages are also withheld. This is a freshness guard, not semantic
proof: native synthesis/retraction is asynchronous and can fail partially.
Always check authoritative Skills/MCP definitions before execution. Fall back to
original-document retrieval when Wiki is unavailable, empty, or still updating.
The desktop panel reports source processing/failure and Wiki page/pending/issue
counts; idle counters alone are not a guarantee of complete Wiki generation.

Plugin settings: `syncIntervalMs` (default 30000), `debounceMs` (1500), and
`requestTimeoutMs` (30000), and `removalGraceMs` (300000). Credentials must be configured before starting
Harness. The authentication worker never loads this integration.

## Local history Wiki (opt-in)

Set `WEKNORA_HISTORY_ENABLED=1`, `WEKNORA_RUNS_KB_ID`, and
`WEKNORA_CONVERSATIONS_KB_ID` to enable local journal backfill and continuous
incremental synchronization. Include all three KB IDs in
`WEKNORA_KNOWLEDGE_BASE_IDS`; the key needs retrieve/ingest access to each.
The local deployment helper `WeKnora-local/deploy-history-wiki.mjs` configures
`gpt-4.1-mini` as the background Wiki synthesis model, using the existing private
OpenAI credential. It does not enable a second conversation agent. Source text
is sent to the configured model provider for synthesis and embedding.

The plugin mirrors visible user/assistant messages, workflow lifecycle events,
plans/judgments, tool calls/results and step-result judgments. Success, failure,
cancellation and pause remain distinct; assistant statements are not execution
evidence. Hidden messages, synthetic test sessions, token streams, heartbeat and
instrument-status polling are excluded. Payloads are bounded and common secrets
are redacted on a best-effort basis; this is not a guarantee of anonymization.
The original local event journal remains authoritative and unchanged.

A private `~/.dsh/edmore/weknora-history.json` checkpoint stores the cursor,
sanitized source documents and pending uploads. Three documents per poll are
attempted, retries survive restart, and content fingerprints avoid duplicate
updates. Initial backfill and native Wiki generation can take time. An upload
acknowledgment is not a guarantee of semantically complete Wiki synthesis.

`weknora_sync_status` reports local backfill progress. `weknora_knowledge_lookup`
accepts `capabilities`, `runs`, or `conversations`, searches current Wiki pages
first, and falls back to original-source hybrid retrieval. The model chooses
when to invoke this tool; this is not an unconditional hook on every chat.
Scoped Wiki search/read tools are also registered for both history KBs.

Update Skills/MCP definitions or append new runtime evidence rather than editing
managed source documents. Historical conversation deletion and retention are not
automatically propagated from the UI: this journal mirror is append-only.
Disabling history stops future uploads but does not erase existing knowledge.
Cloud journals and cross-user synchronization are not enabled by local setup.
