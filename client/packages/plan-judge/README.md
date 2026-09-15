# EDMORE Plan Judge

Skill contracts distinguish required tools from optional support tools. Optional tools remain available to the planner and validator without becoming mandatory steps. The semantic judge receives skill instructions and supporting contracts, including runtime recovery: a proposed child plan is generated, judged, and approved only after a blocker and user agreement, then returns to the saved parent position.

New plans retain only the confirmation gates declared by the bundled skills. Planner-added gates and preview-success text do not introduce additional confirmations. Runtime tool failures still pause execution. Existing persisted plans retain their reviewed gates until revised.

Child workflow completion restores the approved parent plan at its saved step. The resumed event includes the parent plan and step index so subscribers can replace the child display. Outstanding user-input gates pause immediately; ungated steps remain available to the native agent loop through nextLoopDispatch. Returning from a child does not grant user confirmation.
