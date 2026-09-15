---
name: acquire-4d-stem
description: "Workflow for starting BF preview, synchronizing pixel size, confirming ROI, and acquiring 4D-STEM data."
whenToUse: "Workflow for starting BF preview, synchronizing pixel size, confirming ROI, and acquiring 4D-STEM data."
metadata:
  legacy_id: "acquire_4d_stem"
  display_name: "Acquire 4D-STEM on SEM"
  version: "1.4.0"
  kind: "workflow"
  agents:
    - "agent_sem"
  required_tools:
    - "agent_sem.play_bf"
    - "agent_sem.sync_pixel_size"
    - "agent_sem.wait"
    - "agent_sem.stop_playing_detector"
    - "agent_sem.acquire_4d_stem"
  ordered_tools:
    - "agent_sem.play_bf"
    - "agent_sem.wait"
    - "agent_sem.sync_pixel_size"
    - "agent_sem.wait"
    - "agent_sem.stop_playing_detector"
    - "agent_sem.wait"
    - "agent_sem.acquire_4d_stem"
  references:
    []
  source: "nionswift_plugin"
---
## When To Use
Use this skill when the user wants to acquire a new 4D-STEM dataset on the SEM.

Do not use this skill for parameter recommendation, visualization-only tasks, or ptychography submission.

## Required Tools
- `agent_sem.play_bf`
- `agent_sem.sync_pixel_size`
- `agent_sem.wait`
- `agent_sem.stop_playing_detector`
- `agent_sem.acquire_4d_stem`

## Steps
1. Start BF preview with `agent_sem.play_bf`.
2. Wait exactly 10 seconds with `agent_sem.wait` using arguments `{"seconds": 10}`.
3. Synchronize pixel size with `agent_sem.sync_pixel_size`.
4. Ask the user to confirm the ROI after pixel-size synchronization. Represent this as `agent_sem.wait` using arguments `{"seconds": 1}` with `confirm_roi_selection_after_pixel_sync` in `required_inputs`.
5. Stop BF preview with `agent_sem.stop_playing_detector`.
6. Wait exactly 10 seconds with `agent_sem.wait` using arguments `{"seconds": 10}`.
7. Acquire data with `agent_sem.acquire_4d_stem`.

## Recommendation Fallback
- If step 7 is blocked because defocus, dwell, or scan-grid parameters are missing, explicitly tell the user they have two options:
  - provide the missing values manually, or
  - use the `recommend_4d_stem_parameters` skill to generate them.
- In plan review or blocked-step messaging, surface this recommendation fallback as part of the step 7 behavior rather than only as an internal recovery rule.
- When routing to `recommend_4d_stem_parameters`, preserve these SEM UI inputs: `max_ht_kV` from the current SEM hardware `accelerate_voltage_kev`, `current_pA` from the current SEM hardware `probe_current`, `abbe_limit_A=3.5`, `ultimate_resolution_A=0.45`, `max_dose_e_per_A2=1.5e6`, `use_manual_q=True`, `manual_q_1_per_A=0.02`, and `fov_A` from the current SEM ROI x/width when available.
- When routing to `recommend_4d_stem_parameters`, pass those values as concrete recommendation inputs/tool arguments, not only as prose in the summary. In particular:
  - `load_q_spec` must receive `fov_A` when SEM ROI width can be resolved.
  - `check_required_constraints` must be called with `from_sem=True` so the tool reads SEM UI context for `max_ht_kV` and `fov_A`.
  - `max_ht_kV` must be passed explicitly when SEM `accelerate_voltage_kev` is already resolved.
  - If either value is unavailable, say explicitly which one is unavailable.
- Explain that `max_ht_kV` and `current_pA` come from SEM hardware/UI state, `fov_A` comes from the ROI width in SEM UI, and the manual q default is used because the SEM probe Abbe limit should be larger than the gold lattice spacing, so this workflow uses a rough gold nanoparticle size scale as a conservative q estimate.
- After recommendation finishes, resume acquisition with the returned `defocus_A`, `dwell_time` in microseconds, `scan_step_x_A`, `scan_step_y_A`, and scan point counts when available.

## Hard Planning Rules
- Use the exact tool names above.
- Keep the seven-step order above. Do not add extra checks, waits, validation steps, or reconstruction steps.
- The only ROI confirmation is the chat/user-confirmation gate after `agent_sem.sync_pixel_size`.
- Do not use `agent_sem.get_sem_state` or `agent_sem.calculate_scan_parameters` in this workflow unless the user explicitly asks for them as a separate task.
- For acquisition arguments, use JSON numbers when known and JSON `null` or omitted values when unknown. Do not use the string `"None"`.
- For scan grid inputs, one X-direction value (`scan_points_x` or `scan_step_x_A`) and one Y-direction value (`scan_points_y` or `scan_step_y_A`) are sufficient. If they are not provided, let the tool check the current UI fields.
- If UI action context already shows completed steps from this same workflow, plan only the remaining suffix and do not repeat completed tool calls unless the user explicitly asks to redo them.
- If the workflow branches to `recommend_4d_stem_parameters`, the handoff step must include the resolved recommendation defaults as structured values when available, especially `max_ht_kV` and `fov_A`, and must set `from_sem=True` on `check_required_constraints`.

## Completed Action Mapping
Treat these as evidence of progress:
- `play_bf` success or “BF Preview playback started” means step 1 is complete.
- `sync_pixel_size` success or “Pixel size sync” means step 3 is complete.
- `stop_playing_detector` success or “BF Preview playback stopped” means step 5 is complete.
- `acquire_4d_stem` started/finished means step 7 has started or completed.

## Success Criteria
- BF preview starts.
- The two mandatory 10-second waits occur in the correct places.
- Pixel size is synchronized.
- The user confirms the ROI.
- BF preview is stopped.
- 4D-STEM acquisition returns a saved data path or success message.

## Failure Policy
- If pixel size synchronization, ROI confirmation, defocus, dwell, or scan-grid values are missing, put them in the relevant step's `required_inputs` and use `on_failure: ask_user`.
- If a microscope tool fails, stop unless the user provides recovery instructions.
- In step 7, if tool returns an error message about missing parameters, follow the Recommendation Fallback above. If the user does not need recommendations for those parameters, ask them to provide the values manually.
