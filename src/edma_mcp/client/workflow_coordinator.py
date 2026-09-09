from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Callable, Optional

from agents import Agent, Runner

from edma_mcp.client.execution_coordinator import ApprovedPlanExecutionCoordinator, ExecutionCallbacks
from edma_mcp.client.planning_coordinator import (
    PendingPlanDecisionResult,
    PlanningCallbacks,
    PlanningCoordinator,
    PlanningRunResult,
)


@dataclass
class WorkflowRoutingResult:
    action: str
    planning_result: Optional[PlanningRunResult] = None
    message: str = ""


class WorkflowCoordinator:
    def __init__(self) -> None:
        self.planning = PlanningCoordinator()
        self.execution = ApprovedPlanExecutionCoordinator()

    def bind_runtime(self, triage_agent: Any, planner_agent: Any, session: Any, bridge: Any) -> None:
        self.planning.bind_runtime(triage_agent, planner_agent, session, bridge)
        self.execution.bind_runtime(triage_agent, session, bridge)

    def reset(self) -> None:
        self.planning.reset()
        self.execution.reset()

    def has_pending_plan(self) -> bool:
        return self.planning.has_pending_plan()

    def has_paused_execution(self) -> bool:
        return self.execution.has_paused_execution()

    def handle_tool_status(self, tool_status: Any) -> None:
        self.execution.handle_tool_status(tool_status)

    def should_intercept_trigger(self, tool_status: Any) -> bool:
        return self.execution.should_intercept_trigger(tool_status)

    async def handle_user_message(
        self,
        message: str,
        *,
        planning_callbacks: PlanningCallbacks,
        execution_callbacks: ExecutionCallbacks,
        trace_formatter: Callable[[Any], Optional[str]],
        plan_extractor: Callable[[Any], Any],
        handoff_status_extractor: Callable[[str], Optional[str]],
        execution_status_line_checker: Callable[[str], bool],
    ) -> WorkflowRoutingResult:
        route = await self._classify_message_route(message)

        if route == "resume_execution" and self.execution.has_paused_execution():
            message = self._normalize_paused_execution_answer(message)
            await self.execution.resume_execution(
                message,
                execution_callbacks,
                trace_formatter=trace_formatter,
                handoff_status_extractor=handoff_status_extractor,
                execution_status_line_checker=execution_status_line_checker,
            )
            return WorkflowRoutingResult(action="handled")

        if route == "approve_pending_plan" and self.planning.has_pending_plan():
            plan = self.planning.take_pending_plan()
            if plan is None:
                return WorkflowRoutingResult(action="message", message="No pending plan to approve.")
            await self.execution.execute_plan(
                plan,
                execution_callbacks,
                trace_formatter=trace_formatter,
                handoff_status_extractor=handoff_status_extractor,
                execution_status_line_checker=execution_status_line_checker,
            )
            return WorkflowRoutingResult(action="handled")

        if route == "revise_pending_plan" and self.planning.has_pending_plan():
            pending_result = await self.planning.handle_pending_plan_message(
                message,
                callbacks=planning_callbacks,
                trace_formatter=trace_formatter,
                plan_extractor=plan_extractor,
                is_approval_message=self._is_approval_message,
                should_arbitrate_pending_plan=self._should_arbitrate_pending_plan,
            )
            if pending_result.action == "approve":
                plan = pending_result.plan
                if plan is None:
                    return WorkflowRoutingResult(action="message", message="No pending plan to approve.")
                await self.execution.execute_plan(
                    plan,
                    execution_callbacks,
                    trace_formatter=trace_formatter,
                    handoff_status_extractor=handoff_status_extractor,
                    execution_status_line_checker=execution_status_line_checker,
                )
                return WorkflowRoutingResult(action="handled")
            if pending_result.action == "revise":
                return WorkflowRoutingResult(
                    action="plan",
                    planning_result=PlanningRunResult(
                        plan=pending_result.plan,
                        queued_for_approval=self.planning.has_pending_plan(),
                    ),
                )
            return WorkflowRoutingResult(action="message", message=pending_result.message)

        if route == "start_planning":
            planning_result = await self.planning.start_planning(
                message,
                callbacks=planning_callbacks,
                trace_formatter=trace_formatter,
                plan_extractor=plan_extractor,
            )
            if planning_result.error_message and planning_result.plan is None:
                return WorkflowRoutingResult(action="message", message=planning_result.error_message)
            return WorkflowRoutingResult(action="plan", planning_result=planning_result)

        return WorkflowRoutingResult(action="chat")

    async def _classify_message_route(self, message: str) -> str:
        try:
            route = await self._classify_message_route_async(message)
        except Exception:
            route = self._fallback_message_route(message)
        return self._coerce_route_for_current_state(route, message)

    async def _classify_message_route_async(self, message: str) -> str:
        router_agent = self._build_message_router_agent()
        prompt = await self._format_message_router_prompt(message)
        result = await Runner.run(starting_agent=router_agent, input=prompt)
        route = self._extract_message_route(getattr(result, "final_output", result))
        return route or self._fallback_message_route(message)

    def _build_message_router_agent(self):
        kwargs = {
            "name": "WorkflowMessageRouter",
            "instructions": (
                "You classify the latest user message for an instrument-control workflow UI.\n"
                "Return JSON only with keys route and rationale.\n"
                "route must be one of: resume_execution, approve_pending_plan, revise_pending_plan, start_planning, chat.\n"
                "Use the provided paused_execution, paused_reason, pending_plan, and recent messages as context. "
                "The phrase 'selected data' in a fresh request usually describes the currently selected dataset target; "
                "when the recent paused prompt asked the user to select/load data, the same phrase may instead be a confirmation. "
                "Actionable instrument requests such as showing, generating, visualizing, acquiring, recommending, reconstructing, "
                "or inspecting results are generally workflow requests when they are not simply answering an active prompt.\n"
                "Choose approve_pending_plan first when a pending plan exists and the user clearly approves that reviewed plan now, even if another execution is currently paused.\n"
                "Choose resume_execution when execution is paused and there is no pending plan approval taking priority, and the user appears to answer the current prompt, "
                "including a fix choice, a numeric value, a confirmation, or a short phrase like 'fix scan step'. "
                "General rule: when the active plan or paused execution asks the user to confirm something, provide missing inputs, choose an option, or change values, "
                "the user's confirmation, supplied value, selected option, or requested change is usually a continuation of the current plan rather than a new plan. "
                "Phrases such as 'apply fix ht', 'fix max ht', or likely typos such as 'fit ht' are fix choices "
                "and should route to resume_execution when execution is paused. If the user gives multiple fix choices "
                "in one message, such as 'fix alpha, then fix pitch, then fix_fov', route to resume_execution "
                "so the paused workflow can apply those fixes in order. "
                "If the paused prompt asked whether to keep or change recommendation settings, messages like "
                "'scan step use 1.5, current is 0.6 pA', 'alpha 7 mrad', 'dwell 2 ms', 'no changes', or "
                "'use recommended settings' are parameter replies and should route to resume_execution. "
                "If the paused prompt asked for missing ptychography/sample parameters, messages like "
                "'thickness is around 50A, use 5 slices', 'total_thickness=50, num_slices=5', or "
                "'use 5 slices' are parameter replies and should route to resume_execution. "
                "If the paused prompt asked the user to select or load a valid 4D-STEM dataset, messages like "
                "'data selected', 'dataset selected', 'selected', 'done', or 'loaded' may confirm that prompt "
                "and should usually route to resume_execution. "
                "If the paused prompt asked the user to confirm parameters or say what they want to change, "
                "and the user provides specific changed values, route to resume_execution rather than start_planning. "
                "This remains true even when the text contains technical keywords such as scan step, defocus, dose, "
                "material, formula, q-spec, thickness, slices, or ptychography.\n"
                "Choose approve_pending_plan only when a pending plan exists and the user clearly approves execution now.\n"
                "Choose revise_pending_plan only when a pending plan exists and the user asks to change that pending plan.\n"
                "Choose start_planning only for a clearly new workflow request, a request to recommend/acquire/plan from scratch, or a new constraint "
                "that is not an answer to the active plan's confirmation, missing-input request, option choice, or change request. "
                "Visualization requests such as showing iDPC/DPC, virtual detector images, HAADF/BF/ABF/ADF, ptychography results, "
                "or results for a job/slurm id are usually workflow requests when they are not answering an active paused prompt.\n"
                "Choose chat for ordinary questions, explanations, status questions, or unclear messages that do not need tools.\n"
                "Do not call tools. Do not include markdown."
            ),
        }
        model = getattr(self.planning.triage_agent, "model", None)
        if model is not None:
            kwargs["model"] = model
        model_settings = getattr(self.planning.triage_agent, "model_settings", None)
        if model_settings is not None:
            kwargs["model_settings"] = model_settings
        return Agent(**kwargs)

    async def _format_message_router_prompt(self, message: str) -> str:
        pending_plan = self.planning.get_pending_plan()
        pending_summary = ""
        if pending_plan is not None:
            pending_summary = str(getattr(pending_plan, "summary", "") or getattr(pending_plan, "goal", "") or "")[:1200]
        paused_reason = str(getattr(self.execution, "paused_execution_reason", "") or "")[:1200]
        paused_state = str(getattr(self.execution, "paused_execution_state", "") or "")[:1200]
        recent_messages = await self._format_recent_session_messages(limit=10)
        return (
            "Classify this user message for workflow routing.\n\n"
            f"paused_execution: {self.execution.has_paused_execution()}\n"
            f"paused_reason: {paused_reason}\n"
            f"paused_state: {paused_state}\n"
            f"pending_plan: {self.planning.has_pending_plan()}\n"
            f"pending_plan_summary: {pending_summary}\n\n"
            f"Recent conversation messages, oldest to newest, excluding the current user message if not yet stored:\n{recent_messages}\n\n"
            f"User message:\n{message}\n\n"
            "Return JSON only, for example: {\"route\":\"chat\",\"rationale\":\"brief reason\"}"
        )

    async def _format_recent_session_messages(self, limit: int = 10) -> str:
        session = getattr(self.planning, "session", None)
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
            line = self._format_session_item_for_router(item)
            if line:
                lines.append(line)
        return "\n".join(lines) if lines else "(none)"

    def _format_session_item_for_router(self, item: Any) -> str:
        if hasattr(item, "model_dump"):
            try:
                item = item.model_dump()
            except Exception:
                pass
        if not isinstance(item, dict):
            return self._truncate_router_text(str(item), 500)
        role = str(item.get("role") or item.get("type") or item.get("name") or "item")
        if role in {"function_call", "function_call_output"}:
            name = str(item.get("name") or item.get("call_id") or role)
            content = item.get("output") or item.get("arguments") or ""
            return self._truncate_router_text(f"{role} {name}: {content}", 500)
        content = item.get("content")
        text = self._session_content_to_text(content)
        if not text:
            text = str(item.get("text") or item.get("output") or item.get("message") or "")
        if not text:
            return ""
        return self._truncate_router_text(f"{role}: {text}", 500)

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

    def _truncate_router_text(self, text: str, max_chars: int) -> str:
        compact = " ".join(str(text or "").split())
        if len(compact) <= max_chars:
            return compact
        return compact[: max_chars - 3] + "..."

    def _extract_message_route(self, output: Any) -> Optional[str]:
        if hasattr(output, "model_dump"):
            output = output.model_dump()
        if isinstance(output, dict):
            route = str(output.get("route", "")).strip().lower()
            return route if route in self._valid_message_routes() else None
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
            route = str(data.get("route", "")).strip().lower()
            if route in self._valid_message_routes():
                return route
        lowered = text.lower()
        for route in self._valid_message_routes():
            if route in lowered:
                return route
        return None

    def _valid_message_routes(self) -> set[str]:
        return {
            "resume_execution",
            "approve_pending_plan",
            "revise_pending_plan",
            "start_planning",
            "chat",
        }

    def _coerce_route_for_current_state(self, route: str, message: str) -> str:
        if route == "resume_execution" and not self.execution.has_paused_execution():
            return self._fallback_message_route(message)
        if route in {"approve_pending_plan", "revise_pending_plan"} and not self.planning.has_pending_plan():
            return self._fallback_message_route(message)
        if self.planning.has_pending_plan() and self._is_approval_message(message):
            return "approve_pending_plan"
        if self.execution.has_paused_execution() and self._is_paused_execution_answer(message):
            return "resume_execution"
        if (
            route == "chat"
            and not self.planning.has_pending_plan()
            and not self.execution.has_paused_execution()
            and self._is_new_requirement_message(message)
        ):
            return "start_planning"
        return route if route in self._valid_message_routes() else self._fallback_message_route(message)

    def _fallback_message_route(self, message: str) -> str:
        if self.planning.has_pending_plan() and self._is_approval_message(message):
            return "approve_pending_plan"
        if self.execution.has_paused_execution() and (
            not self._is_new_requirement_message(message)
            or self._is_paused_execution_answer(message)
        ):
            return "resume_execution"
        if self.planning.has_pending_plan():
            return "revise_pending_plan" if self._should_arbitrate_pending_plan(message) else "chat"
        if self._is_new_requirement_message(message):
            return "start_planning"
        return "chat"

    def _normalize_plan_message(self, message: str) -> str:
        normalized = " ".join(str(message).strip().lower().split())
        normalized = re.sub(r"(?<=\d),(?=\d)", ".", normalized)
        return re.sub(r"[^0-9a-z\u4e00-\u9fff]+", " ", normalized).strip()

    def _is_approval_message(self, message: str) -> bool:
        normalized = self._normalize_plan_message(message)
        if not normalized:
            return False
        negative_phrases = {
            "dont",
            "do not",
            "not yet",
            "not now",
            "wait",
            "hold on",
            "hold off",
            "stop",
            "cancel",
        }
        if any(phrase in normalized for phrase in negative_phrases):
            return False
        approval_phrases = {
            "approve",
            "approved",
            "go",
            "run",
            "yes",
            "ok",
            "okay",
            "do it",
            "proceed",
            "start",
            "start it",
            "continue",
            "confirm",
            "execute",
            "execute it",
            "批准",
            "执行",
            "批准执行",
        }
        if normalized in approval_phrases:
            return True
        approval_patterns = (
            r"\bgo ahead\b",
            r"\bgo for it\b",
            r"\bapprove(?:d)?(?: (?:it|this|that|the plan|the workflow))?\b",
            r"\bproceed(?: with (?:it|this|that|the plan|the workflow))?\b",
            r"\brun (?:it|this|that|the plan|the workflow)\b",
            r"\bexecute(?: (?:it|this|that|the plan|the workflow))?\b",
            r"\bstart(?: (?:it|this|that|the plan|the workflow))?\b",
            r"\bcontinue(?: with (?:it|this|that|the plan|the workflow))?\b",
            r"\bconfirm(?: and (?:run|execute|start))?\b",
            r"\bdo it\b",
            r"批准(?:执行)?",
            r"执行",
        )
        return any(re.search(pattern, normalized) for pattern in approval_patterns)

    def _is_new_requirement_message(self, message: str) -> bool:
        normalized = " ".join(str(message).strip().lower().split())
        planning_keywords = {
            "plan",
            "plan again",
            "replan",
            "plan it again",
            "suggest",
            "recommend",
            "recommendation",
            "workflow",
            "acquire",
            "acquisition",
            "ptychography",
            "4d-stem",
            "defocus",
            "scan step",
            "dose",
            "sample thickness",
            "material",
            "material id",
            "mp-",
            "formula",
            "chemical formula",
            "element",
            "元素",
            "化学式",
            "材料",
            "新需求",
            "重新计划",
            "重新plan",
            "再计划",
            "建议",
            "推荐",
            "采集",
            "扫描",
            "\u65b0\u9700\u6c42",
            "\u91cd\u65b0\u8ba1\u5212",
            "\u91cd\u65b0plan",
            "\u518d\u8ba1\u5212",
            "\u5efa\u8bae",
            "\u63a8\u8350",
            "\u91c7\u96c6",
            "\u626b\u63cf",
        }
        return any(keyword in normalized for keyword in planning_keywords)

    def _is_paused_execution_answer(self, message: str) -> bool:
        normalized = self._normalize_plan_message(message)
        if not normalized:
            return False
        exact_fix_names = {
            "fix_ht",
            "fix_alpha",
            "lower_abbe",
            "fix_scan_step",
            "fix_step_alpha",
            "fix_step_ht",
            "fix_pitch",
            "lower_ultimate",
            "fix_fov",
            "fix_noise_current",
            "fix_noise_pitch",
            "fix_noise_dwell",
            "fix_dose_current",
            "fix_dose_step",
            "fix_dose_dwell",
            "fix_thickness_pitch",
            "fix_thickness_alpha",
            "fix_thickness_ht",
        }
        compact = normalized.replace(" ", "_")
        if compact in exact_fix_names:
            return True
        if len(self._extract_ordered_fix_choices(normalized)) >= 2:
            return True
        if self._is_paused_parameter_answer(normalized):
            return True
        fix_answer_patterns = (
            r"^(?:apply|use|choose|select|do|run)\s+fix\s+(?:max\s+)?ht$",
            r"^fit\s+(?:max\s+)?ht$",
            r"^fix\s+(?:scan\s+step|step)$",
            r"^fix\s+pitch$",
            r"^fix\s+alpha$",
            r"^fix\s+(?:max\s+)?ht$",
            r"^(?:apply|use|choose|select|do|run)\s+fix\s+(?:scan\s+step|step|pitch|alpha)$",
            r"^(?:apply|use|choose|select|do|run)\s+lower\s+(?:abbe|ultimate)$",
            r"^lower\s+(?:abbe|ultimate)$",
            r"^fix\s+n(?:\s+steps?)?$",
            r"^fix\s+fov$",
            r"^fix\s+(?:noise\s+)?(?:current|dwell)$",
            r"^fix\s+noise\s+pitch$",
            r"^fix\s+dose\s+(?:current|step|dwell)$",
            r"^fix\s+thickness\s+(?:pitch|alpha|ht)$",
        )
        return any(re.search(pattern, normalized) for pattern in fix_answer_patterns)

    def _normalize_paused_execution_answer(self, message: str) -> str:
        normalized = self._normalize_plan_message(message)
        mappings = {
            "fix scan step": "fix_scan_step",
            "fix step": "fix_scan_step",
            "apply fix scan step": "fix_scan_step",
            "apply fix step": "fix_scan_step",
            "use fix scan step": "fix_scan_step",
            "choose fix scan step": "fix_scan_step",
            "fix pitch": "fix_pitch",
            "apply fix pitch": "fix_pitch",
            "use fix pitch": "fix_pitch",
            "fix alpha": "fix_alpha",
            "apply fix alpha": "fix_alpha",
            "use fix alpha": "fix_alpha",
            "fix ht": "fix_ht",
            "fix max ht": "fix_ht",
            "apply fix ht": "fix_ht",
            "apply fix max ht": "fix_ht",
            "use fix ht": "fix_ht",
            "use fix max ht": "fix_ht",
            "choose fix ht": "fix_ht",
            "choose fix max ht": "fix_ht",
            "fit ht": "fix_ht",
            "fit max ht": "fix_ht",
            "lower abbe": "lower_abbe",
            "apply lower abbe": "lower_abbe",
            "use lower abbe": "lower_abbe",
            "lower ultimate": "lower_ultimate",
            "apply lower ultimate": "lower_ultimate",
            "use lower ultimate": "lower_ultimate",
            "fix n": "fix_fov",
            "fix n step": "fix_fov",
            "fix n steps": "fix_fov",
            "fix fov": "fix_fov",
            "apply fix fov": "fix_fov",
            "use fix fov": "fix_fov",
            "fix current": "fix_noise_current",
            "fix dwell": "fix_noise_dwell",
            "fix noise current": "fix_noise_current",
            "fix noise pitch": "fix_noise_pitch",
            "fix noise dwell": "fix_noise_dwell",
            "fix dose current": "fix_dose_current",
            "fix dose step": "fix_dose_step",
            "fix dose dwell": "fix_dose_dwell",
            "fix thickness pitch": "fix_thickness_pitch",
            "fix thickness alpha": "fix_thickness_alpha",
            "fix thickness ht": "fix_thickness_ht",
        }
        if normalized in mappings:
            return mappings[normalized]
        fix_choices = self._extract_ordered_fix_choices(normalized)
        if len(fix_choices) >= 2:
            return "apply fixes in order: " + ", ".join(fix_choices)
        compact = normalized.replace(" ", "_")
        if compact.startswith(("fix_", "lower_")):
            return compact
        return message

    def _is_paused_parameter_answer(self, normalized_message: str) -> bool:
        if normalized_message in {
            "no changes",
            "no change",
            "use recommended",
            "use recommended settings",
            "use defaults",
            "use them",
            "keep them",
            "keep these settings",
            "keep current values",
            "keep settings",
            "keep current settings",
        }:
            return True
        value_pattern = r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?"
        parameter_patterns = (
            rf"\bscan\s+step\b.*\b{value_pattern}\b",
            rf"\buse\b.*\b{value_pattern}\b.*\bas\s+(?:scan\s+)?step\b",
            rf"\bcurrent\b.*\b{value_pattern}\b",
            rf"\b(?:probe\s+)?current\b.*\b{value_pattern}\s*p\s*a\b",
            rf"\bdwell\b.*\b{value_pattern}\b",
            rf"\balpha\b.*\b{value_pattern}\b",
            rf"\bht\b.*\b{value_pattern}\b",
            rf"\bmax\s+ht\b.*\b{value_pattern}\b",
            rf"\bpitch\b.*\b{value_pattern}\b",
            rf"\bn\s+steps?\b.*\b{value_pattern}\b",
            rf"\bdefocus\b.*\b{value_pattern}\b",
            rf"\b(?:total\s+)?thickness\b.*\b{value_pattern}\b",
            rf"\b(?:num\s+)?slices?\b.*\b{value_pattern}\b",
            rf"\buse\b.*\b{value_pattern}\s+slices?\b",
            rf"\b{value_pattern}\s+slices?\b",
        )
        return any(re.search(pattern, normalized_message) for pattern in parameter_patterns)

    def _extract_ordered_fix_choices(self, normalized_message: str) -> list[str]:
        fix_patterns = (
            (r"\bfix\s+(?:max\s+)?ht\b", "fix_ht"),
            (r"\bfit\s+(?:max\s+)?ht\b", "fix_ht"),
            (r"\bfix\s+alpha\b", "fix_alpha"),
            (r"\blower\s+abbe\b", "lower_abbe"),
            (r"\bfix\s+scan\s+step\b", "fix_scan_step"),
            (r"\bfix\s+step\s+alpha\b", "fix_step_alpha"),
            (r"\bfix\s+step\s+ht\b", "fix_step_ht"),
            (r"\bfix\s+pitch\b", "fix_pitch"),
            (r"\blower\s+ultimate\b", "lower_ultimate"),
            (r"\bfix\s+n\s+steps?\b", "fix_fov"),
            (r"\bfix\s+fov\b", "fix_fov"),
            (r"\bfix\s+noise\s+current\b", "fix_noise_current"),
            (r"\bfix\s+noise\s+pitch\b", "fix_noise_pitch"),
            (r"\bfix\s+noise\s+dwell\b", "fix_noise_dwell"),
            (r"\bfix\s+dose\s+current\b", "fix_dose_current"),
            (r"\bfix\s+dose\s+step\b", "fix_dose_step"),
            (r"\bfix\s+dose\s+dwell\b", "fix_dose_dwell"),
            (r"\bfix\s+thickness\s+pitch\b", "fix_thickness_pitch"),
            (r"\bfix\s+thickness\s+alpha\b", "fix_thickness_alpha"),
            (r"\bfix\s+thickness\s+ht\b", "fix_thickness_ht"),
        )
        matches: list[tuple[int, str]] = []
        for pattern, fix_name in fix_patterns:
            for match in re.finditer(pattern, normalized_message):
                matches.append((match.start(), fix_name))
        matches.sort(key=lambda item: item[0])
        ordered: list[str] = []
        for _, fix_name in matches:
            if not ordered or ordered[-1] != fix_name:
                ordered.append(fix_name)
        return ordered

    def _should_arbitrate_pending_plan(self, message: str) -> bool:
        normalized = self._normalize_plan_message(message)
        if not normalized:
            return False
        revision_patterns = (
            r"\bchange\b",
            r"\bupdate\b",
            r"\brevise\b",
            r"\bmodify\b",
            r"\badjust\b",
            r"\breplan\b",
            r"\bplan again\b",
            r"\bnew plan\b",
            r"\binstead\b",
            r"\breplace\b",
            r"\bswitch\b",
            r"\bdifferent\b",
            r"\banother\b",
            r"\buse\b",
            r"\bmp[- ]?\d+\b",
            r"\bformula\b",
            r"\belement\b",
            r"\bchemical formula\b",
            r"\bmanual q\b",
            r"\bq spec\b",
            r"\bmake it\b",
            r"\bcan you\b",
            r"\bcould you\b",
            r"\bi want\b",
            r"\bi need\b",
            r"\bwhat if\b",
            r"\bwhy\b",
            r"\bhow\b",
            r"\?",
            r"重新",
            r"修改",
            r"调整",
            r"换成",
            r"元素",
            r"化学式",
            r"材料",
        )
        return self._is_new_requirement_message(message) or any(re.search(pattern, normalized) for pattern in revision_patterns)
