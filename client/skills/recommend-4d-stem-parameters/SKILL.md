---
name: recommend-4d-stem-parameters
description: "Use the Nion Swift 4D-STEM recommendation calculator to load sample frequencies, calculate constraints, apply fixes, optimize defocus, and write results back to the recommendation UI."
whenToUse: "Use the Nion Swift 4D-STEM recommendation calculator to load sample frequencies, calculate constraints, apply fixes, optimize defocus, and write results back to the recommendation UI."
metadata:
  legacy_id: "recommend_4d_stem_parameters"
  display_name: "Recommend 4D-STEM Calculator Parameters"
  version: "3.1.3"
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
    - "agent_suggestion.apply_fix"
    - "agent_suggestion.update_parameters"
  ordered_tools:
    - "agent_suggestion.load_q_spec"
    - "agent_suggestion.check_required_constraints"
    - "agent_suggestion.recalculate_defaults"
    - "agent_suggestion.update_parameters"
    - "agent_suggestion.find_defocus"
    - "agent_suggestion.apply_fix"
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
4. `agent_suggestion.update_parameters`
   - This is the required settings-confirmation gate after defaults are recalculated and before defocus optimization.
   - The user may reply `confirm` / `no changes`, or provide specific editable parameter changes.
   - In plan review and execution, this step must always include explicit tool arguments `param_names` and `param_values`.
   - For the pure confirmation gate before the user edits anything, use `param_names=[]` and `param_values=[]`.
   - If the user provides setting edits, call the same tool again with only the changed fields in `param_names` and their values in `param_values`.
5. `agent_suggestion.find_defocus`
   - Run defocus optimization only after the settings-confirmation gate.
6. `agent_suggestion.apply_fix`
   - Use this only if diagnostics failed and the user chose a concrete `fix_name`.
7. `agent_suggestion.find_defocus`
   - After each applied fix, re-run defocus and re-check diagnostics.

## Planning Contract
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
   The workflow step that represents this confirmation gate must still be an explicit `update_parameters` tool step with `param_names=[]` and `param_values=[]` in its arguments, plus confirmation-oriented `required_inputs`.
5. After the user responds:
   - If they give parameter changes, call `update_parameters` for only those values.
   - Then call `find_defocus`. A recommendation is incomplete until `defocus_A` is selected or the tool reports why no defocus curve is available.
6. This is a user-input gate in the current approved recommendation workflow, not the end of the workflow. Tell the user which diagnostic failed, quote the failing status/metric from diagnostics, and present the allowed fix choices from the Fix Map below. Ask the user which fix to apply and wait for the reply. Only after the user chooses a concrete fix name, call `apply_fix` with that exact `fix_name`, then call `find_defocus` again and re-check diagnostics. This `apply_fix -> find_defocus` re-check is part of the declared tool order contract. If the user chooses multiple concrete fix names in one reply, apply them in the stated order without creating a new plan: call `apply_fix` for the first `fix_name`, call `find_defocus` and re-check diagnostics, then continue with the next requested `fix_name` only if that diagnostic still applies or the fix remains valid. Repeat this user-choice loop as needed. In initial plan review, mention this only as a future conditional user-facing step with the allowed fix names; do not use placeholders in the executable plan.
7. When all diagnostics pass or the user chooses to stop, report the final diagnostic summary values:
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
- Do not include an `apply_fix` step in the initial recommendation plan unless the user already chose a concrete fix name. Diagnostics must be shown to the user first, with allowed fix choices, and the user must choose before `apply_fix` runs.
- Do not invent or placeholder a `fix_name` during planning. `apply_fix.fix_name` must be one concrete value chosen by the user from the Fix Map.
- If you want the initial plan review to show that a fix step may happen later, do so only in the user-facing explanation and explicitly list the allowed fix names there. Do not use placeholders such as `{{fix_name}}` in the executable plan.
- If the user has already been shown failed diagnostics and replies with one or more concrete fix names, this is a continuation of the fix loop, not a new recommendation plan. Apply the chosen fixes in order inside the current workflow.
- When asking the user for a fix choice, make the response clearly look like a paused input gate by including wording such as `Allowed fix choice(s)` and `reply with <fix_name>`.
- After `recalculate_defaults`, stop for user confirmation before `find_defocus` unless the user already provided explicit confirmation or parameter changes in the latest message. When stopping, make the response clearly look like a paused input gate by including wording such as `reply confirm`, `no changes`, or `reply with specific setting changes`.
- The settings-confirmation gate must always use `agent_suggestion.update_parameters` with explicit arguments `param_names` and `param_values`. If no edits have been supplied yet, those arguments must be empty arrays: `param_names=[]`, `param_values=[]`.
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
- `find_defocus` has been called after user confirmation or requested setting updates.
- The final response includes the diagnostic summary values from step 6.
- If started from acquisition, the final response/handoff includes `defocus_A`, `dwell_time`, scan step arguments, and scan point arguments when available.
