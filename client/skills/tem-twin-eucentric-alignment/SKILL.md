---
name: tem-twin-eucentric-alignment
description: "ONLY Eucentric stage Z: ask which Tango device to use, then run this single bounded calibration. For overall alignment use tem-twin-alignment-sequence."
metadata:
  display_name: TEM Eucentric stage Z
  edmore: {authority: workflow}
  kind: compound_workflow
---

## Execution

First ask the user to choose the target via tem-tango-device-selection, then run the one calibration phase declared in manifest.json.
Run the original autoalign.py z algorithm and verify residual Z correction <100 nm.

The tool reuses the original AutoScript-only Python algorithm, including its
bounded probes, correction loops and stopping rules. Numeric calculations run
inside the tool, not in the LLM or as additional plan steps.

Completion requires `verified: true`: the original tolerance check must pass
and working-condition restoration must succeed. A mere `fixed` result is not
proof of convergence. Keep Harness execution-result review; errors, skipped
measurements, failed verification or uncertain transport outcomes pause the
workflow. Never automatically retry a mutating calibration after a timeout.

Each tool independently restores magnification, intensity, defocus, projector
mode, stage X/Y and screen position while retaining accepted calibration values
and corrected Z. Rotation uses eucentric objective focus during its own scope.
The full sequence must pass Z before rotation or objective stigmation.

For overall alignment select `tem-twin-alignment-sequence`, which calls all six
phase tools in order. Do not expand these tools into individual API calls or
use hidden Twin truth metrics as completion evidence.
