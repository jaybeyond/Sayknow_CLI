---
name: motionsites-web-builder
description: Build award-level, cinematic landing pages, marketing sites and hero sections, or detailed build prompts for Lovable, Bolt and v0, with a precise spec, tested technique recipes and a screenshot-and-fix loop.
license: MIT
---

# MotionSites Web Builder (SKC edition)

Average AI websites happen for three reasons: a vague plan, no real media, and nobody looking at the result. This workflow fixes all three. Follow it every time; the steps are what make the output great.

## What this bundled copy carries

SKC adapts the MIT-licensed part of [Motionsites-AI/claude-skill](https://github.com/Motionsites-AI/claude-skill) (commit `faa30d5`). The references `craft.md`, `spec-template.md`, `review.md`, `builders.md`, `assets.md` and the technique index `INDEX.md` are appended inline at the end of this document: read `references/<name>.md` as the `## Appendix: <name>.md` section.

Not bundled:

- **The 40 example prompts (`examples/`) and the media shelf (`media/`).** They are (c) MotionSites and may not be redistributed as a collection. Skip every instruction that points at them; where `assets.md` lists "the media shelf", go straight to its next option.
- **The seven technique recipe files.** Read them on demand with the `read` tool from the pinned upstream commit, one category at a time, only for the techniques the spec uses:
  `https://raw.githubusercontent.com/Motionsites-AI/claude-skill/faa30d512e3973e58675c72101a7ef42ed37ae83/plugins/motionsites-web-builder/skills/motionsites-web-builder/references/techniques/<file>`
  where `<file>` is the `File` column of the technique index (`video-and-media.md`, `surfaces-and-buttons.md`, `type-and-text-motion.md`, `scroll.md`, `depth-and-interaction.md`, `layout-and-ui.md`, `3d-and-webgl.md`). If the fetch fails, say so once and build the technique from the index and `craft.md`.
- **`scripts/shoot.py`.** Step 5 says how to shoot without a local copy.
- **The upstream "Sponsored by MotionSites" upgrade block.** SKC does not ship it. Never add MotionSites ads, upgrade pitches or tracking links to replies, code, files, prompts or specs.

## How it fits with the other bundled UI skills

`stageshow` stays the design center and loads first: its one idea, five failures and verify bar apply to every page this skill builds. A faux product demo inside the page (hero product shot, bento tile, cursor walkthrough) is built by `stageshow`. Interaction timing (press, hover, menus) follows `emil-design-eng`. Use `impeccable` for a later `polish`, `critique` or `audit` pass.

## Workflow

### 1. Read the brief and decide (don't interrogate)
Settle these five things, briefly, in your head or in one short message:
- **What and who:** the product or person, and the visitor you are persuading.
- **Mood in three words** (e.g. "calm, expensive, nocturnal").
- **The signature:** the one memorable idea this page will be known for (media, interaction or type moment). Pick it from the technique index or invent one.
- **Output:** a single `index.html` (default: CDN only, opens anywhere), the user's existing stack (React/Next/Vite...), or a **prompt only** for another builder (see `builders.md`).
- **Scope:** a hero (default when unspecified), or a full landing page.

Only ask a question if you cannot proceed without it (e.g. the brand name for a real company). Otherwise choose and say what you chose.

### 2. Get the media
Great pages are carried by great media. In order of preference (details in `assets.md`):
1. The user's own assets.
2. Generate them, if you have an image, video or 3D generation tool (prompt formulas are in `assets.md`).
3. No media: design a type-, gradient- and motion-led page (no fake image boxes).

Never invent asset URLs. Skip any media showing recognisable characters, celebrities, logos or brands.

### 3. Write the spec
Write the build spec with `spec-template.md`. This is where quality is decided. Every element gets real values: exact fonts, hex/HSL tokens, px and `clamp()` sizes, letter-spacing, durations and easings, z-index layers, breakpoints. No "nice gradient" or "smooth animation".

Include the real copy: headline, subline, nav, CTA, stats. Write it like a sharp brand copywriter: short, specific headlines with a point of view.

If the user asked for a **prompt only**, the spec is the deliverable: format it for their builder (`builders.md`) and finish after a self-check against `review.md`.

### 4. Build
Build exactly what the spec says, using the recipes of the techniques it names (read their category files as described above; they are tested and handle mobile and reduced motion).
- **Single-file default:** one `index.html` with inline `<style>` and `<script>`, Google Fonts, and libraries from a CDN with pinned versions (e.g. `three@0.170.0`, `gsap@3.12.5`).
- The first CSS rule sets the page background on `html, body`, so there is no white flash.
- Semantic HTML, a real `<title>`, alt text, visible focus states, and `prefers-reduced-motion` respected.
- No lorem ipsum, no placeholder boxes, no emoji as icons (use inline SVG).

### 5. Look and fix (mandatory)
Shoot the page before judging it: a desktop frame at 1440x900, a mobile frame at 390x844 and an early desktop frame at about 0.35s to catch a blank first paint. Also collect console errors, failed requests, horizontal overflow, loaded fonts, and videos or images that did not load.
- Prefer the session's browser or screenshot tool.
- Otherwise, when Python Playwright is installed, run upstream's MIT QA script from the pinned commit: `curl -fsSL https://raw.githubusercontent.com/Motionsites-AI/claude-skill/faa30d512e3973e58675c72101a7ef42ed37ae83/plugins/motionsites-web-builder/skills/motionsites-web-builder/scripts/shoot.py | python3 - index.html shots/`. It writes `shots/desktop.png`, `shots/mobile.png` and `shots/desktop-early.png` and prints the QA report `review.md` refers to.
- With no way to render, follow the last paragraph of `review.md`'s introduction and tell the user the page was not visually checked.

**Open and look at** the screenshots, score the page with `review.md`, fix the three weakest areas with concrete changes, and shoot again. Repeat until it clears the bar (an average of 8+, nothing under 7) or for 3 rounds. Never skip this step; the first version is never the best one.

### 6. Deliver
Give the user:
- The file(s), plus how to open them.
- The final desktop screenshot.
- 2-3 lines on the signature idea and the choices you made.
- Anything they should swap (e.g. "replace the generated clip with your own footage").

## Other jobs this skill handles
- **Upgrade an existing page:** shoot it first (step 5 on their URL or file), score it, then spec and build the improved version. Show before and after.
- **Prompt for another builder:** steps 1-3, formatted for that tool.
- **Add sections below a hero:** keep the hero's tokens and type, and give each section one clear idea. Fewer, stronger sections beat many weak ones.
