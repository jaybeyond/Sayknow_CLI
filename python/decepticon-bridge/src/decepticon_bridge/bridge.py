"""Runnable bridge: launch an ``skc --mode rpc`` session with the
Decepticon red-team host tools wired in.

This is the glue layer. The reusable/tested surface lives in
:mod:`decepticon_bridge.tools` and :mod:`decepticon_bridge.runner`; this
module just owns the live :class:`skc_rpc.RpcClient` lifecycle.
"""

from __future__ import annotations

import sys
from collections.abc import Sequence

from skc_rpc import RpcClient

from .runner import AgentRunner, DecepticonRunner
from .tools import build_host_tools


def run_bridge(
    *,
    prompt: str | None = None,
    model: str | None = None,
    provider: str | None = None,
    command: Sequence[str] | None = None,
    recursion_limit: int | None = None,
    no_session: bool = True,
    headless: bool = True,
    runner: AgentRunner | None = None,
) -> int:
    """Start the bridge.

    Args:
        prompt: when given, run one prompt, print the assistant text, exit.
            When ``None``, read prompts from stdin line by line until EOF or
            ``/quit``.
        model / provider: forwarded to the skc RPC session.
        command: custom launch command (e.g. the in-repo Bun entrypoint)
            instead of the default ``skc --mode rpc``.
        recursion_limit: LangGraph recursion-limit override for dispatched
            Decepticon agents.
        no_session: start the skc session without persistence (default).
        headless: install the headless UI policy so the skc agent's own UI
            requests do not block a non-interactive bridge.
        runner: inject a custom :class:`AgentRunner` (tests / SaaS).

    Returns:
        Process exit code.
    """
    tools = build_host_tools(runner or DecepticonRunner(recursion_limit=recursion_limit))

    kwargs: dict[str, object] = {"custom_tools": tools, "no_session": no_session}
    if model:
        kwargs["model"] = model
    if provider:
        kwargs["provider"] = provider
    if command:
        kwargs["command"] = list(command)

    with RpcClient(**kwargs) as client:
        if headless:
            client.install_headless_ui()

        if prompt is not None:
            turn = client.prompt_and_wait(prompt)
            print(turn.assistant_text or "")
            return 0

        for line in sys.stdin:
            text = line.strip()
            if not text:
                continue
            if text in {"/quit", "/exit"}:
                break
            turn = client.prompt_and_wait(text)
            print(turn.assistant_text or "")
    return 0
