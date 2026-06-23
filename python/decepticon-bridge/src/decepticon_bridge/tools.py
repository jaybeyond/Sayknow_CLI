"""skc-rpc host tools that expose Decepticon red-team agents to the agent.

These are the bridge's actual integration surface: an ``skc --mode rpc``
session launched with these ``custom_tools`` gains two agent-callable tools
(``decepticon_list_agents`` and ``decepticon_run_agent``) whose handlers run
on the Python side and invoke the vendored Decepticon agent graphs.
"""

from __future__ import annotations

from typing import Any

from skc_rpc import HostTool, HostToolContext, HostToolResultValue, host_tool

from .roster import ROLE_NAMES, ROLES_BY_NAME, ROSTER
from .runner import AgentRunner, DecepticonRunner, RunResult

_RUN_DESCRIPTION = (
    "Run a Decepticon red-team specialist agent on an authorized engagement "
    "objective and return its findings.\n\n"
    "Decepticon is an autonomous Red Team framework — only use this for "
    "targets and actions you are explicitly authorized to test. The agent "
    "executes real offensive tooling inside Decepticon's isolated Kali "
    "sandbox, so the Decepticon runtime stack (LiteLLM proxy, sandbox, "
    "Neo4j) must already be running. Call `decepticon_list_agents` first to "
    "see the available roles and what each one does. Long-running: a single "
    "call can drive a full multi-step agent loop before it returns."
)


def build_host_tools(runner: AgentRunner | None = None) -> tuple[HostTool, ...]:
    """Build the bridge's host tools, optionally with an injected runner."""
    active = runner if runner is not None else DecepticonRunner()
    return (_run_agent_tool(active), _list_agents_tool())


def _list_agents_tool() -> HostTool:
    def execute(_args: Any, _ctx: HostToolContext) -> HostToolResultValue:
        lines = ["Available Decepticon red-team agents:"]
        for role in ROSTER:
            tag = " [orchestrator]" if role.orchestrator else ""
            lines.append(f"- {role.name}{tag}: {role.summary}")
        return "\n".join(lines)

    return host_tool(
        name="decepticon_list_agents",
        description=(
            "List the Decepticon red-team agents the bridge can dispatch, "
            "with a one-line description of each role."
        ),
        parameters={
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
        execute=execute,
        label="Decepticon: list agents",
    )


def _run_agent_tool(runner: AgentRunner) -> HostTool:
    def execute(args: Any, ctx: HostToolContext) -> HostToolResultValue:
        params = args if isinstance(args, dict) else {}
        role = params.get("role")
        objective = params.get("objective")

        if not isinstance(role, str) or role not in ROLES_BY_NAME:
            return _error(
                role if isinstance(role, str) else "",
                "invalid_role",
                f"Invalid 'role'. Choose one of: {', '.join(ROLE_NAMES)}.",
            )
        if not isinstance(objective, str) or not objective.strip():
            return _error(
                role,
                "invalid_objective",
                "'objective' must be a non-empty string describing the "
                "authorized task.",
            )

        ctx.send_update(f"Dispatching Decepticon `{role}` agent…")
        result = runner.run(role, objective.strip())
        return _format_result(result)

    return host_tool(
        name="decepticon_run_agent",
        description=_RUN_DESCRIPTION,
        parameters={
            "type": "object",
            "properties": {
                "role": {
                    "type": "string",
                    "enum": list(ROLE_NAMES),
                    "description": "Which Decepticon specialist agent to run.",
                },
                "objective": {
                    "type": "string",
                    "description": (
                        "Authorized task for the agent, e.g. 'enumerate "
                        "subdomains and open ports for in-scope host "
                        "10.0.0.5'."
                    ),
                },
            },
            "required": ["role", "objective"],
            "additionalProperties": False,
        },
        execute=execute,
        label="Decepticon: run agent",
    )


def _format_result(result: RunResult) -> HostToolResultValue:
    if result.ok:
        text = result.output or "(agent returned no text output)"
        return {
            "content": [{"type": "text", "text": text}],
            "details": {"ok": True, "role": result.role},
        }
    return _error(result.role, "run_failed", result.error or "unknown error")


def _error(role: str, code: str, message: str) -> HostToolResultValue:
    return {
        "content": [{"type": "text", "text": f"Decepticon error: {message}"}],
        "details": {"ok": False, "role": role, "error": code},
    }
