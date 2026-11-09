# Bundled frontend UI/UX skills

These `SKILL.md` files are vendored from upstream skill repositories so SKC
sessions can invoke frontend UI/UX craft skills without a separate user
install. They are **not** SKC public workflow skills: the four public
workflows remain `deep-interview`, `ralplan`, `ultragoal`, and `team`.

Regenerate with:

```bash
bun scripts/build-ui-skill-bundle.ts \
  --source emilkowalski=<checkout> \
  --source appllama=<checkout> \
  --source benjitaylor=<checkout> \
  --source pbakaus=<checkout> \
  --source motionsites=<checkout>
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
| [benjitaylor/skills](https://github.com/benjitaylor/skills) at `299140f` (Stageshow 1.1.1, [write-up](https://benji.org/stageshow)) | MIT (`LICENSE.benjitaylor`, from `stageshow/LICENSE`), Copyright (c) 2026 Benji Taylor | `stageshow` (`SKILL.md`, `references/*.md` and `NOTICE.md` inlined) |
| [pbakaus/impeccable](https://github.com/pbakaus/impeccable) at `613fbf8` (Impeccable 4.8.1, `.pi` build) | Apache-2.0 (`LICENSE.pbakaus`), Copyright 2025 Paul Bakaus | `impeccable` (`SKILL.md` and 17 engine-free `reference/*.md` files inlined, see exclusions). Modified by SKC: subset of references plus the overlay below |
| [Motionsites-AI/claude-skill](https://github.com/Motionsites-AI/claude-skill) at `faa30d5` | MIT for the instructions, references and scripts (`LICENSE.motionsites`), Copyright (c) 2026 MotionSites | `motionsites-web-builder`: SKC-authored entry (`scripts/ui-skill-overlays/motionsites-web-builder.entry.md`, adapted from the upstream workflow) with `references/*.md` and `references/techniques/INDEX.md` inlined |

## SKC overlays

`scripts/ui-skill-overlays/<skill>.md` holds SKC-authored sections that the
generator splices into a vendored skill right after its `## SKC invocation`
block, so a regeneration keeps them.

| Overlay | Purpose |
| --- | --- |
| `stageshow`: "SKC: the design center — mandatory for all frontend work" | Makes Stageshow the bar for every frontend surface, says which rules apply to real UI versus faux UI, and how it fits with the other bundled skills |
| `emil-design-eng`: "Stageshow is the design center — mandatory" | Points the craft baseline at `stageshow` and defers conflicts to it |
| `impeccable`: "SKC: how this bundled copy runs" | Keeps `stageshow` as the design center, routes around the unbundled engine (`scripts/impeccable` launcher, detector, live mode, hooks), and maps every unbundled reference to the SKC skill that covers it |

A layout `entry` replaces the upstream `SKILL.md` with an SKC-authored one while
the companion references are still vendored. `motionsites-web-builder` uses it
because the upstream `SKILL.md` makes a paid-upgrade ad with tracking links part
of every delivery and drives the non-redistributable examples and media.

The Stageshow kit, examples, `teaching/`, filming scripts and playground are not
vendored: they are React/TS sources (unreadable from an embedded skill) and
include app-icon artwork the Stageshow MIT license does not cover. The overlay
tells the agent to install the full skill into the user's project for faux UI
builds with `npx -y skills@latest add benjitaylor/skills --skill stageshow -a universal -y`.

Impeccable's engine-dependent and overlapping references are not vendored:
`new-work`, `craft`, `shape`, `init` (owned by `stageshow`), `animate`, `delight`
(owned by `animate`), `ios`, `android`, `*.native` (owned by
`appllama-app-design-skill` and `mobile-native`), `live`, `live-setup`,
`generate` (owned by `prototype`), and `routing`, `document`, `extract`,
`onboard`, `optimize`, `overdrive`, `visualize`, `component-review`,
`region-map`, `hooks`, `doctor`, `degraded/*`. The engine launcher downloads a
native binary on first run, which an embedded skill cannot carry; the overlay
skips its steps and takes upstream's own "Launcher unavailable" path.

## Deliberate exclusions

- `write-swift`, `animate-expo` (emilkowalski) — not web frontend craft.
- `appllama-usage` (Appllama) — it exists only to drive the paid Appllama MCP
  (`mcp.appllama.io`). SKC neither ships nor enables that connector, so
  bundling it would instruct the agent to call tools that do not exist.
  `appllama-app-design-skill` is upstream-documented as standalone.

- [`Jakubantalik/transitions.dev`](https://github.com/Jakubantalik/transitions.dev) — **not vendored.** Its terms license only the `transitions-dev` CLI and Refine tooling under MIT; the transition collection is governed by a separate "Using the transitions" clause that permits unlimited use in your own projects but forbids repackaging or publishing the collection (or a substantial part of it). SKC therefore never carries the content: the agent installs it into the user's own project on demand via `npx -y skills@latest add Jakubantalik/transitions.dev --skill transitions-dev -a universal -y`. See `hooks/ui-skill-keywords.ts`.
- [`DavidHDev/react-bits`](https://github.com/DavidHDev/react-bits) — **components not vendored.** React Bits is a shadcn component registry, not an agent skill repo (it ships no `SKILL.md`), and its MIT + Commons Clause license forbids selling, sublicensing, or redistributing the components "alone, in a bundle, or as a ported version". The bundled `react-bits` skill is therefore **SKC-authored guidance**: when to reach for the registry, how to install one component (`npx shadcn@latest add @react-bits/<Component>-<Variant>`), the `components.json` precondition, and a factual catalog of component names. No upstream component source is included; components are installed from the registry into the user's own project.
- [`Motionsites-AI/claude-skill`](https://github.com/Motionsites-AI/claude-skill) — **examples, media and the upgrade ad not vendored.** Its `examples/` (40 prompts) and `media/` (contact sheets and linked videos/images) are (c) MotionSites and may not be redistributed as a collection, so they are not carried. The upstream `SKILL.md` requires a MotionSites upgrade block with UTM links in every delivery; SKC ships its own entry without it. The seven `references/techniques/*.md` recipe files (MIT, ~285 KB) are not inlined either: the entry has the agent `read` them on demand from the pinned commit `faa30d5`, and run the MIT `scripts/shoot.py` from that commit when Python Playwright is available.

## Trademarks

The Appllama name, llama, and logo are trademarks of Antmind Ventures Private
Limited. The MIT license does not grant rights to use them; they appear here
only to attribute the source of the vendored skill.
