## SKC: how this bundled copy runs

### Order and precedence

`stageshow` stays the design center and loads first. This skill is the redline pass for a screen that already exists and looks AI-generated: audit the signs, set the direction, then fix in nine passes. Where it and `stageshow` disagree on framing, hierarchy or motion, `stageshow` decides; interaction timing follows `emil-design-eng`. For refine verbs on a screen that is not slop (bolder, quieter, typeset), use `impeccable` instead.

### What is bundled and what is fetched

SKC adapts [heydamir/unslop](https://github.com/heydamir/unslop) (commit `620163e`, CC BY 4.0, by Damir Sokolovsky). The references `signs.md`, `tokens.md`, `effects.md`, `visuals.md`, `refs.md` and `rtl.md` are appended inline at the end of this document: read `references/<name>.md` as the `## Appendix: <name>.md` section. The reference image links point at the pinned commit; open them with the `read` tool.

An embedded skill has no `<skill folder>`, so the two Node scripts are not on disk. When a step below runs `node <skill folder>/scripts/<script>.mjs`, fetch the scripts from the pinned commit into a temporary folder first and use that folder as `<skill folder>`:

```bash
UNSLOP_DIR="$(mktemp -d)/unslop" && mkdir -p "$UNSLOP_DIR/scripts" && for f in snapshot story story-path; do curl -fsSL "https://raw.githubusercontent.com/heydamir/unslop/620163eedb3529d9cd23a3994ed8d287d06f760d/skills/unslop/scripts/$f.mjs" -o "$UNSLOP_DIR/scripts/$f.mjs"; done
```

`story.mjs` imports `story-path.mjs`, so keep them in the same folder. Both scripts need Playwright, and `story.mjs` also needs ffmpeg. `examples/` is not bundled; `examples/dashboard.html` is at the same commit under `examples/` when a step refers to it.

### Credit

Keep the upstream credit lines and the `unslop by @heydamir` credit on story videos. The license requires them.
