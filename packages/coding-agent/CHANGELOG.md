# Changelog

Sayknow-CLI is a rebranded fork of [gajae-code](https://github.com/Yeachan-Heo/gajae-code).
This file tracks the **fork's own releases**; upstream's full feature history lives
in that project. Each release notes the upstream version it is built on.


## [0.4.5] — 2026-07-23

### Added (Sayknow Pet in tmux)

- **Auto-enable the Sayknow Pet (and inline sixel graphics) under tmux when the
  outer terminal genuinely supports sixel.** Previously graphics were
  unconditionally suppressed under any multiplexer because tmux advertises
  compile-time sixel support (`DA1 ";4"`) regardless of the attached terminal,
  and no code emitted the DCS passthrough envelope. Now:
  - The startup sixel capability probe runs under tmux with its DA1 +
    XTSMGRAPHICS queries wrapped in tmux's `\ePtmux;…\e\\` passthrough envelope,
    so the **outer** terminal answers — a positive reply is genuine end-to-end
    evidence, not tmux's unreliable self-report. screen/zellij (no passthrough
    envelope) stay suppressed.
  - Sixel render output (pet frames + inline images) is wrapped in the same
    passthrough envelope under tmux.
  - SKC-launched tmux sessions set `allow-passthrough on` (pane-scoped, quiet on
    tmux < 3.3) automatically.
  - Probe-gated and safe: terminals that do not actually render sixel through
    tmux (e.g. Ghostty, which uses the kitty protocol and has no sixel) never
    activate it, so no garbage escapes are emitted. Set `SKC_SIXEL_MULTIPLEXER=0`
    to force the pre-0.4.5 behavior (graphics off under tmux).

## [0.4.4] — 2026-07-22

### Fixed (workflow arbitration native)

- **Port `skc-notifications` to upstream v0.11.6 and switch pi-natives to
  `sdk.rs`.** 0.4.x synced upstream's coding-agent, whose SDK bus requires the
  native `NotificationServer` arbitration API (`registerArbitratedAsk`,
  `retireIfUnclaimed`, `stopAndWait`). But the fork's `skc-notifications` crate
  was stuck at upstream v0.9.1, so `crates/pi-natives/src/sdk.rs` (restored from
  v0.11.6) could not compile against it and was dropped from `lib.rs`. The
  shipped `notifications.rs` `NotificationServer` lacked the arbitration
  methods, so every SDK session startup threw `NativeRuntimeCompatibilityError`
  ("required workflow arbitration methods are missing") — extensions failed to
  load and no session could start on 0.4.1–0.4.3.
- Upgrades `crates/skc-notifications` v0.9.1 → v0.11.6 (adds the
  `broker_protocol`/`control`/`query`/`reverse` modules and the `hmac` workspace
  dependency), wires `mod sdk;` and retires `notifications.rs`. This restores
  the arbitration API **and** the SKC v3 SDK connection lane
  (`onSdkFrame`/`sendTo`/`onConnectionClose`/`registerWorkflowGateAsk`/
  `pushTurnStreamUnchecked`), which was also dead in 0.4.1–0.4.3. No native
  method that the fork already relied on is removed (`sdk.rs`'s
  `NotificationServer` is a strict superset of `notifications.rs`).

## [0.4.3] — 2026-07-21

### Fixed (cross-platform native publish)

- **pi-natives ps.rs: restore `Process.incarnation` getter.** The fork's
  `crates/pi-natives/src/ps.rs` predated upstream v0.11.x's
  `#[napi(getter)] incarnation` method; the chat/telegram daemon control
  runtimes (`sdk/bus/{chat,telegram}-daemon-control.ts`) read
  `processRef.incarnation` for ownership authority, so typecheck failed
  with `Property 'incarnation' does not exist on type 'Process'`.
- **sdk/bus/index.ts: use `NotificationServer.stop()` instead of `stopAndWait()`.**
  The fork's `NotificationServer` (notifications.rs) is synchronous and
  pre-upstream-split; the v0.11.x TS calls `stopAndWait()` which is the
  upstream async variant. TODO(port): add `stop_and_wait` to
  pi-natives/src/notifications.rs when the daemon API is ported forward.

### Strategy change

v0.4.3 is published entirely by CI (no local `bun publish`). v0.4.2's
release hit an integrity-evidence conflict because the darwin-arm64
subpackage was published both locally (from a Mac-built .node) and from
CI (from a CI-built .node) with different SRI hashes; `ci-release-publish`
correctly rejected the second one. For v0.4.3 all 9 main packages + 5
platform subpackages publish from a single CI run.

## [0.4.2] — 2026-07-21

### Fixed (post-0.4.0 publish)

- **Native loader: nested node_modules fallback.** Bun's `-g` install creates a
  nested layout where each workspace package owns its own `node_modules/`. The
  loader's single hardcoded platform-subpackage path
  (`../../natives-<platform>/native`) assumed npm's flat hoist, so `bun install
  -g sayknow-cli` could not resolve the .node and crashed at startup with
  `Failed to load pi_natives native addon`. Added a third candidate path that
  covers `natives/node_modules/@sayknow-cli/natives-<platform>/native`.
- **Catalog resolution via `bun install`.** v0.4.0 was published with stale
  `bun.lock` workspace versions (still pinned to 0.3.16), so `bun publish`
  resolved `catalog:` deps to 0.3.16 and the umbrella ended up depending on
  the previous release's `@sayknow-cli/coding-agent`. v0.4.2 republishes after
  regenerating `bun.lock` from the bumped catalog (0.4.2 everywhere).
- **Native version sentinel.** Rebuilt `pi_natives.darwin-arm64.node` after the
  version bump so it exposes `__piNativesV0_4_2` (the v0.4.0 binary's
  `__piNativesV0_4_0` failed the loader's release-match check).

### Deprecated (on npm)

- `sayknow-cli@0.4.0` and `@sayknow-cli/*@0.4.0` — broken catalog: resolution.
- `sayknow-cli@0.4.1` and `@sayknow-cli/*@0.4.1` — loader missing nested
  `node_modules` fallback.

## [0.4.0] — 2026-07-21

### Changed

- Synced onto upstream **gajae-code v0.11.6** (from v0.6.0), a 5-minor-version jump
  bringing v0.7–v0.11 evolution: managed chat daemon (#2782, #2785, #2786), Telegram
  lock auto-reconciliation (#2781), compiled startup import-cycle fix (#2779), legacy
  daemon tombstone reclamation (#2780), nextest CI hardening (#2777), and the new
  `/handoff` slash command (#2746).
- Rebrand layer regenerated via `extract-fork-layer`: **485 overlay files** (was 188) —
  captures fork-owned content in `notifications/`, `modes/rpc/`, `modes/bridge/`,
  `modes/shared/agent-wire/`, `python/skc-rpc/`, and `crates/skc-notifications/` that
  prior extractions had missed.
- CI workflow: `sayknow-v*` tag prefix now drives every release-gated job
  (`native`, `binaries`, `publish`) via a global prefix check.
- `crates/pi-natives` overlay now ships the fork's actual `skc-notifications` path
  dep instead of the codemod-renamed `skc-sdk` straggler.

### Added

- **SDK subpath exports.** `@sayknow-cli/coding-agent/sdk` and `./sdk/bus/*` are now
  declared in `package.json#exports`, matching upstream's `sdk/` directory split.
- **MRU-aware model fallback** ported from old `sdk.ts` into `sdk/session.ts`:
  when no model is explicitly selected, the fallback ranks candidates by
  most-recently-used, then each provider's curated default, then catalog order
  (was first-catalog-match, which cold-started users on ancient models).
- **i18n: settings tabs.** New `settings.tab.notifications` key; the
  `td()`-wrapped setting label/description/options helpers in `settings-selector.ts`
  cover all tabs including `integrations` and `notifications`.
- **Team runtime fork extensions** now declared in `SkcTeamStartOptions` /
  `SkcTeamConfig`: `mailboxDeliveryTransport`, `skc_session_id`, `platform`.
  `WorkerHeartbeatFile` / `WorkerStatusFile` are now properly exported from
  `team-runtime.ts`.

### Removed

- **Dead patches dropped** from the rebrand manifest:
  - `ci-release-publish.ts` patch — superseded by upstream's richer retry loop
    (`visibilityRetries`, `isTransientVisibilityError`).
  - `sdk.ts` `guardToolForUltragoalAsk` simplification — upstream expanded the
    signature with `UltragoalAskGuardContext`; the fork's single-arg form is obsolete.
  - `interactive-mode.ts` `getPlanReviewHelpText` `t("nav.hint")` — the function was
    removed upstream when plan review moved to `plan-preview-overlay.ts`.

### Known issues (test debt)

- 67 test errors remain from upstream API drift (`model-profile-activation`,
  `model-registry`, `sdk-*`, etc.). All product code typechecks clean (0 src errors)
  and brand/i18n/welcome suites pass (40/40). Test mock migration is filed as a
  follow-up.

## [0.3.0] — 2026-06-23

### Changed

- Synced onto upstream **gajae-code v0.7.1** (from v0.6.5), bringing 0.7.0's mobile
  notifications SDK + managed Telegram daemon and 0.7.1's fixes (assistant
  notification lead-in, stale tmux session reuse, packaged native imports, and the
  glm-zcode Z.AI provider) while preserving the Sayknow-CLI brand.

### Added

- **Decepticon red-team integration.** Vendored [Decepticon](https://github.com/PurpleAILAB/Decepticon)
  as a git submodule (`vendor/decepticon`) plus `python/decepticon-bridge` — an
  `skc-rpc` host-tool bridge that exposes Decepticon's red-team agents to skc
  (`decepticon_run_agent` / `decepticon_list_agents`).
- **Ponytail default rule.** Bundled the ponytail "lazy senior dev" ruleset as an
  always-on default rule: pick the simplest working solution first (YAGNI, reuse,
  stdlib/native first) without ever cutting validation, error handling, security,
  or accessibility. Adapted from [ponytail](https://github.com/DietrichGebert/ponytail) (MIT).

## [0.2.7] — 2026-06-23

### Added

- **Plugin install security scan (advisory).** Newly installed plugins/skills are now
  statically scanned before activation for risky patterns — `curl|bash` download-and-exec,
  `eval`/dynamic import, credential/secret access, obfuscation, cron persistence, and
  package-install markers — with risk scoring. Findings surface as warnings in the install
  output and in `plugin doctor`. Controlled by `plugins.security.scanMode`
  (`warn` = default, `off`, `block`) and `plugins.security.riskThreshold`. Warn-only by
  default — it never blocks an install unless you opt into `block` mode.

## [0.2.6] — 2026-06-22

### Fixed

- The welcome screen's "Updated to vX" line now reflects the running release.
  0.2.5 shipped without its own changelog entry, so a fresh launch reported
  "Updated to v0.2.4"; every release now carries a matching entry.

## [0.2.5] — 2026-06-22

### Changed

- Synced onto upstream **gajae-code v0.6.5** (from v0.6.0), bringing its latest
  features and fixes while preserving the Sayknow-CLI brand. The new welcome
  logo-mode support renders the blue **SAYKNOW** wordmark in every mode.

### Fixed

- Hardened shutdown against terminal/volume I/O errors: an asynchronous EIO/EPIPE
  stdout write failure during teardown (controlling terminal hang-up or a stalled
  external volume) is now swallowed instead of crashing the process into a
  "[Process exited] — press any key to restart" loop.
- Regenerated the bundled config JSON schema so it matches the v0.6.5 settings.

## [0.2.4] — 2026-06-19

### Added

- The model selector is now fully localized — the preset list ("Model presets",
  "Create custom preset", "Browse all models"), the apply/default scope menu,
  action menus, and hints follow the interface language. Model and provider names
  (Claude, Codex, …) stay verbatim.

### Fixed

- Release builds no longer fail spuriously on a timing-flaky pi-shell
  process-reaping test: the Rust test runner now retries flaky tests
  (`cargo nextest --retries 2`).

## [0.2.3] — 2026-06-19

### Fixed

- `skc update` and the binary installer pointed at a non-existent repo path
  (`jaybeyond/sayknow-cli`, lowercased by the rebrand) and 404'd. They now use the
  real repo `jaybeyond/Sayknow_CLI`, so in-app updates and the install script work.

### Changed

- **Now on npm.** Install and upgrade with `npm install -g sayknow-cli`
  (`@latest` to upgrade, or `skc update`). The READMEs lead with the npm install;
  building from source moved to its own "Install from source (development)" section.

## [0.2.2] — 2026-06-18

### Fixed

- Model selection on a fresh launch (no saved default, no session to restore) now
  resumes the model you used last — and brand-new users land on a modern default —
  instead of cold-starting onto the oldest model in the catalog.
- The model selector no longer lets the "log in for an unauthenticated preset" flow
  hijack the selection of an already-authenticated model.
- Continuous integration is green: the rebrand codemod now re-applies Biome's
  organize-imports/format pass, the fork version is stamped into the native version
  sentinel, the generated JSON schemas are current, and the default-theme references
  are consistent across runtime, settings, and docs.

### Changed

- The default theme is **blue-octopus** for both dark and light terminals, with
  **red-octopus** as the bundled warm, high-contrast alternate.

## [0.2.0] — 2026-06-18

### Changed

- Synced onto upstream **gajae-code v0.6.0** (52 commits, +27k lines), bringing its
  new features and fixes — including the opt-in `skc rlm` research mode, the goal
  `pause` operation, steer-by-default while busy, and the experimental
  desktop-control tool surface — while preserving the Sayknow-CLI brand and the
  improvements below.

## [0.1.0] — 2026-06-17

Initial Sayknow-CLI release, forked from gajae-code v0.5.4.

### Added

- **Internationalization — 7 languages:** English, 한국어, 中文 (简体), 日本語,
  Español, Français, Deutsch. System-locale auto-detection on first run, a
  `Settings → Appearance → Language` switch, and translated settings, slash-command
  descriptions, status/error messages, and the welcome screen. Brand and technical
  names (Claude, OpenAI, MCP, …) stay verbatim. Localized READMEs live under
  `docs/readme/`.
- **Blue-octopus identity:** a blue octopus mascot 🐙, the `blue-octopus` default
  theme (with a warm `red-octopus` alternate), a `SAYKNOW` wordmark welcome screen,
  and the tagline _"Coding should feel like thinking."_
- **Richer status bar:** a visual context-usage bar plus input/output tokens, cache
  reads, token rate, cost, rate-limit quota, and elapsed time.

### Changed

- Rebranded `gajae-code` → **Sayknow-CLI** (`skc`, `@sayknow-cli/*`) and reset the
  version to 0.1.0.
- The model selector now starts OAuth login directly when you pick an
  unauthenticated preset, instead of only printing a hint.
- The input caret now shows as soon as the composer is focused, not only after the
  first keystroke.

### Fixed

- OAuth login: guard against concurrent logins and let `Esc` cancel an in-flight
  login — previously two logins could collide on the fixed callback port and freeze
  the UI with no way back.

### Removed

- The GitHub star reminder is disabled by default.
