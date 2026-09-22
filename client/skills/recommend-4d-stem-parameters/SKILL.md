---
name: recommend-4d-stem-parameters
description: "Use the Nion Swift 4D-STEM recommendation calculator to load sample frequencies, calculate constraints, apply fixes, optimize defocus, and write results back to the recommendation UI."
whenToUse: "Use the Nion Swift 4D-STEM recommendation calculator to load sample frequencies, calculate constraints, apply fixes, optimize defocus, and write results back to the recommendation UI."
metadata:
  edmore:
    authority: workflow
  legacy_id: "recommend_4d_stem_parameters"
  display_name: "Recommend 4D-STEM Calculator Parameters"
  version: "3.3.0"
  confirmation_steps:
    - id: accept-settings
      scope: initial
      title: Confirm the displayed recommendation Settings
      before_tool: agent_suggestion.find_defocus
      source_tools: [agent_suggestion.recalculate_defaults, agent_suggestion.update_parameters, agent_suggestion.apply_fix, agent_suggestion.find_defocus]
      result_field: settings
      fields: [ht_kV, alpha_mrad, scan_step_A, detector_pitch_mrad, n_steps, defocus_A, current_pA, dwell_ms]
      edit_tool: agent_suggestion.update_parameters
      names_argument: param_names
      values_argument: param_values
  recovery_loops:
    - id: diagnostic-fixes
      tool: agent_suggestion.find_defocus
      fix_tool: agent_suggestion.apply_fix
      choice_argument: fix_name
      success_field: evaluation.passed
      failures_field: evaluation.failed_checks
      details_field: evaluation.checks
      options:
        - {id: fix_ht, when: [max_ht], description: "Reduce HT to the declared maximum."}
        - {id: fix_alpha, when: [abbe], description: "Adjust alpha to meet the Abbe-resolution requirement."}
        - {id: lower_abbe, when: [abbe], description: "Relax the Abbe-resolution target while preserving alpha."}
        - {id: fix_scan_step, when: [scan_step], description: "Reduce scan step to the allowed maximum."}
        - {id: fix_step_alpha, when: [scan_step], description: "Adjust alpha to accommodate the scan step."}
        - {id: fix_step_ht, when: [scan_step], description: "Search HT values that accommodate the scan step."}
        - {id: fix_pitch, when: [detector_pitch], description: "Adjust detector pitch to meet the resolution requirement."}
        - {id: lower_ultimate, when: [detector_pitch], description: "Relax the ultimate-resolution target while preserving pitch."}
        - {id: fix_fov, when: [fov], description: "Adjust calculator FOV and point count to satisfy the minimum sampling extent."}
        - {id: fix_noise_current, when: [gaussianity], description: "Adjust current to increase electrons per detector pixel; recheck dose."}
        - {id: fix_noise_pitch, when: [gaussianity], description: "Adjust detector pitch to improve electrons per pixel."}
        - {id: fix_noise_dwell, when: [gaussianity], description: "Adjust dwell to increase electrons per pixel; recheck dose."}
        - {id: fix_dose_dwell, when: [dose], description: "Reduce dwell to meet the dose limit; recheck signal statistics."}
        - {id: fix_dose_current, when: [dose], description: "Reduce current to meet the dose limit; recheck signal statistics."}
        - {id: fix_dose_step, when: [dose], description: "Increase scan step to reduce dose; recheck scan sampling."}
        - {id: fix_thickness_pitch, when: [thickness], description: "Adjust detector pitch for the specimen thickness."}
        - {id: fix_thickness_alpha, when: [thickness], description: "Adjust alpha for the specimen thickness."}
        - {id: fix_thickness_ht, when: [thickness], description: "Search HT values compatible with the specimen thickness."}
  kind: "codegen"
  agents:
    - "agent_suggestion"
  required_tools:
    - "agent_suggestion.load_q_spec"
    - "agent_suggestion.check_required_constraints"
    - "agent_suggestion.find_material_ids_by_elements"
    - "agent_suggestion.find_material_ids_by_formula"
    - "agent_suggestion.recalculate_defaults"
    - "agent_suggestion.find_defocus"
  optional_tools:
    - "agent_suggestion.apply_fix"
    - "agent_suggestion.update_parameters"
  ordered_tools:
    - "agent_suggestion.load_q_spec"
    - "agent_suggestion.check_required_constraints"
    - "agent_suggestion.recalculate_defaults"
    - "agent_suggestion.find_defocus"
  references:
    []
  source: "nionswift_plugin"
---
## When To Use
Use this skill when the user asks for 4D-STEM, SEM diffraction, or electron microscopy acquisition parameter recommendations in the Nion Swift recommendation UI.

Do not use this skill to acquire data, submit ptychography reconstruction jobs, or update the ptychography parameter editor.

## Required Tools

- `agent_suggestion.load_q_spec`
- `agent_suggestion.check_required_constraints`
- `agent_suggestion.find_material_ids_by_elements`
- `agent_suggestion.find_material_ids_by_formula`
- `agent_suggestion.recalculate_defaults`
- `agent_suggestion.find_defocus`
- `agent_suggestion.apply_fix`
- `agent_suggestion.update_parameters`

## UI Model
The recommendation UI has four parameter groups:
- `sample`: `mp_api_key`, `material_id`, `zone_axis`, `hmax`, `use_manual_q`, `manual_q_1_per_A`, `fov_A`
- `constraints`: `max_ht_kV`, `abbe_limit_A`, `ultimate_resolution_A`, `detector_pixels`, `max_dose_e_per_A2`, `thickness_A`
- `settings`: `ht_kV`, `alpha_mrad`, `scan_step_A`, `detector_pitch_mrad`, `n_steps`, `defocus_A`, `current_pA`, `dwell_ms`
- `diagnostics`: `q_spec_1_per_A`, constraint statuses, resolution/FOV/depth-of-focus summaries, and defocus status

Treat explicit user values as fixed unless the user asks you to fix or optimize them.

## SEM UI Defaults
If this skill is started from an acquisition or SEM-to-ptychography workflow because acquisition parameters are missing, you may read SEM UI context when the workflow explicitly sets `from_sem=True` on `check_required_constraints`.

When `from_sem=True`:
- `max_ht_kV` from the current SEM hardware `accelerate_voltage_kev`
- `fov_A` from the current SEM ROI x/width
- `current_pA` from the current SEM hardware `probe_current` 

For SEM-started recommendation runs, do not ask the user in plan review for SEM-provided values before trying the SEM UI/context path. This includes `fov_A`, `max_ht_kV`, and `current_pA` when the workflow can read them from SEM UI/hardware state. First try the SEM UI path by calling `load_q_spec` with resolved `fov_A` when available and `check_required_constraints(from_sem=True)`, then use returned `sem_ui_context.current_pA` for `recalculate_defaults` when available. Only ask the user for one of these values if the SEM UI/context path truly cannot resolve it and a tool still needs it after that attempt.

If a required constraint is missing from the UI and unavailable from explicit arguments or SEM UI context, ask the user for that specific value before `recalculate_defaults`.

When using the SEM-side manual q default, explain to the user that this is a SEM-probe heuristic: the probe Abbe limit should be larger than the gold lattice spacing, so the workflow uses a rough gold nanoparticle size scale to set a conservative manual q value of about `0.02 1/A`.

If this skill was entered from a blocked `acquire_4d_stem` step inside a larger workflow, treat it as a continuation of that paused workflow rather than a fresh top-level request. Do not re-expand already completed BF-preview / pixel-sync / ROI-confirmation steps. After recommendation finishes, return only the acquisition arguments needed to resume the blocked `acquire_4d_stem` step and then continue with the remaining suffix of the original workflow.

## Steps
1. `agent_suggestion.load_q_spec`
   - Start by loading q-spec directly.
   - If q-source resolution needs material lookup, use `agent_suggestion.find_material_ids_by_elements` or `agent_suggestion.find_material_ids_by_formula`, then retry `agent_suggestion.load_q_spec`.
2. `agent_suggestion.check_required_constraints`
   - For SEM-started recommendation runs, call this with `from_sem=true`.
3. `agent_suggestion.recalculate_defaults`
   - Run this only after q-spec is available and required constraints pass.
4. Independent confirmation: `accept-settings`
   - This is the required settings-confirmation gate after defaults are recalculated and before defocus optimization.
   - The user may reply `confirm` / `no changes`, or provide specific editable parameter changes.
   - Harness displays the verified Settings snapshot and binds acceptance to its workflow, step and observation version. This step has no tool call.
   - Accepting existing values must not call `update_parameters([], [])` or require a UI write acknowledgement.
   - If the user provides edits, show the exact changes for approval, then call `update_parameters` with only those fields and values. Verify the returned Settings and request acceptance of the new version.
5. `agent_suggestion.find_defocus`
   - Run defocus optimization only after the settings-confirmation gate.
6. `agent_suggestion.apply_fix`
   - Use this only if diagnostics failed and the user chose a concrete `fix_name`.
7. `agent_suggestion.find_defocus`
   - After each applied fix, re-run defocus and re-check diagnostics.

## Planning Contract
- The initial plan includes the normal calculator sequence and the initial Settings confirmation. `recovery_loops` is a reviewed conditional branch, not speculative executable steps. Never insert an `apply_fix` placeholder into the initial steps.
- The `diagnostic-fixes` branch stays within this approved workflow. Failed diagnostics pause for ONE explicit option from the current result's Fix Map; Harness runs `apply_fix(fix_name)` then reruns the same `find_defocus` step. Do not rerun `recalculate_defaults` or the initial Settings confirmation inside this branch.
- User selection authorizes only that specific fix for that diagnostic version. Re-evaluate all checks after every fix; if another check fails, show fresh applicable options. Never queue fixes from stale diagnostics or choose a fix from generic approve/confirm replies.
- `find_defocus.ok=true` means the calculator call completed, not that the recommendation is ready. Completion requires `evaluation.passed=true`, an empty `evaluation.failed_checks`, and a selected defocus solution. Judge must also review the returned Settings and diagnostics.
- Missing inputs, missing/malformed evaluation, tool errors and no defocus maximum are not ordinary mapped diagnostic failures. Explain the blocker and ask for the necessary input or revised plan; do not invent a fix. A stopped or rejected fix loop must not return a successful acquisition handoff.
- In initial plan review, you may show a future conditional user-facing step such as "If diagnostics fail, choose one allowed fix name", but do not schedule an executable `agent_suggestion.apply_fix` step until diagnostics have actually failed and the user has chosen one concrete `fix_name`.
- The user-facing plan should explicitly list the allowed fix names whenever it mentions the possible fix-choice step: `fix_ht`, `fix_alpha`, `lower_abbe`, `fix_scan_step`, `fix_step_alpha`, `fix_step_ht`, `fix_pitch`, `lower_ultimate`, `fix_fov`, `fix_noise_current`, `fix_noise_pitch`, `fix_noise_dwell`, `fix_dose_current`, `fix_dose_step`, `fix_dose_dwell`, `fix_thickness_pitch`, `fix_thickness_alpha`, `fix_thickness_ht`.
- If the plan includes a future conditional fix-choice step before diagnostics have failed, represent that step as a paused user-decision step in plan review text only. Do not attach `agent_suggestion.apply_fix` with a placeholder `fix_name`, template value, dummy value, or unresolved required input in the executable PlanStep list.
- Once diagnostics actually fail and the user replies with one concrete fix name, create or resume execution so that `agent_suggestion.apply_fix(fix_name=<chosen name>)` is followed by `agent_suggestion.find_defocus`.

## Detailed Workflow
1. Find or load q_spec:
   - Call `load_q_spec` directly. The tool checks the current recommendation UI state, existing q_spec, manual q values, and Materials Project fields internally.
   - If explicit context supplies q-source or sample values, pass them as arguments to `load_q_spec`.
   - For SEM-started recommendation runs, pass `use_manual_q=True`, `manual_q_1_per_A="0.02"`, and `fov_A` from SEM UI context when available. Do not assume `load_q_spec` will read SEM UI context by itself.
   - Do not add SEM-provided values such as `fov_A` as required user inputs in the initial plan review for a SEM-started recommendation run. Try the SEM UI-derived values first; only ask the user if one is still unresolved after the tool attempt.
   - The calculator has an internal fallback MP API key; do not ask the user for an MP API key before trying the tool.
   - If `load_q_spec` returns an explicit q-source or Materials Project access error, ask the user for exactly this set of options: use existing q_spec, a Materials Project id such as `mp-48`, a chemical formula such as `SiO2`, element symbols/names such as `Si O` or `silicon oxygen`, or manual q values in `1/A`. Do not omit formula or element options.
   - If the user provides element symbols/names, call `find_material_ids_by_elements`, show the candidate `material_id` values, and ask the user which candidate to use.
   - If the user provides a formula, call `find_material_ids_by_formula`, show the candidate `material_id` values, and ask the user which candidate to use.
   - If the user provides an mp-id, update `material_id` and retry `load_q_spec`.
   - If the user provides manual q values, set `use_manual_q=True`, update `manual_q_1_per_A`, and retry `load_q_spec`.
2. Check required constraints:
   - Call `check_required_constraints`.
   - If the user or explicit context supplied any of `max_ht_kV`, `abbe_limit_A`, `ultimate_resolution_A`, or `max_dose_e_per_A2`, pass those values as arguments to `check_required_constraints`; the tool will overwrite the UI with provided values before checking.
   - For SEM-started recommendation runs, call `check_required_constraints(from_sem=True, ...)`. This tells the tool to read SEM UI context and expose resolved SEM values such as `max_ht_kV` and `fov_A`.
   - When `from_sem=True`, use the returned `sem_ui_context` as the SEM UI source of truth for `max_ht_kV`, `fov_A`, and `current_pA`.
   - If the user did not supply a required constraint, do not invent it and do not pass a default except the explicit defaults above.
   - The tool checks the current UI after applying supplied arguments.
   - Required constraints before default calculation are `max_ht_kV`, `abbe_limit_A`, `ultimate_resolution_A`, and `max_dose_e_per_A2`.
   - Inspect `missing_required_constraints` from the tool result.
   - If `missing_required_constraints` is non-empty, ask only for those still-missing values and stop before `recalculate_defaults`.
3. Call `recalculate_defaults` only after q_spec is available and `check_required_constraints` returns `ok=true`.
   - If explicit context supplied `current_pA`, pass it as `current_pA` to `recalculate_defaults`; the tool will write it into Settings after recalculating defaults.
   - For SEM-started recommendation runs, if `check_required_constraints(from_sem=True)` returned `sem_ui_context.current_pA`, pass that value into `recalculate_defaults`.
4. Show the user the current Settings values exactly as the editable recommendation parameters:
   - `ht_kV` as **HT (kV)**
   - `alpha_mrad` as **alpha (mrad)**
   - `scan_step_A` as **scan step (A)**
   - `detector_pitch_mrad` as **pitch (mrad)**
   - `n_steps` as **# steps**
   - `defocus_A` as **defocus (A)**
   - `current_pA` as **current (pA)**
   - `dwell_ms` as **dwell (ms)**
   If `sample.fov_A` is set, explain that **# steps** is calculated from `fov_A / scan_step_A`; changing the scan step or ROI/FOV changes # steps automatically.
   This is a user-input gate in the current approved recommendation workflow. Ask whether the user has microscope limits or preferences that must change any of these values, and wait for the reply before `find_defocus`. The prompt must explicitly include both options: reply `confirm` / `no changes` to accept the displayed Settings, or reply with specific parameter changes. The prompt must also explicitly say: `scan step (A) is the maximum recommended scan step; you can choose a smaller scan step based on desired FOV.`
   This is an independent Harness confirmation step, not an `update_parameters` call. Accept the displayed version without writing unchanged values. A Settings change invalidates prior acceptance and requires review of the new snapshot.
5. After the user responds:
   - If they give parameter changes, call `update_parameters` for only those values.
   - Then call `find_defocus`. A recommendation is incomplete until `defocus_A` is selected or the tool reports why no defocus curve is available.
6. If diagnostics fail, enter the declared `diagnostic-fixes` loop in the current approved workflow. Quote the failing values and limits and show applicable Fix Map options. Wait for ONE exact fix name, call `apply_fix`, then rerun `find_defocus` and judge all diagnostics again. If the user requests several fixes, ask which single fix to apply first; subsequent choices must use the new diagnostic version. Do not create a new recommendation plan or repeat the initial Settings confirmation for this declared loop.
7. When all diagnostics pass, report the final diagnostic summary values. If the user stops, report the unresolved diagnostics and remain paused; do not treat stopping as success or resume acquisition:
   - **Abbe resolution (A)** from `diagnostics.abbe_resolution_A`
   - **Footprint overlap (%)** from `diagnostics.footprint_overlap_percent`
   - **Ultimate resolution (A)** from `diagnostics.ultimate_resolution_A`
   - **FOV (nm)** from `diagnostics.fov_nm`
   - **Depth of focus (nm)** from `diagnostics.depth_of_focus_nm`
   Also include the final Settings values from step 3 if any changed.
8. If this recommendation workflow was started from an `acquire_4d_stem` failure or SEM-to-ptychography acquisition handoff, hand off back to the acquisition workflow with the recommended acquisition arguments:
   - `defocus_A` from Settings `defocus_A`
   - `dwell_time` from Settings `dwell_ms * 1000` because acquisition expects microseconds
   - `scan_step_x_A` from Settings `scan_step_A`
   - `scan_step_y_A` from Settings `scan_step_A`
   - `scan_points_x` from Settings `n_steps` when `n_steps` is positive
   - `scan_points_y` from Settings `n_steps` when `n_steps` is positive
   - When showing these returned acquisition arguments to the user, label the converted dwell as microseconds, for example `dwell_time_us = dwell_ms * 1000`. Do not show the converted acquisition dwell value as milliseconds.
   Do not acquire data inside this recommendation workflow; return these arguments so the acquisition workflow can resume its 4D-STEM acquisition step.

## Fix Map
- Max HT failure: `fix_ht`
- Abbe/min-alpha failure: `fix_alpha`; if the user prefers preserving alpha, use `lower_abbe`
- Scan-step failure: `fix_scan_step`; alternatives are `fix_step_alpha` or `fix_step_ht`
- Detector-pitch/ultimate-resolution failure: `fix_pitch`; if preserving pitch, use `lower_ultimate`
- FOV/N-steps failure: `fix_fov`
- Gaussianity/e-per-pixel failure: `fix_noise_current`, `fix_noise_pitch`, or `fix_noise_dwell`
- Dose failure: `fix_dose_dwell`, `fix_dose_current`, or `fix_dose_step`
- Thickness failure: `fix_thickness_pitch`, `fix_thickness_alpha`, or `fix_thickness_ht`

## Tool Rules
- Prefer calculator tools over generating new formulas.
- Do not add a separate read-resource or `parameter_info` step before `load_q_spec`; `load_q_spec` reads the needed UI state internally.
- Do not call `recalculate_defaults` before `check_required_constraints`.
- Do not call `recalculate_defaults` unless `check_required_constraints` returns `ok=true`.
- Use `check_required_constraints` as the only required-constraint gate: user/handoff values go into that tool as arguments; otherwise it checks UI; if UI is missing a required value it returns `ok=false`.
- Never proceed to `recalculate_defaults` until all four required constraints are present from the UI, explicit SEM UI context, or user chat.
- For SEM-started recommendation runs, do not ask the user in advance for `max_ht_kV`, `fov_A`, or `current_pA` when `check_required_constraints(from_sem=True)` and the SEM UI/context path can provide them. Ask only for values that remain unresolved after that attempt.
- Do not include an `apply_fix` step in the initial recommendation plan. The reviewed runtime branch requires fresh failed diagnostics and one applicable user choice before `apply_fix` runs.
- Do not invent or placeholder a `fix_name` during planning. `apply_fix.fix_name` must be one concrete value chosen by the user from the Fix Map.
- If you want the initial plan review to show that a fix step may happen later, do so only in the user-facing explanation and explicitly list the allowed fix names there. Do not use placeholders such as `{{fix_name}}` in the executable plan.
- If the user has already been shown failed diagnostics and replies with one concrete allowed fix name, continue the declared fix loop, not a new recommendation plan. Ask for one choice if the reply contains multiple names.
- When asking the user for a fix choice, make the response clearly look like a paused input gate by including wording such as `Allowed fix choice(s)` and `reply with <fix_name>`.
- After `recalculate_defaults`, stop for user confirmation before `find_defocus` unless the user already provided explicit confirmation or parameter changes in the latest message. When stopping, make the response clearly look like a paused input gate by including wording such as `reply confirm`, `no changes`, or `reply with specific setting changes`.
- The settings-confirmation gate is the independent `accept-settings` step. It succeeds on explicit acceptance of the displayed verified Settings version. Only requested edits use `update_parameters`, with nonempty `param_names` and corresponding `param_values`. Do not propose rewriting unchanged defaults as recovery for missing confirmation evidence.
- When asking for missing q-source input, always include element symbols/names and chemical formula as accepted choices, not only mp-id/manual q.
- Use `update_parameters` only for direct user-specified values or small edits not covered by a calculator tool.
- If a tool returns `ok=false`, report the exact tool error and ask for the missing input or relaxation.
- Do not call acquisition, SEM control, visualization, or ptychography tools from this skill.
- When returning to acquisition, convert `dwell_ms` to acquisition `dwell_time` in microseconds. Do not pass milliseconds directly as `dwell_time`.
- If the response shows both recommendation Settings and returned acquisition arguments, keep the units explicit: recommendation Settings use `dwell (ms)`, while acquisition handoff uses `dwell_time` in microseconds with `dwell_time = dwell_ms * 1000`.
- When entered from a blocked acquisition step, do not create a new top-level SEM-to-ptychography plan. Return the recommendation outputs needed to resume the blocked acquisition step in the existing workflow.

## Success Criteria
- q_spec source is loaded or the missing source is requested.
- Defaults are recalculated and the Settings values are shown to the user for confirmation.
- `find_defocus` has been called after the initial user confirmation or requested setting updates, and its evaluation confirms a selected defocus solution and all diagnostics passing. Merely calling the tool or receiving `ok=true` is insufficient.
- The final response includes the diagnostic summary values from step 6.
- If started from acquisition, the final response/handoff includes `defocus_A`, `dwell_time`, scan step arguments, and scan point arguments when available.
