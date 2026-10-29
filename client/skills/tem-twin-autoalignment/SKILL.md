---
name: tem-twin-autoalignment
description: "Non-executable legacy alignment reference. Use tem-twin-alignment-sequence, which composes the six current autoalign.py workflows."
metadata:
  display_name: TEM Twin Autoalignment
  edmore: {authority: support}
  source: tem-twin-autoscript
---

## Execution

This legacy flat graph is not executable for new plans. Its historical YAML is
retained only as a reference. Use `tem-twin-alignment-sequence` and its six
current child workflows instead of the historical procedure below.

The supported sequence is Beam/C2, Gun tilt, Condenser astigmatism, Eucentric Z,
Rotation centre, and Objective astigmatism. Each current child follows its own
`autoalign.py` algorithm using native AutoScript actions and the pure
`calculate_alignment` tool. Never reconstruct a new plan from this archived
flat YAML or use hidden Twin metrics as alignment evidence.
