from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional

from agents import Runner
from openai.types.responses import ResponseTextDeltaEvent

from edma_mcp.client.models import PlanReview


@dataclass
class ExecutionCallbacks:
    on_status: Optional[Callable[[str], None]] = None
    on_trace: Optional[Callable[[str], None]] = None
    on_final: Optional[Callable[[str], None]] = None
    on_error: Optional[Callable[[str], None]] = None
    on_delete_tool_calling_message: Optional[Callable[[], None]] = None
    on_clear_trace_later: Optional[Callable[[], None]] = None


@dataclass
class ExecutionPlanFrame:
    plan: PlanReview
    pause_reason: str = ""
    pause_state: Optional[Dict[str, Any]] = None


class ApprovedPlanExecutionCoordinator:
    def __init__(self) -> None:
        self.agent = None
        self.session = None
        self.bridge = None
        self.active_callbacks: Optional[ExecutionCallbacks] = None
        self.pause_message_emitted: bool = False
        self.paused_execution_plan: Optional[PlanReview] = None
        self.paused_execution_reason: Optional[str] = None
        self.paused_execution_state: Optional[Dict[str, Any]] = None
        self.active_execution_plan: Optional[PlanReview] = None
        self.plan_stack: list[ExecutionPlanFrame] = []
        self.execution_in_progress: bool = False

    def bind_runtime(self, agent: Any, session: Any, bridge: Any = None) -> None:
        self.agent = agent
        self.session = session
        self.bridge = bridge

    def reset(self) -> None:
        self.paused_execution_plan = None
        self.paused_execution_reason = None
        self.paused_execution_state = None
        self.active_execution_plan = None
        self.plan_stack = []
        self.execution_in_progress = False
        self.active_callbacks = None
        self.pause_message_emitted = False

    def has_paused_execution(self) -> bool:
        return self.paused_execution_plan is not None

    def should_intercept_trigger(self, tool_status: Any) -> bool:
        return self.execution_in_progress and isinstance(tool_status, dict)

    def handle_tool_status(self, status: Any) -> None:
        if not isinstance(status, dict):
            return
        if not (self.execution_in_progress or self.paused_execution_plan):
            return
        if status.get("needs_user_input"):
            plan = self.active_execution_plan or self.paused_execution_plan
            if plan is not None:
                self.paused_execution_plan = plan
            self.paused_execution_state = {
                "tool_name": status.get("tool_name"),
                "status": status.get("status"),
                "message": status.get("message"),
                "error": status.get("error"),
                "required_inputs": list(status.get("required_inputs") or []),
            }
            self.paused_execution_reason = str(status.get("message") or status.get("error") or "")
            if not self.pause_message_emitted and self.active_callbacks and self.paused_execution_reason:
                if self.active_callbacks.on_final:
                    self.active_callbacks.on_final(self.paused_execution_reason)
                self.pause_message_emitted = True

    async def execute_plan(
        self,
        plan: PlanReview,
        callbacks: ExecutionCallbacks,
        trace_formatter: Callable[[Any], Optional[str]],
        handoff_status_extractor: Callable[[str], Optional[str]],
        execution_status_line_checker: Callable[[str], bool],
    ) -> None:
        started_as_child_plan = self._push_paused_plan_frame_if_needed(child_plan=plan)
        self.active_execution_plan = plan
        child_return_text = await self._run_execution(
            plan=plan,
            prompt=self._format_execution_prompt(plan, is_child_plan=started_as_child_plan),
            callbacks=callbacks,
            trace_formatter=trace_formatter,
            handoff_status_extractor=handoff_status_extractor,
            execution_status_line_checker=execution_status_line_checker,
            status_label="Triage executing approved plan...",
            emit_final=not started_as_child_plan,
        )
        if started_as_child_plan:
            await self._resume_parent_after_child_if_ready(
                child_plan=plan,
                child_return_text=child_return_text,
                callbacks=callbacks,
                trace_formatter=trace_formatter,
                handoff_status_extractor=handoff_status_extractor,
                execution_status_line_checker=execution_status_line_checker,
            )

    async def resume_execution(
        self,
        user_message: str,
        callbacks: ExecutionCallbacks,
        trace_formatter: Callable[[Any], Optional[str]],
        handoff_status_extractor: Callable[[str], Optional[str]],
        execution_status_line_checker: Callable[[str], bool],
    ) -> None:
        plan = self.paused_execution_plan
        if not plan:
            if callbacks.on_error:
                callbacks.on_error("No paused execution is waiting to resume.")
            return
        pause_state = dict(self.paused_execution_state or {})
        parsed_parameter_update = self._parse_recommendation_parameter_update(
            user_message,
            pause_reason=self.paused_execution_reason or "",
            pause_state=pause_state,
        )
        if pause_state.get("resume_type") == "child_return_confirmation":
            child_plan_goal = str(pause_state.get("child_plan_goal", "") or "")
            child_return_text = str(pause_state.get("child_return_text", "") or "")
            parent_pause_reason = str(pause_state.get("parent_pause_reason", "") or "")
            parent_pause_state = dict(pause_state.get("parent_pause_state") or {})
            if not self._is_confirmation_reply(user_message):
                if self._looks_like_parent_pause_answer(
                    user_message,
                    parent_pause_reason=parent_pause_reason,
                    parent_pause_state=parent_pause_state,
                ):
                    parsed_parent_update = self._parse_recommendation_parameter_update(
                        user_message,
                        pause_reason=parent_pause_reason,
                        pause_state=parent_pause_state,
                    )
                    direct_parent_update_result = await self._maybe_apply_recommendation_parameter_update(
                        parsed_parent_update,
                        callbacks=callbacks,
                    )
                    self.active_execution_plan = plan
                    self.paused_execution_reason = parent_pause_reason
                    self.paused_execution_state = parent_pause_state
                    parent_return_text = await self._run_execution(
                        plan=plan,
                        prompt=(
                            self._format_child_return_parameter_update_prompt(
                                parent_plan=plan,
                                child_plan_goal=child_plan_goal,
                                child_return_text=child_return_text,
                                parent_pause_reason=parent_pause_reason,
                                parent_pause_state=parent_pause_state,
                                user_message=user_message,
                                param_names=parsed_parent_update["param_names"],
                                param_values=parsed_parent_update["param_values"],
                                direct_tool_result=direct_parent_update_result,
                            )
                            if parsed_parent_update
                            else self._format_child_return_user_reply_prompt(
                                parent_plan=plan,
                                child_plan_goal=child_plan_goal,
                                child_return_text=child_return_text,
                                parent_pause_reason=parent_pause_reason,
                                parent_pause_state=parent_pause_state,
                                user_message=user_message,
                            )
                        ),
                        callbacks=callbacks,
                        trace_formatter=trace_formatter,
                        handoff_status_extractor=handoff_status_extractor,
                        execution_status_line_checker=execution_status_line_checker,
                        status_label="Triage resuming previous approved plan...",
                        emit_final=not self.plan_stack,
                    )
                    if self.plan_stack:
                        await self._resume_parent_after_child_if_ready(
                            child_plan=plan,
                            child_return_text=parent_return_text,
                            callbacks=callbacks,
                            trace_formatter=trace_formatter,
                            handoff_status_extractor=handoff_status_extractor,
                            execution_status_line_checker=execution_status_line_checker,
                        )
                    return
                if callbacks.on_final:
                    callbacks.on_final(self.paused_execution_reason or self._format_child_return_confirmation_message(""))
                return
            self.active_execution_plan = plan
            self.paused_execution_reason = parent_pause_reason
            self.paused_execution_state = parent_pause_state
            parent_return_text = await self._run_execution(
                plan=plan,
                prompt=self._format_child_return_resume_prompt(
                    parent_plan=plan,
                    child_plan_goal=child_plan_goal,
                    child_return_text=child_return_text,
                    parent_pause_reason=parent_pause_reason,
                    parent_pause_state=parent_pause_state,
                ),
                callbacks=callbacks,
                trace_formatter=trace_formatter,
                handoff_status_extractor=handoff_status_extractor,
                execution_status_line_checker=execution_status_line_checker,
                status_label="Triage resuming previous approved plan...",
                emit_final=not self.plan_stack,
            )
            if self.plan_stack:
                await self._resume_parent_after_child_if_ready(
                    child_plan=plan,
                    child_return_text=parent_return_text,
                    callbacks=callbacks,
                    trace_formatter=trace_formatter,
                    handoff_status_extractor=handoff_status_extractor,
                    execution_status_line_checker=execution_status_line_checker,
                )
            return
        direct_update_result = await self._maybe_apply_recommendation_parameter_update(
            parsed_parameter_update,
            callbacks=callbacks,
        )
        self.active_execution_plan = plan
        had_parent_frame = bool(self.plan_stack)
        child_return_text = await self._run_execution(
            plan=plan,
            prompt=(
                self._format_resume_parameter_update_prompt(
                    plan=plan,
                    user_message=user_message,
                    pause_reason=self.paused_execution_reason or "",
                    pause_state=pause_state,
                    param_names=parsed_parameter_update["param_names"],
                    param_values=parsed_parameter_update["param_values"],
                    direct_tool_result=direct_update_result,
                )
                if parsed_parameter_update
                else self._format_resume_execution_prompt(
                    plan,
                    user_message,
                    self.paused_execution_reason or "",
                    pause_state,
                )
            ),
            callbacks=callbacks,
            trace_formatter=trace_formatter,
            handoff_status_extractor=handoff_status_extractor,
            execution_status_line_checker=execution_status_line_checker,
            status_label="Triage resuming paused plan...",
            emit_final=not had_parent_frame,
        )
        if had_parent_frame:
            await self._resume_parent_after_child_if_ready(
                child_plan=plan,
                child_return_text=child_return_text,
                callbacks=callbacks,
                trace_formatter=trace_formatter,
                handoff_status_extractor=handoff_status_extractor,
                execution_status_line_checker=execution_status_line_checker,
            )

    async def _run_execution(
        self,
        plan: PlanReview,
        prompt: str,
        callbacks: ExecutionCallbacks,
        trace_formatter: Callable[[Any], Optional[str]],
        handoff_status_extractor: Callable[[str], Optional[str]],
        execution_status_line_checker: Callable[[str], bool],
        status_label: str,
        emit_final: bool = True,
    ) -> str:
        if self.agent is None or self.session is None:
            raise RuntimeError("Execution coordinator runtime is not bound to an agent and session.")

        if callbacks.on_status:
            callbacks.on_status(status_label)

        self.execution_in_progress = True
        self.active_callbacks = callbacks
        self.pause_message_emitted = False
        response = Runner.run_streamed(self.agent, prompt, session=self.session)
        bot_text = []
        try:
            async for event in response.stream_events():
                if event.type == "raw_response_event" and isinstance(event.data, ResponseTextDeltaEvent):
                    delta = event.data.delta
                    bot_text.append(delta)
                    candidate = "".join(bot_text)
                    handoff_status = handoff_status_extractor(candidate)
                    if handoff_status and callbacks.on_status:
                        callbacks.on_status(handoff_status)
                elif event.type == "agent_updated_stream_event":
                    if callbacks.on_trace:
                        callbacks.on_trace(f"Agent active: {event.new_agent.name}")
                elif event.type == "run_item_stream_event":
                    trace_message = trace_formatter(event)
                    if trace_message and callbacks.on_trace:
                        callbacks.on_trace(trace_message)
        except Exception as exc:
            if callbacks.on_delete_tool_calling_message:
                callbacks.on_delete_tool_calling_message()
            self.execution_in_progress = False
            if self.plan_stack:
                self.paused_execution_plan = plan
                self.paused_execution_reason = f"Plan execution failed: {exc}"
                self.paused_execution_state = {
                    "status": "failed",
                    "message": self.paused_execution_reason,
                }
            self.active_execution_plan = None
            if callbacks.on_error:
                callbacks.on_error(f"Plan execution failed: {exc}")
            if callbacks.on_clear_trace_later:
                callbacks.on_clear_trace_later()
            return ""
        finally:
            self.execution_in_progress = False
            self.active_callbacks = None

        if callbacks.on_delete_tool_calling_message:
            callbacks.on_delete_tool_calling_message()
        final_text = self._strip_execution_status_text("".join(bot_text), execution_status_line_checker).strip()
        self._handle_completion(plan, final_text)
        if self.paused_execution_plan is plan and self.paused_execution_reason and not self.pause_message_emitted:
            if callbacks.on_final:
                callbacks.on_final(self.paused_execution_reason)
            self.pause_message_emitted = True
        self.active_execution_plan = None
        if emit_final and final_text and callbacks.on_final and not self.pause_message_emitted:
            callbacks.on_final(final_text)
        if emit_final and callbacks.on_clear_trace_later:
            callbacks.on_clear_trace_later()
        return final_text

    def _push_paused_plan_frame_if_needed(self, *, child_plan: PlanReview) -> bool:
        parent_plan = self.paused_execution_plan
        if parent_plan is None or parent_plan is child_plan:
            self.paused_execution_plan = None
            self.paused_execution_reason = None
            self.paused_execution_state = None
            return False
        self.plan_stack.append(
            ExecutionPlanFrame(
                plan=parent_plan,
                pause_reason=self.paused_execution_reason or "",
                pause_state=dict(self.paused_execution_state or {}),
            )
        )
        self.paused_execution_plan = None
        self.paused_execution_reason = None
        self.paused_execution_state = None
        return True

    async def _resume_parent_after_child_if_ready(
        self,
        *,
        child_plan: PlanReview,
        child_return_text: str,
        callbacks: ExecutionCallbacks,
        trace_formatter: Callable[[Any], Optional[str]],
        handoff_status_extractor: Callable[[str], Optional[str]],
        execution_status_line_checker: Callable[[str], bool],
    ) -> None:
        if not self.plan_stack:
            if callbacks.on_clear_trace_later:
                callbacks.on_clear_trace_later()
            return
        if self.paused_execution_plan is child_plan:
            return
        if self._looks_like_missing_input_pause(child_return_text):
            self.paused_execution_plan = child_plan
            self.paused_execution_reason = child_return_text
            if self.paused_execution_state is None:
                self.paused_execution_state = {
                    "status": "blocked",
                    "message": child_return_text,
                }
            if callbacks.on_final:
                callbacks.on_final(child_return_text)
            if callbacks.on_clear_trace_later:
                callbacks.on_clear_trace_later()
            return
        if self.paused_execution_plan is not None:
            return
        frame = self.plan_stack.pop()
        self.paused_execution_plan = frame.plan
        self.paused_execution_reason = self._format_child_return_confirmation_message(child_return_text)
        self.paused_execution_state = {
            "resume_type": "child_return_confirmation",
            "message": self.paused_execution_reason,
            "required_inputs": ["confirm_resume_previous_workflow"],
            "child_plan_goal": str(getattr(child_plan, "goal", "") or ""),
            "child_return_text": child_return_text,
            "parent_pause_reason": frame.pause_reason,
            "parent_pause_state": dict(frame.pause_state or {}),
        }
        if callbacks.on_final:
            callbacks.on_final(self.paused_execution_reason)
        if callbacks.on_clear_trace_later:
            callbacks.on_clear_trace_later()

    def _handle_completion(self, plan: PlanReview, final_text: str) -> None:
        if self.paused_execution_state and self.paused_execution_plan is plan:
            return
        if self._looks_like_missing_input_pause(final_text):
            self.paused_execution_plan = plan
            self.paused_execution_reason = final_text
            return
        self.paused_execution_plan = None
        self.paused_execution_reason = None
        self.paused_execution_state = None

    def _strip_execution_status_text(self, text: str, execution_status_line_checker: Callable[[str], bool]) -> str:
        cleaned = []
        for line in str(text).splitlines():
            if execution_status_line_checker(line):
                continue
            cleaned.append(line)
        return "\n".join(cleaned)

    def _looks_like_missing_input_pause(self, text: str) -> bool:
        normalized = " ".join(str(text or "").split()).lower()
        pause_patterns = (
            r"\bplease provide\b",
            r"\bneeds? (?:one |a )?missing input\b",
            r"\bmissing input\b",
            r"\brequired input\b",
            r"\bbefore continuing\b",
            r"\bi.ll continue\b",
            r"\bcontinue from the\b",
            r"\ballowed fix choices?\b",
            r"\ballowed fix choice\b",
            r"\bwhich fix\b",
            r"\bfix name\b",
            r"\breply with\b.*\bfix[_\s]",
            r"\bchoose (?:a |the )?fix\b",
            r"\bplease confirm\b",
            r"\breply [`'\"]?confirm[`'\"]? to proceed\b",
            r"\breply with [`'\"]?confirm[`'\"]?\b",
            r"\breply\b.*\bconfirm\b",
            r"\brecommended settings are acceptable\b",
            r"\bsettings are acceptable\b",
            r"\bconfirm (?:the )?recommended settings\b",
            r"\bdo you want to (?:change|modify|adjust)\b.*\bsettings\b",
            r"\breply with\b.*\bno changes\b",
            r"\breply\b.*\bno changes\b",
            r"\bspecific setting changes\b",
            r"\bspecific parameter changes\b",
            r"\bcurrent recommended settings\b",
            r"\bcurrent recommendation settings\b",
            r"\bscan step\b.*\bmaximum recommended\b",
        )
        return any(re.search(pattern, normalized) for pattern in pause_patterns)

    def _is_confirmation_reply(self, text: str) -> bool:
        normalized = " ".join(str(text or "").strip().lower().split())
        if not normalized:
            return False
        if normalized in {"confirm", "confirmed", "yes", "ok", "okay", "go", "run", "resume", "continue"}:
            return True
        patterns = (
            r"\bgo ahead\b",
            r"\bproceed\b",
            r"\bresume\b",
            r"\bcontinue\b",
            r"\bconfirm(?:ed)?\b",
        )
        return any(re.search(pattern, normalized) for pattern in patterns)

    def _looks_like_parent_pause_answer(
        self,
        text: str,
        *,
        parent_pause_reason: str,
        parent_pause_state: Dict[str, Any],
    ) -> bool:
        normalized = " ".join(str(text or "").strip().lower().split())
        if not normalized:
            return False
        if self._is_confirmation_reply(normalized):
            return True

        compact = re.sub(r"[^0-9a-z\u4e00-\u9fff]+", " ", normalized).strip()
        if compact in {
            "no changes",
            "no change",
            "use recommended",
            "use recommended settings",
            "use defaults",
            "keep settings",
            "keep current settings",
        }:
            return True

        pause_context = " ".join(
            [
                str(parent_pause_reason or "").lower(),
                json.dumps(parent_pause_state or {}, ensure_ascii=False).lower(),
            ]
        )
        value_pattern = r"[-+]?(?:\d+(?:[.,]\d*)?|\.\d+)(?:e[-+]?\d+)?"
        parameter_patterns = (
            rf"\bscan\s+step\b.*\b{value_pattern}\b",
            rf"\bcurrent\b.*\b{value_pattern}\b",
            rf"\bdwell\b.*\b{value_pattern}\b",
            rf"\balpha\b.*\b{value_pattern}\b",
            rf"\bht\b.*\b{value_pattern}\b",
            rf"\bpitch\b.*\b{value_pattern}\b",
            rf"\bn\s+steps?\b.*\b{value_pattern}\b",
            rf"\bdefocus\b.*\b{value_pattern}\b",
        )
        if any(re.search(pattern, normalized) for pattern in parameter_patterns):
            return True

        if (
            ("specific parameter changes" in pause_context or "specific setting changes" in pause_context)
            and re.search(value_pattern, normalized)
            and re.search(r"\b(change|set|use|make|update|adjust)\b", normalized)
        ):
            return True
        return False

    def _format_child_return_confirmation_message(self, child_return_text: str) -> str:
        child_summary = str(child_return_text or "").strip()
        if len(child_summary) > 1200:
            child_summary = child_summary[:1197] + "..."
        if child_summary:
            child_summary = f"\n\nReturned result:\n{child_summary}\n"
        return (
            "The child workflow finished and is ready to hand control back to the earlier paused workflow."
            f"{child_summary}\nPlease review this result and reply `confirm` when you want me to continue the unfinished workflow."
        )

    def _format_execution_prompt(self, plan: PlanReview, *, is_child_plan: bool = False) -> str:
        child_context = ""
        if is_child_plan and self.plan_stack:
            frame = self.plan_stack[-1]
            child_context = (
                "This approved plan is a child workflow started while another approved plan was paused.\n"
                "Complete this child workflow only. At the end, return the values needed by the parent workflow "
                "in plain text with clear field names. Do not attempt to execute the parent workflow yourself.\n\n"
                f"Parent pause reason:\n{frame.pause_reason}\n\n"
                f"Parent paused tool status:\n{json.dumps(frame.pause_state or {}, ensure_ascii=False)}\n\n"
            )
        return (
            "The user approved this PlanReview. You are Triage. Execute it now by specialist handoffs.\n"
            "Do not call create_workflow_plan. Do not re-plan.\n"
            "Read the PlanReview steps in order. For each current step, hand off to step.agent and include "
            "the exact step_id, tool_name, arguments, required_inputs, expected_output, on_success, and on_failure.\n"
            "A handoff is not a completed step. After handing off, wait for the specialist to run the requested tool "
            "and return a concrete result/status. Never tell the user you merely handed off a step or that you are "
            "waiting on a handoff result; either continue to the next step after the tool result, ask for required "
            "input, report the exact tool failure, or provide the final workflow result.\n"
            "Do not narrate internal execution progress to the user. Do not write lines like "
            "'Executing step', 'Proceeding to step', 'Step succeeded', 'I handed off', or step metadata. "
            "Do not print the JSON step packet or handoff arguments in the final user-facing response. "
            "Only ask for required user input, report a real failure with the exact tool error, or give the final outcome.\n"
            "If the current step has required_inputs, ask the user only for those inputs and stop before calling tools for that step.\n"
            "If a step succeeds, continue to its on_success step. If it fails, follow on_failure.\n"
            "Never say you lack SEM/control access when the relevant specialist handoff/tool is available.\n\n"
            f"{child_context}"
            f"{plan.model_dump_json()}"
        )

    def _format_resume_execution_prompt(
        self,
        plan: PlanReview,
        user_message: str,
        pause_reason: str,
        pause_state: Dict[str, Any],
    ) -> str:
        return (
            "The user is replying to a paused approved PlanReview execution.\n"
            "You are Triage. Resume the same approved plan now by specialist handoffs.\n"
            "Do not call create_workflow_plan. Do not re-plan.\n"
            "The previous execution paused because a specialist asked for a missing input.\n"
            "Use the latest user reply below as the answer to that missing-input request, then continue the same approved workflow.\n"
            "After the blocked step succeeds, continue to the next specialist step via on_success.\n"
            "A handoff is not a completed step. After handing off, wait for the specialist to run the requested tool "
            "and return a concrete result/status. Never tell the user you merely handed off a step or that you are "
            "waiting on a handoff result.\n"
            "Do not narrate internal execution progress to the user. Do not write lines like "
            "'Executing step', 'Proceeding to step', 'Step succeeded', 'I handed off', or step metadata. "
            "Do not print the JSON step packet or handoff arguments in the final user-facing response. "
            "Only ask for required user input, report a real failure with the exact tool error, or give the final outcome.\n"
            "Never stop at the current specialist if the next agent/tool is available.\n\n"
            f"Structured paused tool status:\n{json.dumps(pause_state, ensure_ascii=False)}\n\n"
            f"Paused execution reason:\n{pause_reason}\n\n"
            f"Latest user reply:\n{user_message}\n\n"
            f"{plan.model_dump_json()}"
        )

    def _format_child_return_resume_prompt(
        self,
        *,
        parent_plan: PlanReview,
        child_plan_goal: str,
        child_return_text: str,
        parent_pause_reason: str,
        parent_pause_state: Dict[str, Any],
    ) -> str:
        return (
            "A child workflow has completed while an earlier approved PlanReview was paused.\n"
            "You are Triage. Resume the earlier approved parent plan now by specialist handoffs.\n"
            "Do not call create_workflow_plan. Do not re-plan.\n"
            "Use the child workflow result as the answer or returned payload for the parent plan's paused step. "
            "If the returned payload includes values such as defocus_A, dwell_time, scan_step_x_A, scan_step_y_A, "
            "scan_points_x, or scan_points_y, pass them to the parent acquisition step when applicable.\n"
            "After the blocked parent step succeeds, continue to the next specialist step via on_success.\n"
            "A handoff is not a completed step. After handing off, wait for the specialist to run the requested tool "
            "and return a concrete result/status. Never tell the user you merely handed off a step or that you are "
            "waiting on a handoff result.\n"
            "Do not narrate internal execution progress to the user. Do not write lines like "
            "'Executing step', 'Proceeding to step', 'Step succeeded', 'I handed off', or step metadata. "
            "Do not print the JSON step packet or handoff arguments in the final user-facing response. "
            "Only ask for required user input, report a real failure with the exact tool error, or give the final outcome.\n"
            "Never stop at the current specialist if the next agent/tool is available.\n\n"
            f"Parent paused tool status:\n{json.dumps(parent_pause_state, ensure_ascii=False)}\n\n"
            f"Parent pause reason:\n{parent_pause_reason}\n\n"
            f"Completed child workflow goal:\n{child_plan_goal}\n\n"
            f"Child workflow returned:\n{child_return_text}\n\n"
            f"{parent_plan.model_dump_json()}"
        )

    def _format_child_return_user_reply_prompt(
        self,
        *,
        parent_plan: PlanReview,
        child_plan_goal: str,
        child_return_text: str,
        parent_pause_reason: str,
        parent_pause_state: Dict[str, Any],
        user_message: str,
    ) -> str:
        return (
            "A child workflow has completed while an earlier approved PlanReview was paused.\n"
            "You are Triage. Resume the earlier approved parent plan now by specialist handoffs.\n"
            "Do not call create_workflow_plan. Do not re-plan.\n"
            "Use the child workflow result as the returned payload for the parent plan's paused step.\n"
            "The latest user reply below is not merely confirmation; treat it as the user's direct answer "
            "to the parent plan's paused input gate and continue the same approved workflow.\n"
            "If the returned payload includes values such as defocus_A, dwell_time, scan_step_x_A, scan_step_y_A, "
            "scan_points_x, or scan_points_y, pass them to the parent acquisition step when applicable.\n"
            "After the blocked parent step succeeds, continue to the next specialist step via on_success.\n"
            "A handoff is not a completed step. After handing off, wait for the specialist to run the requested tool "
            "and return a concrete result/status. Never tell the user you merely handed off a step or that you are "
            "waiting on a handoff result.\n"
            "Do not narrate internal execution progress to the user. Do not write lines like "
            "'Executing step', 'Proceeding to step', 'Step succeeded', 'I handed off', or step metadata. "
            "Do not print the JSON step packet or handoff arguments in the final user-facing response. "
            "Only ask for required user input, report a real failure with the exact tool error, or give the final outcome.\n"
            "Never stop at the current specialist if the next agent/tool is available.\n\n"
            f"Parent paused tool status:\n{json.dumps(parent_pause_state, ensure_ascii=False)}\n\n"
            f"Parent pause reason:\n{parent_pause_reason}\n\n"
            f"Completed child workflow goal:\n{child_plan_goal}\n\n"
            f"Child workflow returned:\n{child_return_text}\n\n"
            f"Latest user reply:\n{user_message}\n\n"
            f"{parent_plan.model_dump_json()}"
        )

    def _format_resume_parameter_update_prompt(
        self,
        *,
        plan: PlanReview,
        user_message: str,
        pause_reason: str,
        pause_state: Dict[str, Any],
        param_names: list[str],
        param_values: list[Any],
        direct_tool_result: Optional[str],
    ) -> str:
        if direct_tool_result:
            direct_status = (
                "The update_parameters tool has already been called directly and succeeded. "
                "Do not call agent_suggestion.update_parameters again. Continue the approved plan from that step's on_success target.\n"
            )
            tool_result_block = f"Direct tool result:\n{direct_tool_result}\n\n"
        else:
            direct_status = (
                "Call agent_suggestion.update_parameters exactly once using the exact param_names and param_values below.\n"
            )
            tool_result_block = ""
        return (
            "The user is replying to a paused approved PlanReview execution.\n"
            "You are Triage. Resume the same approved plan now by specialist handoffs.\n"
            "Do not call create_workflow_plan. Do not re-plan.\n"
            "The paused step is an editable recommendation settings gate for agent_suggestion.update_parameters.\n"
            "The user's latest reply has already been parsed deterministically into exact tool arguments.\n"
            f"{direct_status}"
            "Do not ask the user to restate the value. Do not reinterpret the field. "
            "Do not hand off this settings edit to agent_sem or any non-suggestion agent. "
            "Do not wait at the gate after that call.\n"
            "After the update_parameters step succeeds, continue the approved workflow via on_success.\n"
            "A handoff is not a completed step. After handing off, wait for the specialist to run the requested tool "
            "and return a concrete result/status. Never tell the user you merely handed off a step or that you are "
            "waiting on a handoff result.\n"
            "Do not narrate internal execution progress to the user. Do not print step JSON in the user-facing response.\n\n"
            f"Structured paused tool status:\n{json.dumps(pause_state, ensure_ascii=False)}\n\n"
            f"Paused execution reason:\n{pause_reason}\n\n"
            f"Latest user reply:\n{user_message}\n\n"
            f"{tool_result_block}"
            f"Use these exact tool arguments now:\n"
            f"param_names={json.dumps(param_names, ensure_ascii=False)}\n"
            f"param_values={json.dumps(param_values, ensure_ascii=False)}\n\n"
            f"{plan.model_dump_json()}"
        )

    def _format_child_return_parameter_update_prompt(
        self,
        *,
        parent_plan: PlanReview,
        child_plan_goal: str,
        child_return_text: str,
        parent_pause_reason: str,
        parent_pause_state: Dict[str, Any],
        user_message: str,
        param_names: list[str],
        param_values: list[Any],
        direct_tool_result: Optional[str],
    ) -> str:
        if direct_tool_result:
            direct_status = (
                "The update_parameters tool has already been called directly and succeeded. "
                "Do not call agent_suggestion.update_parameters again. Continue the parent plan from that step's on_success target.\n"
            )
            tool_result_block = f"Direct tool result:\n{direct_tool_result}\n\n"
        else:
            direct_status = (
                "Call agent_suggestion.update_parameters exactly once using the exact param_names and param_values below.\n"
            )
            tool_result_block = ""
        return (
            "A child workflow has completed while an earlier approved PlanReview was paused.\n"
            "You are Triage. Resume the earlier approved parent plan now by specialist handoffs.\n"
            "Do not call create_workflow_plan. Do not re-plan.\n"
            "Use the child workflow result as the returned payload for the parent plan's paused step.\n"
            "The parent pause is an editable recommendation settings gate for agent_suggestion.update_parameters.\n"
            "The latest user reply has already been parsed deterministically into exact tool arguments.\n"
            f"{direct_status}"
            "Do not ask the user to restate the value. Do not reinterpret the field. "
            "Do not hand off this settings edit to agent_sem or any non-suggestion agent. "
            "After that call succeeds, continue via on_success.\n"
            "A handoff is not a completed step. After handing off, wait for the specialist to run the requested tool "
            "and return a concrete result/status. Never tell the user you merely handed off a step or that you are "
            "waiting on a handoff result.\n"
            "Do not narrate internal execution progress to the user. Do not print step JSON in the user-facing response.\n\n"
            f"Parent paused tool status:\n{json.dumps(parent_pause_state, ensure_ascii=False)}\n\n"
            f"Parent pause reason:\n{parent_pause_reason}\n\n"
            f"Completed child workflow goal:\n{child_plan_goal}\n\n"
            f"Child workflow returned:\n{child_return_text}\n\n"
            f"Latest user reply:\n{user_message}\n\n"
            f"{tool_result_block}"
            f"Use these exact tool arguments now:\n"
            f"param_names={json.dumps(param_names, ensure_ascii=False)}\n"
            f"param_values={json.dumps(param_values, ensure_ascii=False)}\n\n"
            f"{parent_plan.model_dump_json()}"
        )

    async def _maybe_apply_recommendation_parameter_update(
        self,
        parsed_update: Optional[Dict[str, Any]],
        *,
        callbacks: ExecutionCallbacks,
    ) -> Optional[str]:
        if not parsed_update or self.bridge is None:
            return None
        try:
            raw_result = await self.bridge.call_tool(
                "agent_suggestion",
                "update_parameters",
                {
                    "param_names": list(parsed_update.get("param_names") or []),
                    "param_values": list(parsed_update.get("param_values") or []),
                },
            )
            result_text = self._stringify_direct_tool_result(raw_result)
            if callbacks.on_status:
                callbacks.on_status("Applied recommendation setting change...")
            return result_text
        except Exception as exc:
            if callbacks.on_trace:
                callbacks.on_trace(f"Direct recommendation update fallback: {exc}")
            return None

    def _stringify_direct_tool_result(self, raw_result: Any) -> str:
        if raw_result is None:
            return ""
        if isinstance(raw_result, str):
            return raw_result
        if hasattr(raw_result, "model_dump_json"):
            try:
                return raw_result.model_dump_json()
            except Exception:
                pass
        if hasattr(raw_result, "model_dump"):
            try:
                return json.dumps(raw_result.model_dump(), ensure_ascii=False)
            except Exception:
                pass
        try:
            return json.dumps(raw_result, ensure_ascii=False)
        except Exception:
            return str(raw_result)

    def _parse_recommendation_parameter_update(
        self,
        text: str,
        *,
        pause_reason: str,
        pause_state: Dict[str, Any],
    ) -> Optional[Dict[str, Any]]:
        if str(pause_state.get("tool_name") or "").strip() != "agent_suggestion.update_parameters":
            return None

        normalized = " ".join(str(text or "").strip().lower().split())
        if not normalized:
            return None

        if normalized in {
            "confirm",
            "confirmed",
            "no changes",
            "no change",
            "use recommended",
            "use recommended settings",
            "use defaults",
            "keep settings",
            "keep current settings",
        }:
            return {"param_names": [], "param_values": []}

        pause_context = " ".join(
            [
                str(pause_reason or "").lower(),
                json.dumps(pause_state or {}, ensure_ascii=False).lower(),
            ]
        )
        if "specific parameter changes" not in pause_context and "specific changes" not in pause_context:
            return None

        alias_map = {
            "ht_kV": (r"\bht\b", r"\bht_?kv\b", r"\baccelerat(?:e|ing)\s+voltage\b"),
            "alpha_mrad": (r"\balpha\b", r"\bconvergence\s+angle\b"),
            "scan_step_A": (r"\bscan[_\s-]*step(?:[_\s-]*a)?\b", r"\bstep\s*size\b", r"\bstepsize\b"),
            "detector_pitch_mrad": (r"\bdetector[_\s-]*pitch\b", r"\bpitch\b"),
            "n_steps": (r"\bn[_\s-]*steps?\b", r"\bnumber\s+of\s+steps\b", r"\b#\s*steps\b"),
            "current_pA": (r"\bcurrent\b", r"\bprobe\s+current\b"),
            "dwell_ms": (r"\bdwell\b", r"\bdwell\s+time\b"),
            "defocus_A": (r"\bdefocus\b",),
        }
        value_pattern = r"([-+]?(?:\d+(?:[.,]\d*)?|\.\d+)(?:e[-+]?\d+)?)"

        matches: list[tuple[int, str, float]] = []
        for canonical_name, aliases in alias_map.items():
            for alias in aliases:
                patterns = (
                    rf"{alias}[^\d+-]*{value_pattern}",
                    rf"{alias}.*?\b(?:to|=|as|is)\b[^\d+-]*{value_pattern}",
                    rf"{value_pattern}[^\w]*(?:a|å|angstrom|angstrom)?[^\w]*{alias}",
                )
                for pattern in patterns:
                    match = re.search(pattern, normalized)
                    if not match:
                        continue
                    parsed_value = self._parse_float(match.group(1))
                    if parsed_value is None:
                        continue
                    matches.append((match.start(), canonical_name, parsed_value))
                    break

        if not matches:
            single_value = self._parse_single_numeric_value(normalized)
            if single_value is not None:
                if re.search(r"\b(scan[_\s-]*step|step\s*size|stepsize)\b", normalized):
                    matches.append((0, "scan_step_A", single_value))
                elif re.search(r"\bdwell\b", normalized):
                    matches.append((0, "dwell_ms", single_value))
                elif re.search(r"\bcurrent\b", normalized):
                    matches.append((0, "current_pA", single_value))
                elif re.search(r"\balpha\b", normalized):
                    matches.append((0, "alpha_mrad", single_value))
                elif re.search(r"\bht\b", normalized):
                    matches.append((0, "ht_kV", single_value))
                elif re.search(r"\bpitch\b", normalized):
                    matches.append((0, "detector_pitch_mrad", single_value))
                elif re.search(r"\bdefocus\b", normalized):
                    matches.append((0, "defocus_A", single_value))
                elif re.search(r"\bn[_\s-]*steps?\b|\b#\s*steps\b", normalized):
                    matches.append((0, "n_steps", round(single_value)))

        if not matches:
            return None

        ordered_updates: list[tuple[str, Any]] = []
        seen: set[str] = set()
        for _, canonical_name, parsed_value in sorted(matches, key=lambda item: item[0]):
            if canonical_name in seen:
                continue
            seen.add(canonical_name)
            if canonical_name == "n_steps":
                parsed_value = int(round(parsed_value))
            ordered_updates.append((canonical_name, parsed_value))

        if not ordered_updates:
            return None
        return {
            "param_names": [name for name, _ in ordered_updates],
            "param_values": [value for _, value in ordered_updates],
        }

    def _parse_single_numeric_value(self, text: str) -> Optional[float]:
        matches = re.findall(r"[-+]?(?:\d+(?:[.,]\d*)?|\.\d+)(?:e[-+]?\d+)?", str(text or ""))
        if len(matches) != 1:
            return None
        return self._parse_float(matches[0])

    def _parse_float(self, value: Any) -> Optional[float]:
        try:
            normalized = str(value).strip().replace(",", ".")
            if not normalized:
                return None
            return float(normalized)
        except Exception:
            return None
