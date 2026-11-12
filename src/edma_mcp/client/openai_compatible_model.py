"""Models served by an OpenAI-compatible Chat Completions endpoint that is not OpenAI.

Currently one: Qwen3.8-Flash-Next on the HU HPC cluster (model name "qwen38"). Every agent
(triage, planner, specialists, message router) runs on it through the openai-agents
``OpenAIChatCompletionsModel``.

Specifics handled here:
- The API key comes from the QWEN_API_KEY environment variable only. Without it the request is
  refused here: the OpenAI client would otherwise fall back to OPENAI_API_KEY and send that key
  to the cluster server.
- The address is QWEN_BASE_URL, else the cluster address below. It is reachable only from inside
  the cluster network (or through a tunnel; then set QWEN_BASE_URL to the tunnel address).
- Thinking effort is not a top-level request field on this server: it is sent as
  ``chat_template_kwargs.reasoning_effort``. The effort is the one configured for the agent
  ("low" when the agent sets none); QWEN_REASONING_EFFORT overrides it for all agents.
- OpenAI hosted tools (code interpreter, ...) do not exist on this server: the bridge leaves
  them out, as it does for Claude.
"""
from __future__ import annotations

import asyncio
import dataclasses
import os
import socket
import weakref
from typing import Any, Optional, Tuple
from urllib.parse import urlparse

from agents.models.openai_chatcompletions import OpenAIChatCompletionsModel

# backend key (as stored in LLM_BACKENDS) -> endpoint
OPENAI_COMPATIBLE_BACKENDS = {
    "qwen38-hu-hpc": {
        "label": "Qwen3.8 Flash Next (HU HPC cluster)",
        "name": "Qwen",
        "model": "qwen38",
        "base_url": "http://hpc-cms01-036.hpc-service.hu-berlin.de:8038/v1",
        "base_url_env": "QWEN_BASE_URL",
        "api_key_env": "QWEN_API_KEY",
        "effort_env": "QWEN_REASONING_EFFORT",
    },
}

_EFFORTS = {"none": "low", "minimal": "low", "low": "low", "medium": "medium", "high": "high",
            "xhigh": "high", "max": "high"}


def base_url_for(backend: str) -> str:
    config = OPENAI_COMPATIBLE_BACKENDS[backend]
    return (os.environ.get(config["base_url_env"]) or config["base_url"]).strip()


def api_key_for(backend: str) -> Optional[str]:
    key = (os.environ.get(OPENAI_COMPATIBLE_BACKENDS[backend]["api_key_env"]) or "").strip()
    return key or None


def server_reachable(backend: str, timeout: float = 3.0) -> Tuple[bool, str]:
    """(True, "host:port") if a TCP connection to the server opens. Nothing is sent."""
    url = urlparse(base_url_for(backend))
    host = url.hostname or ""
    port = url.port or (443 if url.scheme == "https" else 80)
    where = f"{host}:{port}"
    try:
        socket.create_connection((host, port), timeout=timeout).close()
    except OSError as error:
        return False, f"{where} ({error})"
    return True, where


class OpenAICompatibleModel(OpenAIChatCompletionsModel):
    """The chat model of one OPENAI_COMPATIBLE_BACKENDS entry."""

    def __init__(self, backend: str) -> None:
        if backend not in OPENAI_COMPATIBLE_BACKENDS:
            raise ValueError(f"Unknown backend {backend!r}; choose one of {list(OPENAI_COMPATIBLE_BACKENDS)}")
        self.backend = backend
        self._config = OPENAI_COMPATIBLE_BACKENDS[backend]
        self.model_id = self._config["model"]
        # One HTTP client per asyncio loop (a client cannot be used from a second loop);
        # rebuilt when the key or the address changes.
        self._loop_clients: "weakref.WeakKeyDictionary[Any, tuple]" = weakref.WeakKeyDictionary()
        super().__init__(model=self.model_id, openai_client=None)  # client: set per request

    def __repr__(self) -> str:
        return f"OpenAICompatibleModel({self.model_id!r} at {base_url_for(self.backend)})"

    def __str__(self) -> str:
        return self.model_id

    def _supports_default_prompt_cache_key(self) -> bool:
        # prompt_cache_key is an OpenAI request field; this server is not OpenAI.
        return False

    def _get_client(self):
        # Never the default client of the base class: that one is OpenAI with OPENAI_API_KEY.
        self._bind_client()
        return super()._get_client()

    def _bind_client(self) -> None:
        from openai import AsyncOpenAI
        config = self._config
        key = api_key_for(self.backend)
        if not key:
            raise RuntimeError(
                f"No {config['name']} API key: set the {config['api_key_env']} environment variable "
                "(or use Local Key / the key field in the Conversation tab).")
        url = base_url_for(self.backend)
        loop = asyncio.get_running_loop()
        cached = self._loop_clients.get(loop)
        if cached is None or cached[1:] != (key, url):
            cached = (AsyncOpenAI(api_key=key, base_url=url), key, url)
            self._loop_clients[loop] = cached
        self._client = cached[0]

    def _settings(self, model_settings: Any) -> Any:
        """The agent settings in the form this server takes: thinking effort moves from
        ``reasoning.effort`` to ``chat_template_kwargs.reasoning_effort``."""
        reasoning = getattr(model_settings, "reasoning", None)
        effort = reasoning.get("effort") if isinstance(reasoning, dict) else getattr(reasoning, "effort", None)
        effort = os.environ.get(self._config["effort_env"]) or effort or "low"
        effort = _EFFORTS.get(str(effort).strip().lower(), "low")
        extra_body = dict(getattr(model_settings, "extra_body", None) or {})
        template_kwargs = dict(extra_body.get("chat_template_kwargs") or {})
        template_kwargs.setdefault("reasoning_effort", effort)
        extra_body["chat_template_kwargs"] = template_kwargs
        return dataclasses.replace(model_settings, reasoning=None, extra_body=extra_body)

    async def get_response(self, system_instructions, input, model_settings, tools, output_schema, handoffs,
                           tracing, *args, **kwargs):
        self._bind_client()
        return await super().get_response(system_instructions, input, self._settings(model_settings), tools,
                                          output_schema, handoffs, tracing, *args, **kwargs)

    async def stream_response(self, system_instructions, input, model_settings, tools, output_schema, handoffs,
                              tracing, *args, **kwargs):
        self._bind_client()
        async for event in super().stream_response(system_instructions, input, self._settings(model_settings),
                                                   tools, output_schema, handoffs, tracing, *args, **kwargs):
            yield event


_models: dict = {}


def get_model(backend: str) -> OpenAICompatibleModel:
    """The (shared) model object of a backend."""
    if backend not in _models:
        _models[backend] = OpenAICompatibleModel(backend)
    return _models[backend]
