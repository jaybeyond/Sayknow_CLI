from __future__ import annotations

import threading
from typing import Any

import pytest
from skc_rpc import HostToolContext

from decepticon_bridge.roster import ROLE_NAMES
from decepticon_bridge.runner import RunResult
from decepticon_bridge.tools import build_host_tools


class FakeRunner:
    """Records dispatches and returns a canned result."""

    def __init__(self, result: RunResult | None = None) -> None:
        self.result = result
        self.calls: list[tuple[str, str]] = []

    def run(self, role: str, objective: str) -> RunResult:
        self.calls.append((role, objective))
        if self.result is not None:
            return self.result
        return RunResult(role=role, objective=objective, ok=True, output=f"ran {role}")


def make_ctx() -> tuple[HostToolContext, list[Any]]:
    updates: list[Any] = []
    ctx = HostToolContext(
        tool_call_id="tc-1",
        _cancel_event=threading.Event(),
        _send_update=updates.append,
    )
    return ctx, updates


def tools_by_name(runner: Any) -> dict[str, Any]:
    return {t.name: t for t in build_host_tools(runner)}


def test_build_host_tools_exposes_expected_tools() -> None:
    tools = tools_by_name(FakeRunner())
    assert set(tools) == {"decepticon_run_agent", "decepticon_list_agents"}


def test_run_agent_schema_enumerates_roles() -> None:
    run = tools_by_name(FakeRunner())["decepticon_run_agent"]
    schema = run.parameters
    assert schema["additionalProperties"] is False
    assert set(schema["required"]) == {"role", "objective"}
    assert schema["properties"]["role"]["enum"] == list(ROLE_NAMES)


def test_run_agent_dispatches_and_returns_output() -> None:
    runner = FakeRunner(RunResult("recon", "scan", ok=True, output="found 3 hosts"))
    run = tools_by_name(runner)["decepticon_run_agent"]
    ctx, updates = make_ctx()

    result = run.execute({"role": "recon", "objective": "  scan  "}, ctx)

    assert runner.calls == [("recon", "scan")]  # objective stripped
    assert result["details"] == {"ok": True, "role": "recon"}
    assert result["content"][0]["text"] == "found 3 hosts"
    assert updates, "expected a progress send_update before dispatch"


def test_run_agent_rejects_unknown_role_without_dispatch() -> None:
    runner = FakeRunner()
    run = tools_by_name(runner)["decepticon_run_agent"]
    ctx, _ = make_ctx()

    result = run.execute({"role": "nope", "objective": "x"}, ctx)

    assert runner.calls == []
    assert result["details"]["ok"] is False
    assert result["details"]["error"] == "invalid_role"


def test_run_agent_rejects_empty_objective_without_dispatch() -> None:
    runner = FakeRunner()
    run = tools_by_name(runner)["decepticon_run_agent"]
    ctx, _ = make_ctx()

    result = run.execute({"role": "recon", "objective": "   "}, ctx)

    assert runner.calls == []
    assert result["details"]["error"] == "invalid_objective"


def test_run_agent_surfaces_runner_failure() -> None:
    runner = FakeRunner(RunResult("recon", "scan", ok=False, error="sandbox down"))
    run = tools_by_name(runner)["decepticon_run_agent"]
    ctx, _ = make_ctx()

    result = run.execute({"role": "recon", "objective": "scan"}, ctx)

    assert result["details"]["ok"] is False
    assert result["details"]["error"] == "run_failed"
    assert "sandbox down" in result["content"][0]["text"]


def test_list_agents_lists_every_role() -> None:
    list_tool = tools_by_name(FakeRunner())["decepticon_list_agents"]
    ctx, _ = make_ctx()

    text = list_tool.execute({}, ctx)

    assert isinstance(text, str)
    for name in ROLE_NAMES:
        assert name in text
