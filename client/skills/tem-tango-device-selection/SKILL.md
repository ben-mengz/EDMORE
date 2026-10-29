---
name: tem-tango-device-selection
description: "Ask the user to choose the Tango target before any TEM calibration. Shared first phase of TEM workflows."
metadata:
  display_name: Select TEM Device
  edmore: {authority: workflow, workflow: references/workflow.yaml}
---

Ask the user which registered Tango device to operate. Do not infer consent from
there being only one device, and never silently default to a Twin or real hardware.
The registered MCP device enums and list_devices describe the available targets;
list_devices is discovery, not permission to operate. The user must explicitly
choose the exact target before select_device executes. Preserve the ask gate.
This read-only step validates the connection and returns device for result binding.
It changes no global target. All later phase tools bind this same result.
Do not automatically replay a completed selection to switch targets in an active
workflow; changing target requires a new plan and confirmation.
