---
name: virtual-detector-visualization
description: "Calibrate 4D-STEM virtual detector inputs and generate a BF, ABF, or ADF virtual detector image from the selected dataset."
whenToUse: "Calibrate 4D-STEM virtual detector inputs and generate a BF, ABF, or ADF virtual detector image from the selected dataset."
metadata:
  legacy_id: "virtual_detector_visualization"
  display_name: "Virtual Detector Visualization"
  version: "1.2.0"
  kind: "workflow"
  agents:
    - "agent_visulization"
  required_tools:
    - "agent_visulization.virtual_detector_calibration"
    - "agent_visulization.virtual_detector_generate"
  ordered_tools:
    - "agent_visulization.virtual_detector_calibration"
    - "agent_visulization.virtual_detector_generate"
  references:
    []
  source: "nionswift_plugin"
---
## When To Use
Use this skill when the user wants a BF, ABF, or ADF-style virtual detector image from the currently selected 4D-STEM dataset.

Do not use it for iDPC generation or ptychography result review.

## Required Tools
- `agent_visulization.virtual_detector_calibration`
- `agent_visulization.virtual_detector_generate`

## Steps
1. Calibrate virtual detector inputs with `agent_visulization.virtual_detector_calibration`.
2. Generate the requested detector image with `agent_visulization.virtual_detector_generate`.

## Hard Planning Rules
- Do not skip calibration.
- Use the exact tool names above.
- Use `region_mode="inner"` for BF, `"middle"` for ABF, and `"outer"` for ADF.
- Use user-provided values when present; otherwise pass JSON `null` so the tool can infer from dataset metadata.
- Do not add extra waits, SEM state checks, resource reads, or validation steps unless the user explicitly asks for troubleshooting.
- If calibration data is missing, let the calibration tool report the missing input instead of inventing defaults.
- If the user does not specify BF/ABF/ADF, ask which detector region they want before the generate step.

## Success Criteria
- Scan calibration is resolved or validated.
- Diffraction calibration is resolved.
- The requested virtual detector image is displayed.

## Failure Policy
- If the selected data is not valid 4D-STEM data, stop and ask the user to select the correct dataset.
- If convergence angle, mrad/pixel, scan step, FOV, inner angle, or outer angle is required and missing, ask for the exact missing value.
