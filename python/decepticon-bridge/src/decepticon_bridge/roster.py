"""Static roster of Decepticon red-team agents exposed through the bridge.

Single source of truth for which agents the bridge can dispatch, kept in
sync with ``vendor/decepticon/langgraph.json`` (the LangGraph graph keys)
and each agent module's docstring / ``SUBAGENT_SPEC``.

This module imports **nothing** from ``decepticon`` so it stays importable
without the heavy vendored runtime (and without Python 3.13). The actual
agent graphs are loaded lazily by ``runner.DecepticonRunner``.
"""

from __future__ import annotations

from dataclasses import dataclass

#: Import path prefix for the vendored standard agents. Each role ``r``
#: resolves to ``f"{_STANDARD_PKG}.{r.name}"`` exposing a module-level
#: ``graph`` constant — the exact target referenced by langgraph.json.
_STANDARD_PKG = "decepticon.agents.standard"


@dataclass(frozen=True, slots=True)
class AgentRole:
    """One dispatchable Decepticon agent."""

    name: str
    summary: str
    orchestrator: bool = False

    @property
    def module(self) -> str:
        """Dotted import path of the vendored agent module."""
        return f"{_STANDARD_PKG}.{self.name}"


# Order: orchestrator first, then kill-chain phases, then domain specialists.
ROSTER: tuple[AgentRole, ...] = (
    AgentRole(
        "decepticon",
        "Autonomous red-team coordinator. Builds an OPPLAN from existing "
        "RoE/CONOPS docs and executes the kill chain by delegating to "
        "specialist sub-agents. Expects an existing engagement (RoE/CONOPS), "
        "not just a bare one-line objective.",
        orchestrator=True,
    ),
    AgentRole(
        "soundwave",
        "Engagement document writer. Generates the eight planning documents "
        "(RoE / CONOPS / Deconfliction / Threat Profile / Contact / Data "
        "Handling / Abort / Cleanup) that frame a fresh engagement.",
    ),
    AgentRole(
        "recon",
        "Reconnaissance & intel gathering: subdomain enumeration, port/service "
        "scanning, vulnerability scanning, OSINT. Black-box, writes findings "
        "to the engagement workspace.",
    ),
    AgentRole(
        "exploit",
        "Initial access & vulnerability exploitation: turns a confirmed "
        "weakness into a foothold (web/service exploits, credential attacks).",
    ),
    AgentRole(
        "postexploit",
        "Post-exploitation: credential access, privilege escalation, lateral "
        "movement, and C2 management from an initial foothold.",
    ),
    AgentRole(
        "analyst",
        "Vulnerability research lane: source-code review, static analysis, CVE "
        "correlation, fuzzing, and exploit-chain construction (white-box).",
    ),
    AgentRole(
        "reverser",
        "Reverse engineering: binary / firmware analysis (Ghidra-backed).",
    ),
    AgentRole(
        "contract_auditor",
        "Smart-contract auditor: Solidity / on-chain vulnerability review.",
    ),
    AgentRole(
        "cloud_hunter",
        "Cloud attack specialist: misconfiguration and privilege-escalation "
        "paths across cloud providers.",
    ),
    AgentRole(
        "ad_operator",
        "Active Directory operator: AD attack-graph analysis and "
        "BloodHound-driven attack paths.",
    ),
    AgentRole(
        "blue_cell",
        "Blue-cell: defensive analysis — detection engineering and "
        "remediation perspective on findings.",
    ),
    AgentRole(
        "phisher",
        "Phishing / social-engineering campaign specialist.",
    ),
    AgentRole(
        "mobile_operator",
        "Mobile (Android / iOS) application and device attack specialist.",
    ),
    AgentRole(
        "wireless_operator",
        "Wireless (Wi-Fi / RF) attack specialist.",
    ),
    AgentRole(
        "osint_operator",
        "OSINT specialist: open-source intelligence collection and analysis.",
    ),
    AgentRole(
        "iot_operator",
        "IoT device attack specialist.",
    ),
    AgentRole(
        "ics_operator",
        "ICS / OT (industrial control systems) attack specialist.",
    ),
    AgentRole(
        "forensicator",
        "Digital forensics specialist.",
    ),
    AgentRole(
        "supply_chain_operator",
        "Supply-chain attack specialist.",
    ),
)

ROLES_BY_NAME: dict[str, AgentRole] = {r.name: r for r in ROSTER}
ROLE_NAMES: tuple[str, ...] = tuple(r.name for r in ROSTER)
