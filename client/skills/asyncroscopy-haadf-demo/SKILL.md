---
name: asyncroscopy-haadf-demo
description: "Acquire a HAADF image with the asyncroscopy (asyncroscope) digital twin, without hardware. Use for HAADF demo or simulated STEM imaging; not for NionSwift or real SEM acquisition."
metadata:
  edmore:
    authority: workflow
  legacy_id: asyncroscopy_haadf_demo
  display_name: Asyncroscopy Digital Twin HAADF Demo
  version: "1.1.0"
  kind: workflow
  workflow: references/workflow.yaml
  source: asyncroscopy
---

## When To Use
For "take a HAADF image", "haddf", or "HAADF demo" in an asyncroscopy/digital-twin
conversation, select this workflow. If the instrument is ambiguous, propose this
hardware-free demo explicitly; never silently substitute a NionSwift experiment.

## Execution
Read [workflow.yaml](references/workflow.yaml). The four steps use the existing
standard MCP server named asyncroscopy. agent_mcp_asyncroscopy is the Harness
workflow address for that namespace, not a new MCP server or hardware adapter.
Follow the declared step IDs for success transitions and pause on failed steps.

Prepare a PlanReview with exactly these four steps, preserving skill_step_id.
Resolve user-provided scan and FOV parameters into the PlanReview. Parameters marked
`default` are user-overridable: use their declared defaults only when the user did
not specify a value. Do not request ROI selection, dose, detector angles, beam
current, hardware alignment, or additional confirmations. Normal plan approval is
still required. The user has requested a demo, not an optimized experiment.

1. Configure the scan. Defaults are `imsize=128` pixels, `dwell_time=2e-6` seconds
   (2 microseconds per pixel), normalized `scan_region=[0,0,1,1]`, and `.h5` output.
2. Set the field of view. The default is `fov=1e-8` metres, exactly 10 nm.
3. Use the twin's auto_focus.
4. Acquire detector_list ["HAADF"] and report the exact returned HDF5 key.

Only call mcp__asyncroscopy__UnifiedDigitalTwin_* tools. No agent_sem or NionSwift
tools, stage movement, parameter-recommendation workflow, reconstruction or server
startup. If these tools are absent, pause and ask to start the existing standalone
digital-twin and MCP backends. Never fall back to real hardware.

## Parameter Units And Overrides
- `UnifiedDigitalTwin_set_fov.fov` is always in **metres**. Convert a user value
  in nanometres with `fov_m = fov_nm * 1e-9`. Never pass `10` for 10 nm; pass
  `1e-8`. Never claim the twin interprets a bare number as nanometres.
- `settings_json.imsize` is the integer width and height in **pixels**.
- `settings_json.dwell_time` is in **seconds per pixel**. For example, 2 us is
  `2e-6`, and 1 us is `1e-6`.
- `settings_json.scan_region` uses normalized fractional coordinates
  `[x, y, width, height]`; the full scan is `[0,0,1,1]`.
- Use only the exact JSON keys `imsize`, `dwell_time`, `scan_region`, and
  `output_format`. Do not substitute `scan_points_x`, `scan_points_y`, or
  `dwell_seconds`; the device does not use those keys.
- `output_format` remains `.h5` because the Output View reads that acquisition.
- `detector_list` remains `["HAADF"]`; changing the detector would no longer be
  this HAADF workflow.

The PlanReview must show the resolved numerical values and units. A user may set
scan size, dwell time, scan region, or FOV in the original request or while
revising the pending PlanReview. Unspecified values retain the defaults above.

## Success And Failure
Judge each step independently, not against the final acquisition criterion:
- configure-scan succeeds when returned scan settings match the resolved approved
  values (user overrides or defaults).
- set-fov and focus are void Tango commands: a non-error MCP return with empty
  content is their successful acknowledgement, not missing acquisition evidence.
- acquire must return the nonempty HDF5 key below.
All four steps have confirm=false and empty required_inputs. There is no per-step
operator confirmation to prove after the enclosing PlanReview has been approved.

Success means acquisition returns a nonempty stem_image_HAADF_*.h5 key, not merely
that the request was sent. The notebook's Live Acquisition Display watches that
file and updates automatically. Report the key so the user can match it to the
display. Do not claim the model saw the image: the native MCP returns data/text,
not a vision image block.

On an error or ambiguous acquisition result, pause, report the error and ask how
to recover. Do not automatically repeat acquisition. This model uses approximate
HAADF physics; autofocus uses its internal sample-plane model and does not prove
experimental image quality. Demo settings remain on the twin after completion.
