---
name: tem-twin-phase-c2stig
description: "Internal Condenser astigmatism phase. Requires explicit target selection and select_device evidence for the current task. Supports ordinary Skill use or an approved workflow; use the public selection-plus-calibration Skill for standalone requests."
metadata:
  display_name: Condenser astigmatism Phase
  edmore: {authority: workflow, workflow: references/workflow.yaml}
---

First follow tem-tango-device-selection and obtain its successful result for
the explicitly chosen target. In normal Skill mode, proceed with permitted
tools without requesting Workflow mode. In Workflow mode, retain the reviewed
selection-plus-calibration contract and approval gates.
Bind device to {{select_device.device}}; never replace a missing result with a
default. Keep verified=true, restoration evidence and execution-result review.
## Execution

Run the single tool declared in references/workflow.yaml.
Run the original autoalign.py c2stig algorithm and verify ellipticity <0.03.

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
