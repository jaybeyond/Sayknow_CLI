# Changelog

Sayknow-CLI is a rebranded fork of [gajae-code](https://github.com/Yeachan-Heo/gajae-code).
This file tracks the **fork's own releases**; upstream's full feature history lives
in that project. Each release notes the upstream version it is built on.

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
