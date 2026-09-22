# EDMORE Plan Judge

## Native Skill Integration

Production discovery uses `ctx.skills` with the requesting role's session cwd and
agent scope. Routing reads summaries; the planner selects exact registry names
before the adapter loads the selected contract, declared children and supporting
skills. No match produces a planning error, never a fallback experiment.

`metadata.edmore.authority: workflow` declares an EDMORE contract. Its `workflow`
field may contain a relative YAML resource path or an inline structured workflow.
Existing SKILL.md + manifest.json bundles and older desktop-authored YAML bundles
remain supported. The standalone constructor without a registry retains its
filesystem compatibility path for existing integrations and tests.

New plans contain `skill_evidence` with `contract_skill`, `workflow_contracts`, and
`supporting_skills`. Workflow contracts carry provider, registry name, source,
content digest and a snapshot checksum. Supporting material retains its body and
resource base, but cannot authorize experiment steps. Checksums detect accidental
changes; they are not signatures or a trust boundary against a malicious host.

The deterministic judge checks this evidence and each step's pinned contract.
The semantic judge receives the same evidence and cannot override a blocking
verdict. Executor gates check evidence consistency without reloading live skills.
Persisted legacy plans retain their existing snapshot behavior.

General skills can guide normal agent tool use. Planner and judge roles can read
reference files through the native read tools; their role restrictions still
exclude shell execution and experimental MCP calls. These reference reads remain
in the Harness trajectory; only explicitly selected skill bodies and workflow
resources are pinned in `skill_evidence`. Non-directory providers must supply
workflow YAML inline; URL and opaque workflow-resource fetching is unsupported.

The English implementation plan is in `docs/plan-judge-skill-integration-plan.md`
at the repository root.

Skill contracts distinguish required tools from optional support tools. Optional tools remain available to the planner and validator without becoming mandatory steps. The semantic judge receives skill instructions and supporting contracts, including runtime recovery: a proposed child plan is generated, judged, and approved only after a blocker and user agreement, then returns to the saved parent position.

New plans retain only the confirmation gates declared by the bundled skills. Planner-added gates and preview-success text do not introduce additional confirmations. Runtime tool failures still pause execution. Existing persisted plans retain their reviewed gates until revised.

Child workflow completion restores the approved parent plan at its saved step. The resumed event includes the parent plan and step index so subscribers can replace the child display. Outstanding user-input gates pause immediately; ungated steps remain available to the native agent loop through nextLoopDispatch. Returning from a child does not grant user confirmation.
# Runtime Result Review

Result assessment and recovery proposals run in isolated read-only role sessions
with the normal role configuration. They consume explicit evidence rather than
accumulating previous whole-plan review prompts. Invalid/truncated JSON is an
assessment failure, not proof that the instrument action failed; execution stays
paused and no hardware call is automatically retried.

Result review, recovery planning and step execution consume a shared execution
context maintained by the independent `edmore-session-state` plugin in production.
Legacy plan-embedded contexts remain a compatibility input. It contains the original user query, routed
user/UI inputs, accepted resume payloads, actual tool-call arguments and results,
and completed child-workflow evidence. Each record carries its source, event ID,
workflow/session identity and step ID when known. Routed NionSwift inputs retain
the original source event, rather than only the synthesized `confirm` message.
Child workflows can read their parent context; unrelated sessions are excluded.
The plugin prompt projection includes the last 80 relevant records and reports any
omitted count; the persisted evidence is not truncated. Legacy plans without
these records do not acquire invented historical evidence. Runtime confirmation
flags remain authorization state, not a substitute for this evidence context.

Every tool result is reviewed before advancing the approved step. The result
judge reads the pinned current skill instructions, step contract and actual MCP
result, and returns success, failure or uncertain with an evidence-based reason.
Hard protocol errors and deterministic completion failures cannot be overridden.
Unavailable or malformed judge responses pause the workflow rather than defaulting
to success. Assessments are recorded as `edmore.custom.step_result.judged` events.

Recovery directions come from the current skill's failure/recovery instructions,
not instrument-specific branches in Harness. After a non-success result, the
orchestrator reads those instructions and the available skill catalog to propose
a child workflow when appropriate, preserving manual-input alternatives. Without
guidance or an explicit user request, it leaves the workflow paused. Agreement to
the direction permits planning, not execution: the resulting child plan still
requires judge review and user approval. Its return point is the failed parent
step. A failed child-plan generation must not discard the paused parent.
# Independent Confirmation Steps

Workflow metadata may declare `confirmation_steps`. Each declaration names an
`id`, `title`, `before_tool`, `source_tools`, `result_field`, editable `fields`,
and the declared `edit_tool` with its `names_argument` and `values_argument`.
Harness inserts a `kind: confirmation` PlanStep before the guarded tool. It is
reviewed with the plan but is not an MCP call. The planner must not substitute
an empty update, wait, or invented noop tool for it.

Successful source-tool results supply the displayed observation. The observation
version binds the source call and the selected values. Missing observations do
not permit confirmation. Chat acceptance is interpreted against the current
displayed snapshot; UI confirmations carry `workflow_id`, `step_id`, `version`
and `review_version` in `confirmation_context`. Clients may also send `values`;
values inconsistent with the displayed snapshot are rejected. A silent external
UI change that sends no observation/event cannot be detected by this protocol.

Explicit numeric edits are first shown for approval, then executed using the
skill-declared update tool. Only a verified readback matching every requested
edit creates a new observation. The new version requires acceptance again.
Starting an update invalidates the old observation, including across restart.
Failed/ambiguous writes remain paused rather than being marked successful.

Confirmation requests, proposed/accepted edits, tool results and version-bound
acceptance are recorded in session state. Pending confirmations and observations
are persisted. Existing approved plans retain their pinned contracts: adopting
new confirmation behavior requires explicit replanning and approval, not silent
migration. External clients should show and acknowledge the version they actually
displayed, not fetch a newer version only when their Confirm button is pressed.

## Declared Diagnostic Recovery

Workflow metadata may declare `recovery_loops`: a guarded `tool`, `fix_tool`,
`choice_argument`, result paths (`success_field`, `failures_field`,
`details_field`) and named options with failure IDs in `when` and descriptions.
Domain mappings belong in the skill, not Harness. The plan summary exposes the
branch and the judge validates its fix schema before approval. Fixes are not
speculative initial steps. Confirmation `scope: initial` guards the first call
only; omitted scope preserves per-occurrence gates.

Transport success alone is insufficient. Explicit diagnostic failure blocks
advancement even if the result judge says success. The LLM still evaluates
result/context evidence and may withhold success. Missing, malformed or unmapped
diagnostics offer no invented fixes. The workflow remains paused.

One exact currently applicable option authorizes one fix, followed by the original
diagnostic tool and a fresh evaluation of every diagnostic. It does not repeat
defaults, initial confirmation or create a child plan. Generic confirm/approve
does not select a fix. Each result has a new choice version; UI clients send it
with workflow and step IDs in `confirmation_context`. `retry_check` explicitly
reruns diagnostics without a fix. `stop` remains paused, not completed or released.
Recovery outside this contract still requires a separately approved plan.

Requests, selections, calls and results are journaled in session state and
exportable through the existing API. Choices and in-flight fixes persist across
restart; interrupted fixes are never automatically replayed. Existing approved
plans retain their snapshots and require explicit replanning to adopt this
contract. No production experiment is run by the recovery tests.

## Standard MCP Workflows

`agent_mcp_<server>.<tool>` addresses an existing standard MCP registration,
for example `agent_mcp_asyncroscopy.UnifiedDigitalTwin_acquire_scanned_image`.
It dispatches to `mcp__asyncroscopy__UnifiedDigitalTwin_acquire_scanned_image`;
it does not create a NionSwift adapter or a second MCP connection. Discovery,
schema validation and executor model availability use the live Harness registry.
The executor sees only that server's tools. Calls and results pass through the
same approved-step policy and evidence flow as other workflows. Contracted
generic actions cannot run in a bound conversation without an approved workflow.
Generic workflows reserve `mcp:<server>` while active or paused.

The `asyncroscopy-haadf-demo` skill configures a 128 x 128 HDF5 scan at 2 us dwell,
sets a 10 nm FOV, autofocuses the twin and acquires HAADF. It requires normal
PlanReview approval but no additional per-step confirmation. Simulation settings
remain changed after the demo. A saved key is acquisition evidence, not proof of
image quality or calibrated microscope physics.
