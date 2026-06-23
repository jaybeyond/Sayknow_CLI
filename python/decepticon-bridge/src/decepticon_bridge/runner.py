"""Invocation layer that runs a vendored Decepticon agent graph.

The default :class:`DecepticonRunner` lazily imports ``decepticon`` only
when an agent is actually dispatched, so importing this package (and its
tests) never requires the heavy vendored runtime. The :class:`AgentRunner`
protocol lets callers inject a fake runner for testing.
"""

from __future__ import annotations

import importlib
from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable

from .roster import ROLES_BY_NAME, ROLE_NAMES

#: LangGraph recursion limit applied when invoking an agent unless the
#: caller overrides it. Decepticon's own factories default to 60–1000 per
#: role; ``None`` here means "use the graph's compiled-in default".
DEFAULT_RECURSION_LIMIT: int | None = None


@dataclass(slots=True)
class RunResult:
    """Outcome of one agent dispatch."""

    role: str
    objective: str
    ok: bool
    output: str = ""
    error: str | None = None


@runtime_checkable
class AgentRunner(Protocol):
    """Anything that can run a named Decepticon agent on an objective."""

    def run(self, role: str, objective: str) -> RunResult: ...


_INSTALL_HINT = (
    "The Decepticon runtime is not importable. Install the vendored packages "
    "into this environment (Python 3.13), e.g.:\n"
    "    uv pip install -e vendor/decepticon/packages/decepticon-core \\\n"
    "                   -e vendor/decepticon/packages/decepticon\n"
    "and make sure the runtime services (LiteLLM proxy, sandbox, Neo4j) are "
    "running — see vendor/decepticon/docs/architecture.md."
)


def _missing_runtime_message(exc: ImportError) -> str:
    return f"{_INSTALL_HINT}\n(import error: {exc})"


def _content_to_text(content: Any) -> str:
    """Flatten a LangChain message ``content`` field into plain text."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                text = block.get("text")
                if text is None:
                    text = block.get("content")
                if isinstance(text, str):
                    parts.append(text)
        return "\n".join(p for p in parts if p)
    return str(content)


def _extract_text(state: Any) -> str:
    """Pull the final assistant text out of a LangGraph agent result state."""
    messages = state.get("messages") if isinstance(state, dict) else None
    if not messages:
        return ""
    last = messages[-1]
    content = getattr(last, "content", None)
    if content is None and isinstance(last, dict):
        content = last.get("content")
    return _content_to_text(content)


class DecepticonRunner:
    """Default runner: load a vendored agent ``graph`` and ``.invoke`` it.

    Args:
        recursion_limit: optional LangGraph recursion-limit override applied
            via ``config={"recursion_limit": ...}``. ``None`` keeps the
            graph's compiled-in per-role default.
    """

    def __init__(self, *, recursion_limit: int | None = DEFAULT_RECURSION_LIMIT) -> None:
        self._recursion_limit = recursion_limit

    def run(self, role: str, objective: str) -> RunResult:
        spec = ROLES_BY_NAME.get(role)
        if spec is None:
            return RunResult(
                role=role,
                objective=objective,
                ok=False,
                error=f"unknown role {role!r}; valid roles: {', '.join(ROLE_NAMES)}",
            )

        try:
            graph = self._load_graph(spec.module)
        except ImportError as exc:
            return RunResult(role, objective, ok=False, error=_missing_runtime_message(exc))
        except Exception as exc:  # graph build / config failures
            return RunResult(role, objective, ok=False, error=f"failed to load {role} agent: {exc}")

        try:
            config: dict[str, Any] = {}
            if self._recursion_limit is not None:
                config["recursion_limit"] = self._recursion_limit
            state = graph.invoke(
                {"messages": [{"role": "user", "content": objective}]},
                config=config or None,
            )
            return RunResult(role, objective, ok=True, output=_extract_text(state))
        except Exception as exc:  # noqa: BLE001 - surface any runtime failure to the agent
            return RunResult(role, objective, ok=False, error=f"{role} agent run failed: {exc}")

    @staticmethod
    def _load_graph(module_path: str) -> Any:
        module = importlib.import_module(module_path)
        graph = getattr(module, "graph", None)
        if graph is None:
            raise RuntimeError(
                f"{module_path} exposes no module-level `graph` "
                "(is the 'standard' Decepticon bundle enabled?)"
            )
        return graph
