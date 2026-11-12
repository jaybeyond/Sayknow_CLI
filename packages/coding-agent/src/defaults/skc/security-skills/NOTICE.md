# Bundled security review skill

`security-review/SKILL.md` lets SKC sessions run a white-box security review of
the user's own code without a separate install. It is **not** an SKC public
workflow skill: the four public workflows remain `deep-interview`, `ralplan`,
`ultragoal`, and `team`.

Regenerate with:

```bash
bun scripts/build-ui-skill-bundle.ts --source usestrix=<checkout>
```

Only `SKILL.md` is compiled into the binary, and a bundled skill's `baseDir`
is a virtual `embedded:skc/...` path. The vendored documents are therefore
inlined into `SKILL.md` as appendices by the generator; do not add loose
companion files here expecting them to be readable at runtime.

## Source

| Upstream | License | Vendored |
| --- | --- | --- |
| [usestrix/strix](https://github.com/usestrix/strix) at `685bbc8` (Strix 1.7.1) | Apache-2.0 (`LICENSE.usestrix`), Copyright 2025 OmniSecure Inc. | `security-review`: SKC-authored entry (`scripts/ui-skill-overlays/security-review.entry.md`) with `strix/skills/analysis/source_aware_discovery.md`, `counterevidence.md`, `severity_calibration.md`, `fix_verification.md` and `strix/skills/scan_modes/diff.md` inlined |

Modified by SKC: each vendored document loses its YAML frontmatter, and its
Jinja `{% if coverage_tools %}` conditionals are resolved to the branch without
Strix's coverage ledger tools (`record_coverage`, `update_coverage`), which SKC
does not have. The text is otherwise unchanged. The entry maps the remaining
Strix report fields to SKC's report format and adds SKC's scope and
authorization rules, which outrank the appendices.

## Deliberate exclusions

- **The Strix runtime**: the Python agent graph, Docker sandbox, intercepting
  proxy, browser, TUI and cloud client. An embedded skill cannot carry them, and
  SKC reviews source with its own tools.
- **The upstream agent skills** (`skills/*/SKILL.md`): each one only drives the
  `strix` CLI or the managed Strix platform.
- **The live-testing playbooks**: `vulnerabilities/`, `reconnaissance/`,
  `tooling/`, `cloud/`, `technologies/`, `frameworks/`, `protocols/`, and the
  `quick`, `standard` and `deep` scan modes. They direct tests against a running
  target. This skill reviews code the user owns and never sends test input to a
  system it was not told to test.
- **`custom/source_aware_sast.md` and `custom/dependency_cve_scanning.md`**:
  both are written around Strix's sandbox paths and its `create_dependency_report`
  tool. The entry's scanner step covers the same ground with whatever audit tools
  are already installed.
