from __future__ import annotations

import asyncio
import json
import os
import re
from dataclasses import dataclass
from typing import Any, Callable, Optional

from agents import Agent, AgentsException, MaxTurnsExceeded, Runner
from openai.types.responses import ResponseTextDeltaEvent

from edma_mcp.client.models import PlanReview, PlanStep
from edma_mcp.client.plan_judge import judge_plan_review
from edma_mcp.skills.provider import FilesystemSkillProvider


@dataclass
class PlanningCallbacks:
    on_status: Optional[Callable[[str], None]] = None
    on_trace: Optional[Callable[[str], None]] = None
    on_error: Optional[Callable[[str], None]] = None


@dataclass
class PlanningRunResult:
    plan: Optional[PlanReview] = None
    queued_for_approval: bool = False
    error_message: Optional[str] = None


@dataclass
class PendingPlanDecisionResult:
    action: str = "wait"
    plan: Optional[PlanReview] = None
    message: str = ""


class PlanningCoordinator:
    def __init__(self, *, planner_max_turns: int = 30) -> None:
        self.triage_agent = None
        self.planner_agent = None
        self.session = None
        self.bridge = None
        self.pending_plan: Optional[PlanReview] = None
        self.archived_plans: list[PlanReview] = []
        self.planner_max_turns = planner_max_turns

    def bind_runtime(self, triage_agent: Any, planner_agent: Any, session: Any, bridge: Any) -> None:
        self.triage_agent = triage_agent
        self.planner_agent = planner_agent
        self.session = session
        self.bridge = bridge

    def reset(self) -> None:
        self.pending_plan = None
        self.archived_plans = []

    def has_pending_plan(self) -> bool:
        return self.pending_plan is not None

    def get_pending_plan(self) -> Optional[PlanReview]:
        return self.pending_plan

    def get_archived_plans(self) -> list[PlanReview]:
        return list(self.archived_plans)

    def _archive_plan(self, plan: Optional[PlanReview]) -> None:
        if plan is None:
            return
        self.archived_plans.append(plan)

    def take_pending_plan(self) -> Optional[PlanReview]:
        plan = self.pending_plan
        self.pending_plan = None
        return plan

    async def start_planning(
        self,
        message: str,
        callbacks: PlanningCallbacks,
        trace_formatter: Callable[[Any], Optional[str]],
        plan_extractor: Callable[[Any], Optional[PlanReview]],
    ) -> PlanningRunResult:
        self._archive_plan(self.pending_plan)
        self.pending_plan = None
        prompt = await self._format_direct_planner_prompt(message)
        return await self._run_planning_cycle(
            original_message=message,
            planner_prompt=prompt,
            live_label="Planning with Planner...",
            callbacks=callbacks,
            trace_formatter=trace_formatter,
            plan_extractor=plan_extractor,
        )

    async def revise_pending_plan(
        self,
        message: str,
        callbacks: PlanningCallbacks,
        trace_formatter: Callable[[Any], Optional[str]],
        plan_extractor: Callable[[Any], Optional[PlanReview]],
    ) -> PlanningRunResult:
        plan = self.pending_plan
        if not plan:
            return PlanningRunResult(error_message="No pending plan to revise.")
        self._archive_plan(plan)
        self.pending_plan = None
        prompt = self._format_direct_planner_revise_prompt(message, plan)
        return await self._run_planning_cycle(
            original_message=message,
            planner_prompt=prompt,
            live_label="Planning with Planner...",
            callbacks=callbacks,
            trace_formatter=trace_formatter,
            plan_extractor=plan_extractor,
        )

    async def handle_pending_plan_message(
        self,
        message: str,
        callbacks: PlanningCallbacks,
        trace_formatter: Callable[[Any], Optional[str]],
        plan_extractor: Callable[[Any], Optional[PlanReview]],
        is_approval_message: Callable[[str], bool],
        should_arbitrate_pending_plan: Callable[[str], bool],
    ) -> PendingPlanDecisionResult:
        plan = self.pending_plan
        if not plan:
            return PendingPlanDecisionResult(action="wait", message="No pending plan to review.")

        try:
            decision = await self._classify_pending_plan_message_async(message, plan)
        except Exception:
            if is_approval_message(message):
                decision = "approve"
            elif should_arbitrate_pending_plan(message):
                decision = "revise"
            else:
                decision = "wait"

        if decision == "approve":
            plan = self.take_pending_plan()
            return PendingPlanDecisionResult(action="approve", plan=plan)
        if decision == "revise":
            result = await self.revise_pending_plan(
                message,
                callbacks=callbacks,
                trace_formatter=trace_formatter,
                plan_extractor=plan_extractor,
            )
            if result.error_message:
                return PendingPlanDecisionResult(action="wait", message=result.error_message)
            return PendingPlanDecisionResult(
                action="revise",
                plan=result.plan,
                message=(
                    "Plan is ready for approval again."
                    if result.queued_for_approval
                    else "Plan revision completed but was not queued for approval."
                ),
            )
        return PendingPlanDecisionResult(
            action="wait",
            message="Plan is still waiting for approval. Say 'approve', 'go', or 'go ahead' to execute it, or tell me what to change.",
        )

    async def _run_planning_cycle(
        self,
        *,
        original_message: str,
        planner_prompt: str,
        live_label: str,
        callbacks: PlanningCallbacks,
        trace_formatter: Callable[[Any], Optional[str]],
        plan_extractor: Callable[[Any], Optional[PlanReview]],
    ) -> PlanningRunResult:
        if self.planner_agent is None or self.session is None:
            return PlanningRunResult(error_message="Planner runtime is not ready.")

        try:
            final_text = await self._run_agent_to_text(
                planner_prompt,
                live_label=live_label,
                trace_formatter=trace_formatter,
                callbacks=callbacks,
            )
        except AgentsException as exc:
            recovered_plan = self._recover_planreview_from_text(str(exc))
            if recovered_plan is None:
                self.pending_plan = None
                return PlanningRunResult(error_message=self._format_agent_error(exc))
            plan = self._normalize_recommendation_plan(recovered_plan)
            agent_preflight_error = await self._preflight_required_agents(plan, callbacks)
            if agent_preflight_error:
                self.pending_plan = None
                return PlanningRunResult(error_message=agent_preflight_error)
            self.pending_plan = plan
            return PlanningRunResult(plan=plan, queued_for_approval=True)
        plan = plan_extractor(final_text)
        if not plan:
            plan = self._recover_planreview_from_text(final_text)
        if not plan:
            self.pending_plan = None
            return PlanningRunResult(error_message=final_text or "Planner did not return a valid PlanReview.")
        plan = self._normalize_recommendation_plan(plan)
        agent_preflight_error = await self._preflight_required_agents(plan, callbacks)
        if agent_preflight_error:
            self.pending_plan = None
            return PlanningRunResult(error_message=agent_preflight_error)

        replan_history = []
        max_auto_replans = 5
        for attempt_index in range(max_auto_replans + 1):
            try:
                plan.judge_report = await judge_plan_review(plan, self.bridge)
            except Exception as exc:
                plan.judge_report = None
                if callbacks.on_trace:
                    callbacks.on_trace(f"Judge failed: {exc}")
                break

            judge_report = getattr(plan, "judge_report", None)
            judge_status = getattr(judge_report, "status", "pass")
            if judge_status == "pass":
                break
            if self._has_unavailable_agent_issue(judge_report):
                self.pending_plan = None
                return PlanningRunResult(error_message=getattr(judge_report, "summary", "Required agent is not running."))
            fixable = self._is_fixable_judge_report(judge_report)
            if attempt_index >= max_auto_replans or not fixable:
                if not fixable and judge_report is not None and callbacks.on_trace:
                    categories = sorted({
                        str(getattr(issue, "category", "unknown"))
                        for issue in list(getattr(judge_report, "issues", []) or [])
                        if getattr(issue, "severity", "") == "blocking"
                    })
                    callbacks.on_trace(
                        "Judge classified this plan as non-fixable for auto-replan: "
                        f"grounding={getattr(judge_report, 'grounding_status', 'unknown')}, "
                        f"blocking_categories={categories}"
                    )
                break

            replan_history.append(
                f"Blocked {attempt_index + 1} time(s): {getattr(judge_report, 'summary', 'Judge requested revision')}."
            )
            reason_brief = self._judge_reason_brief(judge_report)
            if callbacks.on_trace:
                callbacks.on_trace(
                    f"Judge requested auto-replan #{attempt_index + 1}: "
                    f"{getattr(judge_report, 'grounding_status', 'unknown')} / {judge_status} / {reason_brief}"
                )
            replan_prompt = self._format_judge_replan_prompt(original_message, plan, judge_report, attempt_index + 1)
            try:
                final_text = await self._run_agent_to_text(
                    replan_prompt,
                    live_label=f"Auto-replan #{attempt_index + 1}... {reason_brief}",
                    trace_formatter=trace_formatter,
                    callbacks=callbacks,
                )
            except AgentsException as exc:
                replanned = self._recover_planreview_from_text(str(exc))
                if replanned is None:
                    self.pending_plan = None
                    return PlanningRunResult(error_message=self._format_agent_error(exc))
            else:
                replanned = plan_extractor(final_text)
                if not replanned:
                    replanned = self._recover_planreview_from_text(final_text)
            if not replanned:
                break
            replanned = self._normalize_recommendation_plan(replanned)
            agent_preflight_error = await self._preflight_required_agents(replanned, callbacks)
            if agent_preflight_error:
                self.pending_plan = None
                return PlanningRunResult(error_message=agent_preflight_error)
            plan = replanned

        plan.judge_replan_history = replan_history
        judge_status = getattr(getattr(plan, "judge_report", None), "status", "pass")
        self.pending_plan = plan if judge_status == "pass" else None
        return PlanningRunResult(
            plan=plan,
            queued_for_approval=judge_status == "pass",
        )

    async def _run_agent_to_text(
        self,
        message: str,
        *,
        live_label: str,
        trace_formatter: Callable[[Any], Optional[str]],
        callbacks: PlanningCallbacks,
    ) -> str:
        if self.bridge is not None and hasattr(self.bridge, "planner_discovery_log"):
            self.bridge.planner_discovery_log = []
        response = Runner.run_streamed(
            self.planner_agent,
            message,
            session=self.session,
            max_turns=self.planner_max_turns,
        )
        bot_text = []
        live_items = []
        planner_poll_active = True

        async def poll_planner_discovery():
            last_log = []
            while planner_poll_active:
                try:
                    current = list(getattr(self.bridge, "planner_discovery_log", []) or [])
                except Exception:
                    current = []
                if current and current != last_log:
                    formatted = [self._format_planner_discovery_entry(item) for item in current[-3:]]
                    for status in formatted:
                        if not live_items or live_items[-1] != status:
                            live_items.append(status)
                    if callbacks.on_status:
                        callbacks.on_status(self._compose_live_planning_status(live_label, live_items))
                    last_log = current
                await asyncio.sleep(0.2)

        planner_poll_task = asyncio.create_task(poll_planner_discovery())
        try:
            async for event in response.stream_events():
                if event.type == "raw_response_event" and isinstance(event.data, ResponseTextDeltaEvent):
                    bot_text.append(event.data.delta)
                elif event.type == "agent_updated_stream_event":
                    status = f"Agent active: {event.new_agent.name}"
                    if not live_items or live_items[-1] != status:
                        live_items.append(status)
                        if callbacks.on_status:
                            callbacks.on_status(self._compose_live_planning_status(live_label, live_items))
                elif event.type == "run_item_stream_event":
                    trace_message = trace_formatter(event)
                    if trace_message:
                        if not live_items or live_items[-1] != trace_message:
                            live_items.append(trace_message)
                            if callbacks.on_status:
                                callbacks.on_status(self._compose_live_planning_status(live_label, live_items))
        finally:
            planner_poll_active = False
            try:
                await planner_poll_task
            except Exception:
                pass
        return "".join(bot_text)

    def _format_agent_error(self, exc: AgentsException) -> str:
        if isinstance(exc, MaxTurnsExceeded):
            return self._format_max_turns_error(exc)
        discovery_log = list(getattr(self.bridge, "planner_discovery_log", []) or []) if self.bridge is not None else []
        if discovery_log and not any(str(item).startswith("read_skill_content:") for item in discovery_log):
            return (
                "Planner failed before producing a valid PlanReview, and it did not complete the required "
                f"read_skill_content discovery call. Discovery log: {discovery_log}. Original error: {exc}"
            )
        if not discovery_log:
            return (
                "Planner failed before producing a valid PlanReview before calling any skill discovery tool. "
                f"Original error: {exc}"
            )
        return f"Planner failed before producing a valid PlanReview. Discovery log: {discovery_log}. Original error: {exc}"

    def _format_max_turns_error(self, exc: MaxTurnsExceeded) -> str:
        return (
            f"Planner exceeded its turn limit ({self.planner_max_turns}) before producing a valid PlanReview. "
            "Try narrowing the request or simplifying the relevant skill/playbook. "
            f"Original error: {exc}"
        )

    def _recover_planreview_from_text(self, text: Any) -> Optional[PlanReview]:
        if not isinstance(text, str):
            return None
        candidates: list[dict[str, Any]] = []
        stripped = text.strip()
        if stripped.startswith("{") and stripped.endswith("}"):
            try:
                parsed = json.loads(stripped)
            except Exception:
                parsed = None
            if isinstance(parsed, dict):
                candidates.append(parsed)
        decoder = json.JSONDecoder()
        for match in re.finditer(r"\{", text):
            try:
                parsed, _ = decoder.raw_decode(text[match.start():])
            except Exception:
                continue
            if isinstance(parsed, dict):
                candidates.append(parsed)
        for candidate in candidates:
            repaired = self._repair_planreview_payload(candidate)
            if repaired is None:
                continue
            try:
                return PlanReview.model_validate(repaired)
            except Exception:
                continue
        return None

    def _repair_planreview_payload(self, payload: dict[str, Any]) -> Optional[dict[str, Any]]:
        if not isinstance(payload, dict) or "steps" not in payload:
            return None
        repaired = dict(payload)
        steps = list(repaired.get("steps") or [])
        repaired_steps: list[dict[str, Any]] = []
        inferred_skill = None
        step_ids = [
            str(raw_step.get("step_id") or "").strip()
            for raw_step in steps
            if isinstance(raw_step, dict) and str(raw_step.get("step_id") or "").strip()
        ]
        for index, raw_step in enumerate(steps):
            if not isinstance(raw_step, dict):
                repaired_steps.append(raw_step)
                continue
            step = dict(raw_step)
            skill_value = str(step.get("skill") or "").strip()
            if not skill_value:
                skill_value = self._infer_skill_from_step_payload(step, fallback=inferred_skill)
                if skill_value:
                    step["skill"] = skill_value
            if skill_value and not inferred_skill:
                inferred_skill = skill_value
            step["on_success"] = self._repair_plan_step_ref(
                step.get("on_success"),
                index=index,
                step_ids=step_ids,
                field_name="on_success",
            )
            step["on_failure"] = self._repair_plan_step_ref(
                step.get("on_failure"),
                index=index,
                step_ids=step_ids,
                field_name="on_failure",
            )
            repaired_steps.append(step)
        repaired["steps"] = repaired_steps
        return repaired

    def _repair_plan_step_ref(self, value: Any, *, index: int, step_ids: list[str], field_name: str) -> str:
        ref = str(value or "").strip()
        normalized = ref.lower().replace("-", "_").replace(" ", "_")
        terminal_refs = {"done", "stop", "ask_user"}
        if normalized in terminal_refs:
            return normalized
        if ref in step_ids:
            return ref
        if field_name == "on_success" and normalized in {"proceed", "continue", "next", "next_step", "then", "success"}:
            if index + 1 < len(step_ids):
                return step_ids[index + 1]
            return "done"
        if field_name == "on_failure" and normalized in {"escalate", "fail", "failure", "error", "abort"}:
            return "stop"
        if field_name == "on_failure" and normalized in {"ask_user", "askuser", "ask", "clarify", "request_input"}:
            return "ask_user"
        return ref

    def _infer_skill_from_step_payload(self, step: dict[str, Any], *, fallback: Optional[str] = None) -> str:
        tool_name = str(step.get("tool_name") or "").strip().lower()
        agent = str(step.get("agent") or "").strip().lower()
        if tool_name.startswith("agent_suggestion.") or agent == "agent_suggestion":
            return "recommend_4d_stem_parameters"
        if agent == "agent_ptychography":
            return "ptychography"
        if agent == "agent_sem":
            return "sem"
        if agent in {"agent_visulization", "agent_visualization"}:
            return "visualization"
        return fallback or ""

    async def _classify_pending_plan_message_async(self, message: str, plan: PlanReview) -> str:
        classifier_agent = self._build_pending_plan_gate_agent()
        prompt = self._format_pending_plan_gate_prompt(message, plan)
        result = await Runner.run(starting_agent=classifier_agent, input=prompt)
        decision = self._extract_pending_plan_gate_decision(getattr(result, "final_output", result))
        return decision or "wait"

    def _build_pending_plan_gate_agent(self):
        kwargs = {
            "name": "PendingPlanGate",
            "instructions": (
                "You classify whether the latest user reply should APPROVE execution of a pending plan, "
                "REVISE the plan, or WAIT for clearer instruction.\n"
                "Return JSON only with keys decision and rationale.\n"
                "decision must be one of: approve, revise, wait.\n"
                "Approve when the user clearly wants execution now, even in natural language like "
                "\"looks good, go ahead\" or \"sounds fine, let's do it\".\n"
                "Revise when the user changes requirements, asks to modify the plan, asks a plan question, "
                "or introduces new constraints.\n"
                "Wait when the user is only acknowledging, praising, or being vague without clear approval or revision.\n"
                "\"looks good\" alone should be wait.\n"
                "\"looks good, go ahead\" should be approve.\n"
                "Do not call tools. Do not include markdown."
            ),
        }
        model = getattr(self.triage_agent, "model", None)
        if model is not None:
            kwargs["model"] = model
        model_settings = getattr(self.triage_agent, "model_settings", None)
        if model_settings is not None:
            kwargs["model_settings"] = model_settings
        return Agent(**kwargs)

    def _extract_pending_plan_gate_decision(self, output: Any) -> Optional[str]:
        if hasattr(output, "model_dump"):
            output = output.model_dump()
        if isinstance(output, dict):
            decision = str(output.get("decision", "")).strip().lower()
            return decision if decision in {"approve", "revise", "wait"} else None
        if not isinstance(output, str):
            return None
        text = output.strip()
        candidates = [text]
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end > start:
            candidates.append(text[start:end + 1])
        for candidate in candidates:
            try:
                data = json.loads(candidate)
            except Exception:
                continue
            decision = str(data.get("decision", "")).strip().lower()
            if decision in {"approve", "revise", "wait"}:
                return decision
        return None

    def _is_fixable_judge_report(self, report: Any) -> bool:
        if report is None:
            return False
        if getattr(report, "grounding_status", "") == "ungrounded":
            return False
        issues = list(getattr(report, "issues", []) or [])
        if not issues:
            return False
        fixable_categories = {"order", "parameter", "grounding"}
        for issue in issues:
            if getattr(issue, "severity", "") != "blocking":
                continue
            if getattr(issue, "category", "") not in fixable_categories:
                return False
        return True

    def _format_missing_fix_choice_message(self, report: Any) -> Optional[str]:
        if report is None:
            return None
        for issue in list(getattr(report, "issues", []) or []):
            if getattr(issue, "severity", "") != "blocking" or getattr(issue, "category", "") != "parameter":
                continue
            message = str(getattr(issue, "message", "") or "")
            if "agent_suggestion.apply_fix" not in message or "fix_name" not in message:
                continue
            if "value 'None'" not in message and "Missing required parameter 'fix_name'" not in message:
                continue
            return (
                "A recommendation fix requires a concrete `fix_name`, but none was provided. "
                "Please choose one allowed fix from the failed diagnostic instead of replanning. "
                "Common choices include `fix_dose_dwell`, `fix_dose_current`, `fix_dose_step`, "
                "`fix_fov`, `fix_scan_step`, `fix_alpha`, or `fix_pitch`."
            )
        return None

    def _normalize_recommendation_plan(self, plan: PlanReview) -> PlanReview:
        plan = self._normalize_recommendation_apply_fix_steps(plan)
        return self._normalize_recommendation_confirmation_gate(plan)

    def _normalize_terminal_ref(self, ref: Any) -> str:
        value = str(ref or "").strip()
        return value if value else "END"

    def _normalize_recommendation_apply_fix_steps(self, plan: PlanReview) -> PlanReview:
        steps = list(plan.steps or [])
        if not steps:
            return plan

        def normalize_tool(step: PlanStep) -> str:
            agent = str(getattr(step, "agent", "") or "").strip()
            tool_name = str(getattr(step, "tool_name", "") or "").strip()
            if tool_name.startswith("agent_"):
                return tool_name
            if tool_name and "." in tool_name:
                return tool_name
            if agent and not tool_name.startswith(f"{agent}."):
                return f"{agent}.{tool_name}" if tool_name else agent
            return tool_name

        def is_placeholder_fix(step: PlanStep) -> bool:
            if step.skill != "recommend_4d_stem_parameters":
                return False
            if normalize_tool(step) != "agent_suggestion.apply_fix":
                return False
            fix_name = step.arguments.get("fix_name")
            if fix_name is None:
                return True
            if isinstance(fix_name, str):
                value = fix_name.strip()
                if not value:
                    return True
                lowered = value.lower()
                if lowered in {"fix_name", "placeholder", "choose_fix", "tbd", "unknown", "none"}:
                    return True
                if value.startswith("{{") and value.endswith("}}"):
                    return True
            return False

        changed = False
        filtered_steps: list[PlanStep] = []
        removed_ids: set[str] = set()
        redirect_map: dict[str, str] = {}

        for step in steps:
            if is_placeholder_fix(step):
                removed_ids.add(str(step.step_id))
                redirect_map[str(step.step_id)] = self._normalize_terminal_ref(step.on_success)
                changed = True
                continue
            filtered_steps.append(step)

        if not changed:
            return plan

        def resolve_redirect(ref: str) -> str:
            seen: set[str] = set()
            current = str(ref)
            while current in redirect_map and current not in seen:
                seen.add(current)
                current = redirect_map[current]
            return current

        rewritten_steps: list[PlanStep] = []
        for step in filtered_steps:
            updates: dict[str, Any] = {}
            if step.on_success in removed_ids:
                updates["on_success"] = resolve_redirect(step.on_success)
            if step.on_failure in removed_ids:
                updates["on_failure"] = resolve_redirect(step.on_failure)
            rewritten_steps.append(step.model_copy(update=updates) if updates else step)

        return plan.model_copy(update={"steps": rewritten_steps})

    def _normalize_recommendation_confirmation_gate(self, plan: PlanReview) -> PlanReview:
        steps = list(plan.steps or [])
        if not steps:
            return plan

        def normalize_tool(step: PlanStep) -> str:
            agent = str(getattr(step, "agent", "") or "").strip()
            tool_name = str(getattr(step, "tool_name", "") or "").strip()
            if tool_name.startswith("agent_"):
                return tool_name
            if tool_name and "." in tool_name:
                return tool_name
            if agent and not tool_name.startswith(f"{agent}."):
                return f"{agent}.{tool_name}" if tool_name else agent
            return tool_name

        def has_confirmation_inputs(step: PlanStep) -> bool:
            lowered = [str(item).strip().lower() for item in (step.required_inputs or []) if str(item).strip()]
            return any(
                "recommendation_settings_confirmation" in item
                or "confirm" in item
                or "no changes" in item
                for item in lowered
            )

        def next_gate_step_id(existing_steps: list[PlanStep]) -> str:
            used = {str(step.step_id) for step in existing_steps}
            counter = 1
            candidate = "recommendation_settings_confirmation"
            while candidate in used:
                counter += 1
                candidate = f"recommendation_settings_confirmation_{counter}"
            return candidate

        index = 0
        changed = False
        while index < len(steps):
            step = steps[index]
            if step.skill != "recommend_4d_stem_parameters" or normalize_tool(step) != "agent_suggestion.find_defocus":
                index += 1
                continue

            previous_step = steps[index - 1] if index > 0 else None
            previous_is_gate = (
                previous_step is not None
                and previous_step.skill == "recommend_4d_stem_parameters"
                and normalize_tool(previous_step) == "agent_suggestion.update_parameters"
            )
            if previous_is_gate and has_confirmation_inputs(previous_step):
                index += 1
                continue

            if previous_is_gate:
                updated_arguments = dict(previous_step.arguments or {})
                if "param_names" not in updated_arguments:
                    updated_arguments["param_names"] = []
                if "param_values" not in updated_arguments:
                    updated_arguments["param_values"] = []
                updated_required_inputs = list(previous_step.required_inputs or [])
                if "recommendation_settings_confirmation" not in updated_required_inputs:
                    updated_required_inputs.append("recommendation_settings_confirmation")
                if "confirm or no changes to accept settings; otherwise reply with specific parameter changes" not in updated_required_inputs:
                    updated_required_inputs.append(
                        "confirm or no changes to accept settings; otherwise reply with specific parameter changes"
                    )
                steps[index - 1] = previous_step.model_copy(
                    update={
                        "arguments": updated_arguments,
                        "required_inputs": updated_required_inputs,
                    }
                )
                changed = True
                index += 1
                continue

            gate_step_id = next_gate_step_id(steps)
            gate_step = PlanStep(
                step_id=gate_step_id,
                agent="agent_suggestion",
                goal="Pause for user review of the recommended Settings and apply any requested parameter changes before defocus selection.",
                skill="recommend_4d_stem_parameters",
                tool_name="update_parameters",
                arguments={"param_names": [], "param_values": []},
                required_inputs=[
                    "recommendation_settings_confirmation",
                    "confirm or no changes to accept settings; otherwise reply with specific parameter changes",
                ],
                expected_output=(
                    "The user confirms the recommended Settings or provides specific parameter changes "
                    "to apply before continuing."
                ),
                on_success=step.step_id,
                on_failure="ask_user",
            )

            if previous_step is not None and previous_step.on_success == step.step_id:
                steps[index - 1] = previous_step.model_copy(update={"on_success": gate_step_id})
            steps.insert(index, gate_step)
            changed = True
            index += 2

        if not changed:
            return plan
        return plan.model_copy(update={"steps": steps})

    def _has_unavailable_agent_issue(self, report: Any) -> bool:
        if report is None:
            return False
        for issue in list(getattr(report, "issues", []) or []):
            if getattr(issue, "severity", "") == "blocking" and getattr(issue, "category", "") == "agent":
                return True
        return False

    async def _preflight_required_agents(self, plan: PlanReview, callbacks: PlanningCallbacks) -> Optional[str]:
        required_agents = self._required_agents_for_plan(plan)
        if not required_agents:
            return None
        available_agents = await self._list_available_agents()
        if callbacks.on_trace:
            callbacks.on_trace(
                "Planner/Judge visible agents: "
                f"{', '.join(available_agents) if available_agents else 'none'}"
            )
        missing_agents = [agent for agent in required_agents if agent not in set(available_agents)]
        if not missing_agents:
            return None
        return self._format_missing_agents_message(missing_agents, available_agents, required_agents)

    def _required_agents_for_plan(self, plan: PlanReview) -> list[str]:
        playbooks_root = self._resolve_playbooks_dir()
        provider = FilesystemSkillProvider(playbooks_root)
        required: list[str] = []
        seen = set()
        planner_pseudo_agents = {"planner", "system", "orchestrator", "triage", "mainrouter", "maintriage"}
        for step in list(getattr(plan, "steps", []) or []):
            skill_id = str(getattr(step, "skill", "") or "").strip()
            skill_agents: list[str] = []
            if skill_id:
                try:
                    manifest = provider.get_skill_manifest(skill_id)
                    raw_agents = manifest.get("agents") or []
                    if isinstance(raw_agents, list):
                        skill_agents.extend(str(agent) for agent in raw_agents if str(agent).strip())
                    for tool_name in list(manifest.get("required_tools") or []):
                        if isinstance(tool_name, str) and "." in tool_name:
                            skill_agents.append(tool_name.split(".", 1)[0])
                except Exception:
                    pass
            step_agent = str(getattr(step, "agent", "") or "").strip()
            if step_agent and step_agent.lower() not in planner_pseudo_agents:
                skill_agents.append(step_agent)
            for agent in skill_agents:
                agent_name = str(agent or "").strip()
                if not agent_name or agent_name.lower() in planner_pseudo_agents:
                    continue
                if agent_name not in seen:
                    seen.add(agent_name)
                    required.append(agent_name)
        return required

    def _resolve_playbooks_dir(self) -> str:
        if self.bridge is not None and hasattr(self.bridge, "_resolve_playbooks_dir"):
            return self.bridge._resolve_playbooks_dir()
        package_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        return os.path.join(package_root, "skills", "playbooks")

    async def _list_available_agents(self) -> list[str]:
        if self.bridge is None:
            return []
        try:
            if hasattr(self.bridge, "refresh"):
                await self.bridge.refresh()
        except Exception:
            pass
        try:
            agents = await self.bridge.list_agents()
        except Exception:
            return []
        return sorted(str(agent) for agent in list(agents or []) if str(agent).strip())

    def _format_missing_agents_message(
        self,
        missing_agents: list[str],
        available_agents: list[str],
        required_agents: Optional[list[str]] = None,
    ) -> str:
        missing = ", ".join(missing_agents)
        available = ", ".join(available_agents) if available_agents else "none"
        required = ", ".join(required_agents or missing_agents)
        return (
            f"Required agent is not running: {missing}. "
            f"Agents required by this workflow: {required}. "
            f"Please start/register {missing}, reconnect/rebuild the agents if needed, and then ask again. "
            f"Currently visible agents: {available}."
        )

    def _judge_reason_brief(self, report: Any) -> str:
        if report is None:
            return "unknown reason"
        issues = list(getattr(report, "issues", []) or [])
        if issues:
            first = issues[0]
            category = str(getattr(first, "category", "issue"))
            message = str(getattr(first, "message", "")).strip()
            if message:
                return f"{category}: {message}"
            return category
        summary = str(getattr(report, "summary", "")).strip()
        return summary or "judge requested revision"

    def _format_judge_replan_prompt(self, original_message: str, plan: PlanReview, report: Any, attempt_index: int) -> str:
        issue_lines = []
        for issue in list(getattr(report, "issues", []) or [])[:12]:
            prefix = f"step {getattr(issue, 'step_id', 'plan')}" if getattr(issue, "step_id", None) else "plan"
            issue_lines.append(f"- {prefix}: {getattr(issue, 'category', 'issue')} - {getattr(issue, 'message', '')}")
        issue_block = "\n".join(issue_lines) if issue_lines else "- No detailed issues were provided."
        return (
            "The previous PlanReview failed deterministic contract validation and must be revised.\n"
            "You are the Planner. Return a revised PlanReview only. Do not execute.\n"
            "Revise the workflow so it remains grounded in registered skills and satisfies the skill contract order and MCP tool schema.\n"
            "Do not keep invalid step ordering or invalid parameters.\n"
            f"Auto-replan attempt: {attempt_index}\n\n"
            f"Original user message:\n{original_message}\n\n"
            f"Previous PlanReview:\n{plan.model_dump_json()}\n\n"
            f"Judge summary:\n{getattr(report, 'summary', '')}\n"
            f"Judge issues:\n{issue_block}"
        )

    def _compose_live_planning_status(self, base_label: str, items: list[str]) -> str:
        lines = [base_label]
        for item in items[-4:]:
            if item:
                lines.append(item)
        return "\n".join(lines)

    def _format_planner_discovery_entry(self, entry: Any) -> str:
        text = str(entry or "").strip()
        if text == "list_skills":
            return "Planner: listed skills"
        if text == "list_agents_capabilities":
            return "Planner: checked agent capabilities"
        if text.startswith("get_skill_manifest:"):
            return f"Planner: read manifest {text.split(':', 1)[1]}"
        if text.startswith("read_skill_content:"):
            return f"Planner: read skill {text.split(':', 1)[1]}"
        if text.startswith("list_skill_resources:"):
            return f"Planner: listed resources for {text.split(':', 1)[1]}"
        if text.startswith("read_skill_resource:"):
            _, rest = text.split(":", 1)
            return f"Planner: read resource {rest}"
        return f"Planner: {text}"

    async def _format_direct_planner_prompt(self, message: str) -> str:
        recent_messages = await self._format_recent_session_messages(limit=10)
        return (
            "The user provided a new requirement. You are the Planner.\n"
            "Read the relevant registered skills/playbooks and return a PlanReview for user approval.\n"
            "Do not execute tools except the planner discovery tools needed to read skills and validate capabilities.\n\n"
              "PlanReview schema constraints:\n"
              "- PlanStep.agent must be the specialist MCP agent from the selected skill's Required Tools, such as agent_sem or agent_ptychography. Never use planner, system, orchestrator, or triage as a PlanStep.agent.\n"
              "- Do not include planner discovery tools such as list_skills/read_skill_content/list_agents_capabilities as plan steps.\n"
              "- on_success must be another exact step_id or done. on_failure must be another exact step_id, stop, or ask_user. Do not use proceed/continue/next/escalate labels.\n\n"
              "Mandatory discovery sequence before output:\n"
              "- First call list_skills.\n"
              "- Then choose the relevant registered skill id from that result.\n"
              "- Then call get_skill_manifest for that skill id.\n"
              "- Then call read_skill_content for that skill id.\n"
              "- Only after those tool calls may you produce PlanReview.steps.\n"
              "- If list_skills returns empty or read_skill_content fails, return a PlanReview with no invented workflow steps is not allowed; instead report the discovery failure in risks/missing_inputs and do not invent agent/tool names.\n\n"
              "Context arbitration:\n"
              "- Treat the latest user message below as the authoritative planning goal.\n"
              "- Previous conversation may contain an approved plan, a blocked execution step, or missing-input request. Do not continue that prior step unless the latest user message explicitly answers that step, says continue/resume, or asks to execute/acquire/reconstruct now.\n"
              "- If the latest message asks to run ptychography on the selected/current dataset, expand it with the registered skill id `ptychography`. Do not invent per-step skill ids such as `ptychography_prepare_parameters`, `ptychography_append_exp_params`, `ptychography_save_params`, or `ptychography_start_server`.\n"
              "- If the latest message asks to use recommendations after a previous SEM/acquisition missing-input prompt listed recommendation inputs, preserve those listed handoff inputs exactly in the recommendation plan. For recommend_4d_stem_parameters, pass q-source/sample values such as use_manual_q, manual_q_1_per_A, and fov_A to load_q_spec when they are already resolved; for SEM-started recommendation runs, call check_required_constraints with from_sem=true so the tool reads SEM UI context for SEM-provided values such as max_ht_kV and fov_A, and also pass required constraints such as max_ht_kV, abbe_limit_A, ultimate_resolution_A, and max_dose_e_per_A2 when they were already resolved; pass current_pA to recalculate_defaults when it was listed or returned by sem_ui_context. Do not add pre-step user questions for SEM-provided values when the recommendation was started from SEM acquisition; first try the SEM UI/context path and only ask the user for a value if it remains unresolved after that attempt. After recalculate_defaults, the recommendation plan must include a paused settings-confirmation gate before find_defocus, represented as an agent_suggestion.update_parameters step with required_inputs asking for confirmation or specific setting changes.\n"
              "- If the latest user message asks a separate tool/skill task, create a fresh PlanReview from step_id 1 and choose skills only from that latest request.\n\n"
            f"Recent conversation messages, oldest to newest, excluding the current user message if not yet stored:\n{recent_messages}\n\n"
            f"Latest user message:\n{message}"
        )

    async def _format_recent_session_messages(self, limit: int = 10) -> str:
        session = getattr(self, "session", None)
        get_items = getattr(session, "get_items", None)
        if not callable(get_items):
            return "(unavailable)"
        try:
            items = get_items(limit=limit)
        except TypeError:
            try:
                items = get_items()
            except Exception:
                return "(unavailable)"
        except Exception:
            return "(unavailable)"
        if hasattr(items, "__await__"):
            try:
                items = await items
            except Exception:
                return "(unavailable)"
        if not isinstance(items, list):
            return "(unavailable)"
        recent = items[-limit:]
        lines = []
        for item in recent:
            line = self._format_session_item_for_planner(item)
            if line:
                lines.append(line)
        return "\n".join(lines) if lines else "(none)"

    def _format_session_item_for_planner(self, item: Any) -> str:
        if hasattr(item, "model_dump"):
            try:
                item = item.model_dump()
            except Exception:
                pass
        if not isinstance(item, dict):
            return self._truncate_planner_context(str(item), 700)
        role = str(item.get("role") or item.get("type") or item.get("name") or "item")
        content = item.get("content")
        text = self._session_content_to_text(content)
        if not text:
            text = str(item.get("text") or item.get("output") or item.get("message") or item.get("arguments") or "")
        if not text:
            return ""
        return self._truncate_planner_context(f"{role}: {text}", 700)

    def _session_content_to_text(self, content: Any) -> str:
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts = []
            for part in content:
                if isinstance(part, str):
                    parts.append(part)
                elif isinstance(part, dict):
                    value = part.get("text") or part.get("input_text") or part.get("output_text") or part.get("summary")
                    if value:
                        parts.append(str(value))
                else:
                    text = getattr(part, "text", None)
                    if text:
                        parts.append(str(text))
            return " ".join(parts)
        if content is None:
            return ""
        return str(content)

    def _truncate_planner_context(self, text: str, max_chars: int) -> str:
        compact = " ".join(str(text or "").split())
        if len(compact) <= max_chars:
            return compact
        return compact[: max_chars - 3] + "..."

    def _format_direct_planner_revise_prompt(self, message: str, plan: PlanReview) -> str:
        return (
            "The user sent a message while a PlanReview is pending.\n"
            "You are the Planner. Revise or reset the pending plan based on the latest user message.\n"
            "Return a new PlanReview only. Do not execute.\n\n"
              "Decision rules:\n"
              "- RESET: If the latest user message is a new goal, a new task, a separate question that needs tools/skills, or asks for something not clearly framed as an edit to the pending plan, ignore the pending plan as execution context and create a fresh PlanReview from step_id 1.\n"
              "- For ptychography requests against the selected/current dataset, the reset/revise result must use the registered skill id `ptychography`, not invented sub-skill ids.\n"
              "- REVISE: Only revise/continue the pending plan if the latest user message explicitly refers to that plan, says to change one of its steps/arguments, says continue/resume, or provides information requested by a pending step.\n"
            "- The previous plan is optional context only. Do not continue step numbering from it after RESET.\n\n"
            f"Latest user message:\n{message}\n\n"
            f"Pending PlanReview optional context:\n{plan.model_dump_json()}"
        )

    def _format_pending_plan_gate_prompt(self, message: str, plan: PlanReview) -> str:
        return (
            "Classify the user's latest reply about a pending plan.\n\n"
            f"Pending plan JSON:\n{plan.model_dump_json()}\n\n"
            f"Latest user message:\n{message}\n\n"
            "Return JSON only, for example:\n"
            '{"decision":"approve","rationale":"The user clearly authorized execution."}'
        )
