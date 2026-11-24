---
name: unslop
description: Turns vibecoded, AI-looking UI into a designed interface with its own character. Finds a direction from the product itself, then fixes spacing, color, icons, copy, type, layout, details, visuals and motion in that order, and can generate a real hero visual with an image tool when one is available. Use when the user asks to unslop, polish, clean up or redesign a screen so it stops looking AI-generated, or when a UI shows the usual tells like purple gradients, glows, gradient text, emoji labels, "New ✨" badges, glossy blobs, uppercase tracked labels, pulsing elements or uneven spacing. Works on React, Tailwind, HTML and CSS, for dashboards, apps and landing pages.
license: CC-BY-4.0
metadata:
  author: Damir Sokolovsky
  x: https://x.com/heydamir
  site: https://heydamir.design/unslop
---

# Unslop

## SKC invocation

SKC loads this skill automatically for matching frontend UI/UX work.
Do not wait for a follow-up question. Apply the craft rules immediately
and keep going on the user's actual task.

This skill's companion reference files are appended inline at the end of
this document. Read them there; they are not separate files on disk.

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


unslop was created by Damir Sokolovsky ([@heydamir](https://x.com/heydamir)), who started the Unslopping series on X. It is licensed under CC BY 4.0, so keep this credit in any copy or adaptation.

Vibecoded UI fails in the same predictable ways. Every surface glows, every label has an emoji, spacing is whatever the model typed that day, and the copy shouts. Unslopping fixes the craft and keeps the product. The features, content and order of sections stay. What changes is that every size, color, word and image becomes deliberate.

Removing slop is only half the job. A screen that is clean but could belong to any product is the next template. Every run ends with a screen that only this product could have.

The difference between slop and craft is where the richness goes. Slop spreads color and effects over the chrome, the backgrounds, buttons, borders and labels. Craft keeps the chrome quiet and puts the richness into one or two moments of content that people remember, like a rendered object, a beautiful chart or an image from the product's world.

Work like a designer doing a redline pass, one layer at a time, across the whole screen.

## What good looks like

- **One bright element.** Each screen has one polished thing that carries the color and the craft, a rendered object, a painted scene or a rich chart. Everything around it is quiet, so it reads instantly.
- **Quiet chrome.** Navigation, buttons and text use the tinted neutrals and one accent. Nothing glows, nothing competes with the bright element.
- **A clear idea.** You can say in one sentence what the visual shows and why it belongs to this product.
- **Text on calm space.** The headline sits on a part of the image or layout that was left empty for it, short and specific, with one primary and one secondary action and nothing stacked under them.
- **Real product, real material.** Previews look like the real app with plausible data, and objects look like real things with weight, light and shadow.

Which visual styles tend to work, and which fail, is in [references/visuals.md](#appendix-visuals-md). Finished examples to learn from are in [references/refs.md](#appendix-refs-md), and code treatments like drawing an image in glyphs are in [references/effects.md](#appendix-effects-md).

## Run it

1. **Look at the screen.** Find the files that render it. If you can run the app or open the file in a browser and take a screenshot, do it, so you judge what people see and not only the code.
   - Only a link to a live site, no code? Save the page with `node <skill folder>/scripts/snapshot.mjs <url> unslop/original.html` and work on a copy of that file. A local HTML file works in place of the URL. Add `--dark` or `--light` to match the theme the user sees. It also saves `original.live.png`, a screenshot of the live page, so render the saved copy and compare the two before you start. The script scrolls through the page first, so lazy-loaded sections and images are captured. Animated backgrounds drawn by scripts do not survive, so describe them in the audit from the live page.
   - Only a screenshot? Rebuild the screen as one static HTML file first, matching it closely, and treat that as the original.
   - In both cases the result is a redesigned page in code that the user can hand to whoever owns the real site, so say that in the report.
2. **Audit.** Go through [references/signs.md](#appendix-signs-md) and list every sign you find, one line each with where it lives. If the screen is in Arabic, Persian, Urdu or Hebrew, or should be, read [references/rtl.md](#appendix-rtl-md) first. Its rules win where they differ from the passes.
3. **Decide how much to change.** Read the audit honestly before planning anything.
   - **Heavy slop**, many signs across color, type, icons and copy. Run the full process below.
   - **Light slop**, a screen that is mostly designed with a few signs left. Polish mode. Fix only what the audit found, take the direction from the existing brand instead of inventing a new one, and keep the palette, type, layout and visual. Bigger ideas, like a moment that is missing or a scene for the hero, go into the report as suggestions, not changes.
   - **No slop.** Say so plainly and suggest two or three small refinements at most, with exact values. Apply them only if the user agrees, and stop there. Never change a good screen just to make it different.
4. **Set the direction and stop.** Write the five lines described below. Show the audit and the direction to the user and wait for their answer before editing, since changing the direction later means redoing everything. If you have a tool for asking the user questions, ask through it, otherwise ask in plain text and stop. Skip the wait only when the user already said to just do it.
5. **Fix in nine passes, in order.** Finish a pass across the whole screen before starting the next. When nearly every line changes, plan the passes in order and then write the new screen in one go, as long as every pass is applied. Spacing comes first because everything else reads differently once the rhythm is right. Copy comes before type and layout because the length of the headline decides its size and where it sits. Visuals and motion come last because they should fit a screen that already works without them.
6. **Check.** Run the checklist at the end of this file, render again and compare with the audit list. Anything still on the list gets fixed.
7. **Report** the direction, a few lines per pass about what changed, and any image prompt you wrote.
8. **Record, when asked or when the user wants something to share.** Build the story file and render the video described in [Story video](#story-video). If the user asks for it at the start, write each pass into the story file as you go.

Keep a run quick. Render the screen to check it at most three times. When you generate an image, start it right after the direction is confirmed and keep doing the first passes while it runs, instead of waiting for it.

Exact values for every pass live in [references/tokens.md](#appendix-tokens-md).

## Direction

Before touching anything, write five short lines. Derive them from what the page says the product does and who it is for. Never from what is trending.

- **Product.** What it does and for whom, in one plain sentence.
- **Character.** Two or three concrete words, like `calm, exact, a little warm` or `fast, technical, playful`. Words like clean, modern, sleek, minimal and premium are not allowed, because they describe every template.
- **World.** The place or material the product naturally belongs to. A note app lives near paper and ink, a monitoring tool near instruments and night shifts, a travel app near maps and window light. This world sets the tint of the neutrals, the accent and the visual.
- **Moments.** One or two places where the screen gets rich color, material and detail, chosen from what the product shows. A rendered card or device inside the preview, a chart whose colors each mean a series, an object from the world placed next to the content. Write what they are.
- **Signature.** One small detail only this product would have, used consistently. A live status dot for a monitoring tool, keycaps for a developer tool, hand drawn underlines for a teaching app, a route line for a delivery app. One detail, not five.

The examples here only show the shape of an answer. Derive yours from the product in front of you, even when an example happens to fit.

If the product already has a real brand, like a logo file, a color or a typeface that is not slop, keep it and build the direction around it. A violet to blue gradient, sparkles and glow are slop even when they sit in the logo, so they do not count as brand unless the user says they do.

## 1. Spacing

- Everything sits on a 4px grid. Margins, paddings, gaps and fixed heights are multiples of 4, so 28 or 104 are fine even though they are not in the token list. A 2px step is fine for nudges inside small controls, and an odd value that exactly centers something stays.
- Same thing, same size. All rows in a list share one height and one gap, all cards in a row share one padding.
- Space shows grouping. Space inside a group is smaller than space between groups, so a list reads as one block and sections read as separate ones.
- Things line up. Icons sit in one column, labels start on one line, numbers align right in one column. Nothing is nudged off the line with a stray translate or odd margin.
- Padding follows density. Compact panels and sidebars around 16, cards 20 to 24, page edges 24 to 32.
- Navigation is the densest part of an app. Rows are 32 to 36 tall with 2 to 4 between them, icons in one column, labels on one line. A section label sits closer to its own items than to the section above it, like 24 above and 8 below. Measure the sidebar after the pass, it is where spacing breaks most often.
- Remove one-off values that break the rhythm, like `mt-[13px]` or `py-[11px]`, and replace them with steps from the scale.

## 2. Color

- Build from one neutral ramp, tinted toward the world from the direction. Pick graphite, warm or ink from the tokens, or tint your own the same way. Background, raised surfaces, borders and text all come from that ramp.
- In apps and dashboards the backgrounds, surfaces, borders and text stay neutral, the graphite ramp or something just as grey. People look at them for hours and the content has to carry the color. A screen whose background reads as orange, brown, blue or green has gone too far. The world shows in the accent, the charts and the moments, not in the surfaces. Landing pages can tint their surfaces further toward the world.
- Three text roles, primary, secondary and muted. Not ten slightly different lavenders.
- In the chrome, one accent, used rarely. It marks the primary action, the selection or the one number that matters.
- The moments from the direction are the exception. Inside them color can be rich, several hues in a chart, a rendered object with real materials, an image with its own light, as long as it stays inside the world and each color means something.
- If the brand has a real color, it becomes the accent and leaves the surfaces. If there is no real brand color, take the accent from the world.
- Accent with text on it reaches 4.5 to 1 contrast. If it does not, darken it or put dark text on it. Accent used as text or ink on a light surface needs the same contrast, so use a darker shade of it there.
- On dark themes the primary button can be an off white from the ramp with dark text, and the accent can live in a smaller place like the selection or a key figure. This often looks more deliberate than a colored button.
- Semantic colors only carry meaning, like green for a good change and red for an error, and they are toned down to sit inside the palette.
- Remove hue gradients on surfaces, gradient text, colored glows and colored shadows, radial color washes and blobs behind content, and neon borders.
- Borders are quiet hairlines, the text color of the ramp at 6 to 10% opacity.
- On dark themes depth comes from surface steps and hairlines, not from shadows. A window or object floating over an image may keep a soft neutral shadow. On light themes shadows are neutral, soft and small.
- A gradient is allowed only as a small tone shift inside one neutral, like an active row going from #2b2b2b to #1f1f1f. Never from one hue to another.

## 3. Icons

- Every emoji used as an icon or as decoration in a label becomes a line icon from one set. Use the set the project already has, otherwise lucide.
- One size and one stroke everywhere, 16 or 18px with a 1.5 stroke.
- Icons take the color of their text role, usually secondary or muted. They never get their own colors.
- The icon box has the same width in every row and the gap to the label is fixed, 8 or 10, so labels align.
- Drop icons that add nothing, like an emoji in every card title or before every section label. Categories that need color get a small status dot.

## 4. Copy

- Headlines say what the product does for whom, in plain words, so they could not fit another product. Use the facts already on the page and do not invent new ones.
- No exclamation marks in interface text, and never `!!`.
- No greeting headlines like `Welcome back, Damir! 👋`. The title names the context, like the page name or the period, for example `October 2026`.
- Short labels. `Search`, not `Search anything...`.
- A change says what it compares to, like `+12% vs last month` or `3 fewer vs last month`.
- Headlines, subheads, labels, buttons and captions end without a period. Only paragraphs of several sentences keep their periods.
- No hype words like supercharge, seamless, unlock, magic, revolutionize or game-changing, and no `AI-powered` on everything.
- Claims that cannot be checked, like `Loved by 10,000+ teams` or `10x faster`, become quiet and specific if the user confirms they are real, and are removed otherwise. Ask, and list them in the report.
- Mock data looks real, with plausible numbers and names, never `[X]` or `123,456`.
- Badges like `PRO`, `New ✨` or `Beta 🚀` go away unless the product really needs them, and then they are quiet text.

## 5. Type

- Choose type for the character in the direction, from the families in the tokens. Keep the project's font when it is part of a real brand. A default like Inter that nobody chose may be swapped when another family fits the character better. One family for the interface, plus at most one partner from any row of the tokens, a mono for figures and meta or a display face for large headlines.
- A few sizes from a scale and two weights, 400 and 500, with 600 at most for rare emphasis. No 700 to 900 headings, no gradient text.
- Hierarchy comes from size and color, not from weight.
- Sentence case everywhere. Labels like `NAVIGATION` or `PAID THIS MONTH` with wide tracking become `Navigation` and `Paid this month`.
- Small text never gets negative letter spacing. Readability on small text means bigger, a bit bolder or slightly looser. Tight tracking is only for large display text.
- Numbers use `tabular-nums` and one format across the screen. If one figure is `$48,210`, the next is not `$124,860.40`.
- No italic for emphasis.

## 6. Layout

- Keep the sections and their order. Inside a section, alignment and proportions may change when that makes the screen clearer.
- Apps and dashboards keep real app proportions. The shell fills the viewport, a sidebar of 240 to 280 and fluid content, usually capped around 1440 to 1600 wide, and the page is as long as its content, with more sections below the first screen. Never shrink an app into a narrow centered column. If the original was drawn as a small window on a backdrop, keep it visibly a window, with its frame and backdrop, and still give it desktop proportions inside.
- The strongest landing hero is a scene. One generated image fills the hero from edge to edge, its subject sits on one side, and the headline sits on the calm empty part of the same image, with the product view rising from the bottom edge. Look at the hero in the references to see it.
- Without a scene, use an asymmetric split, text on one side and the visual given at least half the width, or text over a large product view below it. Everything stacked and centered is the template default, keep it only for a short hero with no visual.
- In a scene hero, the text block sits in the upper part, in the space between the navigation and the top of the product view, at its optical center, a little above the true middle.
- In a split, center the text block vertically against the visual, so neither side leaves a big empty corner. If the visual is much taller, shorten it instead of pushing the text down. Floating cards and devices next to the text are hard to balance, prefer one solid visual. The spacing token from the navigation to the headline applies to stacked heroes, a split hero is centered instead.
- Long headlines align left. Centered text works for one or two short lines.
- One primary action and at most one secondary action next to it. Anything else moves out of the hero.
- Navigation stays quiet. Logo, the existing links, one button. Log in is a quiet text link next to it, not a second button. A floating pill header is not required. On small screens the links collapse into one menu button.
- Compose the first screen as a whole. The hero fills the viewport height without a dead empty band. If the content is shorter, center it or let the product view start low and run past the bottom edge, so the page invites a scroll.
- On small screens everything stacks in reading order, the headline drops to the mobile size from the tokens and the visual comes after the actions. A dense preview gets simpler on mobile, with fewer rows and columns, instead of being zoomed down. No text in it goes below 11px.

## 7. Details

- Nested radius. An inner radius equals the outer radius minus the padding between them, never less than 4. Controls 8 to 10, cards 12 to 16, panels 14 to 20. Not everything is a pill.
- Counts and meta become quiet text, often mono and muted, instead of glowing pills.
- Keyboard shortcuts become small keycaps.
- Charts sit on a muted grid with muted mono labels. No rainbow bars inside one series, no glowing bars, no uppercase day labels. If the chart is placeholder noise, replace it with data that tells something real.
- Charts have a hierarchy, like text. One main chart is clearly the biggest thing on the screen, drawn with care, like smooth lines or a mirrored comparison. Anything else that shows data is smaller and different in kind, like a ranked list with thin bars or a short table, never a second chart of the same size.
- One accent per chart. The thing that matters, like the current month, the line you are tracking or the plan that grew, gets the accent, and everything else sits in neutral steps of the ramp. Several hues only when the chart really has to tell series apart, and even then one leads and the rest are quiet.
- Stat cards are numbers. A label, a big figure and a change with what it compares to. No sparklines, tallies, mini bars or icons added to fill them, they read as decoration. A card can hold a real looking object when it is the very thing its number counts, like a paid receipt next to paid revenue or bank cards next to spend. Use as many as make sense for that dashboard, as long as each one reads on its own and none of them is a mini chart.
- Vary the sizes. Cards of equal width side by side, each with the same kind of content, read as a template. Give the grid a rhythm, like three or four compact stats in a row above one wide chart, or a wide chart next to a narrow list.
- Pick the chart type for the data. A trend is a line, a comparison is bars, a share is one stacked bar or a list with bars, a single goal is a progress bar.
- The active state is a small surface step with a hairline highlight, not a gradient with a glow.
- Hover and focus states exist and stay inside the palette. A visible focus ring for keyboard users.
- The logo is the product name in the main family, plus a simple mark if there is one. No gradient wordmark and no sparkle tile.
- The signature detail from the direction appears where it belongs and nowhere else.

## 8. Visuals

- Decorative filler goes. Glossy blobs, orbs, nebulas, floating cubes, glowing grids, holographic brains and robots say nothing about the product.
- A landing hero gets a visual that shows something true.
- Dashboards and app screens almost never need generated images. Their moments come from the product itself: a chart drawn with care, figures set beautifully, real content like product photos or avatars, a status that feels alive. A physical thing the product deals with, like a payment card in a finance app, is usually better built in code with real materials, a soft gradient, a chip, a number.
- Generate images for an app only for empty states, onboarding and marketing moments, or when the user asks for it.
- With an image generation tool, the first choice for a landing hero is a scene from the world in the direction, generated wide enough to sit behind the whole hero, with calm empty space where the text goes. It carries the color and the mood, and the chrome stays quiet over it.
- Under the scene, or as the visual when there is no tool, show the product. Build a preview in code of what the page already promises, with the project's components or careful HTML and plausible data, like the main screen, one key card or the result the product produces. Showing what the copy already claims is not inventing a feature. In a scene hero it rises from the bottom edge and runs past it.
- The product view carries a moment, not just a plain card. A rendered object inside it, like a payment card on a figure, a rich chart or a small object from the world. These are kinds of objects, so using one that fits is fine.
- Before this pass, look at the references in [references/refs.md](#appendix-refs-md). Take qualities from them, like composition, light, restraint and how the moment is placed, never their subject or layout.
- Rendered objects and scenes come from an image generation tool when you have one. If you do not, build what you can in code, write the prompts for the rest and leave empty slots of the right size.
- How to pick the subject, the prompt recipe and how to place the image are in [references/visuals.md](#appendix-visuals-md). Read it before this pass.

## 9. Motion

- Remove motion that loops for no reason, like `animate-pulse` or `animate-ping` on things that are not live, shimmer on headings, breathing glows, floating elements and parallax.
- Remove `transition-all`, bouncy springs, `hover:scale` on cards and anything that moves more than a few pixels on hover.
- Keep motion that explains something. A hover is a quick color or surface change, a press is a tiny scale down, a menu fades and rises a few pixels from where it opens, a changed number tweens.
- Transition color, background, border, opacity and transform, and name them, like `transition-colors` or `transition-[transform,opacity]` in Tailwind, instead of a catch all. Never animate width, height, top, left, margins or large blurs, they stutter on weak devices.
- One easing curve and a few durations across the screen, from the tokens. Short for feedback, a little longer for things that enter.
- At most one entrance on load, a short fade and rise for the main content with a small stagger. Not every card flying in from a different side.

## Story video

A short video where the screen unslops itself step by step, with red redlines on the slop. Look at [refs/story-dashboard-frames.webp](https://raw.githubusercontent.com/heydamir/unslop/620163eedb3529d9cd23a3994ed8d287d06f760d/skills/unslop/references/refs/story-dashboard-frames.webp) before you build it, eight frames from it in order. That video went viral, and this is how it works:

- **Nothing is swapped, everything morphs.** One page, and each step only changes CSS, so padding, gaps, sizes, colors, radii and shadows tween from the old value to the new one in place. You see the spacing open up, the purple drain out, the corners soften.
- **A wave.** Elements start a few dozen milliseconds apart from the top left down, so a change runs across the screen instead of everything flipping at once.
- **Text rolls.** Copy that changes blurs out, and the new words rise in letter by letter.
- **Redlines first.** The slop gets red selection boxes with tags, a spacing step shows red measurements that turn white once fixed, a details step outlines corners with their radius.
- **Close and short.** Square, cropped close on the part that changes most, so it reads on a phone, and about 10 seconds.

It adds a few minutes, so make it only when the user wants it.

1. **One story file.** Build `unslop-story/story.html`, a standalone copy of the original screen with its styles in the file. Keep the original rules as they are, they are step 0.
2. **Steps.** Three to five, merging passes so each one changes something you can see, like `Spacing`, `Color and icons`, `Type and copy`, `Details`. A new chart or visual goes into the last step. List them in the head as `<meta name="unslop-steps" content="Spacing, Color and icons, Type and copy, Details">`. A name containing Spacing shows spacing measurements, one containing Details shows corner outlines.
3. **Each step is CSS on top.** Write the changes of step 1 under `.s1`, step 2 under `.s2` and so on, like `.s1 .card { padding: 24px }` or `.s2 body { background-color: #141415 }`. The classes add up, so step 3 still has the rules of steps 1 and 2. Change values, never structure, so the browser can tween them.
4. **What cannot tween, and how to handle it.**
   - Gradients, glows and washes: put them on their own layer and fade its `opacity` to 0, with the solid color underneath changing. Gradient text goes on the `.from` span only, never on the swap or its parent, because a text clip also catches the hidden new text.
   - Pills: write their radius as half the height, like `23px`, not `9999px`, or the corner only changes in the last frame.
   - Use swaps sparingly, only where the words change, at most eight in a story. Twenty swaps blurring at once read as a cut between two pictures, which is exactly what the video must not look like. Weight, size, tracking and color changes tween on their own, so they never need a swap. A new font family switches directly in its step, without swaps.
   - Text that changes, a new font family, an emoji that becomes an icon: `<span class="swap" data-at="3"><span class="from">Welcome back, Damir! 👋</span><span class="to">October 2026</span></span>`. At step 3 the old part blurs out and the new one rolls in.
   - Emoji that become icons: put the new icon next to the emoji inside the same box, both absolutely stacked, and crossfade their `opacity` in the step. That is not a swap and does not count toward the limit.
   - Things that disappear, like a `New ✨` badge: `data-out="2"` collapses them at step 2.
   - Things that appear, like a legend: `data-in="4"` fades them in at step 4. Reserve their space so nothing jumps.
5. **Redlines.** The measurements follow the elements live, so their numbers count from the old value to the new one while things move. That is the moment people watch, so choose them well.
   - `data-gap` goes on the blocks of a vertical stack, like the brand row, the search, the navigation group and the plans group in a sidebar, or the headline, the stat row and the chart in the main column. Not on every row, or the screen fills with tiny 2px tags. Aim for four to six measured gaps per stack, and give each stack its own name if there is more than one, like `data-gap="sidebar"` and `data-gap="main"`.
   - `data-radius` goes on two to four buttons and cards whose corners change.
   - `data-slop="Gradient text"` and so on marks the slop for a short first beat, at most five, on the clearest examples that sit apart from each other, with short tags. It is optional, the reference video has none.
6. **Only the screen and its background.** The video shows the story page as it is, with no extra window, border or shadow around it, so the page's own background fills the frame and the screen is the only box. If the screen sits in a window that grows to desktop proportions, anchor it to the left in the story so it widens to the right instead of gliding sideways. The story page renders 1440 wide and at least 900 tall, so do not size things from `100vh`, and keep `position: fixed` for background layers only.
7. **Camera.** `<meta name="unslop-frame" content="0 0 960">` sets which part of the page fills the frame, as x, y and width in page pixels. Point x and y at the screen's own top left corner, so the frame starts with the page background around it, and crop close on where the most visible change happens, usually the sidebar or headline and the first cards.
8. **Render.** `node <skill folder>/scripts/story.mjs unslop-story/story.html unslop-story.mp4`, square by default, `--wide` for 16:9. It needs Playwright and ffmpeg, so if either is missing, tell the user the one command that installs it. To watch it live first, run it with `--play` instead of the output path, and it loops in a browser window until closed. Pull a few frames with ffmpeg and look at them before you hand it over. Checking the story file and the video does not count toward the render limit of a run.
9. **The story file is a presentation piece.** The clean result still ships as normal code in the project's own stack, without `.s` classes or story attributes. Every video carries a small `unslop by @heydamir` credit, as the license asks.

## Do not

- Do not rename the product, even when the name has AI in it. Keep a real logo as it is. When the logo itself is slop, like an emoji or a sparkle in a gradient tile, redraw it flat: the wordmark alone in the new type, or a simple glyph from the product's idea in one solid color. Never a glossy or gradient ball, a glow or a gradient tile, those read as AI at first sight.
- Do not change what the product is. Keep its features, content and the order of sections unless the user asks for more. Placeholder content that means nothing may be replaced with content that does.
- Do not replace removed decoration with new decoration, and do not swap one trend for another like glass, grain, noise, neon or bento grids.
- Do not invent features, claims or data.
- Do not fall back to the same look for every product. The direction decides the palette tint, type and visual, not habit.

## Checklist

- [ ] The direction is written and every pass follows it
- [ ] Every spacing value is on the 4px scale and equal things have equal sizes
- [ ] Icons, labels and numbers each sit in one aligned column
- [ ] One tinted neutral ramp, three text roles, one accent with enough contrast
- [ ] No hue gradients, gradient text, glows, colored shadows or color blobs
- [ ] No emoji left in the interface
- [ ] One icon set at one size and stroke
- [ ] Type chosen for the character, weights 400 to 600, no uppercase tracked labels, no italic, no negative tracking on small text
- [ ] Right to left screens follow [references/rtl.md](#appendix-rtl-md): `dir` and `lang` set, logical properties, the layout mirrored, directional icons flipped, mixed text isolated, one digit system, zero letter spacing on Arabic
- [ ] No exclamation marks, no trailing periods on short strings, no greeting headline, no unverified claims
- [ ] Numbers in one format with tabular figures
- [ ] Nested radii add up
- [ ] Table row states read apart: header, value in use, selection and keyboard focus are each recognizable
- [ ] Buttons share the control radius, no square corners against the component style
- [ ] A hero has a real visual or a product preview with at least one moment, never filler and never a labeled placeholder
- [ ] The first screen is composed as a whole with no dead empty band
- [ ] No looping or bouncy motion, one easing curve, no animated layout properties
- [ ] Template check. If you swapped the product name for another product's, would the screen still fit? If yes, push the direction harder in the copy, the visual and the signature detail

---

## Appendix: effects.md

# Effects

Code treatments that turn an image into something made for this page. They are optional. Use one only when it fits the character in the direction, on the main visual only, and never as decoration on other elements.

## Glyphs

Draw the image as a grid of characters, brightness picking the character. It works best when the characters come from the product's own material, so the image is literally made of what the product deals with.

- Money, invoices, finance: `. : 1 7 4 0 8 $ %`
- Code, developer tools: `. : / { } < > = #`
- Music: note names like `c d e g a` and `♭ ♯`
- Writing, reading: lowercase letters of a word from the product
- Data, monitoring: `. · : | + ▪`

Keep the cell between 6 and 10px, use the mono from the type choice, and color the glyphs from the image or from the ramp. Let a few cells change slowly over time so the picture feels alive.

### Implementation

```js
function glyphs(canvas, image, { cell = 8, chars = ". :1740$%", font = "Geist Mono", fps = 8 } = {}) {
  const ctx = canvas.getContext("2d");
  const columns = Math.floor(canvas.width / cell);
  const rows = Math.floor(canvas.height / cell);

  const sample = document.createElement("canvas");
  sample.width = columns;
  sample.height = rows;
  const sampler = sample.getContext("2d", { willReadFrequently: true });
  sampler.drawImage(image, 0, 0, columns, rows);
  const pixels = sampler.getImageData(0, 0, columns, rows).data;

  const atlas = document.createElement("canvas");
  atlas.width = cell * chars.length;
  atlas.height = cell;
  const pen = atlas.getContext("2d");
  pen.font = `500 ${cell + 1}px ${font}`;
  pen.textAlign = "center";
  pen.textBaseline = "middle";
  pen.fillStyle = "#fff";
  [...chars].forEach((char, index) => pen.fillText(char, index * cell + cell / 2, cell / 2));

  const cells = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const i = (y * columns + x) * 4;
      const light = (0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]) / 255;
      cells.push({ x, y, light, color: `rgb(${pixels[i]},${pixels[i + 1]},${pixels[i + 2]})`, seed: Math.random() });
    }
  }

  const tinted = document.createElement("canvas");
  tinted.width = cell;
  tinted.height = cell;
  const tint = tinted.getContext("2d");

  const draw = (step) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const c of cells) {
      if (c.light < 0.06) continue;
      const jitter = Math.sin(c.seed * 999 + step) > 0.92 ? 1 : 0;
      const pick = Math.min(chars.length - 1, Math.floor(c.light * chars.length) + jitter);
      tint.globalCompositeOperation = "copy";
      tint.drawImage(atlas, pick * cell, 0, cell, cell, 0, 0, cell, cell);
      tint.globalCompositeOperation = "source-in";
      tint.fillStyle = c.color;
      tint.fillRect(0, 0, cell, cell);
      ctx.drawImage(tinted, c.x * cell, c.y * cell);
    }
  };

  let frame = 0;
  let last = 0;
  let step = 0;
  let visible = true;
  new IntersectionObserver(([entry]) => (visible = entry.isIntersecting)).observe(canvas);
  const loop = (now) => {
    frame = requestAnimationFrame(loop);
    if (!visible || now - last < 1000 / fps) return;
    last = now;
    draw(step++);
  };
  frame = requestAnimationFrame(loop);
  return () => cancelAnimationFrame(frame);
}
```

For a large canvas, bake the tinted glyphs for each cell once into an offscreen canvas and only redraw the cells that change on a step.

## Halftone dots

Dots on a grid whose size follows brightness. Suits editorial, print and crafted characters. Same sampling as glyphs, but draw `arc` circles with a radius of `light * cell / 2` in one ink color on the page color.

## Dithering

An ordered or error diffusion dither into two or three colors from the ramp. Suits retro, technical and playful characters. Do it once when the image loads, not on every frame.

## Duotone

Map the image's brightness onto two colors, the darkest surface of the ramp and the accent or the primary text color. The simplest way to make any generated image belong to the palette. In CSS, a grayscale image under a `mix-blend-mode: color` layer of the accent, or an SVG `feColorMatrix` filter.

## Performance

These effects broke on weak laptops before, so keep to these rules.

- Read pixels once when the image loads. Never call `getImageData` inside the animation loop, it stalls the GPU and drops frames to single digits.
- Prepare glyph atlases and tinted cells ahead of time and draw them with `drawImage`.
- Animate at 8 to 12 steps per second, not 60, and change only a small share of cells per step.
- Pause when the canvas is off screen.
- Size the canvas for the device pixel ratio, but cap it at 2.

---

Part of unslop by Damir Sokolovsky ([@heydamir](https://x.com/heydamir)), CC BY 4.0. Keep this credit in copies and adaptations.

---

## Appendix: refs.md

# References

Finished screens by Damir Sokolovsky ([@heydamir](https://x.com/heydamir)). Look at them before the Visuals pass. Take their qualities, never their subject, palette or layout, so every product still gets its own screen. `unslop-dashboard-after` is the finished version of `examples/dashboard.html`, so when you unslop that example, find your own answer instead of rebuilding it.

| File | What it shows | Why it works |
| --- | --- | --- |
| [unslop-hero-after.webp](https://raw.githubusercontent.com/heydamir/unslop/620163eedb3529d9cd23a3994ed8d287d06f760d/skills/unslop/references/refs/unslop-hero-after.webp) | An invoicing hero with a paper plane drawn in digits and currency signs, small notes pinned to it, and the product rising from below | The visual is made of the product's own material, money, so it is the moment and the signature at once. Text sits on calm sky, the chrome is quiet, and the product view invites a scroll |
| [unslop-dashboard-after.webp](https://raw.githubusercontent.com/heydamir/unslop/620163eedb3529d9cd23a3994ed8d287d06f760d/skills/unslop/references/refs/unslop-dashboard-after.webp) | A finance dashboard with two rendered payment cards and a revenue chart drawn as soft colored curves over a mirrored grey comparison | Quiet graphite chrome, and all the color lives in two moments, a real looking object and a chart where every color means a series |
| [beacon-engraving.webp](https://raw.githubusercontent.com/heydamir/unslop/620163eedb3529d9cd23a3994ed8d287d06f760d/skills/unslop/references/refs/beacon-engraving.webp) | An incident monitoring hero drawn as one blue engraving of a lighthouse on a rocky coast, with a serif headline in the same ink | A print style working because the whole page is in it. One ink, one paper tone, and the headline sits in the calm sky the drawing leaves for it |
| [meadow-3d.webp](https://raw.githubusercontent.com/heydamir/unslop/620163eedb3529d9cd23a3994ed8d287d06f760d/skills/unslop/references/refs/meadow-3d.webp) | A footer as a soft 3D meadow with a few matte crystal shapes and a huge wordmark standing behind the hills | Friendly stylized 3D with a restrained palette, type that becomes part of the scene, and quiet links on the open sky |
| [story-dashboard-frames.webp](https://raw.githubusercontent.com/heydamir/unslop/620163eedb3529d9cd23a3994ed8d287d06f760d/skills/unslop/references/refs/story-dashboard-frames.webp) | Eight frames from the viral story video, a vibecoded dashboard unslopping itself in about 10 seconds | Everything morphs in place in a wave, red redlines measure the slop and turn white when fixed, copy rolls letter by letter, and the frame is square and cropped close on the sidebar and first cards |

What they share: one bright element per screen, quiet chrome around it, a visual that can be explained in one sentence, and headlines placed on space that was left empty for them.

---

Part of unslop by Damir Sokolovsky ([@heydamir](https://x.com/heydamir)), CC BY 4.0. Keep this credit in copies and adaptations.

---

## Appendix: rtl.md

# Right to left

Rules for screens in Arabic, Persian, Urdu or Hebrew, or any screen with `dir="rtl"`. Read this before the passes when the screen is right to left, or when the user asks for an Arabic or Hebrew version. Where a rule here differs from the passes in the skill, this one wins.

Most RTL slop is not decoration. It is a left to right screen with the words swapped, so the text runs one way and everything around it runs the other. Fix the direction first, then run the passes as usual.

## Direction

- The root carries `dir="rtl"` and the right `lang`, like `<html lang="ar" dir="rtl">`. Without them the browser aligns text left, picks the wrong fallback fonts and breaks punctuation at the ends of lines.
- Use logical properties everywhere, so the layout flips by itself. `margin-inline-start`, `padding-inline-end`, `inset-inline-start`, `text-align: start`, `border-start-start-radius`. In Tailwind that is `ms-*`, `me-*`, `ps-*`, `pe-*`, `start-*`, `end-*`, `text-start` and `rounded-s-*`. A hard `left` or `right`, `ml-*`, `mr-*` or `text-left` is a bug waiting for the other direction.
- The whole screen mirrors. The sidebar moves to the right, the logo sits at the top right, the primary action of a pair comes first from the right, and a back arrow points right.
- Progress bars, sliders and steppers fill from the right.
- Do not flip with `transform: scaleX(-1)` on whole containers. It mirrors the text inside too.

## Icons

- Mirror icons that show direction or order: back and forward arrows, chevrons in breadcrumbs and next buttons, undo and redo, a list indent, a reply arrow, a send icon, a sidebar toggle.
- Do not mirror icons that show a real object or a universal sign: play, pause and the media controls, a clock, a checkmark, a search glass, a phone, a download arrow pointing down, logos, and anything with Latin letters in it.
- Mirror with `[dir="rtl"] .icon-directional { transform: scaleX(-1) }` on the icon only, or pick the opposite icon from the set.

## Mixed text

- Latin words, numbers, code, emails and links inside an Arabic sentence go in `<bdi>` or get `unicode-bidi: isolate`, so `Al-Fatiha` or `v2.1` does not drag the punctuation around it to the wrong side.
- Signed numbers and changes, like `+12%` or `-3`, go in `<bdi dir="ltr">`. Otherwise the sign jumps to the far side and reads `12%+`.
- Content the user typed, like names, titles and search queries, goes in `<bdi>`, which picks its direction from its own first strong letter. Put `dir="auto"` on an inline element, not on a table cell or a block, or the whole cell flips its alignment and runs into the next column.
- Inputs for email, URLs, phone numbers and codes stay `dir="ltr"` with `text-align: end`, so they read left to right but sit on the right edge with the other fields.

## Numbers

- Choose Western digits (0 to 9) or Arabic-Indic digits (٠ to ٩) for the whole screen and never mix them. Western digits are common in North Africa and in technical products. Arabic-Indic digits suit the Gulf, Egypt and anything traditional or religious. Persian uses its own forms (۰ to ۹).
- Format with `Intl.NumberFormat("ar-EG")`, `"ar-SA"` or `"ar"` with `numberingSystem: "latn"`, instead of building strings by hand.
- Numbers still use `tabular-nums`, and figures in a column align to the end of the column, which is the left edge in RTL.

## Type

- Choose a family that was drawn for the script, with real weights, not a Latin family that falls back to a system Arabic font. Pair it with a Latin family from the same design, so mixed lines keep one texture.

| Character | Arabic interface family | Latin partner | Optional display |
| --- | --- | --- | --- |
| Precise, technical, calm | IBM Plex Sans Arabic | IBM Plex Sans | IBM Plex Mono for figures |
| Neutral, everyday | Noto Sans Arabic | Noto Sans | Noto Kufi Arabic for large headlines |
| Warm, friendly, modern | Readex Pro | Readex Pro | Reem Kufi for the hero headline only |
| Persian first | Vazirmatn | Vazirmatn | |
| Literary, traditional, religious | Noto Sans Arabic or IBM Plex Sans Arabic for the interface | the matching Latin | Noto Naskh Arabic or Amiri for headlines and reading text |

- Hebrew screens use Noto Sans Hebrew, Heebo or Rubik with the same rules, and Urdu reading text uses Noto Nastaliq Urdu.
- Cairo and Tajawal on every element, at every weight, are the Arabic equivalent of Inter that nobody chose. Keep them when they are part of a real brand, otherwise pick for the character.
- Letter spacing on Arabic is always 0. Any tracking, positive or negative, pulls the joined letters apart and breaks the word. This includes large display text.
- Arabic has no capitals, so there is no uppercase or sentence case to fix. Labels get hierarchy from size, weight and color only.
- Arabic has no italic. A browser fakes it by slanting the glyphs, which reads as broken. Use weight or color.
- Arabic looks smaller than Latin at the same size. Body text is 15 to 17, captions no smaller than 13.
- Arabic needs more line height, because dots and vowel marks sit above and below the line. Body 1.6 to 1.8, headings 1.3 to 1.4. The tight 1.02 to 1.08 for Latin heroes clips marks on Arabic.
- Do not justify short interface text and do not stretch words with tatweel (ـ) to fill a line. Align to the start.

## Copy

- Arabic punctuation: the comma `،`, the semicolon `؛` and the question mark `؟`. No space before punctuation and one after it. Quotes are `«»` or `""`, chosen once.
- The rules from the Copy pass hold. No exclamation marks, no greeting headline like `أهلاً بعودتك يا أحمد! 👋`, no trailing period on labels and buttons.
- Arabic hype words count as hype: ثوري، سحري، مذهل، بلا حدود، الأفضل على الإطلاق، بضغطة زر، مدعوم بالذكاء الاصطناعي. Say what the thing does.
- Copy that reads translated, with English word order, `ال` stuck onto English words, or a different register in every label, gets rewritten in one register. Modern Standard Arabic for most products, a dialect only when the brand really speaks it.
- Short labels: `بحث`, not `ابحث عن أي شيء...`.

## Scripture and quoted text

- Quranic verses, hadith, poetry and other quoted text are copied exactly from a verified source, with their marks, and never rewritten, shortened mid verse or invented. If the screen has placeholder scripture, replace it with real text from a source the user names, or leave the exact slot and say so in the report.
- Set it in a face made for reading it, like Amiri Quran or a mushaf font for Quranic text, separate from the interface family.
- No gradient, glow, outline or animation on scripture. It carries the screen through the type, the space around it and the paper it sits on.
- The end of a verse is marked with ۝ (U+06DD) and its number in the digits of the screen, not with a glowing pill.

---

Part of unslop by Damir Sokolovsky ([@heydamir](https://x.com/heydamir)), CC BY 4.0. Keep this credit in copies and adaptations.

---

## Appendix: signs.md

# Signs of slop

Go through every group and note each sign you find with where it lives. Each line pairs the sign with its fix.

## Surfaces and color

- Purple to blue or violet to pink gradients on backgrounds, cards, buttons or the active nav item → one neutral surface, accent only where it means something
- Gradient text in headings, numbers or the logo → solid primary text color
- Colored glows, like `shadow-[0_0_20px_rgba(139,92,246,0.5)]`, `drop-shadow` on emoji or glowing pills → remove, depth from surface steps and hairlines
- Radial color washes or blurred blobs behind content → remove
- Neon or high contrast colored borders → hairline at 6 to 10% opacity
- Many near identical tints of the same hue for text, like five lavenders → three text roles from one neutral ramp
- Every element highlighted, so nothing stands out → one accent used once or twice per screen
- Glass cards with a white inner highlight and a colored shadow → plain raised surface with a hairline

## Type

- Headings at weight 800 or 900 → 400 to 500 and size for hierarchy
- Uppercase labels with wide tracking, like `NAVIGATION` or `PAID THIS MONTH` → sentence case at normal or slightly open tracking
- Too many sizes and weights on one screen → a few sizes from the scale, weights 400 and 500
- Numbers in mixed formats, like `$48,210` next to `$124,860.40`, or `07` → one format, tabular figures
- Negative letter spacing on small text → zero or slightly positive
- Italic used for emphasis → color or weight instead

## Icons

- Emoji as nav icons, label decoration or status, like 🏠 📥 🚀 💰 ⚠️ 📈 🔥 😬 → one line icon set or nothing
- Emoji inside pills and counts, like `18 👤` → plain number
- Icons in many sizes and colors → one size, one stroke, text role color
- Icons nudged off the column → same icon box width in every row
- A sparkle ✨ for anything AI → remove or use a plain icon only where it explains something

## Spacing

- Arbitrary values, like `mt-[13px]`, `ml-[7px]`, `h-[31px]` → steps on the 4px scale
- Rows in one list with different heights or gaps → one height, one gap
- Groups that sit closer to their neighbours than to their own items → smaller gaps inside groups, bigger between them
- Uneven padding inside sibling cards → one padding
- Big empty gaps above a section and cramped space below it → balanced rhythm

## Copy

- Greeting headlines, like `Welcome back, Damir! 👋` → the page or period as the title
- Exclamation marks and `!!` → plain statement
- Changes without a reference, like `+12%!!` or `3 less!!` → `+12% vs last month`, `3 fewer vs last month`
- Wordy placeholders, like `Search anything...` → `Search`
- Hype words, like supercharge, seamless, unlock, magic, revolutionize → what the thing actually does
- Trailing periods on labels and buttons → none
- Fake looking data, like `$123,456` or `[X]` → plausible numbers

## Components

- Glowing pills for counts, plans, shortcuts or status → quiet mono text or a keycap
- `PRO`, `New ✨`, `Beta 🚀` badges everywhere → remove or one quiet text badge
- Every element a full pill, from search to buttons to cards → radius by size, nested radius math
- Charts with rainbow bars, glowing bars, pill shaped bars or uppercase day labels → one or two series, muted grid and mono labels, one highlight color
- Every chart or stack in several shades of the accent, so nothing leads → neutral steps with the accent only on the one thing that matters
- Sparklines, tallies or mini bars added to every stat card → the number, its label and its change
- Equal cards side by side, each with the same chart or layout → one main chart, compact stats, varied widths
- Logo as a gradient tile with a sparkle and a gradient wordmark → product name as text plus a simple flat mark
- Logo mark as a glossy orb, a gradient ball or a glowing dot → a flat glyph in one solid color, or the wordmark alone

## Landing pages and heroes

- A pill badge above the headline, like `✨ Introducing X 2.0` → remove, or a quiet text link if it is real news
- A headline that could fit any product, like `Supercharge your workflow with AI` → say what the product does for whom
- Gradient or shimmer on the headline → solid text
- Floating blobs, orbs, grids and glowing lines behind the hero → plain background or one real product visual
- Everything stacked and centered, headline, text, buttons and a picture below → an asymmetric split or text over a large product view, see the Layout pass
- Three or more buttons, or chips and avatars stacked under the buttons → one primary and at most one secondary action
- `Trusted by 10,000+ teams`, `Loved by 10,000+`, rows of avatar dots or five stars without a source → ask if it is real, then make it quiet and specific or remove it
- Parallax and elements floating on scroll → static layout, motion only with a purpose
- Feature cards with an emoji, a bold title and a vague line each → fewer features, concrete copy, line icons or none

## Visuals

- Glossy 3D blobs, orbs, liquid chrome shapes or a purple nebula as the hero visual → the product itself or one concrete metaphor for what it does
- Stock robots, glowing brains, circuit lines or holograms for anything AI → remove, or show what the AI actually produces
- Text, fake buttons or a fake logo baked into an image → real text in the page, a clean image without text
- An image that does not blend into the page, with a hard edge and a different black → background matched to the page and a soft mask at the edges
- A visual on every section → one visual where it helps, usually only the hero

## Motion

- `animate-pulse`, `animate-ping` or breathing glows on things that are not live → static
- `transition-all` and `hover:scale` on cards and buttons → color or surface step on hover, a tiny scale down on press
- Bouncy springs and overshoot on simple UI → one ease-out curve
- Everything flying in on load from different directions → one short fade and rise with a small stagger
- Parallax, floating loops and elements that move on scroll → static layout
- Animating width, height, top or left → transform and opacity

## Right to left

The fixes are explained in [rtl.md](#appendix-rtl-md).

- Arabic or Hebrew text aligned left, or a page without `dir="rtl"` and `lang` → set both on the root and align to the start
- The sidebar, logo and back arrow still on the left of an Arabic screen → mirror the layout with logical properties
- `ml-*`, `mr-*`, `left-*` and `text-left` in an RTL screen → `ms-*`, `me-*`, `start-*` and `text-start`
- Next and back arrows or chevrons pointing the left to right way → mirror directional icons only, keep media controls and objects as they are
- Progress bars filling from the left → fill from the right
- Letter spacing or `tracking-*` on Arabic, often from uppercase label styles → 0
- Fake italic or fake bold on Arabic, or a Latin font falling back to a system Arabic font → a family drawn for Arabic with real weights
- Cairo or Tajawal on everything with nobody choosing it → a family picked for the character
- Western and Arabic-Indic digits mixed on one screen, like `٣` next to `3` → one digit system
- Latin words or numbers pushing punctuation to the wrong side, or a sign jumping to the end, like `12%+` → `<bdi>` or `unicode-bidi: isolate`, `<bdi dir="ltr">` for signed numbers
- Tight Latin line height clipping dots and vowel marks → 1.6 to 1.8 for body, 1.3 to 1.4 for headings
- Latin punctuation in Arabic, like `,` and `?` → `،` and `؟`
- Arabic hype and greetings, like `تجربة ثورية!` or `أهلاً بعودتك! 👋` → what the product does, the page name as the title
- Gradient text, glow or animation on Quranic or other quoted text → plain text in a reading face, exact from a verified source

## Template look

These are not slop, but they are what a cleaned up screen falls back to when nobody made a decision. Watch for them after the passes.

- Pure grey #161616 page, Inter, white text and the old brand color on one button, on a product whose world is warm or bright → a ramp tinted toward the world and an accent from it
- A headline that would fit another product if you swapped the name → say what this product does, with its own nouns
- A hero visual that is an empty box or a generic picture → a product preview in code or an image from the world
- Every product getting the same layout, type and palette → let the direction choose

---

Part of unslop by Damir Sokolovsky ([@heydamir](https://x.com/heydamir)), CC BY 4.0. Keep this credit in copies and adaptations.

---

## Appendix: tokens.md

# Tokens

Starting values for each pass. When the project already has a good system, keep its values and only fix how they are used. These are starting points, not a house style, so let the direction move them.

## Spacing scale

4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96, 128

- Inside a control: 4 to 12
- Between related items, like rows in a list: 2 to 8
- Between groups, like a label and its list or two cards: 12 to 24
- Between sections: 32 to 64, landing sections 80 to 128
- Row heights: 32 compact, 36 default, 40 to 44 touch
- Hero: 96 to 128 from the navigation to the headline on desktop, 48 to 64 on mobile

## App layout

- Sidebar 240 to 280 wide, content fluid with page padding 24 to 32, capped around 1440 to 1600.
- Top bar or page header 56 to 64 tall.
- Navigation rows 32 to 36, gap 2 to 4, section labels 24 above and 8 below.
- Stat cards in a row share one height, usually 3 or 4 compact cards per row on desktop, numbers only.
- The main chart spans at least two thirds of the content width and is 280 to 360 tall. A second data block next to it is a list or table, narrower, not another chart.

## Neutral ramps

For apps and dashboards use graphite, or a ramp just as grey, for every surface. For landing pages pick the ramp whose tint matches the world in the direction. Warm suits paper, wood, food, craft and anything human. Ink suits night, sky, water and anything technical. You can tint your own ramp the same way, keeping saturation very low, so a surface never reads as a color on its own.

### Dark

| Role | Graphite | Warm | Ink |
| --- | --- | --- | --- |
| Deepest surface, like a sidebar | #0f0f10 | #12110f | #07080d |
| Page background | #141415 | #161513 | #0b0d14 |
| Card | #19191b | #1c1a18 | #11141c |
| Raised, like an active row or input | #232325 | #262421 | #1a1e28 |
| Hairline | primary text at 8% | primary text at 8% | primary text at 8% |
| Primary text | #ededed | #efe9de | #eef0f5 |
| Secondary text | #a1a1a6 | #aaa398 | #a3a9b8 |
| Muted text and icons | #85858b | #8a847a | #7a8296 |

### Light

| Role | Graphite | Warm | Ink |
| --- | --- | --- | --- |
| Page background | #fafafa | #f7f4ee | #f5f7fa |
| Card | #ffffff | #fdfbf7 | #ffffff |
| Raised, like an active row or input | #f4f4f5 | #efe9df | #eceff4 |
| Hairline | primary text at 8% | primary text at 8% | primary text at 8% |
| Primary text | #171717 | #1f1b16 | #111827 |
| Secondary text | #525252 | #5e554a | #4b5565 |
| Muted text and icons | #737373 | #7b7266 | #6b7487 |

Muted text is for meta and captions only and stays near 4.5 to 1 on its surface. Body text uses primary or secondary.

Semantic colors, toned to sit inside any ramp: positive #4cc38a on dark and #16a34a on light, negative #e5484d on dark and #dc2626 on light.

## Accent

- Keep a real brand color. A violet to blue or any other hue to hue glow gradient is slop, not a brand color, unless the user says otherwise.
- Without a brand color, take it from the world. Warm worlds suit amber, coral or ember orange. Cool worlds suit cobalt, teal or a clear sky blue. Natural worlds suit moss or sage. Avoid the purple to blue family unless the brand really is purple.
- Text on the accent reaches 4.5 to 1 contrast. Darken the accent or use dark text when it does not.
- The accent covers a few percent of the screen, like the primary action, the selection and one key figure.

## Buttons

- Hero buttons 44 to 48 tall, navigation buttons 32 to 36, padding 16 to 20 on the sides.
- Primary on dark: an off white from the ramp with dark text, or the accent. Primary on light: the primary text color as a fill with white text, or the accent.
- Secondary: the raised surface with a hairline, primary text.
- A soft top highlight like `inset 0 1px 0 rgba(255,255,255,0.12)` on dark buttons gives depth without a glow.

## Type families

Pick by the character in the direction. All of these are free, and a partner can come from any row.

| Character | Interface family | Optional partner |
| --- | --- | --- |
| Precise, technical, calm | Geist, Inter, IBM Plex Sans | Geist Mono, IBM Plex Mono, JetBrains Mono for figures and meta |
| Warm, friendly, human | Instrument Sans, DM Sans, Figtree | Instrument Serif or Newsreader for the hero headline only |
| Editorial, literary, crafted | Inter or Instrument Sans for the interface | Newsreader, Instrument Serif or Fraunces for headlines |
| Playful, bold | Space Grotesk, Bricolage Grotesque | a mono for small labels |

A display serif belongs to large headlines only, never to labels or buttons.

For Arabic, Persian, Urdu and Hebrew, the families and sizes are in [rtl.md](#appendix-rtl-md). The letter spacing values below are for Latin only.

## Type scale

| Use | Size | Line height | Weight |
| --- | --- | --- | --- |
| Small labels, meta, counts | 12 | 16 | 400, mono welcome |
| Secondary text, captions | 13 to 14 | 20 | 400 |
| Body, nav items | 14 to 15 | 20 to 22 | 400 to 500 |
| Logo wordmark | 16 to 18 | 1 | 500 to 600 |
| Hero subhead | 18 to 20 | 28 to 30 | 400, secondary color, at most 36rem wide |
| Card figures | 28 to 32 | 1 | 500, tabular |
| Page title | 28 to 36 | 1.15 | 400 to 500 |
| Hero headline | 56 to 72 desktop, 36 to 44 mobile | 1.02 to 1.08 | 400 to 500 |

Letter spacing is 0 for anything under 16px, slightly positive like 0.01em is fine for small muted text. Display text from 40px can go to -0.02em, and from 56px to -0.03em.

## Radius

| Element | Radius |
| --- | --- |
| Keycap, tag, small button | 4 to 6 |
| Row, input, button | 8 to 10 |
| Card | 12 to 16 |
| Panel or window | 14 to 20 |

Nested radius: inner = outer − padding, never below 4. A 16px card with 8px padding holds items with an 8px radius.

## Icons

lucide, 16 or 18px, stroke 1.5, color of the muted or secondary text role, 8 to 10px gap to the label.

## Depth

- Dark: surface steps plus a hairline. An active row can carry `inset 0 1px 0 rgba(255,255,255,0.12)` as a top highlight.
- Light: `0 1px 2px rgba(0,0,0,0.05)` for small things, `0 8px 24px rgba(0,0,0,0.06)` for floating ones.

## Motion

One easing curve for everything, `cubic-bezier(0.22, 1, 0.36, 1)`.

| Use | Duration |
| --- | --- |
| Hover, press, toggles | 120 to 180ms |
| Menus, popovers, tooltips | 160 to 220ms |
| Entrances, sheets, layout changes | 300 to 500ms |
| Stagger between items | 40 to 60ms, at most six items |

- Rise distance on enter: 6 to 12px. Press scale: 0.97 to 0.98.
- Transition color, background, border, opacity and transform only.

---

Part of unslop by Damir Sokolovsky ([@heydamir](https://x.com/heydamir)), CC BY 4.0. Keep this credit in copies and adaptations.

---

## Appendix: visuals.md

# Visuals

How to replace decorative filler with a visual that belongs to this product, and how to generate one when an image tool is available.

## Decide what the visual is

1. **Does the screen need one?** Dashboards, settings and most app screens do not. Landing heroes and empty states usually do.
2. **Is there an image tool?** For a landing hero, generate a scene from the world as the background of the whole hero, with the subject on one side and calm space for the headline on the other. Then show the product rising from the bottom edge. This is the strongest hero.
3. **Show the product.** Below the scene, or as the visual when there is no tool, build a preview in code of what the page already promises. Pick the one moment that proves the headline, not the whole app. A scheduling tool shows one week with a booked slot, a code review tool shows one diff with a comment, a habit app shows a streak on one card. Use the project's own components when they exist, otherwise careful HTML in the new palette, with plausible data and real looking names. Frame it like a window or a device only if that helps it read.
4. **Write the scene as one sentence.** Use the world and character from the direction and write the subject as one plain sentence before generating anything. If you cannot say it in one sentence, it is not clear yet.

These examples only show the shape of a good sentence. Do not reuse them, derive yours from the product in front of you.

- A tool that protects backups → a small lighthouse on a dark rocky coast with its beam reaching into fog
- A meditation app → a single cup of tea steaming on a windowsill at first light
- A logistics API → one container ship seen from straight above on a calm grey sea
- A language learning app → a stack of handwritten flashcards on a café table in afternoon sun

Avoid the AI defaults, unless the product is literally about them. No glossy blobs, orbs, nebulas, chrome liquid, floating cubes, neon circuits, holograms, glowing brains, robots, rockets or crystal shapes.

## Styles that work

Pick one that fits the character, and keep it for the whole page.

- **Painted background art.** A calm sky or landscape with one subject, painted like the backgrounds of modern Japanese animated films, crisp clouds and soft light, with open sky left for the text. Good for warm, hopeful, human products.
- **Cinematic photo of one object.** A single real thing in simple dramatic light on a plain field, like a lighthouse in fog or a paper object in mid air. Good for calm, serious, trustworthy products.
- **Soft stylized 3D.** One small scene or object with matte materials and gentle light, like a doorway standing in a meadow. Good for playful or friendly products.
- **Product object render.** A real looking object from the product, like a payment card, a phone or a package, studio lit with true materials, used as a moment inside the interface. Good for anything that touches the physical world.
- **Light and optics.** One physical phenomenon on a dark field, like light splitting through a prism. Good for technical or data products.
- **Engraving or print.** A monochrome engraving or woodcut in one ink on a soft tinted page, with type and palette that belong to the same world. Good for products with heritage, craft or an editorial voice.
- **A code treatment over an image.** Rendering a generated image as glyphs, dots or a duotone in the page palette, so it feels made for the page. See [effects.md](#appendix-effects-md).

What tends to fail:

- Prompts that ask for film grain, paper grain or a mottled texture. Models bake a fine checker pattern into the image. Add texture in code if you need it.
- A print style, like engraving, woodcut or risograph, on one image while the rest of the page is a plain modern interface. It reads as a filter. The same styles work well when the whole brand lives in them, with matching type and a paper palette, like a monochrome engraving on a soft tinted page.
- Several subjects or a busy collage. The idea stops reading in a second.
- Purple and blue glossy abstractions of any kind.

## Objects for moments

Besides whole scenes, generate single objects to place into the interface, like a payment card, a phone, a parcel, a coffee cup or a notebook from the product's world. They make a coded preview feel real.

- Ask for one object, studio lit, on a plain background in the exact page color, with soft contact shadow and nothing else in frame.
- Ask for the angle you need in the layout, like "tilted 20 degrees, seen slightly from above".
- If the tool can remove backgrounds, cut the object out. Otherwise blend it with a mask into the page color.
- Place it overlapping the edge of a card or window, a little rotated, with a soft shadow in the ramp's darkest color, so it sits in the same space as the UI.
- Background removal deletes dark areas that are close to the background color, like a switched off black screen. Ask for the screen in a contrasting flat color, or rebuild the alpha from the outer edge of the cutout.
- To show real UI on a generated device, generate it straight on with no perspective, measure the screen rectangle, lay HTML over it and rotate both together. The text stays sharp and real.
- Everything inside one visual tells the same story. If the list shows invoice INV-0142 for a client, the phone shows the same client, number and amount.

## Generate it

Look for an image generation tool among the tools you have, for example an MCP server for fal, Replicate, OpenAI images, Higgsfield or a design tool. If there is one:

- Show the user the prompt, the model and the size, and ask before running, since generation can cost money.
- Run once. Judge the result against the one sentence and the palette before trying again, and change the prompt rather than rerolling the same one.
- Save the result into the project's assets, not a temporary URL.

If there is no tool and the screen needs a scene or an object, say so before the Visuals pass and offer to connect one, like an MCP server for fal, Replicate, OpenAI images or Higgsfield, then go on once it is connected. If the user skips it, leave the slot empty and put the prompt in your report, not on the page. The empty slot is a plain surface step of the exact size with the radius of the layout and no text inside, so nothing unfinished can ship by accident. Tell the user which kind of service can generate it and the file name to save it under.

## Prompt recipe

Build the prompt from these parts, in this order:

- **Subject.** The one sentence, concrete and physical.
- **Setting.** Where it is, kept simple.
- **Light and palette.** Matched to the page. Name the page background color so the edges can blend into it, and the direction of the light.
- **Style.** One clear direction that fits the character, like cinematic photo, soft 3D render, editorial illustration, risograph print or painted background. Pick what fits the product, not what is trending.
- **Composition.** Where the subject sits so the text has room, like "subject on the right half, calm empty space on the left". For a scene behind the whole hero, ask for 16:9 or wider, keep the lower fifth calm too, since the product view rises over it, and fade the edges into the page color in code.
- **Exclusions.** No text, no letters, no logos, no UI, no watermark.
- **Format.** The aspect ratio of the slot at twice the display size.

## Put it on the page

- Export as WebP or AVIF at twice the display size, with a real `alt` that says what is shown.
- Match the image edges to the page background. If they do not match, fade them with a mask, like `mask-image: radial-gradient(closest-side, #000 70%, transparent)`, or a gradient overlay in the page color. A hard rectangle on a page of a different color is a sign of slop.
- Keep it static or give it one slow, subtle motion that fits the subject. No parallax.
- A treatment in code, like a duotone into the page palette, can make a generated image feel native. Use one only when it fits the character, and never as new decoration.
- Load the hero image with high priority and give it fixed dimensions so the layout does not jump.

---

Part of unslop by Damir Sokolovsky ([@heydamir](https://x.com/heydamir)), CC BY 4.0. Keep this credit in copies and adaptations.
