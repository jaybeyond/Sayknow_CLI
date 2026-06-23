from __future__ import annotations

import json
from pathlib import Path

import pytest

from decepticon_bridge.roster import ROLE_NAMES, ROLES_BY_NAME, ROSTER

_REPO_ROOT = Path(__file__).resolve().parents[3]
_LANGGRAPH_JSON = _REPO_ROOT / "vendor" / "decepticon" / "langgraph.json"


def test_roster_is_nonempty_and_unique() -> None:
    assert ROSTER, "roster must not be empty"
    names = [r.name for r in ROSTER]
    assert len(names) == len(set(names)), "roster role names must be unique"


def test_lookup_tables_match_roster() -> None:
    assert ROLE_NAMES == tuple(r.name for r in ROSTER)
    assert set(ROLES_BY_NAME) == set(ROLE_NAMES)
    for name, role in ROLES_BY_NAME.items():
        assert role.name == name


def test_modules_target_vendored_standard_package() -> None:
    for role in ROSTER:
        assert role.module == f"decepticon.agents.standard.{role.name}"


def test_exactly_one_orchestrator() -> None:
    orchestrators = [r.name for r in ROSTER if r.orchestrator]
    assert orchestrators == ["decepticon"]


def test_every_role_has_a_summary() -> None:
    for role in ROSTER:
        assert role.summary.strip(), f"{role.name} is missing a summary"


def test_roster_matches_vendored_langgraph_graphs() -> None:
    """Roster must stay in sync with the vendored langgraph.json graph keys."""
    if not _LANGGRAPH_JSON.exists():
        pytest.skip("vendor/decepticon submodule not checked out")
    graphs = json.loads(_LANGGRAPH_JSON.read_text()).get("graphs", {})
    assert set(ROLE_NAMES) == set(graphs), (
        "decepticon_bridge.roster.ROSTER is out of sync with "
        "vendor/decepticon/langgraph.json graphs"
    )
