# EDMORE Session State

Independent Cordis plugin `@deepseek-ai/dsh-edmore-session-state`, enabled by the
EDMORE backend profile. It observes the existing event hub and accepts explicit
workflow evidence records from Plan/Judge. It cannot approve, cancel, resume or
execute a workflow. Skills remain the source of domain success/recovery policy.

## Storage

Default directory: `$DSH_HOME/edmore/session-state` (normally
`~/.dsh/edmore/session-state`).

- `events.jsonl`: append-only, versioned evidence journal, including source event
  IDs, timestamps, session/workflow identity, user/UI events, calls and results.
- `state.json`: atomically replaced derived snapshot, refreshed on API reads,
  model reviews and periodically while running. Rebuilt from the journal after restart.

Directories are created with mode 0700; files with 0600. This is private local
storage, not encrypted storage. Do not place it in a public/shared directory.
The existing backend event log remains intact during this compatibility phase;
startup backfills it idempotently into the plugin. Global/unassigned events stay
in the journal but are not guessed into a session's model context.
A malformed/truncated journal stops loading rather than silently losing evidence.
The snapshot is disposable; the journal is authoritative.

## State and Evidence

State exposes per-workflow lifecycle, step identity, accepted confirmation
history, calls with actual arguments/results, and separately labelled model
assessments. Only trusted runtime event sources update confirmation/lifecycle
state. A UI assertion or a tool string saying "confirmed" does not satisfy a gate.
Stored accepted confirmations are historical evidence, not authorization to
execute later steps; the workflow runtime still enforces the current gate.

Result Judge, Plan Judge, recovery planner, step executor and child/revision
planning consume versioned state-plus-events packets. Packets are restricted to
the current session and explicit workflow lineage. Original queries and old
plan-embedded context are imported lazily for compatibility. New production
context is recorded in this plugin, not duplicated into new plan snapshots.
Each consumption records consumer, journal version, projection version, selected event IDs, lineage and a
SHA-256 digest as `edmore.context.used`. No unrecorded historical evidence is
invented. Last-80-event selection reports omissions; it is not a claim that all
history fits in the model prompt. Projection v2 also budgets event payloads to
16,000 characters, replaces repeated skill snapshots with checksum references,
and bounds long strings/nested structures. Derived call details are compacted
separately. These limits affect model input only, not the private journal or
training export. Earlier packets without a projection version used v1; their
digests must not be compared against v2 projections. Large scientific datasets should remain external
artifacts referenced by their tool outputs rather than embedded as arrays.

## Read-Only API

All routes are GET, on the existing Harness web server:

| Route | Query | Result |
| --- | --- | --- |
| `/api/edmore-session-state/sessions` | none | Recorded session IDs |
| `/api/edmore-session-state/state` | `session_id` | Versioned derived state |
| `/api/edmore-session-state/events` | `session_id`, optional `after`, `limit` | Ordered records and next cursor |
| `/api/edmore-session-state/stream` | `session_id` | SSE version notifications; refetch state/events on change or reconnect |
| `/api/edmore-session-state/evidence` | `session_id`, `workflow_id`, optional `version` | Reproducible single-workflow evidence packet |
| `/api/edmore-session-state/export` | `session_id` | Downloadable JSONL trajectory |

The workspace Conversation / Session State tabs use the dedicated SSE endpoint.
Existing NionSwift `llm_client/ui/llm.py` still subscribes to `/api/edmore/ui/stream`
and replays only the `events` field of `/api/edmore/ui/state`; it does not yet render
the new state. Native clients can consume `/stream` version notifications and
read `/state` plus `/events` with their own session ID. Reconnection always sends
the latest version; clients recover missed details through event pagination.

Existing `/api/edmore/ui/state` also includes `session_state`. UIs can poll state
versions and fetch events after their last cursor. No extra UI-specific storage is
needed. The existing server's access boundary applies; keep it bound to loopback
unless an authenticated gateway is configured. No public hosting is added.

## Training Export

The initial portable format is `edmore.session-trajectory`, schema version 1:
a metadata line followed by ordered event records. Failures, retries and
confirmation provenance are retained. Labels default to null, with
`review_required=true`; model judgments are not human ground truth. This is a
training-data source format, not automatically a provider's SFT upload format.
Split datasets by entire session/workflow lineage, not by individual steps.

Export recursively redacts credential-like fields and common token strings;
inline image/audio data is replaced by a checksum/reference description.
The private raw journal is unchanged. Filtering is best-effort: arbitrary personal
data, scientific data, paths and secrets embedded in free text still require
human review before sharing or training. No export uploads data anywhere.
