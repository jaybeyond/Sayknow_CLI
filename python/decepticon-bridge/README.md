# decepticon-bridge

Expose the vendored [Decepticon](https://github.com/PurpleAILAB/Decepticon)
red-team agents (`vendor/decepticon`, git submodule) to the `skc` coding
agent as **host tools**.

This is integration path **B**: a Python sidecar that imports the Decepticon
SDK and bridges it to skc over the existing `skc --mode rpc` protocol — no new
wire protocol, reusing `skc-rpc`'s host-tool mechanism.

## Topology

```
                 host tools (JSONL/stdio, skc-rpc)
  ┌────────────────────────────┐        ┌───────────────────────────┐
  │  decepticon-bridge (this)  │  spawns│      skc --mode rpc       │
  │  RpcClient(custom_tools=…)  ├───────▶│   (the sayknow-cli agent) │
  │                            │        │                           │
  │  decepticon_run_agent  ◀───┼────────┤  agent calls the tool     │
  │  decepticon_list_agents    │        └───────────────────────────┘
  │        │ lazy import                                              
  │        ▼                                                          
  │  vendor/decepticon agent graphs  ──▶  LiteLLM / Kali sandbox / Neo4j
  └────────────────────────────┘            (Decepticon Docker stack)
```

The bridge process is the RPC **host**: it launches an skc session and
registers two agent-callable tools whose handlers run here in Python:

- `decepticon_list_agents` — list the dispatchable agents and what each does.
- `decepticon_run_agent(role, objective)` — run one Decepticon specialist
  agent on an authorized objective and return its findings.

## Requirements

The bridge core (roster, runner contract, host tools) only needs `skc-rpc`.
**Actually running an agent** additionally needs:

1. The vendored Decepticon packages importable in this environment
   (**Python 3.13**).
2. The Decepticon runtime services up (LiteLLM proxy, Kali sandbox, Neo4j) —
   see `vendor/decepticon/docs/architecture.md`. The SDK is a client that
   routes LLM + sandbox execution to those services; it does not run them.

If Decepticon is not importable, `decepticon_run_agent` returns a clear,
actionable error instead of crashing the bridge.

## Install (dev)

```sh
# from the repo root
git submodule update --init vendor/decepticon

uv venv --python 3.13 .venv
uv pip install --python .venv \
  -e python/skc-rpc \
  -e python/decepticon-bridge

# Decepticon runtime (Python 3.13), pinned to the vendored submodule commit:
uv pip install --python .venv \
  -e vendor/decepticon/packages/decepticon-core \
  -e vendor/decepticon/packages/decepticon
```

> The `redteam` extra (`pip install -e python/decepticon-bridge[redteam]`)
> pulls Decepticon from PyPI instead — use the editable installs above to stay
> pinned to the exact submodule commit.

## Run

```sh
# one-shot prompt
decepticon-bridge --model anthropic/claude-sonnet-4-5 \
  -p "List the available red-team agents, then run recon against in-scope host 10.0.0.5"

# interactive (prompts from stdin)
decepticon-bridge --model anthropic/claude-sonnet-4-5

# develop against the in-repo Bun entrypoint instead of an installed skc:
python -m decepticon_bridge --help
```

## Tests

Unit tests inject a fake runner, so they need **neither** Decepticon **nor**
the service stack:

```sh
uv pip install --python .venv -e python/decepticon-bridge[test]
.venv/bin/pytest python/decepticon-bridge/tests
```

## Safety

Decepticon executes real offensive tooling. The bridge does not weaken any of
Decepticon's own safety gates (RoE/engagement context, `ask_user_question`,
mandatory handoff). Only point it at targets you are authorized to test.
