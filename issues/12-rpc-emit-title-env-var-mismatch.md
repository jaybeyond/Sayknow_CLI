# 12 — `SKC_RPC_EMIT_TITLE` is documented but the code reads `PI_RPC_EMIT_TITLE`

- **Severity:** Low
- **Scope:** `packages/coding-agent/src/modes/rpc/rpc-mode.ts:73-78` (`shouldEmitRpcTitles`), `docs/rpc.md:463`, `docs/environment-variables.md:396`
- **Surface:** RPC mode configuration

## Summary

RPC mode suppresses `setTitle` UI events unless an env var opts back in. The code
reads `PI_RPC_EMIT_TITLE`:

```ts
function shouldEmitRpcTitles(): boolean {
  const raw = $env.PI_RPC_EMIT_TITLE;          // <-- PI_ prefix
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
```

`$env` is a direct passthrough of `Bun.env` (`packages/utils/src/env.ts:220`), so
there is **no `SKC_`→`PI_` aliasing**. But both docs tell users to set
`SKC_RPC_EMIT_TITLE`:

- `docs/rpc.md:463`: "Set `SKC_RPC_EMIT_TITLE=1` to opt back in…"
- `docs/environment-variables.md:396`: `SKC_RPC_EMIT_TITLE` — "Boolean-like flag
  enabling title events in RPC mode".

## Impact

- Setting the documented `SKC_RPC_EMIT_TITLE` has **no effect**; only the
  undocumented `PI_RPC_EMIT_TITLE` works. The in-code comment at
  `rpc-mode.ts:402` also points users to `PI_RPC_EMIT_TITLE`, confirming the doc
  is the outlier.

## Suggested fix

Pick one name and align. Given the public-surface rebrand convention (`skc` /
`SKC_` for user-facing config, per `AGENTS.md`), rename the code to read
`SKC_RPC_EMIT_TITLE`:

```ts
const raw = $env.SKC_RPC_EMIT_TITLE;
```

and update the inline comments at `rpc-mode.ts:402`. (If the `PI_` prefix must be
retained for legacy reasons, accept both and fix the docs — but a single
`SKC_`-prefixed name is consistent with the rest of the documented env surface.)
