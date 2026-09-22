---
name: ptychography-results-visualization
description: "Query recent ptychography slurm IDs and visualize reconstruction results such as object, probe, positions, or loss curve."
whenToUse: "Query recent ptychography slurm IDs and visualize reconstruction results such as object, probe, positions, or loss curve."
metadata:
  edmore:
    authority: workflow
  legacy_id: "ptychography_results_visualization"
  display_name: "Ptychography Results Visualization"
  version: "1.2.0"
  kind: "workflow"
  agents:
    - "agent_visulization"
  required_tools:
    - "agent_visulization.list_ptychography_result_ids"
    - "agent_visulization.visualize_ptychography_results"
  ordered_tools:
    - "agent_visulization.list_ptychography_result_ids"
    - "agent_visulization.visualize_ptychography_results"
  references:
    []
  source: "nionswift_plugin"
---
## When To Use
Use this skill when the user wants to inspect existing ptychography reconstruction results on the server.

Do not use it for submitting new ptychography jobs or for 4D-STEM virtual detector/iDPC generation.

## Required Tools
- `agent_visulization.list_ptychography_result_ids`
- `agent_visulization.visualize_ptychography_results`

## Steps
1. Query recent result IDs with `agent_visulization.list_ptychography_result_ids`.
2. Visualize the requested result with `agent_visulization.visualize_ptychography_results`. If the user does not provide a slurm ID, ask the user to choose one from the queried results before this step.

## Hard Planning Rules
- Use the exact tool names above.
- Do not visualize before a slurm ID is known.
- Use `epoch="final"` unless the user explicitly asks for a checkpoint epoch.
- Use `to_visualization` exactly as one of `"object"`, `"probe"`, `"positions"`, or `"Loss Curve"`.
- Keep `start_slices_obj` and `end_slices_obj` at defaults unless the user explicitly asks for an object-slice subset.
- Do not add extra server checks, waits, or filesystem steps unless the user explicitly asks for troubleshooting.

## Success Criteria
- Recent result IDs can be queried.
- The requested result is displayed.

## Failure Policy
- If the server is unreachable, stop and report it.
- If the slurm ID is missing or invalid, ask the user for a valid choice.
- If the requested result file is missing, report the missing file and stop.
