"""Claude models (Anthropic Messages API) as an openai-agents ``Model``.

The multi-agent system (triage, planner, specialists, handoffs, MCP tools) is built with
openai-agents. This module lets every agent run on Claude instead of an OpenAI model:
``ClaudeModel`` converts the Responses-format input the runner gives it into a Messages API
request, calls Claude with the official ``anthropic`` SDK, and converts the reply back into
Responses output items (reasoning / message / function_call).

Claude specifics handled here:
- Thinking is adaptive for every model offered here (Claude Opus 5.5, Fable 5.1, Sonnet 5.5,
  Haiku 5.5); depth is set with ``output_config.effort`` from the agent's reasoning effort.
- Thinking blocks are returned to the runner as reasoning items (the block is kept in
  ``encrypted_content``) and replayed unchanged on the next request. Agents in this system share
  one conversation but each has its own system prompt and tools, so a replayed block can come from
  a different prefix; ``prefix_mismatch_behavior: "drop_block"`` makes the API drop such blocks
  instead of rejecting the request.
- Forced tool use (``tool_choice`` any/tool) is not accepted by these models: "required" or a
  named tool becomes ``auto`` plus an instruction.
- Structured output (the Planner's PlanReview) uses ``output_config.format``; if the API rejects
  the schema, the request is retried with the schema in the system prompt instead.
- Refusals: server-side fallbacks (``fallbacks: "default"``) are on, except for Claude Haiku 5.5,
  which has none (the parameter is left out); a final ``refusal`` stop reason is returned as a
  plain assistant message.
- Hosted OpenAI tools (code interpreter, web search, ...) are not available to Claude and are left
  out of the request.
"""
from __future__ import annotations

import copy
import json
import os
import re
import time
import uuid
from typing import Any, AsyncIterator, Optional

from agents.handoffs import Handoff
from agents.items import ModelResponse, TResponseInputItem, TResponseStreamEvent
from agents.models.interface import Model, ModelProvider, ModelTracing
from agents.tool import FunctionTool, Tool
from agents.usage import Usage
from openai.types.responses import (
    Response,
    ResponseCompletedEvent,
    ResponseCreatedEvent,
    ResponseFunctionToolCall,
    ResponseOutputMessage,
    ResponseOutputText,
    ResponseReasoningItem,
    ResponseTextDeltaEvent,
)
from openai.types.responses.response_reasoning_item import Summary
from openai.types.responses.response_usage import InputTokensDetails, OutputTokensDetails, ResponseUsage

# Choices shown to the user. "openai" keeps the agents' own OpenAI models.
LLM_BACKENDS = {
    "openai": "OpenAI GPT-5.4 mini (recommendation: GPT-5.4)",
    "claude-opus-5-5": "Claude Opus 5.5",
    "claude-fable-5-1": "Claude Fable 5.1",
    # Cheaper choices (appended, so the existing combo-box positions do not move).
    "claude-sonnet-5-5": "Claude Sonnet 5.5 (cheaper)",
    "claude-haiku-5-5": "Claude Haiku 5.5 (cheapest)",
    "openai-gpt-5.6-terra": "OpenAI GPT-5.6 Terra (all agents)",
    # Not OpenAI, not Claude: an OpenAI-compatible server (see openai_compatible_model).
    "qwen38-hu-hpc": "Qwen3.8 Flash Next (HU HPC cluster)",
}
# OpenAI choices that put every agent (triage, planner, specialists) on one model,
# instead of each agent's own configured GPT model: backend -> OpenAI model id.
OPENAI_SINGLE_MODEL_BACKENDS = {"openai-gpt-5.6-terra": "gpt-5.6-terra"}
CLAUDE_MODEL_IDS = ("claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-5-5")

_THINKING_MARKER = "claude-thinking:"
_FALLBACK_BETA = "server-side-fallback-2026-07-01"
_BETAS = [_FALLBACK_BETA, "thinking-binding-controls-2026-08-01"]
# No server-side fallback exists for these models: `fallbacks` (and its beta) are not sent.
_NO_SERVER_FALLBACK = frozenset({"claude-haiku-5-5"})
_EFFORTS = {"none": "low", "minimal": "low", "low": "low", "medium": "medium", "high": "high",
            "xhigh": "xhigh", "max": "max"}
DEFAULT_MAX_TOKENS = 64000


def _fake_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:24]}"


def _as_dict(item: Any) -> dict:
    if isinstance(item, dict):
        return item
    if hasattr(item, "model_dump"):
        return item.model_dump(exclude_none=True)
    return dict(item)


def _content_to_text(content: Any) -> str:
    """Text of a Responses message content (str or list of parts)."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    parts = []
    for part in content:
        part = _as_dict(part)
        text = part.get("text")
        if text is None and part.get("type") == "refusal":
            text = part.get("refusal")
        if text:
            parts.append(str(text))
    return "\n".join(parts)


def _tool_output_to_content(output: Any) -> Any:
    if isinstance(output, str):
        return output if output else "(empty result)"
    if isinstance(output, list):
        text = _content_to_text(output)
        return text if text else json.dumps(output, ensure_ascii=False, default=str)
    return json.dumps(output, ensure_ascii=False, default=str)


def _strict_object_schema(schema: Any) -> Any:
    """Copy of a JSON schema with additionalProperties: false on every object that does not set it
    (required by output_config.format)."""
    if isinstance(schema, dict):
        out = {k: _strict_object_schema(v) for k, v in schema.items()}
        if out.get("type") == "object" and "properties" in out and "additionalProperties" not in out:
            out["additionalProperties"] = False
        return out
    if isinstance(schema, list):
        return [_strict_object_schema(v) for v in schema]
    return schema


def _strip_code_fence(text: str) -> str:
    match = re.match(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", text, re.S)
    return match.group(1) if match else text


def responses_input_to_messages(input: str | list[TResponseInputItem]) -> list[dict]:
    """Responses-format input items -> Messages API ``messages``. Deterministic, so the same
    history always gives the same request prefix (prompt cache, thinking-block binding)."""
    if isinstance(input, str):
        return [{"role": "user", "content": [{"type": "text", "text": input}]}]

    messages: list[dict] = []

    def add(role: str, block: dict) -> None:
        if messages and messages[-1]["role"] == role:
            messages[-1]["content"].append(block)
        else:
            messages.append({"role": role, "content": [block]})

    for raw in input:
        item = _as_dict(raw)
        item_type = item.get("type")
        role = item.get("role")
        if item_type in (None, "message") and role in ("user", "system", "developer"):
            text = _content_to_text(item.get("content"))
            if text:
                if role != "user":
                    text = f"[{role} instruction]\n{text}"
                add("user", {"type": "text", "text": text})
        elif item_type in (None, "message") and role == "assistant":
            text = _content_to_text(item.get("content"))
            if text:
                add("assistant", {"type": "text", "text": text})
        elif item_type == "reasoning":
            encrypted = item.get("encrypted_content") or ""
            if encrypted.startswith(_THINKING_MARKER):      # a Claude thinking block: replay unchanged
                try:
                    add("assistant", json.loads(encrypted[len(_THINKING_MARKER):]))
                except ValueError:
                    pass
            # OpenAI reasoning items cannot be replayed to Claude: skipped.
        elif item_type == "function_call":
            try:
                arguments = json.loads(item.get("arguments") or "{}")
            except ValueError:
                arguments = {"_raw_arguments": item.get("arguments")}
            if not isinstance(arguments, dict):
                arguments = {"value": arguments}
            add("assistant", {"type": "tool_use", "id": item.get("call_id") or item.get("id") or _fake_id("toolu"),
                              "name": item.get("name") or "unknown_tool", "input": arguments})
        elif item_type == "function_call_output":
            add("user", {"type": "tool_result", "tool_use_id": item.get("call_id"),
                         "content": _tool_output_to_content(item.get("output"))})
        else:
            # Hosted-tool items from an earlier OpenAI run (code interpreter, web search, ...).
            summary = {k: v for k, v in item.items() if k in ("type", "name", "status", "output", "outputs", "code")}
            if summary:
                add("assistant" if item_type and item_type.endswith("_call") else "user",
                    {"type": "text", "text": "[earlier tool item] " + json.dumps(summary, ensure_ascii=False, default=str)[:4000]})

    return _repair_tool_pairs(messages)


def _repair_tool_pairs(messages: list[dict]) -> list[dict]:
    """Every tool_use needs a tool_result in the next user message and every tool_result needs its
    tool_use; tool_result blocks come first in that user message."""
    # Roles alternate here: add() merges consecutive blocks of the same role into one message.
    repaired: list[dict] = []
    for message in messages:
        message = {"role": message["role"], "content": list(message["content"])}
        if message["role"] == "user":
            previous = repaired[-1] if repaired else None
            open_ids = [b["id"] for b in (previous["content"] if previous else []) if b.get("type") == "tool_use"]
            results, others = [], []
            for block in message["content"]:
                if block.get("type") == "tool_result" and block.get("tool_use_id") in open_ids:
                    results.append(block)
                elif block.get("type") == "tool_result":
                    others.append({"type": "text", "text": "[tool result] " + str(block.get("content"))})
                else:
                    others.append(block)
            answered = {b["tool_use_id"] for b in results}
            results += [{"type": "tool_result", "tool_use_id": i, "content": "(no result recorded)", "is_error": True}
                        for i in open_ids if i not in answered]
            message["content"] = results + others
        repaired.append(message)
    # A trailing assistant tool_use with no result yet.
    if repaired and repaired[-1]["role"] == "assistant":
        open_ids = [b["id"] for b in repaired[-1]["content"] if b.get("type") == "tool_use"]
        if open_ids:
            repaired.append({"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": i, "content": "(no result recorded)", "is_error": True}
                for i in open_ids]})
    if repaired and repaired[0]["role"] != "user":
        repaired.insert(0, {"role": "user", "content": [{"type": "text", "text": "(conversation continues)"}]})
    return repaired


def _claude_tools(tools: list[Tool], handoffs: list[Handoff]) -> list[dict]:
    result = []
    for tool in tools:
        if isinstance(tool, FunctionTool):
            schema = tool.params_json_schema or {"type": "object", "properties": {}}
            result.append({"name": tool.name, "description": tool.description or tool.name, "input_schema": schema})
        # Hosted OpenAI tools (code interpreter, file search, web search, ...) are skipped.
    for handoff in handoffs:
        result.append({"name": handoff.tool_name, "description": handoff.tool_description or handoff.tool_name,
                       "input_schema": handoff.input_json_schema or {"type": "object", "properties": {}}})
    result.sort(key=lambda t: t["name"])        # stable order: identical prefix on every request
    return result


def _fix_handoff_name(name: str, tool_names: Optional[set], handoff_names: Optional[list]) -> str:
    """Map a call to a tool this agent does not have onto the handoff that leads to it; the
    runner would otherwise stop with "Tool ... not found in agent ...".
    - ``transfer_to_<agent>`` it cannot reach (a specialist going straight to the next specialist
      instead of back to triage): with exactly one handoff, that one.
    - ``<agent>__<tool>`` of another agent (triage calling a specialist's MCP tool itself): the
      handoff to that agent, which then calls the tool."""
    if tool_names is None or name in tool_names or not handoff_names:
        return name
    if name.startswith("transfer_to_"):
        return handoff_names[0] if len(handoff_names) == 1 else name
    if "__" in name:
        owner = re.sub(r"[^a-z0-9]+", "_", name.split("__", 1)[0].lower()).strip("_")
        for handoff_name in handoff_names:
            if handoff_name.lower() == f"transfer_to_{owner}":
                return handoff_name
    return name


def message_to_output_items(message: Any, *, json_output: bool, tool_names: Optional[set] = None,
                            handoff_names: Optional[list] = None) -> list:
    """Claude response content -> Responses output items, in the same order."""
    items: list = []
    for block in message.content:
        block_type = getattr(block, "type", None)
        if block_type in ("thinking", "redacted_thinking"):
            raw = block.model_dump(exclude_none=True)
            summary_text = getattr(block, "thinking", "") or ""
            items.append(ResponseReasoningItem(
                id=_fake_id("rs"), type="reasoning",
                summary=[Summary(text=summary_text, type="summary_text")] if summary_text else [],
                encrypted_content=_THINKING_MARKER + json.dumps(raw, ensure_ascii=False)))
        elif block_type == "text":
            text = block.text
            if json_output:
                text = _strip_code_fence(text)
            items.append(ResponseOutputMessage(
                id=_fake_id("msg"), type="message", role="assistant", status="completed",
                content=[ResponseOutputText(type="output_text", text=text, annotations=[])]))
        elif block_type == "tool_use":
            items.append(ResponseFunctionToolCall(
                id=_fake_id("fc"), type="function_call", call_id=block.id,
                name=_fix_handoff_name(block.name, tool_names, handoff_names),
                arguments=json.dumps(block.input, ensure_ascii=False), status="completed"))
        # fallback switch markers and other block types carry nothing the runner needs.
    if message.stop_reason == "refusal":
        details = getattr(message, "stop_details", None)
        category = getattr(details, "category", None)
        explanation = getattr(details, "explanation", None)
        text = "The Claude model declined this request" + (f" (category: {category})" if category else "") + "."
        if explanation:
            text += f" {explanation}"
        items.append(ResponseOutputMessage(
            id=_fake_id("msg"), type="message", role="assistant", status="completed",
            content=[ResponseOutputText(type="output_text", text=text, annotations=[])]))
    elif message.stop_reason == "max_tokens" and not any(isinstance(i, ResponseFunctionToolCall) for i in items):
        items.append(ResponseOutputMessage(
            id=_fake_id("msg"), type="message", role="assistant", status="completed",
            content=[ResponseOutputText(type="output_text", text="(The reply was cut off at the output token limit.)",
                                        annotations=[])]))
    return items


def _usage(message: Any) -> Usage:
    u = getattr(message, "usage", None)
    input_tokens = int((getattr(u, "input_tokens", 0) or 0) + (getattr(u, "cache_read_input_tokens", 0) or 0)
                       + (getattr(u, "cache_creation_input_tokens", 0) or 0))
    output_tokens = int(getattr(u, "output_tokens", 0) or 0)
    return Usage(requests=1, input_tokens=input_tokens, output_tokens=output_tokens,
                 total_tokens=input_tokens + output_tokens,
                 input_tokens_details=_input_details(int(getattr(u, "cache_read_input_tokens", 0) or 0),
                                                     int(getattr(u, "cache_creation_input_tokens", 0) or 0)),
                 output_tokens_details=OutputTokensDetails(reasoning_tokens=0))


def _input_details(cache_read: int, cache_write: int) -> InputTokensDetails:
    fields = InputTokensDetails.model_fields
    kwargs = {"cached_tokens": cache_read}
    if "cache_write_tokens" in fields:
        kwargs["cache_write_tokens"] = cache_write
    return InputTokensDetails(**kwargs)


class ClaudeModel(Model):
    """An openai-agents Model that calls Claude through the official anthropic SDK."""

    def __init__(self, model_id: str = "claude-opus-5-5", *, api_key: Optional[str] = None,
                 default_effort: Optional[str] = None, max_tokens: int = DEFAULT_MAX_TOKENS) -> None:
        if model_id not in CLAUDE_MODEL_IDS:
            raise ValueError(f"Unsupported Claude model {model_id!r}; choose one of {CLAUDE_MODEL_IDS}")
        self.model_id = model_id
        self._api_key = api_key
        self.default_effort = default_effort
        self.max_tokens = max_tokens

    def __repr__(self) -> str:
        return f"ClaudeModel({self.model_id!r})"

    # -- request -------------------------------------------------------------------------------
    def _request(self, system_instructions, input, model_settings, tools, output_schema, handoffs) -> dict:
        system = system_instructions or ""
        claude_tools = _claude_tools(tools, handoffs)
        tool_choice: dict = {"type": "auto"}
        choice = getattr(model_settings, "tool_choice", None)
        if choice == "none":
            tool_choice = {"type": "none"}
        elif choice == "required" and claude_tools:
            system += "\n\nYou must call one of the available tools in this reply."
        elif isinstance(choice, str) and choice not in ("auto", "required") and claude_tools:
            system += f"\n\nYou must call the tool `{choice}` in this reply."
        if getattr(model_settings, "parallel_tool_calls", None) is False and tool_choice["type"] == "auto":
            tool_choice["disable_parallel_tool_use"] = True

        reasoning = getattr(model_settings, "reasoning", None)
        effort = getattr(reasoning, "effort", None) if reasoning is not None else None
        if isinstance(reasoning, dict):
            effort = reasoning.get("effort")
        effort = _EFFORTS.get(str(effort or self.default_effort or "medium").lower(), "medium")

        output_config: dict = {"effort": effort}
        json_output = output_schema is not None and not output_schema.is_plain_text()
        if json_output:
            output_config["format"] = {"type": "json_schema", "schema": _strict_object_schema(output_schema.json_schema())}

        request = {
            "model": self.model_id,
            "max_tokens": int(getattr(model_settings, "max_tokens", None) or self.max_tokens),
            "system": system,
            "messages": responses_input_to_messages(input),
            "thinking": {"type": "adaptive", "display": "summarized",
                         "block_binding": {"prefix_mismatch_behavior": "drop_block"}},
            "output_config": output_config,
            "fallbacks": "default",
            "betas": list(_BETAS),
        }
        if self.model_id in _NO_SERVER_FALLBACK:
            del request["fallbacks"]
            request["betas"].remove(_FALLBACK_BETA)
        if claude_tools:
            request["tools"] = claude_tools
            request["tool_choice"] = tool_choice
        return request

    async def _call(self, request: dict) -> Any:
        import anthropic
        api_key = self._api_key or os.environ.get("ANTHROPIC_API_KEY")
        # A client per call: the chat runs every message in its own asyncio loop/thread.
        async with anthropic.AsyncAnthropic(api_key=api_key) as client:
            try:
                async with client.beta.messages.stream(**request) as stream:
                    return await stream.get_final_message()
            except anthropic.BadRequestError as error:
                fmt = request.get("output_config", {}).get("format")
                if fmt is None or "schema" not in str(error).lower() and "output_config" not in str(error).lower():
                    raise
                # The structured-output schema was rejected: ask for the JSON in the prompt instead.
                retry = copy.deepcopy(request)
                retry["output_config"].pop("format", None)
                retry["system"] = (retry["system"] + "\n\nReply with only one JSON object (no code fence, no prose) "
                                   "that validates against this JSON schema:\n" + json.dumps(fmt["schema"], ensure_ascii=False))
                async with client.beta.messages.stream(**retry) as stream:
                    return await stream.get_final_message()

    async def get_response(self, system_instructions, input, model_settings, tools, output_schema, handoffs,
                           tracing: ModelTracing, *, previous_response_id=None, conversation_id=None,
                           prompt=None) -> ModelResponse:
        request = self._request(system_instructions, input, model_settings, tools, output_schema, handoffs)
        message = await self._call(request)
        json_output = output_schema is not None and not output_schema.is_plain_text()
        tool_names = {t["name"] for t in request.get("tools", [])}
        handoff_names = [h.tool_name for h in handoffs]
        return ModelResponse(output=message_to_output_items(message, json_output=json_output, tool_names=tool_names,
                                                            handoff_names=handoff_names),
                             usage=_usage(message), response_id=None,
                             request_id=getattr(message, "_request_id", None))

    async def stream_response(self, system_instructions, input, model_settings, tools, output_schema, handoffs,
                              tracing: ModelTracing, *, previous_response_id=None, conversation_id=None,
                              prompt=None) -> AsyncIterator[TResponseStreamEvent]:
        """The reply is produced in one piece (streamed from the API underneath) and emitted as
        created -> text deltas -> completed, which is what the runner and the chat window use."""
        response = await self.get_response(system_instructions, input, model_settings, tools, output_schema,
                                           handoffs, tracing, previous_response_id=previous_response_id,
                                           conversation_id=conversation_id, prompt=prompt)
        usage = response.usage
        final = Response(
            id=_fake_id("resp"), created_at=time.time(), model=self.model_id, object="response",
            output=list(response.output), tool_choice="auto", tools=[], top_p=None,
            parallel_tool_calls=True, status="completed",
            usage=ResponseUsage(input_tokens=usage.input_tokens, output_tokens=usage.output_tokens,
                                total_tokens=usage.total_tokens,
                                input_tokens_details=_input_details(usage.input_tokens_details.cached_tokens,
                                                                    getattr(usage.input_tokens_details, "cache_write_tokens", 0) or 0),
                                output_tokens_details=OutputTokensDetails(reasoning_tokens=0)))
        sequence = 0
        yield ResponseCreatedEvent(type="response.created", sequence_number=sequence,
                                   response=final.model_copy(update={"output": [], "status": "in_progress", "usage": None}))
        for index, item in enumerate(final.output):
            if isinstance(item, ResponseOutputMessage):
                for content_index, part in enumerate(item.content):
                    if isinstance(part, ResponseOutputText) and part.text:
                        sequence += 1
                        yield ResponseTextDeltaEvent(type="response.output_text.delta", item_id=item.id,
                                                     output_index=index, content_index=content_index,
                                                     delta=part.text, logprobs=[], sequence_number=sequence)
        sequence += 1
        yield ResponseCompletedEvent(type="response.completed", response=final, sequence_number=sequence)


class ClaudeModelProvider(ModelProvider):
    """Returns the chosen Claude model whatever model name an agent asks for."""

    def __init__(self, model_id: str = "claude-opus-5-5", api_key: Optional[str] = None) -> None:
        self._model = ClaudeModel(model_id, api_key=api_key)

    def get_model(self, model_name: Optional[str]) -> Model:
        return self._model


def resolve_model(backend: Optional[str], openai_model: Any) -> Any:
    """The model object/name an agent should use for the chosen backend."""
    if backend in CLAUDE_MODEL_IDS:
        return ClaudeModel(backend)
    if backend in OPENAI_SINGLE_MODEL_BACKENDS:
        return OPENAI_SINGLE_MODEL_BACKENDS[backend]
    from edma_mcp.client.openai_compatible_model import OPENAI_COMPATIBLE_BACKENDS, get_model
    if backend in OPENAI_COMPATIBLE_BACKENDS:
        return get_model(backend)
    return openai_model
