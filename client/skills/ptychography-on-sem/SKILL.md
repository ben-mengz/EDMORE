---
name: ptychography-on-sem
description: "Compound workflow that acquires 4D-STEM data on the SEM and then runs the ptychography preparation/submission workflow."
whenToUse: "Compound workflow that acquires 4D-STEM data on the SEM and then runs the ptychography preparation/submission workflow."
metadata:
  legacy_id: "ptychography_on_sem"
  display_name: "Ptychography on SEM"
  version: "1.1.0"
  kind: "compound_workflow"
  agents:
    - "agent_sem"
    - "agent_ptychography"
  required_tools:
    []
  ordered_tools:
    []
  references:
    - "acquire-4d-stem"
    - "ptychography"
  source: "nionswift_plugin"
---
## When To Use
Use this compound skill when the user wants a full SEM-to-ptychography workflow.

## References
- `acquire_4d_stem`
- `ptychography`

## Steps
1. Expand `acquire_4d_stem` into concrete PlanSteps.
2. Expand `ptychography` after acquisition into concrete PlanSteps.

## Composition Rules
- This skill is only a composition layer. Do not leave high-level placeholder steps such as “run acquire_4d_stem” or “run ptychography”.
- Use exactly the tools and order defined by the referenced skills.
- Do not insert bridge steps, SEM state checks, scan-parameter calculation, ROI confirmation tools, or extra waits unless a referenced skill explicitly requires them.
- If the `acquire_4d_stem` expansion routes to `recommend_4d_stem_parameters` because acquisition parameters are missing, preserve these SEM UI recommendation inputs: `max_ht_kV` from the current SEM hardware `accelerate_voltage_kev`, `current_pA` from the current SEM hardware `probe_current`, `abbe_limit_A=3.5`, `ultimate_resolution_A=0.45`, `max_dose_e_per_A2=1.5e6`, `use_manual_q=True`, `manual_q_1_per_A=0.02`, and `fov_A` from the current SEM ROI x/width when available.
- If the `acquire_4d_stem` expansion routes to `recommend_4d_stem_parameters`, those SEM UI inputs must be carried as structured recommendation arguments/defaults, not merely described in prose. In particular:
  - `load_q_spec` must receive `fov_A` whenever it is available from the SEM ROI.
  - `check_required_constraints` must be called with `from_sem=True` so the tool reads SEM UI context for `max_ht_kV` and `fov_A`.
  - `max_ht_kV` must be present in the recommendation handoff whenever it is available from SEM hardware/UI state.
- In plan review and blocked execution messaging for this compound workflow, explicitly mention that the acquisition step can branch into `recommend_4d_stem_parameters` if defocus, dwell, or scan-grid parameters are missing, instead of presenting manual input as the only recovery path.
- If the workflow is already paused at the acquisition step and then branches into `recommend_4d_stem_parameters`, do not restart from step 1 of the compound workflow. Plan only the recommendation sub-workflow, then resume from the blocked `acquire_4d_stem` step and continue with the remaining suffix after acquisition. Do not repeat completed BF-preview / sync / ROI-confirmation steps unless the user explicitly asks to redo them.
- When SEM acquisition is complete and the workflow hands off into `ptychography`, pass SEM/acquisition context into the `agent_ptychography.prepare_parameters` step:
  - Set `accela_voltage` to the beam acceleration voltage in kV from the SEM/acquisition/recommendation context when available, e.g. the acquisition HT / recommendation `ht_kV`.
  - Set `PLRotation_deg` to the string `"auto"` unless the user explicitly provided a numeric rotation.
  - Keep every other `prepare_parameters` argument required by the `ptychography` skill contract present; use that skill's `null`/default values for unknown fields.
- If the user explicitly says acquisition should be skipped because a suitable 4D-STEM dataset is already selected, omit `acquire_4d_stem` and plan only `ptychography`.
- If a later ptychography step needs the acquisition output, reference it as a placeholder such as `{{acquire_4d_stem.data_path}}`.

## Success Criteria
- 4D-STEM data is available.
- Ptychography parameters are prepared and saved.
- The reconstruction job is submitted.

## Failure Policy
- If acquisition fails because required acquisition parameters are missing, explicitly offer the `recommend_4d_stem_parameters` branch before stopping for manual input.
- If acquisition fails for other reasons, stop before reconstruction.
- If reconstruction parameters are missing, ask the user before submission.
