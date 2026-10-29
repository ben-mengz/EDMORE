---
name: tem-twin-alignment-sequence
description: "Default Skill for complete TEM Digital Twin alignment: ALL SIX phases: beam/C2, gun tilt, condenser astigmatism, eucentric Z, rotation centre, and objective astigmatism. Follow normally with permitted tools when Workflow mode is off; use as the primary reviewed Workflow when that mode is explicitly enabled."
metadata:
  display_name: TEM Twin Alignment Sequence
  edmore:
    authority: workflow
  kind: compound_workflow
  source: tem-twin-autoscript
---

# TEM Twin Alignment Sequence

With Workflow mode off, follow this Skill normally for user-requested actions
using permitted tools. Do not require a mode switch. Preserve explicit target
selection, safety confirmations, phase order and result verification. Explaining
or drafting this procedure is not permission to execute it. With Workflow mode
on, use the declared contract to generate a plan requiring separate approval.
Tool permissions remain required. Judge is optional for ordinary Skill execution.

Use this compound workflow for the complete six-stage TEM Digital Twin alignment.
An unqualified request to align the Digital Twin means this complete sequence.
Select a single child only when the user explicitly limits the alignment scope.
Do not inherit a narrower scope from an earlier proposal when the latest request
asks for overall alignment. Do not select a child as primary and put this parent
in supporting_skills: that does not authorize execution of the other phases.
The executable references are declared in [manifest.json](manifest.json).
Reuse the child contracts; do not copy their steps into another workflow definition.

## Ordered Child Workflows

1. `tem_tango_device_selection`: ask the user which device to control and validate it.
2. `tem_twin_phase_beam`: beam shift and C2 aperture.
3. `tem_twin_phase_gun`: gun tilt.
4. `tem_twin_phase_c2stig`: condenser astigmatism.
5. `tem_twin_phase_z`: eucentric focus using stage Z.
6. `tem_twin_phase_rot`: rotation centre.
7. `tem_twin_phase_ostig`: objective astigmatism.

## Composition Rules

In normal Skill mode, apply the same device-selection and phase requirements
without creating a PlanReview. Review each returned result before proceeding;
stop and report any failure or uncertainty. Do not claim a workflow was queued.
The plan-specific representation below applies when Workflow mode is enabled.

- The approved plan contains exactly seven steps: user-confirmed device selection,
  then six calibration tools. All six bind device to {{select_device.device}}.
  Never infer a target or skip the selection gate even if only one is registered.
  Do not expand internal AutoScript calls, calculations, loops or cleanup.
- Call the six tools in the declared order. Each independently snapshots and
  restores working conditions, while retaining corrected alignment values and Z.
- Each tool reuses the corresponding original autoalign.py algorithm and checks
  its original completion tolerance. A correction marked fixed is not sufficient:
  the returned verified field must be true.
- Preserve Harness execution-result review. A false/missing verified value,
  error, unmeasurable result, uncertain outcome or review veto pauses the sequence.
  Never automatically retry a mutating tool after a timeout or transport failure.
- Z must pass before rotation or objective astigmatism. Rotation sets eucentric
  objective focus inside its own scope; restoring user defocus between tools
  does not invalidate that measurement.
- WeKnora supplies knowledge only. Do not replace Plan/Judge authority or use
  hidden Twin metrics as evidence.
- New tool contracts do not replace old approved snapshots. Generate a new plan
  for this six-tool version; do not resume the previous expanded plan.

## Result

Report six phase outcomes with the tool's correction and verification evidence.
Full success requires all six phases to pass. Internal numeric calculations no
longer require separate calculate_alignment calls in this workflow.
