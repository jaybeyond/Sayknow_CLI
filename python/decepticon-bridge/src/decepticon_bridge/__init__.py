"""decepticon-bridge — expose vendored Decepticon red-team agents to skc.

A Python sidecar that launches an ``skc --mode rpc`` session and registers
the Decepticon agents (``vendor/decepticon``) as skc host tools. The skc
agent can then call ``decepticon_run_agent`` / ``decepticon_list_agents``;
the handlers run here and invoke the vendored Decepticon agent graphs.

Public surface:

- :func:`decepticon_bridge.tools.build_host_tools` — the skc host tools.
- :class:`decepticon_bridge.runner.DecepticonRunner` /
  :class:`decepticon_bridge.runner.AgentRunner` — the agent invocation layer.
- :func:`decepticon_bridge.bridge.run_bridge` — the runnable glue.
- :data:`decepticon_bridge.roster.ROSTER` — the dispatchable agent roster.
"""

from __future__ import annotations

from .roster import ROLE_NAMES, ROLES_BY_NAME, ROSTER, AgentRole
from .runner import AgentRunner, DecepticonRunner, RunResult
from .tools import build_host_tools

__all__ = [
    "AgentRole",
    "AgentRunner",
    "DecepticonRunner",
    "ROLES_BY_NAME",
    "ROLE_NAMES",
    "ROSTER",
    "RunResult",
    "build_host_tools",
]
