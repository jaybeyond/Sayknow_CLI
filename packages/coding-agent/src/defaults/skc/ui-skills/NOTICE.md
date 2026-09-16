# Bundled frontend UI/UX skills

These `SKILL.md` files are vendored from upstream skill repositories so SKC
sessions can invoke frontend UI/UX craft skills without a separate user
install. They are **not** SKC public workflow skills: the four public
workflows remain `deep-interview`, `ralplan`, `ultragoal`, and `team`.

Regenerate with:

```bash
bun scripts/build-ui-skill-bundle.ts \
  --source emilkowalski=<checkout> \
  --source appllama=<checkout>
```

Only `SKILL.md` is compiled into the binary, and a bundled skill's `baseDir`
is a virtual `embedded:skc/...` path. Companion reference files are therefore
inlined into each `SKILL.md` as appendices by the generator; do not add
loose companion files here expecting them to be readable at runtime.

## Sources

| Upstream | License | Vendored skills |
| --- | --- | --- |
| [emilkowalski/skills](https://github.com/emilkowalski/skills) | MIT (`LICENSE.emilkowalski`), Copyright (c) 2026 Emil Kowalski | `emil-design-eng`, `animate`, `review-animations`, `improve-animations`, `find-animation-opportunities`, `pick-ui-library`, `prototype`, `mobile-native`, `animation-vocabulary`, `apple-design`, `ask-sonner` |
| [Appllama/appllama-skills](https://github.com/Appllama/appllama-skills) | MIT (`LICENSE.appllama`) | `appllama-app-design-skill` |

## Deliberate exclusions

- `write-swift`, `animate-expo` (emilkowalski) — not web frontend craft.
- `appllama-usage` (Appllama) — it exists only to drive the paid Appllama MCP
  (`mcp.appllama.io`). SKC neither ships nor enables that connector, so
  bundling it would instruct the agent to call tools that do not exist.
  `appllama-app-design-skill` is upstream-documented as standalone.

- [`Jakubantalik/transitions.dev`](https://github.com/Jakubantalik/transitions.dev) — **not vendored.** Its terms license only the `transitions-dev` CLI and Refine tooling under MIT; the transition collection is governed by a separate "Using the transitions" clause that permits unlimited use in your own projects but forbids repackaging or publishing the collection (or a substantial part of it). SKC therefore never carries the content: the agent installs it into the user's own project on demand via `npx -y skills@latest add Jakubantalik/transitions.dev --skill transitions-dev -a universal -y`. See `hooks/ui-skill-keywords.ts`.
- [`DavidHDev/react-bits`](https://github.com/DavidHDev/react-bits) — **components not vendored.** React Bits is a shadcn component registry, not an agent skill repo (it ships no `SKILL.md`), and its MIT + Commons Clause license forbids selling, sublicensing, or redistributing the components "alone, in a bundle, or as a ported version". The bundled `react-bits` skill is therefore **SKC-authored guidance**: when to reach for the registry, how to install one component (`npx shadcn@latest add @react-bits/<Component>-<Variant>`), the `components.json` precondition, and a factual catalog of component names. No upstream component source is included; components are installed from the registry into the user's own project.

## Trademarks

The Appllama name, llama, and logo are trademarks of Antmind Ventures Private
Limited. The MIT license does not grant rights to use them; they appear here
only to attribute the source of the vendored skill.
