---
name: ptychography
description: "Prepare ptychography reconstruction parameters, append experimental parameters, save them, and submit reconstruction to the server."
whenToUse: "Prepare ptychography reconstruction parameters, append experimental parameters, save them, and submit reconstruction to the server."
metadata:
  edmore:
    authority: workflow
  legacy_id: "ptychography"
  display_name: "Ptychography Parameter Preparation And Submission"
  version: "1.2.0"
  kind: "workflow"
  agents:
    - "agent_ptychography"
  required_tools:
    - "agent_ptychography.prepare_parameters"
    - "agent_ptychography.append_exp_params"
    - "agent_ptychography.save_params"
    - "agent_ptychography.start_server_ptychography"
  optional_tools:
    - "agent_ptychography.load_preset"
    - "agent_ptychography.search_RAG_for_parameters"
    - "agent_ptychography.change_pypty_parameters"
  ordered_tools:
    - "agent_ptychography.prepare_parameters"
    - "agent_ptychography.append_exp_params"
    - "agent_ptychography.save_params"
    - "agent_ptychography.start_server_ptychography"
  references:
    []
  source: "nionswift_plugin"
---
## When To Use
Use this skill when the user wants to prepare, review, save, and submit a ptychography reconstruction for a selected 4D-STEM dataset.

## Required Tools
- `agent_ptychography.prepare_parameters`
- `agent_ptychography.append_exp_params`
- `agent_ptychography.save_params`
- `agent_ptychography.start_server_ptychography`
- Optional support tools: `agent_ptychography.load_preset`, `agent_ptychography.search_RAG_for_parameters`, `agent_ptychography.change_pypty_parameters`

## Steps
1. Prepare essential and experimental parameters with `agent_ptychography.prepare_parameters`. Because this MCP tool schema marks every argument as required, the plan step must include every argument listed in the Prepare Parameters Argument Contract below. Use JSON `null` for unknown optional values and explicit defaults for non-null defaults.
2. Ask the user to review the prepared parameters, then call `agent_ptychography.append_exp_params`. Put `confirm_prepared_ptychography_parameters` in this step's `required_inputs`.
3. Save parameters with `agent_ptychography.save_params`.
4. Ask the user to confirm the saved parameters, then call `agent_ptychography.start_server_ptychography`. Use `param_path` from the `save_params` output or the current ptychography UI experimental params path, and put `confirm_saved_ptychography_parameters_before_server` in this step's `required_inputs`.

## Prepare Parameters Argument Contract
The `agent_ptychography.prepare_parameters` step must include this complete argument object. Do not omit keys.

```json
{
  "total_thickness": null,
  "num_slices": null,
  "convergence_angle": null,
  "accela_voltage": null,
  "fov_nm": null,
  "PLRotation_deg": null,
  "rez_pixel_size_mrad": null,
  "rez_pixel_size_A": null,
  "aberrations": [0, 0, 0],
  "data_pad": null,
  "bright_threshold": 0.2,
  "scan_step_A": null,
  "transform_axis_matrix": [1, 0, 0, 1]
}
```

If the user provides any of these values or they are available from previous workflow context, replace only those keys with the provided values. For scan-size control, at least one of `scan_step_A` or `fov_nm` may remain `null` because the tool can read metadata/UI defaults, but both keys must still be present.

When this skill is expanded from `ptychography_on_sem` after SEM acquisition, use SEM/acquisition context to fill:
- `accela_voltage`: beam acceleration voltage in kV from SEM/acquisition/recommendation context when available, e.g. recommendation `ht_kV`.
- `PLRotation_deg`: `"auto"` unless the user explicitly provided a numeric rotation.

## Hard Planning Rules
- Use the exact tool names above.
- Keep `prepare_parameters` and `append_exp_params` as separate steps.
- Do not create extra no-op confirmation steps. Use `required_inputs` on `append_exp_params` for prepared-parameter confirmation and on `start_server_ptychography` for saved-parameter confirmation.
- For `agent_ptychography.prepare_parameters`, never omit required schema keys. Use JSON numbers when known and JSON `null` when unknown. Keep non-null defaults populated explicitly: `aberrations: [0, 0, 0]`, `bright_threshold: 0.2`, and `transform_axis_matrix: [1, 0, 0, 1]`.
- Preserve the exact confirmation input names above so the execution layer can recognize the pause/resume gates.
- Use support tools only when the user explicitly asks to explain or modify parameters.

## Success Criteria
- Evaluate each executed step separately using its actual output. MCP transport success alone is not evidence that parameters were prepared.
- The legacy response "You didn't select the data properly, please select a 4d-stem data--ptychography agent job" means preparation failed. Do not proceed to parameter review or append.
- Parameters are prepared.
- Experimental parameters are appended.
- Parameters are saved.
- The reconstruction job is submitted.

## Failure Policy
- If no valid dataset is selected, ask the user to select the acquired 4D-STEM dataset in NionSwift, then retry the failed preparation step. Do not offer a parameter-recommendation subplan for a missing dataset, and do not invent a dataset path.
- If required reconstruction inputs are missing, put them in the relevant step's `required_inputs` and use `on_failure: ask_user`.
- If preparation, append, save, or submission fails, stop and report the exact failing tool and error.
