# Notices

Sayknow-CLI is an **independently developed, MIT-licensed** project. It descends
from the original MIT work of Mario Zechner and Can Bölük and extends that
lineage substantially with its own features, workflows, tooling, and brand. It
is **not** maintained or endorsed by the original authors.

As the MIT License requires, the original authors' copyright notices are
retained in [`LICENSE`](LICENSE) alongside Sayknow-CLI's own copyright.

Sayknow-CLI also builds on lessons from a small family of agent harnesses and keeps
attribution visible:

- [`oh-my-pi`](https://github.com/jaybeyond/oh-my-pi) — the upstream red-octopus lineage and implementation DNA.
- [`oh-my-codex`](https://github.com/jaybeyond/oh-my-codex) — Codex-focused orchestration experiments.
- [`oh-my-claudecode`](https://github.com/jaybeyond/oh-my-claudecode) — Claude Code workflow exploration.

## Vendored submodules

- [`Decepticon`](https://github.com/PurpleAILAB/Decepticon) — vendored at `vendor/decepticon` (git submodule, Apache License 2.0). Autonomous Red Team agent by PurpleAILAB; license in `vendor/decepticon/LICENSE`.
- [`emilkowalski/skills`](https://github.com/emilkowalski/skills) — vendored at `packages/coding-agent/src/defaults/skc/ui-skills` (MIT License, Copyright (c) 2026 Emil Kowalski). Bundled frontend UI/UX craft skills; license in that directory's `LICENSE`.
- [`Appllama/appllama-skills`](https://github.com/Appllama/appllama-skills) — vendored at `packages/coding-agent/src/defaults/skc/ui-skills` (MIT License). Bundled native mobile app-design skill; license in that directory's `LICENSE.appllama`. The Appllama name and logo are trademarks of Antmind Ventures Private Limited and are used only for attribution.
