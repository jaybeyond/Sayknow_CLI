---
name: motionsites-web-builder
description: Build award-level, cinematic landing pages, marketing sites and hero sections, or detailed build prompts for Lovable, Bolt and v0, with a precise spec, tested technique recipes and a screenshot-and-fix loop.
license: MIT
---

# MotionSites Web Builder (SKC edition)

## SKC invocation

SKC loads this skill automatically for matching frontend UI/UX work.
Do not wait for a follow-up question. Apply the craft rules immediately
and keep going on the user's actual task.

This skill's companion reference files are appended inline at the end of
this document. Read them there; they are not separate files on disk.


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

---

## Appendix: assets.md

# Media: sourcing, generating, preparing

Great pages are carried by their media. Choose it before you design the layout around it.

## Order of preference
1. **The user's assets.** Ask once if the brief clearly needs them (a product photo, footage, a logo). Otherwise don't block on it.
2. **Generate them** if you have an image or video generation tool. Use the formulas below.
3. **The media shelf** (`media/MEDIA.md` + `media/sheet-*.jpg`):
   - Open the contact sheets, look at them, and pick by eye. Match:
     - the **edge colour** to your intended page background;
     - the **subject position** to the side opposite your text;
     - the **palette** to the brand;
     - the **motion type** (ambient loop vs. something you'll scrub).
   - Use the URL exactly as listed.
   - Skip anything showing recognisable characters, celebrities, logos or brands.
   - "Site preview" entries are screenshots of finished designs. Use them only as project thumbnails in a portfolio grid, never as a hero background.
   - Tell the user which shelf items you used and that they're stand-ins they may want to replace.
4. **No media.** Build a type-led hero, for example:
   - mega word at 14–28vw with mono labels;
   - monochrome + grain + one soft directional light falloff (≤8% alpha, static);
   - a dot grid at 5%;
   - a large inline-SVG mark.

   Never use grey placeholder boxes, random stock photos or lorem-picsum.

**Before you rely on any URL,** check it's alive (a quick ranged GET, or the QA report from `scripts/shoot.py`). Never invent URLs or file paths you don't have.

## What makes hero media work
- **One subject, one continuous shot, no cuts.** Slow motion: gentle orbit, drift, float, turn in place, a slow push-in. Nothing enters or leaves the frame.
- **Loopable:** the end matches the start, or the loop is masked with a fade, boomerang or crossfade.
- **Edges fall off to one flat colour** that becomes the page background, so no seams and no overlay are needed.
- **A defined empty zone** (left half, top 35–40%, or bottom band) where the copy sits for the entire loop.
- **A restrained palette:** 2–3 hues, plus one luminous highlight (rim light, glow, sunset band) against a dark or neutral field.
- **A cinematic grade:** 24fps, soft volumetric light, shallow depth of field. Often a CGI render or illustration rather than stock photography.
- **No text, logos, UI or watermark** inside the footage.
- **Paired stills** (spotlight reveal, parallax layers) must be pixel-aligned: the same composition in two materials or separated layers.

**Archetypes that work:**
- an isolated object in a seamless void (glass, chrome, silk, a floating island);
- a stylised 3D character on a saturated flat backdrop;
- a painterly landscape with a low horizon and a tiny figure;
- a surreal minimal scene (a silhouette walking toward a glowing portal);
- a studio product or fashion shot on white seamless;
- photoreal nature b-roll as switchable moods;
- abstract terrain with a single rim glow.

## Placing media
- **Background video:** `position:absolute; inset:0; width:100%; height:100%; object-fit:cover` with `autoplay muted loop playsinline preload="auto"`. Give it a `poster` when you have one.
- **Focal control:** use `object-position` (e.g. `70% center`), oversize to 110–120% (top-aligned), or translate offsets, so the subject lands away from the text.
- **Mobile:** re-aim `object-position`, or move the media below the text in a square or 4:5 frame.
- **Cut-outs:** `object-fit: contain; object-position: bottom`, sized by viewport height. Use `draggable="false"` and `pointer-events: none`, and preload with `new Image()`.
- **Tiles:** a rounded container with `overflow: hidden` and a fixed aspect ratio. On hover, scale 1.05 over 700ms. Use a bottom gradient only where text sits on the tile.
- **HLS (`.m3u8`):** use native playback where `video.canPlayType('application/vnd.apple.mpegurl')` succeeds, otherwise hls.js.
- **Decorative media** gets `alt=""` / `aria-hidden="true"`. Meaningful images get real alt text.

## Generating media (when you have a generation tool)
**Workflow:**
1. Generate a still keyframe (16:9, 2K+).
2. Animate it image-to-video for 5–10s.
3. Make it loop.
4. Export H.264 MP4 at 1920×1080, 24fps, no audio, ≤8MB, and pull a first-frame poster.

**Still (keyframe) formula:**
```
[shot type] of [ONE subject], [material/finish], [pose/state],
placed in the [right third | lower half | center-bottom], occupying ~30% of frame,
[seamless backdrop | environment] that falls off to pure [#000000 | #FFFFFF | brand hex] at all edges,
[lighting: soft rim light / volumetric haze / single warm key],
palette limited to [2–3 colours], [one luminous highlight],
[style: photoreal CGI render | cinematic 35mm still, shallow DOF | hand-painted anime-film background | high-key studio],
large empty negative space on the [left half | top 40%] reserved for a headline,
no text, no logos, no UI, no watermark, 16:9, ultra-detailed.
```

**Motion (image-to-video) formula:**
```
Single continuous shot, no cuts. Camera: [locked | very slow push-in ~5% | slow 15° orbit].
Subject: [rotates slowly in place | floats gently | grass sways | fabric ripples | light pulses softly].
Nothing enters or leaves frame; background stays flat [colour]; lighting constant.
Slow and calm, ~half real-time. 24 fps, 8–10 seconds, seamless loop: last frame matches first.
```

**Cut-out sets:** generate "full body [subject] isolated on flat [chroma colour], even studio light, 3:4, consistent style across the set", then remove the background, then export WebP with alpha at ≤500KB.

**Checks before using generated media:**
- Look at frames from 0%, 50% and 100%: the text zone must be empty in all three.
- The edges must equal the page background.
- No stray text or artefacts.
- The loop seam must be invisible.

If a check fails, fix it with `object-position` or oversizing, or regenerate. Don't paper over it with a dark overlay.

## Preparing video for the web (ffmpeg)
```bash
# Web MP4: H.264, 1080p, 24fps, no audio, fast start
ffmpeg -i in.mp4 -an -vf "scale=1920:-2,fps=24" -c:v libx264 -preset slow -crf 26 -pix_fmt yuv420p -movflags +faststart hero.mp4
# Mobile version
ffmpeg -i in.mp4 -an -vf "scale=960:-2,fps=24" -c:v libx264 -preset slow -crf 28 -pix_fmt yuv420p -movflags +faststart hero-mobile.mp4
# Poster (first frame, WebP)
ffmpeg -i hero.mp4 -frames:v 1 -vf "scale=1920:-2" -q:v 80 poster.webp
# Seamless loop: crossfade the last second into the first (for an 8s clip)
ffmpeg -i in.mp4 -filter_complex "[0]split[a][b];[a]trim=1:8,setpts=PTS-STARTPTS[main];[b]trim=0:1,setpts=PTS-STARTPTS[head];[main][head]xfade=transition=fade:duration=1:offset=6[v]" -map "[v]" -an loop.mp4
```

---

## Appendix: builders.md

# Prompts for other builders

When the user wants a prompt to paste into another AI builder, the spec **is** the deliverable. Write it in the same style as the examples: imperative, exact, ordered. Then adapt it for the tool:

| Tool | Stack line to open with | Notes |
|---|---|---|
| **Lovable** | "React + Vite + TypeScript + Tailwind CSS + shadcn/ui, framer-motion for animation, lucide-react for icons." | Put tokens as HSL CSS variables in `index.css` (Lovable's convention). Ask for the full hero in one go; for long pages, "build the hero and next two sections now". |
| **Bolt** | "Vite + React + TypeScript + Tailwind CSS + Framer Motion, single page, no backend." | Bolt follows numbered structure closely: keep sections numbered and the tokens in one block. Ask for one component per file. |
| **v0** | "Next.js App Router + Tailwind + shadcn/ui; framer-motion for animation." | v0 is conservative with motion unless asked; spell out every animation. |
| **Cursor / Claude Code** | The user's existing stack, or "a single index.html, no build step". | Can follow very long specs; include the file structure. |
| **Manus / Kimi / Google AI Studio** | "Build a single standalone index.html (inline CSS and JS, no build step)." | Agentic builders do best with one self-contained file and every asset URL spelled out. |

**Rules for any builder:**
1. **Exact media URLs.** Paste every URL in full, with what it's for and how it's positioned. Builders invent media if you're vague.
2. **Exact copy.** Spell out every headline, nav label and CTA. Left alone, builders write bland copy.
3. **Numbers, not adjectives:** sizes per breakpoint, tracking, durations, easing, opacities.
4. **Constraints last:** finish with "Do not add…" lines, e.g. "No extra sections, no decorative blobs, no placeholder images, no emoji." Builders respect what comes last.
5. **Length:** 3–15k characters is normal for a gallery-grade hero. Don't trim precision to save space.
6. **If the result drifts:** send one focused fix per message ("make the H1 clamp(56px,8vw,120px) with -0.04em tracking"), not a long list.

---

## Appendix: craft.md

# Craft: the taste rules

These are the recurring decisions that separate gallery-grade pages from average AI output. They are defaults, not laws. Break one only on purpose, and say why in the spec.

## Composition
- **One idea per first screen.** Mark + nav + one headline + one sub + 1–2 CTAs + one media plane, plus at most one quiet strip (logos, stats or socials). Supporting material goes below the fold. No cards, stat grids or icon stacks in the first viewport unless they *are* the concept.
- **The media carries the design and the UI stays quiet.** 3–5 nav links at 12–15px, pill buttons, sparse text. Often the only "graphic" is the footage.
- **Anchor somewhere specific.** Choose one of:
  - **centred stack:** badge → H1 → sub → CTA;
  - **bottom-anchored:** headline bottom-left, a secondary element bottom-right, with a flex spacer above;
  - **left column:** vertically centred;
  - **editorial four corners:** labels in the corners around a big headline.

  Centred is the safe default, not the best one.
- **Text and subject never collide.** The subject takes the centre or right third and the text takes the other side or the empty band. Move the media to make room (`object-position`, oversize 110–120%, translate) before shrinking the text.
- **Negative space is real:**
  - sub max-width 28–42rem;
  - side blocks 240–320px wide;
  - bottom padding 40–80px on desktop;
  - gutters 20–24px on mobile, 48–64px on desktop.
- **Depth comes from layering, not decoration:**
  - a giant ghost word behind a cut-out subject;
  - a cut-out in front of the headline;
  - a foreground frame over video;
  - a spotlight mask revealing a second aligned image.
- **Inset-frame variant:** the hero sits in `padding: 16–24px` with a 24–40px-radius media container, a calm, expensive look.

## Typography
**Pairing archetypes** (pick one):
1. **Editorial serif display + neutral grotesk.** A high-contrast serif (often italic) for the headline, or just for 1–3 accent words inside a sans headline. Set the accent words in a muted colour, not a brighter one.
2. **Single grotesk system.** Headline at weight 400–500, never bold, with tight tracking; size and space do all the work.
3. **Heavy condensed display for mega words:** uppercase, 14–28vw, with a calm body face.
4. **Mono or dot-matrix** for tech personality, or as a micro-label system: 10–12px, uppercase, +0.15–0.3em tracking, 40–60% opacity, for indices (`01 / 05`), eyebrows and metadata.

| | Display / H1 | Mega type | Body | Labels |
|---|---|---|---|---|
| Size | 72–96px desktop, 36–48px mobile (`clamp()`) | 14–28vw | 14–18px | 10–13px |
| Line-height | 0.9–1.05 (0.95 is the sweet spot) | 0.75–0.88 | 1.5–1.6 | 1–1.3 |
| Tracking | −0.02 to −0.05em | −0.04 to −0.08em | 0 to −0.01em | +0.15 to +0.3em |
| Weight | 400–500 (300 for big numerals) | 800–900 | 300–400 | 500–600 |

- **Scale contrast does the work:** the H1 is 5–6× the body size.
- **Break headlines by hand** into 2–3 lines. Stop bad wraps on desktop (`white-space: nowrap` per line) and let the lines flow on mobile.
- **Gradient text is rare and controlled:** a subtle vertical silver on display type, or nothing at all.
- **Wordmarks** are tight-tracked text with a superscript ®/™, or a small custom inline-SVG mark. Never a generic icon next to a bold word.
- **At most 2 families,** plus an optional mono for labels. Load only the weights you use.

## Colour
- **Palette:** 1 background, 1 foreground, 1–2 greys, and at most 1 accent. Use the accent on no more than 3 element types (CTA fill, a dot, a glyph). Monochrome plus media is the most common winning palette.
- **Hierarchy comes from opacity, not new colours.** Over media, step the text through fg 100 → 80 → 60 → 40. Borders are 10–20% fg.
- **The page background equals the media's edge colour,** whether black footage on black, white studio on off-white, or a red backdrop on red. That's why great heroes need no overlay and never flash.
- **Use near-blacks and off-whites:**
  - dark: `#000`, `#050505`, `#0a0a0a`, `#0c0c0c`;
  - light: `#f0f0ee`, `#f7f5f0`, `#fcfcfc`.
- **Theme the selection colour.**
- **Banned by default:** purple/indigo gradients, glow orbs, blobs, radial-gradient backgrounds as "the visual", heavy drop shadows (use soft ones only, e.g. `0 4px 14px rgba(0,0,0,.16)`).

## Surfaces and components
- **One material, reused everywhere.** Define it once (e.g. a liquid-glass or frosted class) and apply it to the nav, chips, cards and secondary buttons. No extra border classes on glass; the material provides the edge.
- **Buttons are pills.**
  - Primary is solid and inverse (white on dark, black on light): 14px, weight 500, padding 10–12px × 20–32px.
  - Secondary is glass, ghost or a text link with an icon.
  - An arrow (↗/→) often sits in a contrasting circle inside the pill and nudges 2px or rotates −45° on hover.
- **Radii stay consistent:** pills for actions, 20–40px for cards.
- **Micro-components that add credibility:**
  - an announcement badge with an inner chip ("New" + one line);
  - 3 overlapping avatars + one line of social proof;
  - 2–4 stats (big number + small muted label);
  - a logo strip at 40–50% opacity with edge fade;
  - an email pill (input + round submit).
- **Grain:** an SVG fractal-noise layer at 0.04–0.15 opacity, `pointer-events: none`, on top. It unifies video and UI and kills banding.

## Motion
- **Entrance choreography.**
  - Order: nav → eyebrow → H1 → sub → CTA → secondary strip.
  - Steps 0.1–0.2s apart, starting at 0–0.4s; the whole sequence is done by ~1.5s.
  - Base move: opacity 0→1 + translateY 20–30px, optionally blur 10px→0 or scale 0.96→1. Duration 0.6–1.1s (0.8s default).
- **Easing:**
  - entrances: `cubic-bezier(0.22,1,0.36,1)` or `cubic-bezier(0.16,1,0.3,1)`;
  - state changes: `cubic-bezier(0.4,0,0.2,1)`;
  - linear only for marquees.
- **Headline treatments** (pick one per page):
  - per-word blur-in (100ms stagger; add a word gap, since negative tracking eats spaces);
  - masked line rise from 110% inside `overflow: hidden`;
  - per-character slide (30ms stagger);
  - typewriter (35ms/char);
  - scramble.
- **Media entrance:** video fades in from 0 over ~500ms on `loadeddata`, and/or settles from scale 1.06 → 1 over 1.8s.
- **Scroll reveals:** in-view once, 10–25% threshold, y 20–40px, 0.6–0.9s, 0.1s stagger.
- **Hovers stay small:** scale ≤1.05, colour/opacity changes at 150–300ms, `:active` scale 0.97.
- **What is NOT animated, which is where the restraint shows:**
  - backgrounds and decorative layers;
  - no infinite pulsing or floating blobs;
  - no shimmer on headlines;
  - no CSS transitions on `<video>`.

  The media is the ambient motion.
- **Always add a `prefers-reduced-motion` branch** (final state, no smoothing). The rest state must be visible: if JS fails, nothing stays at opacity 0.

## Copy
- **Headline:** 3–9 words over 2–3 lines. Use a two-beat statement, a contrast pair, or a three-word staccato. Emphasise with italic serif or muted colour, never bold. Make it aspirational and specific, not salesy.
- **Sub:** 1–2 sentences, 15–30 words: a concrete benefit plus texture, in a muted colour.
- **Nav:** 3–5 links of 1–2 words. Warm labels beat defaults (Studio, Work, Journal, Inquire).
- **CTA:** 2–3 words, verb first. The primary is direct (Start, Book, Get); the secondary is softer (Watch the film, See how). Repeat the primary label in the nav.
- **Microcopy adds brand texture:** coordinates, a live local time, "Available for projects" with a pulsing dot, index numbers.
- **Never** lorem ipsum, "Your tagline here", generic "Feature 1/2/3", or emoji as icons.

## Failure modes to design against
| Failure | Guard |
|---|---|
| White flash | `html,body{background:…}` as the first CSS rule; media starts at opacity 0 and fades in on `loadeddata` |
| Visible loop seam | rAF fade loop, boomerang, crossfade, or loopable footage |
| Text unreadable over video | Footage with an empty zone; a bottom fade to bg; glass behind small UI; a soft text-shadow |
| Mobile 100vh clipping | `height:100vh; height:100dvh`; safe-area insets |
| Layout shift | Fixed-height lines for typed or rotating text; reserved media aspect ratios |
| Scrubbed-video jitter | Seek only when `!video.seeking`; lerp the target |
| Competing animations | Cancel the previous rAF; `isAnimating` locks (650–1000ms) |
| Blank page if animations fail | Rest state visible; JS forces the final state after 2 frames |
| Desktop-only interactions on touch | Disable hover/scrub effects under 1024px or on `(hover: none)` |
| Horizontal scroll | `overflow-x: clip` on the root; vw-sized mega type with nowrap and clipping |
| Menu leaves the page scrollable | Lock body scroll while it's open; close on link, Esc and resize |

## Extra craft details (values)

Recurring values from gallery-grade builds that go beyond the rules above. Working code for each pattern is in `references/techniques/`.

**Type**
- Tracking by size: condensed caps −.02em; large sans/serif −.025 to −.035em; big sans −.045 to −.05em (italic serif at ~88px ≈ −4px); vw wordmarks −.07em; stat numbers −.025em; UI and body −.01 to −.015em.
- Line-height by role: mega/serif titles .75–.78; vw wordmarks .85; italic serif display .8–.9; stacked caps .88–.92; two-line sans headlines 1.05–1.12; a sub under an italic display can be 1.25.
- Sizes: lede 15.5–18px; nav and buttons 13–15px; badges and eyebrows 11–13.5px; compact stats 18–26px with 9–12.5px labels, big metrics `clamp(48px,10vw,96px)` at weight 300. Fluid examples: hero `clamp(28px,6.2vw,80px)`, section title `clamp(3rem,12vw,160px)`, stacked statement `clamp(2rem,9vw,9rem)`, h2 `clamp(1.5rem,4vw,3.2rem)`.
- Weight 300 at huge sizes on dark backgrounds reads expensive; 500 for big sans wordmarks.
- Pairings that recur: Instrument Serif italic + Inter or Barlow; Inter + Outfit; Geist alone; Manrope alone; Kanit 300–900 alone; Anton + Inter (poster); Poppins + Source Serif 4 italic; Helvetica Now / Neue Haas (Swiss); a dot-matrix or pixel display face + Inter for UI.
- Two-tone headline: the first phrase in the primary, the rest in a lighter tint of the same hue (`#336443` → `#85AB8B`); or muted-tone words without italics.
- Logo craft: a 10px ®/™; a ✳︎ or ✦ glyph after the logotype; one lowercase italic serif letter in a 48px glass disc; an SVG mark with a metallic multi-stop gradient.
- Micro-label formats: `// Capabilities` (14px, 80 %), `[ 02 ] Section`, `01 ——` with a 64×1.5px rule, `/ SERVICE NAME` lists, an eyebrow led by a 32px hairline or a 6px dot, counts as superscripts on nav items (`Projects⁶`, mono 10px at 60 %). Mapping a mono class to the sans keeps the tracked look without a third font.
- Inline icon circles inside a headline (56px, 1px border, 22px icon, nudged −4px) work as ornaments that invert on hover. All-lowercase copy suits calm tech brands.
- Rendering: `-webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale`; `font-variant-numeric:tabular-nums` on changing numbers; `font-display:swap` + `preconnect` to fonts.gstatic.com (`crossorigin`). Card copy max 32ch; ledes max 28rem (~470px).

**Colour**
- Palettes that recur: warm cream on black (`#DEDBC8` / `#E1E0CC`, cards `#101010`–`#212121`); paper on photography (`#fdf1e1`, ink `#111411`); light pages `#fcfcfc` / `#f0f0ee` / `#EFEFEF` / `#f9fafb` with ink `#111` or deep navy `#051A24` / `#0D212C`; dark cards `hsl(0 0% 5–8%)`, borders `hsl(0 0% 12–20%)`, muted text `hsl(0 0% 53–65%)` or `#9a9a9a` / `#8e8e8e` / `#6F6F6F`.
- Define tokens as HSL triplets (`--fg: 0 0% 100%`) so `hsl(var(--fg) / .6)` opacity steps work.
- Selection: `rgba(255,255,255,.2)` on dark, or the brand at 30 % alpha.

**Text over media**
- Text-shadow instead of boxes: body `0 2px 18px rgba(0,0,0,.42)`, display `0 16px 38px rgba(0,0,0,.32)`, nav `0 2px 16px rgba(0,0,0,.2)`. Never a flat 50 % black wash.

**Buttons, pills, cards**
- Sizes: nav CTA 20×10px at 14px; hero CTA 24–32×12px; minimal heroes go large (56×20px, 16px). Tech and metal styles use a crisp 6–7px radius instead of pills.
- Announcement badge: inner white chip 12px semibold, padding 4×12px; message 14px at 90 % white. Email capture: submit inside the pill, pill padding `8px 8px 8px 24px`.
- Light-page physical button shadow: `0 1px 2px rgba(5,26,36,.1), 0 4px 4px rgba(5,26,36,.09), 0 9px 6px rgba(5,26,36,.05), 0 17px 7px rgba(5,26,36,.01), 0 26px 7px rgba(5,26,36,0), inset 0 2px 8px rgba(255,255,255,.5)`; secondary `0 0 0 .5px rgba(0,0,0,.05), 0 4px 30px rgba(0,0,0,.08)`; cards `0 4px 16px rgba(0,0,0,.08)` at radius 32–40px. Hover glow in the accent at ~30 %.
- Circular icon buttons 40–64px (2px white border or glass); a row of three glass social circles (16px padding, 20px icons) can close a hero.
- Tag pills: min-height 38–42px, padding 0 16–25px, paper colour on photos with `0 12px 30px rgba(0,0,0,.18)`; on dark, mono 9–10px outline tags that invert on hover. Numbered section badge: a 24–28px dark circle + a bordered 12–13px pill label.
- Media cards: 16/9, radius 24px, media zooms 1.05 over 700ms on hover, bottom scrim, a glass ↗ disc. Portfolio image tiles use 40–60px radii.

**Layout & spacing**
- Content max-width 64–80rem (or 1440px); hero copy 860–980px; lede 440–540px. Horizontal rhythm 20 / 32 / 48px by breakpoint; airy transparent navs go to ~112px side padding on desktop.
- Section padding 128–176px vertical; ~96px under section subtitles. Safe areas: `padding-bottom:max(36px, env(safe-area-inset-bottom))`.
- Sheet transitions between sections: the next section gets `border-radius:40–60px 40–60px 0 0`, `margin-top:-40…-56px`, `position:relative; z-index:10`, alternating near-black and white.
- Grids: 12-column bottom grid under giant type (8 + 4); bento spans 7/5/5/7; asymmetric about grid `26% / 1fr / 48%`, images aligned end, text start.
- Architectural guide lines: fixed 1px `rgba(255,255,255,.1)` verticals at the container edges (desktop, just above the background video).
- Ambient light (never "the visual"): `radial-gradient(ellipse at top, rgba(255,255,255,.03), transparent 70%)` behind dark sections; a CTA card's top glow `radial-gradient(600px circle at 50% 0%, rgba(255,255,255,.15), transparent 70%)` at opacity .3.

**Navigation**
- Floating split pills: logo in its own 40–44px circle, links in a separate pill (`#EDEDED` on light, `neutral-900/90` + blur on video), solid CTA pill right.
- A pill wrapping logo · 1×20px divider · links · divider · CTA that gains a shadow after `scrollY > 100`. Active item in a glass pill nav: `rgba(255,255,255,.2)` + blur + a `rgba(255,255,255,.3)` border, 16×6px padding.
- "Hanging tab" nav: a solid black pill attached to the top edge of an inset hero (bottom radius 16–24px, links 10 → 14px). Or a fixed floating bottom pill (24px from the bottom, centred, white, layered shadow) with a monogram + CTA.
- Link underline grows from the left on hover: `::after` `scaleX(0 → 1)`, origin left, .3s. Live time as `HH:MM in City`; links separated by `•` dots.

**Social proof & data**
- Avatar stack: 3 × 32px, −8px overlap, a 2px ring in the page colour, plus one 14px muted line.
- Pipe-separated stat strip pinned to the bottom (12–14px at 70 %, pipes hidden on mobile); definition-list facts with serif numerals `4.2rem/.9` and 86px gaps; glass stat cards (220px wide, 20px padding, outline icon top, italic-serif number ~36px at −1px, 12px light label); a star row (five 20px stars + "5/5") beside a testimonials heading.

**Motion**
- More easings: `cubic-bezier(.25,.1,.25,1)` scroll reveals and button text rolls; `(.34,1.56,.64,1)` spring overshoot (checks, pops); `(.32,.72,0,1)` bottom sheets; `(.215,.61,.355,1)` body fade-ups.
- Durations: hovers 150–350ms; button rolls 500ms; panel wipes 400–700ms; menus 280–500ms; carousels 640–800ms; crossfades 1s; count-ups 1.5–2s; video fades 500ms; media settles 1.8s; shine sweeps 600–650ms.
- Stagger: 30ms characters, 50ms nav items, 60–80ms words and blocks, 100–150ms cards and stats.
- Lerp factors: .1 cursor spotlight; .12 pointer parallax and scroll-scrubbed video; .14 pinned scroll stages; .04 shader blob momentum.
- Ambient loops stay slow: orbits 30–60s, marquees 20–40s (~40–60px/s), bob 3s, gradient border 3s, gradient shift 6s.
- Direction: the nav enters from above, content from below, secondary items sideways; logos and fine print only fade. Release transforms once an entrance ends (`animation:none` or an `.is-in` class) so hover transforms still work.
- Reduced motion: scroll-driven pieces keep the mapping but drop smoothing; pointer effects turn off; `(hover:none)` gets an autonomous or static alternative.

**Mobile**
- Stat grids 4 → 2×2; footer stat rows become columns; hero actions stack with full-width buttons at ≤560px.
- Height breakpoints (`max-height: 850px / 720px`) keep single-frame heroes intact on short laptops.
- Background video either stays full-bleed with a portrait `object-position` and a stronger directional scrim, or moves in-flow below the copy.

---

## Appendix: review.md

# Look-and-fix review

You cannot judge a page you have not seen. After every build, run:

```bash
python scripts/shoot.py index.html shots/
```

Open `shots/desktop.png`, `shots/mobile.png` and `shots/desktop-early.png` and look at them properly, as images. Read the QA report too. Then score the page against the rubric below, honestly, as a jury member who has seen a thousand landing pages this year.

If the screenshot tool is unavailable, use whatever browser or preview tool you have. If you truly have none, say so, review the code line by line against this rubric, and tell the user the page was not visually checked.

## Fix immediately (blocking)
Any of these makes the page fail, whatever else is good:
- Console errors, failed requests, broken images, or a video that should play but doesn't (the QA report lists them).
- Horizontal overflow on mobile (`horizontalOverflow: true`).
- A white or blank flash in `desktop-early.png` on a dark design (set the background colour on `html` and `body` in the first CSS rule).
- Text you can't read: over a busy part of an image/video, under ~4.5:1 contrast for body text, or clipped.
- Fonts not loaded (`fontsLoaded` missing the display font) or the H1 falling back to a system font.
- Layout broken at either size: overlapping elements that shouldn't overlap, a nav wrapping onto two lines, a hero taller than the viewport hiding the CTA on desktop.
- Placeholder or filler copy ("Lorem", "Your tagline here", "Feature 1").

## Score 1–10 on each
1. **First glance (the 3-second test).** One clear focal point. You know what it is and where to look. It feels intentional, like a studio made it, not a template.
2. **Signature.** Is there one memorable thing (the media, an interaction, a type moment) that someone would screenshot and share? Average pages have none.
3. **Typography.** Display type is big, confident and tightly tracked; body is calm and readable; at most 2 families; consistent scale; nothing default-looking.
4. **Composition and space.** Generous, deliberate negative space; aligned edges; the eye travels hero → message → CTA. No clutter, no orphaned elements, no equal-weight everything.
5. **Colour and light.** A small palette with one accent used with intent; text protected over media (gradients/scrims); depth from light, blur or grain rather than random decoration.
6. **Media integration.** The image/video/3D feels like part of the design (cropped, positioned and layered on purpose), not a rectangle dropped in.
7. **Motion (judge from code + early/late frames).** Entrance is choreographed (staggered, 0.6–1.2s total, ease-out), interactions feel physical, nothing loops distractingly, reduced motion respected.
8. **Mobile.** Not just "stacked": type rescaled, media re-cropped, tap targets ≥ 44px, still has the signature.
9. **Copy.** Specific, short, believable for this brand; a headline with a point of view; CTA with a verb.
10. **Polish.** Hover/focus states, consistent radii and borders, favicon/title, no stray scrollbars, no layout shift as fonts/media load.

**The bar is an average of 8 or more with no score under 7.** Most first drafts land at 6–7. That's normal; the fixes are what make it great.

## Fix loop
1. Write down the three weakest scores and, for each, the specific change (values, not adjectives): "H1 from 64px to clamp(56px, 8vw, 128px), tracking -0.04em", "add a 40% black-to-transparent gradient over the bottom of the video", "move the stats row into one line with 1px dividers".
2. Make those changes, then shoot again and look again.
3. Repeat up to 3 rounds, or until you clear the bar. If something can't be fixed (e.g. no suitable media), tell the user plainly what would lift it.

Common high-impact fixes:
- **It looks generic.** Make the type bigger, cut words, strengthen the signature, remove a section or element.
- **It looks busy.** Remove decorative elements, unify radii, increase spacing by one step, reduce the colours to bg/ink/muted/accent.
- **It looks flat.** Add depth with a media layer, gradient scrim, subtle grain, glass surfaces, or light falloff.
- **The text fights the video.** Reposition the text over the calm area, add a scrim, or choose a calmer clip.
- **Mobile looks broken.** Re-crop media with `object-position`, scale display type with `clamp()`, hide secondary nav behind a menu.

---

## Appendix: spec-template.md

# The build spec

Quality is decided here, before any code. A gallery-grade spec reads like a precise brief from a senior designer to a developer: every visible element has real values, every asset a real URL, every motion a delay, duration and easing. Aim for 600–1,200 words for a hero and 1,200–2,500 for a multi-section page. The examples you opened in step 2 are your calibration; match their density.

## Precision rules
- **No adjective stands alone.** "Cinematic", "premium" and "glassy" must be followed by the values that produce them: blur px, alpha, gradient stops, durations.
- **Every visible element gets a full style line:** size at each breakpoint (3–5 tiers or `clamp()`), weight, line-height, tracking, colour with opacity, max-width and margins.
- **Colour:** hex/HSL tokens only, with opacity steps for hierarchy (100 / 80 / 60 / 40).
- **Motion:** per element, give the trigger, delay, duration, easing and from→to values. Write stagger formulas out (`delay = 0.3 + i*0.12s`).
- **Media:** exact URL, element and attributes, fit, focal point (`object-position`, oversize, offsets), playback mode, plus one sentence on what the footage shows, where its subject sits and where the empty zone is.
- **Logic:** algorithms in steps, with constants (lerp factor, locks in ms, thresholds) and cleanup.
- **Absolute positions are explicit** (`top: 18%; left: 6vw`). Grids are explicit (`grid-template-columns: 26% 1fr 48%`).
- **Verbatim blocks** for anything that must be exact: CSS classes, keyframes, SVG paths, the font `<link>`.

## Consistency pass (before building)
Check the spec against itself:
- every asset has a reachable URL or a declared placeholder;
- no conflicting classes or values on one element;
- every "do not" agrees with the asset list and layout;
- every font named is actually loaded;
- the page background equals the hero media's edge colour.

## Template
Fill every `{{ }}`. Write "none" rather than leaving a block blank, and delete blocks that truly don't apply.

````markdown
# {{Brand}} · {{one-line concept}}

## 0. Brief
Build {{a single full-viewport hero | an N-section landing page: Hero, …}} for **{{Brand}}**, {{what it is, for whom}}.
Aesthetic: {{3–6 words}}.
Signature idea (the ONE thing this page is remembered for): {{…}}.
Fidelity: build exactly as specified; add no sections, cards, badges, gradients or decorations not listed here.

## 1. Stack & files
{{single index.html, inline CSS/JS, CDN libs pinned (e.g. gsap@3.12.5) | React 18 + Vite + TS + Tailwind 3.4 + motion}}; icons: {{inline SVG | lucide: ArrowUpRight, Menu, X}}.

## 2. Fonts
| Role | Family | Weights/style | Used on |
|---|---|---|---|
| Display | {{…}} | {{…}} | {{H1, accent words, big numbers}} |
| Body/UI | {{…}} | {{400/500}} | {{nav, body, buttons}} |
| Labels (optional) | {{mono or body}} | {{…}} | {{eyebrows, indices, metadata}} |
Load: `{{exact Google Fonts URL}}`. Fallback stack: `{{…}}`.

## 3. Colour tokens
```css
:root{
  --bg: {{…}};      /* equals the hero media's edge colour */
  --fg: {{…}};
  --muted: {{…}};
  --line: {{…}};
  --accent: {{one hue or none}};  /* only on: {{≤3 element types}} */
}
html,body{background:var(--bg);color:var(--fg)}   /* first rule: no white flash */
```
Text hierarchy over media: {{fg 100 headline / 80 nav / 60 body / 40 labels}}.

## 4. Global utilities (verbatim)
{{material class (e.g. glass), grain, keyframes, reduced-motion block}}

## 5. Assets
| Slot | Type | URL | Element & attributes | Fit & focal point | Behaviour | Fallback |
|---|---|---|---|---|---|---|
| hero-bg | {{MP4 loop}} | `{{exact URL}}` | `<video autoplay muted loop playsinline preload="auto">` | `object-fit:cover; object-position:{{…}}` | {{native loop | rAF fade loop}} | bg colour; fade in on `loadeddata` |
Art direction: {{what the media shows, where the subject sits, where the empty zone is, dominant colours, motion speed}}.
Overlay policy: {{none | bottom fade to --bg | edge vignette}}.

## 6. Layers & root
Root: {{position, height 100vh then 100dvh, overflow}}.
z-ladder: media 0 → fades 1 → content 10 → nav 20 → menu 50 → grain 100 (pointer-events none).
Skeleton: {{e.g. flex column: nav / flex-1 stage with content pinned bottom-left / bottom strip}}.

## 7. Navbar
Container: {{…}}. Left: {{wordmark}}. Centre: {{3–5 links, style}}. Right: {{CTA, style}}.
Mobile: {{burger → full-screen menu, timing, stagger, closes on link/Esc/resize}}.

## 8. Hero content (reading order)
| Element | Copy | Tag | Font | Size (base→md→lg) | Wt | Leading | Tracking | Colour | Box/spacing | Motion |
|---|---|---|---|---|---|---|---|---|---|---|
| Eyebrow | {{≤8 words}} | span | … | … | … | … | … | … | … | … |
| H1 | {{3–8 words, line breaks marked /}} | h1 | display | {{clamp(…)}} | … | {{0.9–1.05}} | {{−0.02 to −0.05em}} | … | … | … |
| Sub | {{15–30 words}} | p | body | … | … | 1.5–1.6 | … | {{fg/60}} | {{max-width}} | … |
| Primary CTA | {{verb + object}} | a | body | … | … | … | … | … | … | … |
| Secondary | {{softer action}} | a | … | … | … | … | … | … | … | … |

## 9. Sections (repeat per section)
### {{Name}}
Background {{…}}; padding {{…}}; container {{…}}. Eyebrow · Heading · Body (each with full style lines). Grid {{…}}. Card {{radius, padding, material, inner layout}}. Media {{…}}. Reveal {{in-view config}}.

## 10. Motion table
Default easing `cubic-bezier(0.22,1,0.36,1)`.
| Element | Trigger | Delay | Duration | From → To |
|---|---|---|---|---|
The entrance completes by {{≤1.5s}}. Hovers: {{…}}. NOT animated: {{…}}.
Reduced motion: {{final state shown, no smoothing/scrub}}.

## 11. Interaction & state
State, handlers, constants, algorithm in steps, cleanup, touch fallback.

## 12. Responsive
| Element | <640 | ≥768 | ≥1024 |
|---|---|---|---|
Use 100dvh and safe-area insets; no horizontal scroll at 375px; add a short-viewport rule (max-height 720px) when the hero is dense.

## 13. Constraints & acceptance
Do not: {{…}}.
Must: {{…}}.
Acceptance (first viewport): {{one paragraph describing exactly what's visible and where}}.
````

## Add-on modules
Append the one(s) that match the brief.
- **Video hero.**
  - Loop mode: native, rAF fade loop, crossfade between clips, mouse-scrub, scroll-scrub or boomerang.
  - Focal point and oversize.
  - Overlay policy.
  - Poster image.
  - Behaviour on touch devices.
- **Cut-out / 3D showcase.**
  - Per-role transform table (centre/left/right/back: position, height %, scale, blur, opacity, z).
  - One shared transition with an animation lock.
  - Preloading.
  - Ghost mega-word behind the subject.
  - For real 3D (Three.js/GLB): camera, framing maths, lights, interaction model and loading state.
- **Editorial / mega type.**
  - Display size in vw.
  - Line-height 0.75–0.9.
  - Tracking −0.04 to −0.08em.
  - Overflow clipping.
  - Which words sit in front of or behind the media.
  - A mono micro-label system.
- **SaaS.**
  - Product mock-up anatomy (window chrome, columns, realistic rows).
  - Logo strip (opacity, edge mask).
  - Pricing (material, toggle).
- **Portfolio.**
  - The name as a display element.
  - Work grid spans.
  - Hover reveals.
  - Availability microcopy.
  - Marquee speed.
- **Scroll story.**
  - Sticky stage height.
  - Segment ranges.
  - Per-frame variables.
  - smoothstep/lerp helpers.
  - Choreography listed by scroll range.

---

## Appendix: INDEX.md

# Technique library: index

58 tested recipes in 7 files. Each recipe has what/when, the premium parameter values, a vanilla single-file implementation, a React/Framer variant where it differs meaningfully, and reduced-motion and mobile notes. Every file opens with its conventions and the shared easing tokens its code uses.

## How to choose a signature

Pick **one signature technique per page**: the single idea the page will be remembered for (a real 3D object, a scrubbed film, a giant word behind a cut-out, a pinned cinematic stage). Then add **2–4 supporting techniques** that stay quiet: an entrance (blur-rise), one material (liquid glass), one type move (a serif accent), and a reveal for the sections below. **Never stack five effects** in one viewport; if two techniques compete for the same attention (spotlight + magnet + parallax), cut one. Allow at most **one heavy** technique per page and let the media or the signature carry the motion: everything else should feel inevitable, not busy. Typical sets:
- **Cinematic video hero:** background video layer + edge-blend scrim + liquid glass + blur-rise + serif accent.
- **Product object:** 3D model hero + floating pill nav + blur-rise + count-up stats.
- **Editorial portfolio:** giant display type + split-text entrance + magnetic hover + scroll-linked word reveal + stacking cards.

## Techniques

| Technique | File | Use it when | Cost |
|---|---|---|---|
| Cinematic background video layer (autoplay, HLS, settle-in) | video-and-media.md | Footage carries the mood; the default foundation of a video hero | medium |
| Seamless video loop with rAF opacity fades | video-and-media.md | A looping clip shows a hard cut or mismatched first/last frame | light |
| Background-video framing & art direction | video-and-media.md | The clip's subject collides with the copy or crops badly on phones | light |
| Edge-blend scrims & text protection | video-and-media.md | Copy needs contrast over footage, or the hero must melt into the next section | light |
| Progressive bottom blur | video-and-media.md | Bottom-anchored titles over footage whose colours must stay untouched | medium |
| Cursor-scrubbed video (delta · split dual) | video-and-media.md | A turntable or head-turn clip should feel like a live 3D object (desktop) | medium |
| Scroll-scrubbed video with canvas frame cache | video-and-media.md | Scrolling should drive a transformation clip behind sparse copy | heavy |
| Boomerang (ping-pong) video loop | video-and-media.md | A non-looping clip (push-in, bloom, smoke) must loop seamlessly; pre-render it (runtime capture is heavy) | light |
| Crossfading multi-video scene switcher | video-and-media.md | Visitors pick an atmosphere or location from 3–5 moods | heavy |
| Liquid-glass surface | surfaces-and-buttons.md | UI floats over moving footage: nav, chips, cards, secondary CTAs | light |
| Frosted glass UI kit (chips, badge, numbered panel, contact card) | surfaces-and-buttons.md | Text must sit *on* glass over video and stay legible | light |
| Premium button finishes (liquid metal, halo, jewel) | surfaces-and-buttons.md | The CTA itself should feel machined or glow on a dark hero | light |
| Text-roll button with rotating arrow chip | surfaces-and-buttons.md | A studio or agency CTA needs a tactile hover | light |
| Sliding-fill buttons (+ hard offset shadow) | surfaces-and-buttons.md | Editorial or playful pages want a colour-wipe hover | light |
| Animated gradient border ring | surfaces-and-buttons.md | One CTA must pull the eye without changing the layout | light |
| Media card hover (icon-to-label pill, zoom, veil) | surfaces-and-buttons.md | Case-study and work grids | light |
| Texture overlays (grain, noise type, halftone, dot grid) | surfaces-and-buttons.md | Flat colour, gradients or video banding look too digital | light |
| Staggered blur-rise load choreography | type-and-text-motion.md | Every hero entrance (the default) | light |
| Fail-safe entrance system with a motion vocabulary | type-and-text-motion.md | Rich single-file choreography that must never leave a blank page | light |
| Word-by-word blur-in headline | type-and-text-motion.md | A big italic-serif headline over video should "exhale" in | light |
| Split-text entrances (masked lines/words, char cascade) | type-and-text-motion.md | Giant display words or stacked statements rising out of a slot | light |
| Serif-italic accent words | type-and-text-motion.md | Almost any headline with a natural key phrase | light |
| Gradient-clipped text (metallic, shine sweep) | type-and-text-motion.md | Name-as-hero metal type, or one "magic" word in a headline | light |
| Scramble / decode text | type-and-text-motion.md | AI, tech or sci-fi brands with monospace type | light |
| Typewriter with zero-reflow caret + depth-of-field lead-in | type-and-text-motion.md | An assistant/persona voice or a typed contact headline | light |
| Rotating word slot | type-and-text-motion.md | One word in a sentence should cycle (roles, verbs, places) | light |
| Scroll-linked word/char opacity reveal | type-and-text-motion.md | A manifesto or About paragraph read at scroll pace | medium |
| Giant display type as image (ghost word, wordmark, watermark, scattered) | type-and-text-motion.md | A word should be architecture: behind a cut-out, edge-to-edge, or as a backdrop | light |
| Geometric SVG wordmark assembly | type-and-text-motion.md | An institution or studio header with a constructed mark | light |
| Count-up stats & counter preloader | type-and-text-motion.md | Proof numbers, or a portfolio intro loader | light |
| Depth carousel with role slots + colour crossfade | depth-and-interaction.md | 3–6 products or characters, each with its own colour | medium |
| Magnetic hover | depth-and-interaction.md | A hero subject or primary CTA should feel weighted and alive | light |
| Pointer parallax depth layers | depth-and-interaction.md | A layered still (cut-outs over a backdrop) needs depth | light |
| Cursor-following spotlight reveal mask | depth-and-interaction.md | Two aligned images where the hidden one is the point (x-ray, night, render) | medium |
| Cursor image trail | depth-and-interaction.md | A closing CTA block should spray portfolio thumbnails | medium |
| Exclusion-blend overlay UI & custom cursor | depth-and-interaction.md | Fixed UI must stay legible as the page goes video → black → white | light |
| Orbit rings with counter-rotating avatars | depth-and-interaction.md | A community, talent network or integrations visual | medium |
| Sand-dissolve image transition + auto-cycling index | depth-and-interaction.md | Cycling collection or chapter images with an archival feel | heavy |
| Viewport-triggered staggered reveal (+ corner decor) | scroll.md | Every section below the hero | light |
| Sticky cinematic stage with CSS-variable choreography | scroll.md | Layered photography tells a story across one long pinned scroll | heavy |
| Panel slide-over + viewport-scaled scattered gallery + blend outro | scroll.md | Fashion or archive pages with many tall images | medium |
| Pinned heading with counter-drifting parallax columns | scroll.md | A gallery "playground" orbiting a pinned title | medium |
| Sticky stacking cards that scale down | scroll.md | 3–5 case studies or process steps | medium |
| Scroll-linked opposing marquee rows | scroll.md | A wall of work right after a portfolio hero | medium |
| 3D tilted text crawl (spring-smoothed) | scroll.md | A manifesto paragraph over video should feel like a film opening | medium |
| Hero composition patterns | layout-and-ui.md | Deciding where copy sits over a full-bleed visual | light |
| Viewport-locked single-frame hero | layout-and-ui.md | A poster hero that must look identical on every screen size | light |
| Floating pill navigation | layout-and-ui.md | The nav for most premium heroes (glass, frosted, white, dock, editorial) | light |
| Expanding glass capsule menu | layout-and-ui.md | Minimal heroes where a full link row would be noise | light |
| Mobile menu (burger morph, overlay / drawer / bottom sheet) | layout-and-ui.md | Every page with navigation, below 768–1024 px | light |
| Overlapping avatar trust cluster | layout-and-ui.md | Compact social proof above a SaaS or AI headline | light |
| Selectable chip group with spring check | layout-and-ui.md | Contact, enquiry or onboarding forms that should feel conversational | light |
| In-page product UI mockup | layout-and-ui.md | SaaS, dev tools or dashboards, instead of a screenshot | light |
| Desktop grid → mobile scroll-snap rail | layout-and-ui.md | 3–4 large cards (pricing, plans, features) | light |
| Seamless infinite marquee (logos, images, giant text) | layout-and-ui.md | A logo strip, image strip or giant text band | light |
| Infinite looping card slider | layout-and-ui.md | Locations, testimonials or case studies in a carousel | light |
| Real 3D model hero (Three.js + GLB) | 3d-and-webgl.md | The object is the story and you have (or can generate) a GLB | heavy |
| Animated shader backdrop (swirl, chroma blob, fluted glass) | 3d-and-webgl.md | A light agency hero with a living, refractive background | heavy |

**Cost** is the runtime weight on a mid-range phone: *light* = CSS or a little JS; *medium* = per-frame work, filters or extra media; *heavy* = WebGL, large frame caches, several videos or SVG filters on bitmaps. Every recipe already handles `prefers-reduced-motion` and touch; keep those branches when you adapt them.
