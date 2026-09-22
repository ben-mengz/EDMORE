---
name: idpc-visualization
description: "Calibrate 4D-STEM iDPC inputs and generate an iDPC-style image from the selected dataset."
whenToUse: "Calibrate 4D-STEM iDPC inputs and generate an iDPC-style image from the selected dataset."
metadata:
  edmore:
    authority: workflow
  legacy_id: "idpc_visualization"
  display_name: "iDPC Visualization"
  version: "1.2.0"
  kind: "workflow"
  agents:
    - "agent_visulization"
  required_tools:
    - "agent_visulization.idpc_calibration"
    - "agent_visulization.idpc_generate"
  ordered_tools:
    - "agent_visulization.idpc_calibration"
    - "agent_visulization.idpc_generate"
  references:
    []
  source: "nionswift_plugin"
---
## When To Use
Use this skill when the user wants an iDPC-style image from the currently selected 4D-STEM dataset.

Do not use this skill for BF/ABF/ADF virtual detector images or ptychography result review.

## Required Tools
- `agent_visulization.idpc_calibration`
- `agent_visulization.idpc_generate`

## Steps
1. Calibrate iDPC inputs with `agent_visulization.idpc_calibration`.
2. Generate the image with `agent_visulization.idpc_generate`.

## Hard Planning Rules
- Do not skip calibration.
- Use the exact tool names above.
- Use user-provided values when available; otherwise pass JSON `null` so the tool can infer from dataset metadata.
- `rotation_scan` may be numeric or `"auto"`; if the user does not specify it, use `"auto"`.
- Do not add extra waits, SEM state checks, resource reads, or validation steps unless the user explicitly asks for troubleshooting.
- If calibration data is missing, let the calibration tool surface the missing input instead of inventing defaults.

## Success Criteria
- Scan calibration is resolved or validated.
- Diffraction calibration is resolved.
- The iDPC image is displayed.

## Failure Policy
- If the selected data is not valid 4D-STEM data, stop and ask the user to select the correct dataset.
- If convergence angle, mrad/pixel, scan step, FOV, or rotation is required and missing, ask for the exact missing value.
