from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from edma_mcp.client.models import PlanJudgeIssue, PlanJudgeReport, PlanReview
from edma_mcp.skills.provider import FilesystemSkillProvider


@dataclass
class SkillContract:
    skill_id: str
    agents: List[str]
    required_tools: List[str]
    ordered_tools: List[str]


def _load_skill_contracts(playbooks_dir: str) -> Dict[str, SkillContract]:
    contracts: Dict[str, SkillContract] = {}
    provider = FilesystemSkillProvider(playbooks_dir)
    if not os.path.isdir(playbooks_dir):
        return contracts
    for meta in provider.list_skills():
        skill_id = str(meta.get("id", "")).strip()
        if not skill_id:
            continue
        try:
            manifest = provider.get_skill_manifest(skill_id)
        except Exception:
            continue
        required_tools = manifest.get("required_tools") or []
        ordered_tools = manifest.get("ordered_tools") or []
        agents = manifest.get("agents") or []
        if not isinstance(agents, list):
            agents = []
        if not isinstance(required_tools, list):
            required_tools = []
        if not isinstance(ordered_tools, list):
            ordered_tools = []
        contracts[skill_id] = SkillContract(
            skill_id=skill_id,
            agents=[str(agent) for agent in agents],
            required_tools=[str(tool) for tool in required_tools],
            ordered_tools=[str(tool) for tool in ordered_tools],
        )
    return contracts


def _normalize_mcp_tools(mcp_tools: Any) -> List[Dict[str, Any]]:
    if not mcp_tools:
        return []
    if not isinstance(mcp_tools, list):
        return []
    out: List[Dict[str, Any]] = []
    for tool in mcp_tools:
        if isinstance(tool, dict):
            out.append(tool)
            continue
        record: Dict[str, Any] = {}
        name = getattr(tool, "name", None)
        description = getattr(tool, "description", None)
        schema = getattr(tool, "inputSchema", None) or getattr(tool, "input_schema", None)
        if isinstance(name, str):
            record["name"] = name
        if isinstance(description, str):
            record["description"] = description
        if isinstance(schema, dict):
            record["inputSchema"] = schema
        out.append(record)
    return out


def _schema_accepts_type(schema: Dict[str, Any], value: Any) -> bool:
    if not schema:
        return True

    for union_key in ("anyOf", "oneOf"):
        options = schema.get(union_key)
        if isinstance(options, list) and options:
            return any(_schema_accepts_type(option, value) for option in options if isinstance(option, dict))

    schema_type = schema.get("type")
    if isinstance(schema_type, list):
        return any(_schema_accepts_type({"type": one_type}, value) for one_type in schema_type)

    if value is None:
        return schema_type in {None, "null"}
    if schema_type in (None, "any"):
        return True
    if schema_type == "string":
        return isinstance(value, str)
    if schema_type == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if schema_type == "number":
        return (isinstance(value, (int, float)) and not isinstance(value, bool))
    if schema_type == "boolean":
        return isinstance(value, bool)
    if schema_type == "array":
        return isinstance(value, list)
    if schema_type == "object":
        return isinstance(value, dict)
    return True


def _is_placeholder_value(value: Any) -> bool:
    return isinstance(value, str) and value.strip().startswith("{{") and value.strip().endswith("}}")


def _is_subsequence(sequence: List[str], ordered: List[str]) -> bool:
    if not sequence:
        return False
    idx = 0
    for item in ordered:
        if idx < len(sequence) and item == sequence[idx]:
            idx += 1
    return idx == len(sequence)


def _normalize_step_tool_name(agent_name: str, tool_name: str) -> Tuple[str, str]:
    raw = str(tool_name or "").strip()
    prefix = f"{agent_name}."
    if raw.startswith(prefix):
        normalized = raw[len(prefix):]
        return normalized, f"{agent_name}.{normalized}"
    return raw, f"{agent_name}.{raw}"


def _unique_issue_values(issues: List[PlanJudgeIssue], category: str) -> List[str]:
    values: List[str] = []
    seen = set()
    for issue in issues:
        if issue.category != category:
            continue
        match = re.search(r"'([^']+)'", issue.message)
        value = match.group(1) if match else issue.message
        if value not in seen:
            seen.add(value)
            values.append(value)
    return values


async def judge_plan_review(plan: PlanReview, bridge: Any, playbooks_dir: Optional[str] = None) -> PlanJudgeReport:
    playbooks_root = playbooks_dir
    if not playbooks_root:
        if hasattr(bridge, "_resolve_playbooks_dir"):
            playbooks_root = bridge._resolve_playbooks_dir()
        else:
            package_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            playbooks_root = os.path.join(package_root, "skills", "playbooks")

    contracts = _load_skill_contracts(playbooks_root)
    issues: List[PlanJudgeIssue] = []
    grounded_steps = 0
    step_sequences: Dict[str, List[str]] = {}
    try:
        if hasattr(bridge, "refresh"):
            await bridge.refresh()
    except Exception:
        pass
    available_agents = set(await bridge.list_agents())
    tools_by_agent: Dict[str, Dict[str, Dict[str, Any]]] = {}

    async def get_tool_specs(agent_name: str) -> Dict[str, Dict[str, Any]]:
        if agent_name not in tools_by_agent:
            normalized = _normalize_mcp_tools(await bridge.list_tools(agent_name))
            tools_by_agent[agent_name] = {
                str(tool.get("name")): tool for tool in normalized if str(tool.get("name", "")).strip()
            }
        return tools_by_agent[agent_name]

    for step in plan.steps:
        contract = contracts.get(step.skill)
        normalized_tool_name, full_tool_name = _normalize_step_tool_name(step.agent, step.tool_name)
        step_is_grounded = False

        if contract is None:
            issues.append(PlanJudgeIssue(
                severity="blocking",
                category="skill",
                step_id=step.step_id,
                skill=step.skill,
                message=f"Skill '{step.skill}' does not exist in the registered playbooks.",
            ))
        else:
            if full_tool_name not in contract.required_tools:
                issues.append(PlanJudgeIssue(
                    severity="blocking",
                    category="grounding",
                    step_id=step.step_id,
                    skill=step.skill,
                    message=f"Step uses tool '{full_tool_name}' which is not declared in skill '{step.skill}'.",
                ))
            else:
                step_is_grounded = True
                grounded_steps += 1
                step_sequences.setdefault(step.skill, []).append(full_tool_name)

        if step.agent not in available_agents:
            issues.append(PlanJudgeIssue(
                severity="blocking",
                category="agent",
                step_id=step.step_id,
                skill=step.skill,
                message=f"Step references unavailable agent '{step.agent}'.",
            ))
            continue

        tool_specs = await get_tool_specs(step.agent)
        tool_spec = tool_specs.get(normalized_tool_name)
        if tool_spec is None:
            issues.append(PlanJudgeIssue(
                severity="blocking",
                category="tool",
                step_id=step.step_id,
                skill=step.skill,
                message=f"Step references unavailable tool '{full_tool_name}'.",
            ))
            continue

        schema = tool_spec.get("inputSchema") or tool_spec.get("input_schema") or {}
        properties = schema.get("properties") if isinstance(schema, dict) else {}
        if not isinstance(properties, dict):
            properties = {}
        required = schema.get("required") if isinstance(schema, dict) else []
        if not isinstance(required, list):
            required = []

        for key in required:
            if key not in step.arguments:
                issues.append(PlanJudgeIssue(
                    severity="blocking",
                    category="parameter",
                    step_id=step.step_id,
                    skill=step.skill,
                    message=f"Missing required parameter '{key}' for tool '{full_tool_name}'.",
                ))
            elif _is_placeholder_value(step.arguments.get(key)):
                continue

        for arg_name, arg_value in step.arguments.items():
            if _is_placeholder_value(arg_value):
                continue
            if properties and arg_name not in properties:
                issues.append(PlanJudgeIssue(
                    severity="blocking",
                    category="parameter",
                    step_id=step.step_id,
                    skill=step.skill,
                    message=f"Unexpected parameter '{arg_name}' for tool '{full_tool_name}'.",
                ))
                continue

            arg_schema = properties.get(arg_name)
            if isinstance(arg_schema, dict) and not _schema_accepts_type(arg_schema, arg_value):
                issues.append(PlanJudgeIssue(
                    severity="blocking",
                    category="parameter",
                    step_id=step.step_id,
                    skill=step.skill,
                    message=f"Parameter '{arg_name}' has value '{arg_value}' that does not match the MCP schema for '{full_tool_name}'.",
                ))

        if step.skill == "recommend_4d_stem_parameters" and full_tool_name == "agent_suggestion.apply_fix":
            fix_name = step.arguments.get("fix_name")
            required_inputs = {str(item).strip() for item in (step.required_inputs or []) if str(item).strip()}
            if fix_name is None or _is_placeholder_value(fix_name) or "fix_name" in required_inputs:
                issues.append(PlanJudgeIssue(
                    severity="blocking",
                    category="order",
                    step_id=step.step_id,
                    skill=step.skill,
                    message=(
                        "Initial recommendation plans must not include "
                        "'agent_suggestion.apply_fix' until diagnostics fail and the user chooses "
                        "a concrete 'fix_name'."
                    ),
                ))

    recommend_steps = [step for step in plan.steps if step.skill == "recommend_4d_stem_parameters"]
    for index, step in enumerate(recommend_steps):
        _, full_tool_name = _normalize_step_tool_name(step.agent, step.tool_name)
        if full_tool_name != "agent_suggestion.find_defocus":
            continue
        if index == 0:
            issues.append(PlanJudgeIssue(
                severity="blocking",
                category="order",
                step_id=step.step_id,
                skill=step.skill,
                message=(
                    "Recommendation plans must include a settings-confirmation user-input gate "
                    "before 'agent_suggestion.find_defocus'."
                ),
            ))
            continue
        previous_step = recommend_steps[index - 1]
        previous_inputs = [str(item).strip().lower() for item in (previous_step.required_inputs or []) if str(item).strip()]
        has_confirmation_gate = any(
            "recommendation_settings_confirmation" in item
            or "confirm" in item
            or "no changes" in item
            for item in previous_inputs
        )
        prev_tool_normalized, prev_full_tool_name = _normalize_step_tool_name(previous_step.agent, previous_step.tool_name)
        if not has_confirmation_gate or prev_full_tool_name != "agent_suggestion.update_parameters":
            issues.append(PlanJudgeIssue(
                severity="blocking",
                category="order",
                step_id=step.step_id,
                skill=step.skill,
                message=(
                    "Recommendation plans must stop for settings confirmation after "
                    "'recalculate_defaults' and before 'agent_suggestion.find_defocus', using an "
                    "'agent_suggestion.update_parameters' step with confirmation required_inputs."
                ),
            ))

    missing_agents = _unique_issue_values(issues, "agent")
    if missing_agents:
        agent_list = ", ".join(missing_agents)
        available_list = ", ".join(sorted(available_agents)) if available_agents else "none"
        required_agents = []
        seen_required_agents = set()
        for step in plan.steps:
            contract = contracts.get(step.skill)
            candidates = list(getattr(contract, "agents", []) or []) if contract else []
            step_agent = str(getattr(step, "agent", "") or "").strip()
            if step_agent:
                candidates.append(step_agent)
            for agent in candidates:
                if agent and agent not in seen_required_agents:
                    seen_required_agents.add(agent)
                    required_agents.append(agent)
        required_list = ", ".join(required_agents or missing_agents)
        return PlanJudgeReport(
            grounding_status="partially_grounded" if grounded_steps > 0 else "ungrounded",
            status="block",
            summary=(
                f"Required agent is not running: {agent_list}. "
                f"Agents required by this workflow: {required_list}. "
                f"Please start/register {agent_list} and then ask again. "
                f"Currently available agents: {available_list}."
            ),
            issues=issues,
        )

    for skill_id, sequence in step_sequences.items():
        contract = contracts.get(skill_id)
        if contract and contract.ordered_tools and not _is_subsequence(sequence, contract.ordered_tools):
            issues.append(PlanJudgeIssue(
                severity="blocking",
                category="order",
                skill=skill_id,
                message=f"Plan steps for skill '{skill_id}' do not follow the tool order declared in the skill contract.",
            ))

    if grounded_steps == len(plan.steps) and grounded_steps > 0:
        grounding_status = "fully_grounded"
    elif grounded_steps > 0:
        grounding_status = "partially_grounded"
    else:
        grounding_status = "ungrounded"

    blocking_issues = [issue for issue in issues if issue.severity == "blocking"]
    if grounding_status == "fully_grounded" and not blocking_issues:
        status = "pass"
        summary = "Plan is fully grounded in registered skills and passed deterministic MCP tool/schema validation."
    elif grounding_status == "partially_grounded":
        status = "revise"
        summary = "Plan is only partially grounded in registered skills and needs revision before approval."
    else:
        status = "block"
        summary = "Plan is not sufficiently grounded in registered skills or failed deterministic tool/schema validation."

    return PlanJudgeReport(
        grounding_status=grounding_status,
        status=status,
        summary=summary,
        issues=issues,
    )
