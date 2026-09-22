# Skill format migration

Status: first vertical slice, `acquire-4d-stem`. Other built-ins retain legacy
compatibility until their instructions and tool contracts have been reviewed.

## Storage

The portable entry point is `SKILL.md` with Agent Skills YAML frontmatter.
Deterministic EDMORE workflows optionally include `references/workflow.yaml`.
This YAML schema is an EDMORE extension, not an Anthropic execution protocol.
Plain SKILL.md-only skills remain browsable knowledge skills, not automatically
executable instrument workflows.

`client/skill-format.mjs` is shared by the desktop editor and planner/judge.
It prefers workflow.yaml, reads old manifest.json only when no new workflow is
declared, and reports malformed/missing new definitions without fallback.
New custom saves use standard hyphenated directory names and do not write a
manifest. An existing legacy copy is retained; the new definition takes precedence.

## Definition and enforcement

Workflow schema version 1 contains stable step IDs, names/purposes, MCP tool IDs,
parameter bindings (`fixed`, `ask`, `result`, `tool_default`), expected output,
confirmation gates, completion conditions, and sequential-success/pause-on-failure
policy. Units/descriptions supplement the live MCP schema rather than duplicating
its full type definitions.

Supported completion conditions: tool success, structured result field presence,
and structured result field equality. Field paths are resolved only within MCP
`structuredContent`; free text is never guessed to satisfy a structured condition.
The existing tool-error detector still applies first. Data quality is not inferred
from tool success. Arbitrary branches and automatic retries are not implemented.

Plans embed the selected definitions with version, content SHA-256 and instruction
text. Both deterministic and semantic judges use these snapshots. The executor
uses the approved step's completion condition; editing a file cannot rewrite it.
Fixed values, result references, gates and stable step order are checked against
the pinned definitions. Full workflows or contiguous remaining suffixes are allowed.

The human-readable step summary is managed between `edmore:steps` markers in
SKILL.md; custom saves update that block while retaining other prose. Copied
legacy prose still needs review when changing the workflow's meaning.

## Pilot

The acquisition pilot preserves seven steps, two 10-second waits and the ROI gate
after pixel synchronization. Optional acquisition parameters use the current SEM
UI/tool defaults. Missing values pause execution and expose the existing manual
input or parameter-recommendation guidance; no automatic acquisition retry occurs.

Validation uses unit tests, mocked tool-result tests and native Electron tests with
a local schema fixture. No real microscope acquisition is used for these checks.
