# PlanJudge Skill Integration Plan

## Objective

Use the native Harness skill registry for discovery and loading, and complete
EDMORE's workflow-contract interpretation inside the existing PlanJudge plugin.
General skills can guide ordinary tool use. Only validated workflow contracts
can supply executable steps to an EDMORE experiment plan; tool authorization
and approval remain runtime responsibilities.

## Implementation

1. Introduce a PlanJudge skill adapter with the calling agent's cwd, scope and
   invocation policy. Discover summaries first and load selected bodies on demand.
2. Interpret `metadata.edmore.authority` and workflow resource declarations.
   Adapt existing EDMORE manifest bundles without changing general SKILL.md files.
   Reject invalid declarations and unavailable resources explicitly.
3. Select a primary `contract_skill` and optional `supporting_skills` from the
   visible catalog. Remove the unrelated ptychography fallback. Expand declared
   child workflows and reject missing or cyclic references.
4. Record the root contract, allowed child contracts and actually loaded supporting
   skills in the plan. Pin their content, provider and digest for review and resume.
5. Extend deterministic review to validate contract authority, step membership,
   snapshots, tools, ordering, parameters, confirmations and completion conditions.
   Give the semantic judge the same evidence; it cannot override blocking checks.
6. Preserve approved-plan execution gates and paused-plan snapshots. Update the
   backend wiring and remove unused automatic top-three skill preloading.
7. Verify native registry scope and invocation policies, general-skill support,
   compound and custom workflows, no-match behavior, snapshot consistency and
   semantic-judge authority using focused tests and existing regression tests.

## Compatibility and Boundaries

- Keep the native registry and model-facing skill tool unchanged.
- Metadata declares contract intent; it does not grant hardware permissions.
- A primary compound workflow may include multiple explicitly referenced contracts.
- Existing persisted plans retain the legacy review path; new plans include
  explicit provenance. Existing SKILL.md + manifest.json bundles are adapted.
- General skills need the tools and resources required by their instructions;
  recognizing the file format alone does not guarantee all skills can run.
- Unsupported non-filesystem workflow resources report an explicit error unless
  the provider supplies the workflow inline.

## Acceptance

A general skill can inform an EDMORE workflow plan without becoming an execution
contract. Native discovery chooses one winning definition per skill. Invalid or
unmatched contracts cannot silently become a different experiment. Approved plans
continue using their reviewed snapshots after source files change.

## Implementation Status (2026-09-15)

Implemented in the existing PlanJudge plugin, with a new `src/skills.ts` adapter
and backend wiring for per-role skill views. The native filesystem profile now
includes default project/user roots. Bundled workflows declare their authority;
the desktop Markdown writer preserves existing invocation settings and emits
workflow metadata for new custom skills.

New-plan validation rejects undeclared actions, inconsistent evidence, invalid
child ordering and attempts to use general instructions as an execution contract.
The former implicit ptychography fallback is removed. Approved execution and
state restoration retain pinned definitions instead of rereading live files.

Verification completed on Node.js 24.19.0:

- PlanJudge suite: 28 tests passed, including 11 new integration tests.
- Desktop skill persistence/validation suite: 2 tests passed.
- Client smoke test: startup, offline MCP, skill discovery, UI route,
  conversation persistence, restart and shutdown passed.
- `git diff --check` passed.

Model selection and semantic review were tested with controlled role-runner
responses. No live model request, microscope action or reconstruction submission
was performed. Native reference-file reads remain recorded in the Harness
trajectory; their contents are not additionally frozen in plan evidence.
