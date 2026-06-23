"""``python -m decepticon_bridge`` — launch the red-team bridge."""

from __future__ import annotations

import argparse

from .bridge import run_bridge


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="decepticon-bridge",
        description=(
            "Launch an skc --mode rpc session with Decepticon red-team agents "
            "exposed as host tools (decepticon_run_agent / decepticon_list_agents)."
        ),
    )
    parser.add_argument(
        "-p",
        "--prompt",
        help="Run a single prompt then exit. Omit to read prompts from stdin.",
    )
    parser.add_argument("--model", help="Model id for the skc session.")
    parser.add_argument("--provider", help="Provider for the skc session.")
    parser.add_argument(
        "--recursion-limit",
        type=int,
        default=None,
        help="LangGraph recursion-limit override for dispatched agents.",
    )
    parser.add_argument(
        "--session",
        action="store_true",
        help="Enable skc session persistence (default: no session).",
    )
    parser.add_argument(
        "--interactive",
        action="store_true",
        help="Handle skc UI requests interactively instead of headless.",
    )
    args = parser.parse_args(argv)

    return run_bridge(
        prompt=args.prompt,
        model=args.model,
        provider=args.provider,
        recursion_limit=args.recursion_limit,
        no_session=not args.session,
        headless=not args.interactive,
    )


if __name__ == "__main__":
    raise SystemExit(main())
