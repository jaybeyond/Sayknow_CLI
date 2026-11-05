---
name: stageshow
description: Build faux product UI that looks like a real product, as a still illustration or an animated demo with a cursor. Browser and app windows, dashboards, phones, notifications, terminals, bento grids and cursor walkthroughs, framed, masked and cropped the way a marketing page, feature card or docs hero needs them. Use whenever someone wants a fake or mocked UI, a product demo or walkthrough animation, a hero or feature-card illustration of an app, a product shot in the style of a polished marketing site, or an animated cursor doing things in an interface, even if they never say "faux UI". React and plain CSS.
metadata:
  version: 1.1.1
---

# Stageshow

## SKC invocation

SKC loads this skill automatically for matching frontend UI/UX work.
Do not wait for a follow-up question. Apply the craft rules immediately
and keep going on the user's actual task.

This skill's companion reference files are appended inline at the end of
this document. Read them there; they are not separate files on disk.

## SKC: the design center — mandatory for all frontend work

SKC loads this skill first for every frontend task, ahead of the matching specialized skill and `emil-design-eng`: web pages, dashboards, components, design systems, mobile web, native app screens and faux product UI alike. Do not skip it because the task is a single component or a real screen rather than a demo. SKC's own terminal UI is not frontend work and does not route here.

### What applies where

- **Every surface, real product UI included.** The one idea and the five ways it fails are the review bar for every screen you build or review. Apply `references/craft.md` (restraint, type, spacing and alignment, icons and logos, color, chrome) to every still frame, `references/motion.md` to anything that moves (every motion has a cause, content moves instead of swapping, values roll, a result holds), and the hierarchy rules of `references/framing.md` (one focal object, the heaviest mark on what the screen is about, no dead corners, no void under a list). On a real interface the content is the product's own, so the word budget becomes a weight budget: decide where the eye lands and quiet everything else.
- **Look before handing over.** Judge the rendered result, never the code: at the shown width and at 390px, with a browser or screenshot tool when the session has one. Walk the `references/verify.md` questions that apply (Framing, Hierarchy and density, Motion) and fix the largest visible fault first: framing, then hierarchy, then motion, then polish.
- **Faux product UI** (a mocked or illustrated product: hero or feature-card demo, bento tile, cursor walkthrough, product shot, docs illustration, a still or looping animation of an app, phone, terminal or dashboard) follows this skill in full: the seven-step workflow, the kit, the closest gold example and filming with `--gate`.
- Rules about the stage, the `Act` script, the cursor, the loop and the poster frame apply only to faux UI.

### The bundled copy and the full skill

This bundled copy carries `SKILL.md` with every `references/*.md` file and the upstream `NOTICE.md` appended inline: read `references/<name>.md` as the `## Appendix: <name>.md` section at the end of this document. The React kit, the gold examples, `teaching/`, the filming scripts (`scripts/film.mjs`, `jumps.mjs`, `layout.mjs`) and the playground are not bundled; they are React/TS sources plus app-icon artwork the MIT license does not cover.

For a faux UI build, install the full skill into the user's project yourself with `npx -y skills@latest add benjitaylor/skills --skill stageshow -a universal -y` through the `bash` tool. It lands in `<project>/.agents/skills/stageshow/`; copy `kit/` from there, start from the closest gold example and film with its scripts. Later sessions load that installed copy instead of this one. Do not ask the user to run the install. If it fails (offline, blocked registry), say so once and apply the rules here by hand.

### How Stageshow fits with the other bundled UI skills

- **Depicted UI feedback stays real.** A press, menu, tooltip or toggle inside a demo follows `emil-design-eng`: under 300ms, ease-out custom curves, `scale(0.97)` on press, never from `scale(0)`. Only storytelling motion (travel, arrivals, camera, holds) runs slower; that is the "Marketing/explanatory" row of its duration table.
- **Stagger** stays 40-80ms between items in a scene, inside `emil-design-eng`'s 30-80ms band. Tiles of a grid are the one exception: 80-120ms apart.
- **Reduced motion** shows the demo's poster frame: a complete still that tells the story with the result on screen. Movement is dropped, not the payoff.
- **Frequency rule.** A demo loop is decorative and rarely seen; it never blocks interaction and never reacts to the page's keyboard input.
- **Specialized skills keep their scope.** `animate`, `review-animations`, `mobile-native`, `appllama-app-design-skill` and the rest decide their own domain's mechanics; this skill decides whether the result reads as a real, simplified, intentionally framed product.
- **Review output** uses the Before/After/Why table from `emil-design-eng`'s Review Format.


Miniature product UI: a believable interface, framed in its space, as one still or a short animation in which one thing happens. The viewer recognizes the screen and sees the thing happen.

## The one idea

**It reads as a real product, simplified to what the viewer needs, framed with intent, and every motion has a cause.**

Five ways it fails:

- **Too much.** Real text in every row, numbers everywhere, everything packed. The more detail, the more it looks generated.
- **Wireframe.** Two gray blobs and a button. Built too small, or stripped of what made it recognizable.
- **Boxed.** A whole window shrunk into a card with even margins: a screenshot pasted in, not a product shot.
- **Flat.** Every object the same weight in the same bordered card. The eye has nowhere to land.
- **Bland.** A gray window with a cursor, whatever the brief said. The brief's look and energy (a blueprint, glass over color, a Dynamic Island, a mascot) are the point; take what it asks for and build it to the rules, as `examples/hero-demo` does with its typed popup and terminal satellite (a satellite is a smaller second object, a receipt, phone or detail card, straddling the hero's edge).

The fix: a full, structured screen in quiet grays, real words only on what the story is about, placeholder lines for the rest, room to breathe, a crop that puts the eye where the story is. Simplify the words, not the context. An empty corner, a void under a list, rows spread to fill a pane, a window floating on a plate (a backdrop or tinted field behind it): unfinished, not calm.

These are authored illustrations, not browser automation: `a.click()` draws the cursor pressing, `a.set()` changes the scene.

## How hard to press

Build it the way a product designer builds a launch page they will be judged on. The gold examples in `examples/` are the bar, not a reference: if yours is the emptier, flatter or smaller one beside the closest gold, that is the first fix. Then look at the frame the way the most exacting designer you know would, the one who screenshots the one wrong thing and sends it back with "what is this?": a dot off its avatar, a unit on its own line, a grabber under the island, copy touching a card. If you can picture that screenshot, you have found the next fix.

## Workflow

Most of the quality is decided before any code. Write the plan first: where it sits, the focal object, the action, the payoff, what can be left out.

1. **Medium and place.** Still or animation (loop, once in view, or hover). The page, its ground, its width. Design at the size it will be seen, about 720 × 340 for a hero beside copy (`hero-demo`), 900 to 1100 wide for a full-width hero (`linear`), 400 × 300 for a card, shown at 1:1; never under about 320 wide for a demo, though a bento tile or a satellite card may be smaller. Every demo that can sit in a phone column ships a `compact` design at the column's width (358), a redesign not a squeeze (`references/framing.md`, Small formats and the page). A grid of tiles is one set: plan it with `references/bento.md`.
2. **Look.** With the product's code or site at hand, map its tokens to the kit's (`references/looks.md`); if the developer asks for their own components, use them inside the stage instead of the kit's small parts. Otherwise a theme (light, dark, blueprint, glass), a palette (accent, mono) and a fidelity: `minimal` is all bars, `standard` is words where they carry meaning and bars elsewhere, `realistic` is real content everywhere. Default light, accent, standard; go realistic at hero scale, for a named real product, or a still whose subject is a list or page. Write filler once with `Text filler` and the fidelity decides. The product's own icons, its real chrome, the content that makes it recognizable. A brief with a style (kawaii, paper, a poster color) gets that style in full, still built to these rules.
3. **The story.** Its shape (`references/motion.md`, Story): how it feels to use, a flow, or what the system does. Three to five beats and a payoff, 10 to 16 seconds. No cursor move you can't explain. Data never rewinds in view without a cause. Between a richer story and a calmer frame, choose the frame.
4. **Start from an example.** Find the closest gold example (the Gold table below) and film it (`node scripts/film.mjs "<preview>/?capture=<gold>" --select '#example' --still --out gold.png`; `npm run dev` serves the preview). Copy its folder into your project as the starting point; don't rewrite it from a glance. The quickest loop: copy it to `examples/<yours>/` here, where the preview picks it up and `?capture=<yours>` films it, then move it into the host when it passes and fix its kit import path. Keep its structure: the stage size, the crop and bleed, row and type sizes, spacing, the script's beats, the kit parts. Now read `references/craft.md` in full: it is short, and it holds the still-frame rules the gold can't show you, the cases your gold doesn't happen to contain. Then replace its look and content with the brief's product: the tokens from step 2, the product's own icons, chrome and words. A copy that only changes the name is not done: it should read as the brief's product, not the gold's. If no gold tells your story, choose in two parts: the layout first (pick it from the table in `references/framing.md`; each layout names its example), and copy that example even though its story differs; then borrow the motion for your beats from the example whose story is closest, and build what neither has in the same style. Then frame it: crop to the panel the story happens in, judged in the final visible crop (`references/framing.md` has the rules and the layout table). The short form: one gutter, a full one or well past; only filler bleeds; what opens stays in; windows keep their shape; the page is the ground, so no plate under a hero on a white or dark page and no window whole with air on four sides; `unframed` only when the developer asks; no dead corners. Film one still at both widths beside the gold's; if yours is emptier, flatter or more boxed, fix the frame before any motion.
5. **The screen.** Count the real strings, usually 3 to 7 (`references/craft.md`, Restraint): a budget for words, not elements. Build with the kit's tokens, `Bar`, `Text` and `Row`. Fit every control's text before it moves. Mark what the cursor touches with `data-target` and `data-cursor`; measure with `rect()`, never hard-code.
6. **Choreograph.** The `Act` API. Keep what appears mounted and toggle it so exits animate (`Bubble` and `Fly` hand off explicitly). Animate the relationship, not just the object: a new row carries the rows below it, a surface that resizes never stretches its text. Beats overlap, groups stagger, the payoff holds, the loop ends where it began or resets with a visible cause.
7. **Rehearse.** Set `poster` first: most people see only that frame (a thumbnail, reduced motion, a screenshot), so it is the beat that tells the story on its own, never one caught mid-change, with the result left on screen rather than tidied away (`references/motion.md`, Story). Then film the loop, not just a still, and always with `--gate`: it is the same contact sheet plus the verdict, so it costs nothing extra. Film the contact sheet at the shown width and at 390, and step through every press, menu, morph and the loop seam (`references/rehearse.md`). A still can't show a pop. Read every frame, fix the largest visible fault first (framing, then hierarchy, then motion, then polish), re-film. Then hold it next to the closest gold and answer the whole-composition and style pairs in `references/teaching.md` as questions about your still (what does the eye land on first, and is it the result? is one window, tile or device clearly leading?); any no is the largest fault. Don't hand over until the loop's `--gate` ends `rehearsal passed`: every line it prints is a fault a viewer will see, even when the contact sheet looks smooth. Short on time or tool calls, fixing its lines comes before more stills, the review and the notes. Passing is necessary, not sufficient. Then run the last pass in `references/rehearse.md`: a fresh-eye review (`references/review.md`) and `REHEARSAL.md` beside the component (template in `references/verify.md`, Hand over): the gold you copied, what you changed, what you did not check.

Faults that come back every round, each with its rule; check them before handing over:

- **Content that swaps** instead of moving (`references/motion.md`, Changing text and values).
- **Gray bars where the eye lands;** filler belongs at the edges (`references/craft.md`, Restraint).
- **A plate behind the window, or a window floating** with air on four sides; the window or phone fills at least two thirds of the stage and runs off an edge (`references/framing.md`, rule 5 and Small formats and the page).
- **Empty bands, cut controls and shadows** (`references/craft.md`, Restraint; `references/framing.md`, rule 4).
- **Stock AI and made-up logos:** sparkles, purple, a letter in a colored square (`references/craft.md`, Icons and logos).
- **Busy rows and uneven insets** (`references/craft.md`, Restraint and Spacing and alignment).
- **Long holds and a reset with no cause** (`references/motion.md`, Loops).
- **A selection that isn't under the I-beam** (`references/motion.md`, Drags and selection).
- **A status bar or home indicator drawn by hand;** the Phone draws both (`references/craft.md`, Chrome and devices).
- **A centered amount centered with its sign** (`references/craft.md`, Spacing and alignment).

## Examples

Film the closest one before you start (step 4). The gold examples are the quality bar; product studies are for borrowing an interaction, never another product's identity; specimen sheets are catalogs, not compositions. Run everything with `npm install` and `npm run dev`. `teaching/` holds bad/good pairs (`references/teaching.md`) for diagnosing a problem; the bad halves are never starting points.

### Gold

| Need | Example | What to learn |
|---|---|---|
| Still or feature card | `static-card` | Quiet hierarchy, a hard crop, one satellite, real words only on the selected customer, its neighbors and the total |
| Dark still | `dark-bento` | One signal said once; album art keeps it a music app |
| Animated hero, a gesture | `hero-demo` | Five beats, named targets, an annotation, a terminal coming forward |
| Choreography, no cursor | `payout-flow` | Slow overlapping arrivals, reading time, a payoff that holds |
| Content changing in place | `choreography` | Retained tracks, soft masks, dependent timing |
| AI answer | `ai-chat` | The question sent, Thinking, the answer streaming in with its height, sources last; no sparkles, no purple |
| AI with cards | `ai-cards` | A multiple-choice card answered and kept as the record, a card of options opening in the thread, booked from its own button |
| Form validation | `form-error` | An error on the field that caused it, cleared by fixing it, then the button confirms on itself |
| Drag to reorder | `reorder` | A row lifted by its grip, the others making room, dropped into place |
| Chart scrub | `chart-scrub` | A hairline and dot that follow the pointer, the headline value rolling to the day under it |
| Edit in a table | `table-edit` | A cell edited in place, then the total it feeds rolls a beat later |
| Loading to content | `loading` | A skeleton at the content's own geometry, rows resolving top to bottom, real chrome throughout |
| Dark hero | `dark-hero` | Depth from surface steps on black, one lit color, a status that changes on its own pill |
| Live collaborators | `presence` | Each person one color everywhere, names riding their cursors, work shown in the doc's own marks |
| System story | `subscriptions` | A chip flies into a row, MRR rolls, a second scene is the reset |
| Close-up | `close-up` | One control at 1.4x with its window's chrome, the row whole, a large cursor to match |
| Many of one | `many-of-one` | A grid of one thing off every edge, one tile in focus by depth, the only one with words |
| Fade crop | `fade-crop` | A window fading out at its foot, over filler, instead of running off an edge |
| Panel over product | `panel-annotation` | A settings panel over the product's margin, one leader from the setting to what it changed |
| Overlapping windows | `overlap` | A card in front of a window, its edge on the window's sidebar line |
| Stacked cards | `stacked-cards` | Two components at one width, a small gap, the lower one off the bottom |
| Opposite corners | `opposite-corners` | A bento tile: copy bottom-left, the product hung from the top-right corner |
| Tilted stack | `tilted-stack` | A loose pile of paper, small alternating angles, only the top card has words |
| Corner chip | `corner-chip` | A small chip centered on a window's corner, half outside |
| Monochrome | `monochrome` | Other companies' products in a row, grayscale, faded at the foot |
| Row of windows | `window-row` | Sessions side by side at one height: focus by depth, neighbors cut by the stage, only filler cropped |
| Window and phone | `device-pair` | A dashboard and a lock screen telling one event; the phone straddles over margin, never over the figure |
| Related objects | `story` | An invoice, a plan, a connector, rolling totals |
| Calendar drag | `calendar` | A populated week, one focal event, a measured pickup |
| Free dragging | `freeform-drag` | Grab offset, a measured grid, a drop slot that snaps |
| Phone app | `phone-touch` | A card opens into its screen as one object, and the loop folds back |
| Dynamic Island | `dynamic-island` | One black shape, its content a separate layer |
| Messages | `messages` | Composer, typing, receipts, a bubble's lifetime |
| Cursors | `cursors`, `cursor-morph`, `cursor-resize` | Five styles, element-driven kinds, resize edges and corners, no cursor at all |
| Annotations | `annotations` | Leaders, dimensions, flows and a moving target; `references/annotations.md` |
| Feature grid | `bento` | One hero, one window, a stat, an object, a diagram |
| Dark ruled grid | `ruled-bento` | Shared rules and technical imagery |
| Consumer grid | `staggered-bento` | Offset tiles, graphic art, physical objects |
| Image-led hero grid | `hero-grid` | Different grounds and materials composed as one picture |
| Upload | `upload` | A file dragged in from the desktop, an upload row with progress that settles as a file row |
| Share | `share` | A share popover over a document: an email becomes a chip, a role menu, a person added to the list |
| Swipe | `swipe` | A phone swipe to archive: press, swipe, a throw at the finger's speed, the gap closes |

### Product studies

Recognizable products (Figma, Linear, Slack, Raycast, Finder, Spotify, Notion, Gmail, Google's apps, Office, Wikipedia, Telegram, iMessage): read `references/products.md` first. Borrow the interaction, not another product's identity.

| Need | Example | What to learn |
|---|---|---|
| Design tool | `figma` | Canvas selection, a color picker, a second cursor |
| Issue tracker | `linear` | Command menu and assignment |
| Chat | `slack` | Messages, a reaction, a thread reply |
| Launcher | `raycast` | Search and clipboard history over a blurred desktop |
| Files | `finder`, `finder-glass` | Quick Look over a file list; a file moved into a folder; the same window in frosted glass |
| Music, dark | `spotify` | A dark desktop app with album art |
| Docs and editors | `notion`, `google-docs` | A slash command; a comment and its reply |
| Email | `gmail` | Hover actions, archive, an undo toast |
| Calendar, real app | `google-calendar` | Drag to create an event, the quick-create popup |
| Office | `powerpoint`, `excel` | Slide editing; AutoSum and a chart |
| Browser page | `wikipedia` | Search suggestions in a browser |
| Phone conversations | `telegram`, `imessage` | Native chat apps on an iPhone |

### Specimen and reference sheets

Catalogs of parts and grounds, described in `references/kit.md` (Specimen sheets). Look up a part here; compose from a gold example.

| Need | Example | What to learn |
|---|---|---|
| Kit specimens | `chrome`, `phones`, `controls`, `buttons`, `cards`, `parts`, `kit-extras` | Every frame and part |
| Glass | `glass` | Frosted surfaces over a color field |
| Backgrounds | `backgrounds` | One interface over twenty grounds; `references/backgrounds.md` |
| Logos | `brand-marks` | Real marks, optically sized, on light and dark; `references/brands.md` |
| A product's look | `looks` | Type, shape and color working together |

## The kit

Copy `kit/` into the project and import from `kit/index.ts`. React, react-dom and lucide-react (for `Icon`, which `Field` and `Chip` use); each part brings its own CSS. It does the parts that are hard to get right by hand and leaves the product's look to you. `references/kit.md` has every part's props and rules; read the entries for the parts you use.

- **The stage.** `Stage`: design size and scale-to-fit, `compact`, scene state, playback, the look, the cursor. The script gets an `Act` (`set`, `wait`, `move`, `click`, `type` and the rest: `references/kit.md`, Act).
- **Frames.** `Window`, `Phone` with `LockScreen` and `Notification`, `Keyboard`, `Thread` with `Bubble`, `Stamp`, `Receipt`. Real geometry; never draw a window, device or bubble by hand.
- **Motion.** `Collapse`, `Roll`, `Swap`, `Count`, `Connector`, `Fly`, `Follow`, `States`, `Stream`, `Popover`, `Scroll`, `Camera`, `Expand`. They handle the frames a cold hand gets wrong.
- **Small parts.** `Bar`, `Text`, `Row` (every list is made of it), `Card`, `Divider`, `Avatar`, `Pin`, `Icon`, `Menu`, `Field`, `Draft`, `Button`, `Segmented`, `Toggle`, `Tabs`, `Badge`, `Chip`, `Kbd`, `BrandMark`, `Code`, `Chart`, `Toast`. Quiet starting points; restyle to the product, never reshape a kit part's geometry from outside.
- **Use the kit part, never a lookalike.** Before writing a class for a button, card, tab, avatar, field, toast, badge or shortcut, check this list: a hand-built one is where uneven padding, squeezed labels and unsized text come from. Restyle the kit part with its props and tokens instead. When a button's label or icon changes, change it on the same `Button`, which animates it; never swap in a second element (`references/motion.md`, Story).
- **`stageshow.css`**: tokens, looks, edge fades, chrome, phones, keycaps.

## The references

`references/framing.md`: the framing rules and the layout table. `references/craft.md`: the still frame (restraint, type, spacing, icons, color, chrome). `references/motion.md`: story, loops, pace, the cursor and drags. `references/verify.md`: the checklist with a you-see / you-do table. `references/rehearse.md`: how to film, and the film lines that are never intentional.

---

## Appendix: NOTICE.md

# Notices

Stageshow source is MIT licensed; see `LICENSE`.

Product and operating-system names, familiar device geometry, app icons, and
illustrated interfaces are used as examples. Those names and marks remain
with their owners; the Stageshow license does not grant trademark rights or
imply endorsement. Adapt examples to the product you are illustrating.

The Radix-inspired look uses publicly documented color and spacing values;
its source is identified in `examples/looks/radix.css`. The app icons in `assets/app-icons.ts` are artwork from their respective app
bundles, as identified in that file; they are not covered by the Stageshow MIT
license. They remain illustrative references to those products. The Wikipedia
study includes two local photographs dedicated under CC0 1.0 (also used
in the Finder, Telegram and annotation studies); their authors,
original source pages and modifications are recorded in
[`examples/wikipedia/PHOTOS.md`](examples/wikipedia/PHOTOS.md). Other scenes
use CSS and vector illustrations. No third-party fonts are bundled, and the
playground does not fetch fonts or photographs from external services at runtime.

The local brand registry in `kit/brands/` includes SVG artwork from SVGL (MIT), payment-icons (Apache 2.0), Cryptocurrency Icons (CC0 1.0), and official Linear, American Express and Circle assets. Per-file sources, hashes and license files are listed in [`kit/brands/SOURCES.md`](kit/brands/SOURCES.md). The original artwork and brand usage terms remain with their respective owners.

`Phone frame="photo"` is optional. Supply your own permitted bezel image via
`--ss-phone-photo-light: url(...)` and optionally `--ss-phone-photo-dark`.
Without it, the kit uses its CSS-drawn `pro` frame. No bezel photographs are
bundled.

---

## Appendix: annotations.md

# Annotations, guides and connecting lines

An annotation explains one relationship: what a chart point means, how big a selection is, where an event went, which object a note belongs to. The product stays visible. A line earns its place by removing ambiguity; it is not a reason to add a spotlight, another frame or a caption to every object.

Design the product before its annotations. A line that attaches perfectly cannot rescue faint text, weak hierarchy or generic nested cards. Give the table, invoice or record believable anatomy, readable type and one clear action, and save the stronger color for the relationship the line explains.

See `examples/annotations/`. Its picker mounts one of eight studies, so only the chosen story runs. The scenes use a native canvas width down to 288px instead of shrinking their labels, and each has a reduced-motion result.

| Study | Cause and result | Geometry owner |
|---|---|---|
| Usage into an invoice | Three usage sources connect, deliver their first combined result, then the feeds stay open. | Each source is measured; one white-rimmed junction joins the inputs before the solid delivery. |
| A payout and its detail | Select a payout; its linked settlement opens; a leader explains its arrival; clearing closes the detail. | A dotted record link and a separate solid leader meet measured surface edges. |
| A chart point | Select a point; its explanation appears; click away to clear it. | Point and label are measured with `rect()`; their edges go to `Connector`. |
| Selection and dimensions | Select a card, resize it by its handle, drag back, deselect. | Card, ring and guides share one changing box, which shows its real dimensions. |
| A request and its reply | Send an event; the request draws; the acknowledgement returns after delivery; the trace clears. | Measured source and destination edges. Solid outbound arrow, dashed return. |
| Following a layer | Select a photograph; Arrange moves and resizes it; Reset returns it; click away to clear. | `Follow` owns the object and its note together. |
| A shared processing graph | Store an asset, fan out to three jobs, then clear the completed result. | One measured trunk and one shared spine; each branch starts at its own junction. |
| An ongoing event stream | Connect a checkout source; events keep arriving in its activity table. | A static measured route under moving dots; the path never moves. |

## Choose a line for a relationship

Start with the product question, then choose the line. If the layout already makes the relationship obvious, leave the line out. More connections do not make a fuller explanation.

Give related surfaces different jobs and different weight: the invoice leads and a smaller usage table sits in front of its empty upper corner; the selected ledger row stays readable beside a smaller settlement detail. Overlap can tie a composition together, but it never covers record text or forces a line through useful content. At narrow widths, stack the relationship rather than shrinking its type.

- **A leader explains a visible object or value.** One selected point joined to one short note, usually with no arrow and no continuing motion. Keep the note out of useful content and remove it with the selection.
- **A leader is a fine line with two clear ends.** 1px (1.5px at hero scale) in a quiet ink, never a bar. It leaves the note's edge and lands 4 to 6px short of the object it explains, ending in a 4px dot or at the object's edge with a gap, never butting into or crossing a rounded border. It runs straight or with one bend; it does not pass behind or through another surface (`examples/annotations`).
- **A record link joins two views of the same thing.** One row opens its settlement, and a fine dotted link makes that explicit. The quieter solid leader below explains arrival. Different jobs, different weights.
- **A collection joins several inputs to one result.** Three meter rows gather into one invoice. One blue runs through the incoming paths, their junction and the shared output, because they are one relationship; the small junction is the aggregation. Draw each incoming route once, and start the delivery only after every input has arrived. Never add a junction to fill space.
- **Direction shows transfer.** A request, an acknowledgement or a posted result needs an unambiguous origin and destination. A request and its response start from different ends, so the return arrow starts at the recipient; a decorative two-headed line cannot say that. Reveal the route before confirming arrival, and change the status after the transfer, not before the line has landed. A stationary arrow can stay afterwards.
- **A moving phase shows ongoing work.** Dots move only while data is flowing: fine, slow enough to follow, on a fixed route with only the phase animated. Never on a finished one-off request. Stop or freeze them when the connection closes, pause them offscreen and with the host, and keep a static directional poster under reduced motion. A finished invoice update can sit beside an ongoing feed: its first values have landed while new usage still travels the retained routes.

A small white pill with a fine rim and a tight shadow makes a job or service read as a node. In the processing graph each pill holds the job name and, where there is room, its arriving check; the narrow layout keeps the text alone and marks completion through the pill's ink and rim instead of squeezing in an icon. The source stays a file row with its filename, metadata and action. A node is part of the system being explained; annotation text is the explanation attached to it. Don't turn every label and endpoint into the same pill, and measure the pill's visible edge when connecting to it.

Center the pill's visible content as one group. A hidden status icon reserves neither width nor gap: the name alone is centered before the result, then the slot and gap open while the label moves with them, so the group stays centered throughout. Reverse that on removal.

A short inline badge can name the line itself: `POST`, `200 OK`, a protocol, a step. A slightly heavier label and a small shadow keep it legible over the stroke. It arrives with the completed line and keeps its footprint small; it is neither an endpoint nor a product surface.

A saturated blue dotted line is a deliberate, legible treatment; purple or teal can suit another study. One relationship, one color, rather than a hue per joined input. Color need not be pale to be restrained. The kit's default endpoint is a small colored center matching the route, a white rim and a subtle shadow, which marks a port or junction against a crossing line. Size it to the stroke and the display scale, treat it as a specific node rather than a decoration for every endpoint, and let it appear on arrival with its center on the route. A plain cap, a small arrow or no marker may be clearer elsewhere.

Keep four things separate: the route's geometry, the stroke pattern, the reveal along the route, and any continuing phase. A reveal mask lets a dotted line draw progressively without stretching its dots, and the phase never moves the route or the attached content.

## Attach to what is drawn

`Connector` takes points in stage pixels. Derive them from named targets, never from positions guessed off a screenshot. Attach to the edge that faces the relationship, with room for the line and its label, and keep the label out of the main content and other connectors. Horizontal and vertical compositions may need different endpoints.

Check the direction of the final segment, not just where it ends. A line meeting a label's bottom edge approaches vertically; one meeting its side approaches horizontally. An endpoint on the right border is still wrong if the segment before it runs along that border, underlines the label or crosses its interior. In the chart study, `route="h"` travels across first, then rises to the measured bottom center.

`rect()` refreshes after state commits and when a CSS transition finishes; it does not track CSS motion every frame. When something moves continuously, either update the scene's state each frame or put the object and its annotation in the same moving coordinate space. The following-layer study does the latter: its leader, note and outline are children of the same `Follow` wrapper as the object. A separate line aimed at Follow's destination would jump ahead of the visible layer.

`Follow` suits a selection ring retargeting between objects: it keeps its velocity while the target rect changes. Don't give the label its own spring if it must stay attached. For a drag, keep the grip offset and use `a.drag`'s per-frame point to size or move the object; read the displayed dimension from that same geometry, not from a number chosen in advance.

## Show the cause, then hold the explanation

Start the line when selection or delivery begins. `Connector` draws on and fades off intact; its arrow and label arrive with the line. A callout can fade in without moving its measured anchor. Hold the result long enough to read, and clear it with an on-screen action.

Endpoint markers wait for the visible route to reach them; `Connector` ties them to the reveal. A branching graph propagates from its incoming junction outward, starting each branch as its junction is reached, and a sender confirms delivery after the acknowledgement returns. Crossfade discrete statuses in stable `States` slots, start-aligned beside their status dots; a measured dimension tracks its box directly, in tabular numerals.

Line styles mean different things: a solid request and a dashed acknowledgement separate direction and role. A shared trunk means one input fans out, so draw the shared segment once, or the overlapping paths darken and knot.

## Frame the whole relationship

Leave room for the guide, arrowhead and label outside the target, clear of the product frame's clip. On a narrow host, stack the surfaces and move the labels with their lines, at their normal size. Chart marks may compress horizontally; their label stays readable. An annotation is not permission to cover the result it explains.

If a detail really needs a camera, use `Camera` with a focus from `a.rect(name, { layout: true })`, keep the annotation in the same coordinate space as its target, and never feed an already transformed rect back into the focus. These studies read without one.

## Check attachment in motion

Film `?capture=annotations`, choosing a study with `annotation=collect`, `detail`, `chart`, `measure`, `flow`, `follow`, `branch` or `stream`:

```sh
node scripts/film.mjs '<url>/?capture=annotations&annotation=follow' --out shots/annotation-follow.png
node scripts/layout.mjs '<url>/?capture=annotations&annotation=measure' --select body
```

Watch the entry, the held result, the exit and the return. During a resize, compare the guide ends with the card's edges on every sampled frame; during a follow, compare the leader's end with the object's edge, since a clean start and end can hide separation between them. Check the narrow width, and the picker, focus and Replay too. A contact sheet cannot prove continuous attachment or steady text: the gaps between samples are unchecked.

---

## Appendix: backgrounds.md

# Backgrounds and the whole picture

The supplied looks are examples, not a menu of allowed styles. Start with the product and the feeling you want. A neutral interface, a saturated poster, a dark technical surface, a tactile control and an image-led composition can all work. Typography, content, layout, imagery, material and motion should all support the same idea; changing the accent color alone does not make a new identity.

## Choose the ground for what it does

- **Quiet solid or tint:** gives dense UI room to read. Separate the foreground with a clear step in value before adding a shadow.
- **Color field or graphic pattern:** makes a sparse picture distinctive. Keep a calm area behind useful text, and let the pattern give direction or scale. Crisp bands show what a glass surface blurs; a glow everywhere cannot.
- **Colorful gradient:** choose its direction and color relationships on purpose. A diagonal transition, a broad radial light, blended fields and a multicolor sweep are different compositions. Keep strong color behind an opaque surface, or give glass enough density to keep its text readable. A vivid ground does not also need vivid controls, a colored shadow and a glow.
- **Material:** paper, glass, metal and sculpted plastic need different edges, highlights and shadows. Use those cues consistently. Texture supports a material; it does not sit over text or stand in for hierarchy.
- **Photography or artwork:** use a suitable licensed local asset, keep its subject and credit it where required. A graphic illustration may be abstract, but never present a CSS landscape as a photograph. The graphic album sleeve in `examples/hero-grid/` is artwork on purpose.
- **Dark:** choose text, borders and raised surfaces together. Black behind a white mockup and a coherent dark product are different compositions; both can be intentional.

`examples/backgrounds/` holds the same small interface across twenty grounds, so you can compare tint, fields, light, linework, material, six vivid gradients and six textures (dot grid, halftone, blueprint, grain, conic sweep, fine stripes). The gradients vary their direction, value and material rather than repeating one glow in different colors. They are examples of relationships, not a preset selector.

Give banded grounds a hierarchy: a dominant field, a supporting color and an optional narrow highlight. Let glass show their tint while its text and controls stay readable. Band width and color area deserve the same composition judgment as the foreground.

## Compose the set before the tiles

The rules of the set (one hero, contrasting neighbors, grounds composed together, copy outside the picture) are `bento.md` rules 2, 4, 6 and 10. `examples/hero-grid/` shows them with several grounds: a drafting sheet, orange keycaps, violet-to-peach bands under glass, a neutral icon collection and a dark music player, held by shared 8px gaps and 12px corners. Orange returns in the artwork and violet links the glass to the dark sleeve: borrow the relationships, not the colors. Judge adjacent colors as a pair and the grid as a silhouette. An image-led hero can skip tile headlines when the pictures carry the idea.

## Objects and drawings as tiles

The tiles that stop a grid being five windows are rarely UI: a payment card lit from one side, a folded corner of paper, a chip, a keycap, a line drawing of a stack or a graph. Give an object one light source, a real material (a matte card has a soft falloff, a glass pane has a rim) and a shadow that agrees with the tiles around it. A line drawing uses one stroke weight and the grid's own ink, and holds still. Neither needs a label inside the picture; the tile copy does that.

A stack of objects is one object. Center the whole silhouette (every card in the fan, not the front one) with the same air on each side of the tile, and keep the back ones clear of the copy; a stack drifting up under the words reads as spilt. A payment card keeps its real anatomy at any size: the chip about an eighth of the card's width, a third of the way down, with the contactless arcs beside it at about half the chip's height; the name and number along the bottom edge, the network mark in the bottom-right corner. A chip the size of an icon on a card the size of a tile is the first thing that gives a drawn card away.

## Recompose for the host

Recomposition and motion follow `bento.md` rules 11, 12 and 13. In `examples/hero-grid/` the controls get a native compact layout, the glass and player go full width, the two small object collections share a row, and only the drafting tile has a story. A crop can take a blank keycap edge, album artwork or window margin, never the label or result the viewer needs.

---

## Appendix: bento.md

# Bento

A bento grid is one picture made of tiles, not five demos side by side. Most of its quality is decided before any tile is built: which tiles show UI at all, which one is the hero, and what sits next to what. A grid where every tile is a cropped window reads as generated however well each window is made.

These are starting recipes for mixed feature grids; the product, brief and content decide the final composition. Single-tile framing (crops, satellites, gutters) is in `framing.md`; this file is about the set.

## The rules

1. **Not every tile is UI.** About a third to a half of the tiles show product UI; the rest are other kinds (the table below). UI is the thing a bento is good at breaking up, not the thing it repeats.
2. **One hero.** One tile is bigger (two columns, or two rows) and carries the richest picture or the main idea. The rest support it at a smaller size: a wide UI tile spanning two thirds of a row, or an object or photograph leading a taller composition. Equal tiles need a clear difference in content and weight.
3. **A UI tile shows one thing, not a window.** Crop to the single component the tile is about (the button, the status stepper, the fee picker, the command row) and show it at real size or larger, so a third of the tile can be one control. Window chrome appears at most once in a grid, on the hero; four sets of traffic lights in one grid is four times the same signal.
4. **Neighbors contrast.** Alternate kinds like a checkerboard, across and down: a picture next to a number, dense next to calm, a photo next to an icon and a sentence. Two window crops never sit side by side. Vary density and silhouette across rows and columns so the eye has a clear path.
5. **Big type is a tile.** A stat tile is one real number at display size (48 to 72px as shown), a short lead ("Up to"), a one-line label, and at most one colored glyph such as a bolt or battery. A short statement in large type ("99.99% uptime", "More ports and faster charging.") is a tile too. These are the calm tiles that let the UI tiles breathe. Real figures, never "10x" filler. The number sits close under its copy or fills the tile; a stat pinned to the bottom of a tall tile with a void above it reads as missing content, not calm.
6. **Copy is short and outside the picture.** A title of one to four words, or one sentence; at most one supporting sentence; never a paragraph or a bullet list. Two patterns work: the run-in, a bold lead and a gray continuation at the same size ("**Stay in sync.** Your files stay up to date."), or a large title alone. Tile copy is page type: 17 to 24px, set by the page, never the 12px of the UI inside the tile. A 15px title scaled to 10px is a caption, not a headline.
7. **One frame, varied contents.** Tiles share radius, gap, padding and where the copy sits (all top or all bottom); the variety lives inside them, and grounds and materials may differ when the composition calls for it. Pick one family: rounded tiles on a gap, or a ruled grid with no gap and fine lines between cells. The gap equals the tiles' inner padding or a clear fraction of it. Judge the outside too: a grid on its own ground usually wants an even outer gutter, and a page that already gives that space shouldn't double it. A crop inside one tile is no reason to press the whole grid against its frame. Align left-led UI and diagrams to the copy gutter with one gap below the copy; don't center each by habit. A centered object is its own deliberate composition.
8. **Use the tile edge deliberately.** The outer tile owns the bleed. An inner fixed-width Stage must not slice a window halfway across a wider tile and leave a blank strip beside it: measure the picture slot and match its width at every breakpoint, compact included, and inspect the right and bottom edges at the host's width. `scripts/layout.mjs` reports this as `nested-composition-crop`; look at the image and fix any unintended inner cut. A window or phone can enter from an edge and crop supporting content, as in `framing.md`, with its action and payoff whole. A UI fragment without chrome can dissolve into the tile ground; a solid window crops at a clear boundary. A centered object, lone control or statistic can be shown complete when its scale and the space around it are intentional. The boxed failure is shrinking a whole screen until its contents are unreadable, not leaving a margin.
9. **Say each thing once across the set.** No real string, avatar, color mark or chrome repeats from tile to tile. One conversation threaded through five tiles ("Refund for order #4821" three times) is the same signal repeated, not a story.
10. **Compose the grounds together.** A quiet feature grid can share one surface, with one photo, accent or inverted tile as punctuation. That is a starting recipe, not a limit: an expressive hero grid can use several grounds when their lightness, temperature and saturation make a rhythm. Keep neighbors distinct, give one tile the lead, and don't repeat the same gradient or spend every accent everywhere. See `backgrounds.md` and `examples/hero-grid/` for a multicolor composition.
11. **Give motion one place to lead.** In a supporting feature grid a tile does one small thing: a number ticks, a dot grid changes, a bar fills, a button settles into its pressed state. It plays once as the grid scrolls in, staggered 80 to 120ms across tiles in reading order, or on hover for that tile alone. A hero grid can give its lead tile a short cursor story while the others hold still, as in `examples/hero-grid/`. Several competing loops leave the eye nowhere to land.
12. **Shown at 1:1, one Stage per tile.** Each picture is its own `Stage`; the copy is page HTML beside it, never inside the stage. Never wrap the whole grid in one Stage: it scales every tile's type down with the grid (a 1000px grid in a 630px column draws 15px titles at 9.5px). Tiles change width as the grid reflows, so measure the picture slot, use that native width for a bleeding Stage, and recompose its contents for compact slots. Text stays at native size; changing a Stage's width is not a scale transform, and a host wrapper marked `data-ss-wide` scales the wide design only for a slot sized by height. Pin a deliberate crop to the tile edge. A centered object can keep a fixed design canvas when its inner boundary cuts only empty ground. `examples/bento/` uses both patterns.
13. **Narrow, it recomposes.** Keep two columns only while each tile stays readable and deliberately framed: an article column around 550px may hold two, a phone column usually stacks, hero first. Pick the breakpoint from the content, not a universal screen width. Each UI picture gets a compact composition when it no longer fits; type tiles reflow by themselves. Important text stays at least 10px at a 320px host, gutters included.
14. **A stat is one line.** The number and its unit sit together and never wrap: size the number to the tile with the unit on (`white-space: nowrap`), or move the unit into the lead line ("Works at 30,000 ft" becomes a lead of "Works at" and a number of "30,000 ft" that fits). The film names it `unit wrapped:`.

## Kinds of tile

| Kind | What it holds | Example |
|---|---|---|
| **One component** | A single control or panel at real size or larger, cropped by the tile | A backup control, keycaps or locale list |
| **Hero UI** | The one tile with a real screen: window or phone, cropped per `framing.md` | Checkout or a conversation |
| **Stat** | One big number, a lead, a label, maybe one colored glyph | Battery life, charging progress or measured uptime |
| **Statement** | One sentence in large type, an icon in color beside or above | A short claim about connectivity or speed |
| **Object** | A product, a card, a chip, an isometric drawing | A payment card, processor or physical control |
| **Diagram** | An abstract picture of what the feature does: a grid, a heatmap, nodes and lines | A heatmap, sync relationship or shared canvas |
| **Collection** | Logos, app icons, file tiles, emoji: many small marks, bleeding off | Integration marks, file thumbnails or emoji |
| **Photo** | A real photo, with type over its quiet part. Never a scene drawn in SVG or CSS to stand in for one: however much grain and haze it gets, a drawn "photo" reads as generated. With no licensed photo to hand, pick another kind. A landscape photo rarely fits a tall tile with copy on top: it ends up a sliver, or the horizon crowds the headline. An illustration in its place is either purely graphic (a pattern, a motif from the place, like azulejo tiles for Portugal) or drawn in smooth, continuous curves, never lumpy or faceted, and it holds still | A licensed product or lifestyle photograph |

A grid of five usually wants one hero UI, one or two components, one stat or statement, and one object, diagram or collection.

## Layouts

| Layout | Shape | Use for |
|---|---|---|
| **Hero and strip** | A row of 2/3 + 1/3, then three equal tiles | The default for five or six features |
| **Staggered pair** | Two columns, tall and short tiles alternating, offset between columns | Four to six claims with photos |
| **Even grid** | 3 × 2 equal tiles | Only when every neighbor is a different kind |
| **Big square** | Four columns, a 2 × 2 hero, small tiles round it | Many products, one flagship |
| **Ruled** | One rounded container, 1px rules, no gaps, mixed spans | Technical or developer pages |

**Every width is its own design.** Check the grid at each width it will meet, down to an article column (about 550, so half tiles near 270). Two columns work there when each picture has been composed for its narrower tile; stack when the content needs more width. At each width every picture lines up with its tile's copy: left edge on the copy's gutter, and a matching gutter on the right or a clear crop off the right or bottom. Never center a picture about as wide as the tile, so it touches both edges or loses a few pixels to each; resize it, re-lay it out or swap the card for that width.

## Planning a grid

Write the tile list before building anything:

| Tile | Span | Kind | The one thing | Words |
|---|---|---|---|---|
| Inbox | 2 × 1 | Hero UI | One conversation arriving, selected | "Shared inbox" + one sentence |
| SLAs | 1 × 1 | Stat | "14m" left, in the warning color | "Never miss a reply." |
| Assign | 1 × 1 | Component | The assignee menu, Maya checked | "Assignments" |
| AI drafts | 1 × 2 | Component | The draft reply and its Send button | "Drafts that sound like you." |
| Integrations | 1 × 1 | Collection | App marks bleeding off the right | "Works with your tools." |

Then check the plan against rules 1, 2, 3, 4 and 9: how many tiles are UI, which is the hero, does any tile sit next to the same kind, does any real string appear twice. Inspect the built grid and each crop at the widest and narrowest host; a good tile can still be the wrong neighbor. The still questions are in `verify.md`.

---

## Appendix: brands.md

# Brand marks

Use current real artwork when a scene shows a known product or payment method. Check the official brand source before trusting a third-party icon catalog: catalogs keep outdated colors and logos. `BrandMark` has a small local registry for common integrations and checkout rows. The SVGs ship with the kit, keep their original colors and proportions, and never call an icon service at runtime.

```tsx
import { BrandMark } from './kit'

<BrandMark brand="google-calendar" size={28} />
<BrandMark brand="visa" size={20} tile={false} />
<BrandMark name="Your product" src="/assets/product.svg" size={28} />
```

`size` is the footprint's height. App marks get a square footprint; wide payment marks get a proportionate width. Amex uses its white wordmark on a blue card tile, and its official blue-box logo when bare. A mark that ships as a glyph on a solid square field (Dropbox) is shown as the glyph alone in its brand color, on the same white tile as the other app marks; a sharp blue square inside a rounded white one is never right, and a solid blue tile shouts next to the rest of the row. `width` overrides the footprint when a product row has a fixed track. The artwork is always `object-fit: contain`, never stretched to fill a square. The bundled marks carry optical scale adjustments, so a narrow Figma mark and a full Gmail mark have the same presence.

`surface` follows the Stage's light or dark theme. Pass `surface="light"` for a white card inside a dark Stage. Dark variants are picked automatically where supplied; full-color artwork without one keeps a white tile on a dark surface. If you remove the tile, check the bare mark against its real background. Keep the native colors even in a monochrome UI. Crypto marks are flat, with no coin bevels or metallic shading.

`name` overrides the accessible label. A custom `name` with no artwork keeps the neutral initial tile for a fictional product; never use an initial or a hand-drawn approximation in place of a supplied real mark. Minimal fidelity hides the artwork along with the other content.

A real company named in the scene (Chase, Wells Fargo, Stripe, Slack) carries its real mark from `kit/brands/`, never an initial in a brand-colored tile: that is an invented logo beside a real name, and film flags `invented mark`. The kit carries the payment networks, the common product marks and seven banks (Chase, Wells Fargo, Bank of America, Barclays, HSBC, Monzo, Revolut, in `kit/brands/`, category Banks). If the kit has no mark for the company, name one it has, or a fictional one with the neutral initial tile; a real name and a fake mark together are the one thing never shipped.

| Group | `brand` values |
|---|---|
| Payments | `visa`, `mastercard`, `amex`, `discover`, `paypal`, `stripe` |
| Crypto | `bitcoin`, `ethereum`, `solana`, `usdc`, `tether` |
| Banks | `chase`, `wellsfargo`, `bankofamerica`, `barclays`, `hsbc`, `monzo`, `revolut` |
| Apps | `notion`, `gmail`, `google-calendar`, `google-docs`, `1password`, `figma`, `slack`, `github`, `linear`, `dropbox`, `google-drive`, `google-sheets`, `google-slides`, `google-meet`, `zoom`, `vercel`, `shopify` |

Use only the integrations or payment methods the scene needs. A small row explains a relationship; it does not fill spare space with logos. Keep equal row tracks and align the marks by eye: their different silhouettes are no excuse for ragged labels or uneven gaps.

`examples/brand-marks/` shows every bundled mark on light and dark surfaces. `brandMarks` and `BrandName` are exported for a typed picker or registry lookup. `kit/brands/SOURCES.md` has the pinned artwork sources and licenses.

Inspect the rendered artwork, not just its image box. Tall marks need real air above and below; wide marks must show in full. Give the image a definite box inside a centered flex layout: percentage image dimensions in an intrinsic grid track can grow unexpectedly and leave uneven insets. Check the real light and dark backgrounds, not just their theme attributes.

---

## Appendix: choreography.md

# Choreography

Start with a readable still and a short account of the change. Name the frame that holds still, the state that starts things, the responses that depend on it, the destination and the hold. Pick timing only once those relationships are clear. A quiet frame gives the moving parts something to move against; moving every layer at once takes that away.

## A change passing through an interface

Keep the header, outer surface and action positions steady while the variable content changes inside them. A setting can lead its dependent amount, payment method and form. Start the dependent movements before the previous ones finish, with offsets that make the order legible. Keep the old and new content in tracks rather than replacing the whole screen.

Use a fixed, local soft mask where a track enters and leaves. Its settled text sits wholly inside the opaque part, and the control's border stays outside the mask. Don't soften the whole interface, blur every transition or use a mask to hide bad resting geometry. A row changing height needs something else: fade its content while its space opens or closes, so the moving edge never slices readable ink.

`examples/choreography/` shows a cursorless checkout changing market. Its frame and product stay put while the currency, price, method and address respond. The comparison beside it uses the same layout and movement with every start at once, so timing is the only variable. Read it as one possible sequence, not a required checkout style or timing preset.

## Timing has different jobs

| Job | Decision |
| --- | --- |
| Direct feedback | Start on the input; a presentation delay feels unresponsive. |
| Travel between stable positions | A departure, a stretch of clear travel and a soft arrival. Length alone does not make it fluid. |
| Related data updates | Recognition, transfer and the accumulated result can each take a different time. The result still follows its cause. |
| Introducing a composition | A small front-loaded movement can settle for longer than its busy part. Don't scale readable text much. |
| Replacing content | Keep the container, alignment and reading interval; mask only the moving slot. |
| Holding a result | Stop. A useful still needs no new pulse or repeated count. |

## Choose the curve for the movement

A slow departure, concentrated travel and soft arrival make a retained content track readable. A direct press needs quicker feedback. A number accumulating after a transfer may take longer than the transfer itself. Choose these together: one duration or easing applied everywhere flattens the hierarchy.

A small expressive icon may overshoot while its card and text settle without bounce; keep that accent local. Keep useful content through a form change, and give the final state time to read. In a code demo, use real syntax-highlighted code with sans-serif labels and copy: monospace belongs to the code, not the whole scene.

## Review the full change

Watch at normal speed, then step through the onset, the overlap, the masks, the final cleanup and the hold. Check text pixels as well as geometry: a stable rectangle can still hide glyph shimmer. Check the narrow host, reduced motion, pause, step, replay and the return from offscreen. A paused new scene must finish its first measurements without advancing the story. If pacing looks uneven, compare independent RAF samples with elapsed time; a smooth virtual-clock export says nothing about live playback.

---

## Appendix: craft.md

# Craft

The rules for the still frame. Framing is in `framing.md`; everything that moves is in `motion.md`.

Index: [Restraint](#restraint), [Type](#type), [Spacing and alignment](#spacing-and-alignment), [Icons and logos](#icons-and-logos), [Color and looks](#color-and-looks), [Density](#density), [Chrome and devices](#chrome-and-devices), [A page of demos](#a-page-of-demos), [Recipes](#recipes).

## Restraint

- **Count the real strings:** the title, the thing acted on, what is typed, the result; usually 3 to 7. The rest is `Bar`.
- **A word budget is not an element budget.** A calendar needs a populated week, a search a collection, a filter enough rows.
- **Lists are made of `Row`;** hand-built rows are where lists go wrong (`examples/gmail`).
- **Bars are the product's filler; the subject is words.** Bars where the eye lands read unfinished (`examples/spotify`).
- **In a still the subject is real,** words and values; a sidebar or list of bars beside it is filler and fine.
- **Where the story touches a list,** two or three real rows and at most as many bars. Film flags `skeleton ladder` at realistic fidelity only.
- **In a small surface a row is one line:** in a popover, a card or a tile, avatar, name, value. No gray bar under a real name there; filler beside real words reads as noise.
- **Named avatars take their own color** (the kit default); gray discs are filler only.
- **Label and value match:** both words or both bars. A blank pill beside a real control is dead; leave it out.
- **Keep the domain's signature content:** album art, thumbnails, avatars; swapped for the feature's signal it is a generic list (`examples/dark-bento`).
- **When the output is the subject** (a log, a diff, a terminal), real lines are the content: short and few, the rest of the screen quiet.
- **A terminal is a character grid:** a spinner and a text tick share one `1ch` cell; each line owns its mark, swapped in place (a tick on its own line in `examples/ruled-bento`).
- **One number gets to be big;** the rest are lines (`examples/subscriptions`).
- **Placeholder widths vary** row to row (60, 45, 70, 52).
- **A date-range band runs week by week** with air between rows, fades where the range continues, and is capped only on the real start and end days, each a solid disc (a circle, not a rounded square) in the accent with the day in white.
- **Say it once.** One clear link for the feature, not its signal in header, satellite and every row; a second confirmation only when it differs (`examples/dark-bento`).
- **No masthead for a fictional name:** no monogram, logo, sidebar and nav in every crop; a real mark only when recognition needs it.
- **The product's name appears only when the brief leans on it** and the real product would show it there: a notification's app name, the app's own title bar. A brief that just names the product doesn't need it on screen; the page around the demo already says it.
- **Simplify before polishing:** the fewest surfaces and strings that explain the product, then borders and badges only where earned.
- **Simplification keeps the character.** Cut repeated framing before meaningful imagery; an empty white card is not the cure.
- **Judge the silhouette before the details.** At thumbnail size the subject, support and empty space make one picture.
- **Compose objects, not an inventory of cards:** hierarchy from proportion, space, material and ground, not more boxes (`examples/story`).
- **The heaviest marks sit on what the story is about;** never a 2px black underline under a gray bar.
- **Space follows the story.** The payoff gets the room; no empty band mid-window while the result is pushed into the crop. No gap above a card, no cream under a phone's last row, no void between a stat's label and its number.
- **Dots, halos, badges and focus rings sit fully inside the content edge.**
- **Check imagery at its smallest size and over every surface it crosses;** a pale thumbnail can look see-through.
- **A specimen still describes one plausible app:** title, toolbar, navigation and body agree.
- **Nothing outsized.** The hero element sits in proportion to a real screen.
- **Realism is the developer's call.** At `fidelity="realistic"` or when asked, plausible content everywhere, still with room to breathe (`examples/wikipedia`).
- **Character is real too.** A styled brief gets its colors, radii, mascot and motion in full, still a shippable product under these rules.

## Type

- **Fit the text before fixing the box.** A control's border-box holds content, padding and border; flex centering does not make it fit.
- **Small text gets a line height of at least 1.3** and insets on every side; check the text slot's own clearance.
- **Real sizes, then scale:** 11 to 15px UI text, scaled by the stage; never 7px type.
- **One family:** the product's or the system stack. Monospace only for code, identifiers and aligned numbers, never a technical product's labels (`examples/ruled-bento`).
- **Keep only the text needed** to recognize the product and follow the beat; extra logs and timestamps are noise.
- **Sentence case** unless the real product has caps; hierarchy from spacing and one weight step.
- **No real headings.** A faux app's title is a `div`, never `h1` to `h6`: the demo lives in someone's page outline.

## Spacing and alignment

- **A button keeps 8 to 12px from the field, line or card edge above it;** sitting on the field it reads as touching (film flags `tight control`), and much more lets it drift off from the field it belongs to. A floating card (a comment popup, a toast) pads the same all round, measured to the avatar's and button's edges, not their words: 20px above the name with 14px at the side reads as a miss. A composer's Post or Send sits close under its box; padding sized for the posted card goes on the card, not between box and button.
- **Words keep a 12px inset** from the edge of a window, card, panel or hovered row; film flags `tight inset` under 8px. Bars may bleed, words do not.
- **Row padding is 12px,** 8px for a dense list; a one-line row three times taller than its words is a `fat row`.
- **A title over its subtitle reads as one item:** 4 to 6px of ink between the lines, a 1.3 line height plus a 2px gap. The air comes from the row's padding (`examples/gmail`).
- **Bars sit in the same line box as the text they replace,** so a skeleton row keeps the real row's pitch.
- **Bars keep their lines' white space, not line pitch:** 6 and 5px bars want 7px between; a trailing time sits on line one.
- **Text never touches a neighboring box:** a fixed `gap` of 8 to 12px, never leftover `space-between` (`touching`).
- **A placeholder bar follows the text rules:** it never touches or runs under an avatar, badge, icon or bar.
- **Center a label on its letters, not its line box.** Capitals sit low in a plain line box, so a label beside an icon (a check and "Sent" in a button), in a pill, or an initial in a disc reads low. Trim the label: `text-box: trim-both cap alphabetic` (the kit's `Badge` and `Avatar` already do).
- **Nested shapes pad evenly** (a pill inside a field, an icon inside a button: the same distance from every edge), and the outer radius equals the inner radius plus that padding.
- **Carry the inset round the bottom;** a comfortable top does not excuse a cramped action.
- **Content clears the bar above it:** a page's first heading sits at least the content's side inset below a toolbar or title bar's rule, never just under it.
- **Whitespace groups:** a title sits closer to its metadata than to the next record; never spread lines equally to fill a frame.
- **Align the reading edge, then the visible ink.** A small icon aligns with the title's first line; size each lane before nudging.
- **Center on the visible face.** Take tracking back with a negative `margin-right`; a pair centers as a pair.
- **Field text centers cap height to baseline** (`text-box: trim-both cap alphabetic`), as the kit's `Field` does (`examples/controls`).
- **A popup under a field draws its ring inset** so its sides line up with the field's.
- **A control hugs its content;** never `flex: 1` with its contents at one end (`lopsided`).
- **Fix overflow by fitting the content,** not by widening the container; re-measure padding after (`uneven`).
- **Columns line up:** every row shares one grid template with fixed tracks; optional content keeps its track empty; bars vary inside their track.
- **A dot, badge or ring is not a column:** in the gutter or on the avatar, 6px clear, inside the row's inset (`tight mark`, `examples/gmail`).
- **No near-tangents.** Edges 1 to 3px apart read as an accident: line them up exactly, or part them by at least the gutter and never under 8px.
- **Don't end just short of an edge:** real room, or move it down and crop it (`framing.md`, rule 11).
- **A centered amount centers its digits;** `$45` centered as one string sits right of center to the eye. The currency sign hangs off the left, outside the centering: the digits are the centered box and the sign is absolutely placed at `right: 100%` inside it. A rolling amount rolls only the digits.
- **Links have no hover surface;** a control gets a surface visible at rest.
- **Hover and selection fills are inset and rounded;** negative margins go on the list, not the row; copy a real product's square fills (`examples/wikipedia`).
- **Clone a real product's menu from its computed styles** (`examples/wikipedia`).
- **A trigger with its popover open keeps its pressed look:** `data-open`, styled like `[data-hover]` (`examples/hero-demo`).

- **A progress ring is one track and one arc,** round caps, never butt-capped dashes chopped into segments; a week of days goes in the dots beside it. A number in a ring centers on its digits: `Roll` with proportional figures, not `Count`, whose fixed-width digits leave a 1 off center; trim it to cap height (`text-box: trim-both cap alphabetic`) and set an icon above it apart, so the figure the eye lands on is the ring's center, not the pair's box.

## Icons and logos

- **Imagery earns its place:** real imagery or a good icon, never invented illustration; gray art only for empty states.
- **Icons come from a set, never from your hand.** The product's own pack first (its dependencies, icons folder, sprite or `Icon` component); otherwise a set chosen on purpose (below), used at one size and one stroke width throughout. A glyph drawn by hand is the first tell of generated UI: its weight never matches its neighbors (film flags `mixed icons`).
- **No hand-drawn marks** (pin, cursor, badge, ringed dot, chip, contactless arcs): from the kit or the product's assets, else leave them out.
- **A drawn mark gets a close-up beside the real thing,** seen as a stranger would.
- **Otherwise choose a set on purpose:** kit `Icon filled` for Apple, Material Symbols for Android, else Phosphor, Iconoir, Radix, Tabler or Heroicons; Lucide deliberately, never reflexively.
- **Apple chrome uses SF-style glyphs;** a Lucide glyph only where no system glyph exists, as `examples/finder` does.
- **One family, one stroke weight, one size** (14 to 16px) per scene; equal boxes can still hide a heavy fill beside a thin outline.
- **Even glyphs in even boxes;** an odd icon in an even box snaps when motion ends (`half-pixel glyph`).
- **Fixed boxes don't shrink:** an icon button or chip in a flex row gets `flex: none` (`squeezed`).
- **Small icons are filled.** At 14px and under, and in tinted tiles, use the filled style; thin outlines go wiry (`examples/kit-extras`).
- **Icons are one opaque color** (`--ss-icon`, `--ss-icon-faint`, opaque text tokens); fade with `opacity` on the svg; no duotone.
- **Emoji are content, never icons.** A playful look rounds the icons, it does not swap them for emoji (`emoji icon`).
- **Other products' logos come from `BrandMark`** or a project asset, in original proportions and colors; never a look-alike (`brands.md`).
- **Center glyphs by eye:** shift a play triangle toward its point by a sixth of its width.
- **AI features get no sparkle, wand or star, and no purple as the AI color.** Show what the AI does. The product's own icon is fine even when it is a sparkle (`examples/hero-demo` uses its product's `list-sparkle`); a sparkle as generic AI decoration is not.
- **No invented logo.** A letter or glyph in a colored square is not the product's mark (film flags `invented mark`). Use the product's real mark, or a plain text wordmark.

## Color and looks

- **One neutral family** for window, sidebar and cards; a colored ground or another material differs on purpose.
- **Five inks and one accent** to start; status colors mean status; an expressive product may need more, with a clear hierarchy.
- **No redundant tonal borders.** Try the fill alone; add the border for separation, state, or because the product draws it.
- **Quiet is not faint:** check text, actions and surface against the real ground.
- **A gradient or glow serves the story or goes.**
- **The hero isn't outlined to point at it.** An accent ring with a soft halo around the card the story is about reads as a focus state nobody gave it, and a dot beside its label is a mark with no meaning. Lift it the way the product would: its own surface, the raised shadow, a label in the accent. A ring is for a field that really has focus.
- **A filled button keeps its color under the pointer:** one step of its own color, never a gray swap; success is the one real change.
- **In mono, mark the thing acted on with a solid step** in surface and weight, never a translucent wash (`examples/dark-bento`).
- **Nothing translucent overlaps.** Overlapping avatars are `Facepile`; stacked chips or cards take opaque fills (`onion skin`, `examples/figma`).
- **On dark themes depth comes from a lighter surface,** not shadow; satellites go on `--ss-raised` (`examples/linear`).
- **A light document over a dark workspace stays a readable light document** with its own foreground and edge.
- **The light inks are tuned for white cards on gray canvas;** on white, step them up a tone.
- **Status color stays legible:** success, pending and disabled distinct, never passing through mud.
- **Contrast has a purpose.** A dark editor can be identity with a clear edge; a near-black strip for no reason is a hole.
- **Grounds support the subject;** a muddy halo standing in for foreground contrast does not (`backgrounds.md`).
- **Build once, check every look:** `theme` (light, dark, blueprint, glass), `palette` (accent, mono), `fidelity` (minimal, standard, realistic); `Text` for words, tokens for color.
- **A light pass does not prove dark.** Film every look the request names; `--dark` films the dark theme; `theme="dark"` is always dark.

## Density

- **Density follows the story.** Would a person do this here? No element quota; empty space can be hierarchy; enlarge content before adding anatomy.
- **Never under about 320 wide for a demo;** a bento tile or a satellite card may be smaller. Below that, keep the action and readable type, drop the desktop anatomy.

## Chrome and devices

- **A messaging app on an iPhone keeps Messages' conventions** unless the brief gives it a look: blue sent bubbles (`--ss-accent` as the kit sets it), gray received, the plus and the mic in the composer, reactions on the bubble. "Our messaging app" names the product, not a palette; inventing an accent and a composer makes it read as a fake (`examples/messages`).
- **Does the frame help?** Browser chrome only when the browser is part of the picture; a desktop app gets its real chrome (`examples/chrome`).
- **Chrome for the task:** a sharing panel needs a document, permissions and an action; a browser bar explains nothing.
- **Columns run the full height of their window** (`Window sidebar`); a column that stops short leaves a seam (`examples/finder`).
- **Window chrome is fixed at 38px;** `barSize="tall"` (64px) only for a real icon-and-label toolbar (`examples/finder-glass`).
- **Never draw platform chrome from memory;** open the real app or a screenshot first.
- **macOS 26 Finder:** solid white window, only the floating sidebar is glass, gray glyphs, selected row on a gray pill (`examples/finder-glass`).
- **Quiet browser windows** center their content and carry a rounded, centered URL pill (`examples/static-card`).
- **A document that is not the hero is content:** a ruled page with real margins, not another window.
- **Phones come from the kit** (the frames are in `kit.md`, Phone); `photo` falls back to `pro`, never an empty bezel (`examples/phones`).
- **System surfaces keep their real proportions.** Never shrink the iOS clock; the payoff wins by content, timing and crop (`examples/dynamic-island`).
- **A notification is one bold title over its message** with `Notification`'s geometry and a real app icon (`examples/phones`).
- **Nothing sits under the island;** a sheet or grabber starts below the status bar.
- **The status bar and home indicator come from the Phone,** true to iOS, never drawn by hand. A second indicator inside the app shows as a bar that scales into place and a sliver under the real one. An app that covers a dark screen turns the Phone's `dark` off as its surface arrives, and both fade to dark.
- **A phone is lit from its first frame:** never dimmed, blacked out or faded up.
- **A phone background has a job:** `LockScreen` for notification and island stories; never invented home-screen icons (`examples/dynamic-island`).
- **A phone may straddle a window but never covers the amount it explains.**
- **Several windows:** choose the active step; quieter contrast and shadow push the others back (`examples/hero-demo`).

## A page of demos

- **One figure language:** one ground, one gutter, one window shadow (`--ss-shadow-hero`), one radius set; a different shadow says something or is a mistake.
- **Fewer, stronger demos.** No little labeled containers or text tiles when the demo says it.
- **A comparison pair shows a different demo** from the one just above it.
- **A bad example is marked in the page's own annotation style,** never with crosses or scrawls.

## Recipes

- **Scope the CSS to the demo:** nest the stylesheet under its root class (`@keyframes` outside); a prefix is not enough. Hosts styling prose by class exclude stages with `:not(:where(.ss-stage *))`.
- **`compact`** is a second design for the phone column, not a squeeze (`framing.md`, Small formats and the page).
- **Check a fresh load at each width and a resize between:** targets, clips, overlays, poster.
- **A grid of cards** is planned with `bento.md`.

---

## Appendix: framing.md

# Framing

How the screen sits in its space decides whether it reads as a product shot or a screenshot in a box. Decide the framing before building the screen: a crop needs nothing past the crop, and it sets how big the type must be. SKILL.md has the summary; the numbers are here.

## The rules

1. **One hero object, at most one or two satellites** (a receipt, a phone, a detail card) that carry the point (`examples/static-card`).
2. **Keep what identifies the product:** a title, the real chrome, the rows that give the action a reason. Logo and nav are not required; crop around the story.
3. **The medium picks the first layout:** corner bleed for a hero beside copy, pinned bottom bleed for a card or tile, a phone pinned from the top. If it doesn't hold, try a second from the table below.
4. **Crop only filler.** The payoff, the action, what the cursor touches and every real word stay whole; a list, diff or terminal may run one line off a bled bottom edge. A placeholder action the crop would slice is removed, not sliced; if the story does not fit, change the stage size or the layout. A button, chip or shadow sliced by the stage edge is the usual fault.
5. **Crop 10 to 40% of the hero off stage.** The window or phone fills at least two thirds of the stage's width and runs off an edge. Labeled controls stay whole. Shapes that read when cut (a card, a slider track, a row of avatars) run off by a third or more.
6. **The stage masks everything** (`overflow: hidden`); one rounded corner per edge. Fades are for sliding tracks, stacks and charts, and for one crop: a window fading out at its foot.
7. **Satellites straddle the hero's edge, about half outside,** never fully inside or floating apart; fully outside, tie it back with a 1px leader ending in a dot.
8. **Distinct depth:** `--ss-shadow-satellite` on a satellite sitting on the hero, `--ss-shadow-ground` for a lone surface; a hairline on light edges; the shadow on the outlined shape, never a wrapper (`examples/story`).
9. **Start flat and frontal; earn a tilt** by comparing with the straight version at final size. Depth from shadow, z-order, scale and opacity; perspective only when asked.
10. **One gutter, measured in the final crop after any wrapper.** The gutter is the hero's inset from the stage edge (the layout table gives it per layout); every other edge distance in the frame matches it. The exception is a satellite straddling in the wider column; a phone counts as a satellite.
11. **A full gutter or well past, on every edge.** Crossing by under 24px or stopping a few pixels short is a mistake. Content near a container's bottom follows the same rule.
12. **A window keeps its device's shape:** whole, 1.25:1 or wider; bled, what shows is at least square. Fix by crop or layout, never by squashing.
13. **What the story opens stays in frame,** a gutter from every edge on every frame; place the trigger so the overlay has room.
14. **On a colored stage the hero is inset 8 to 20% from the sides** and runs off the bottom, so the ground frames it on three sides.
15. **No dead corners at rest or anywhere in the loop.** Fix crop or layout first; a satellite only with a role; a reserved column is filled from frame one.
16. **Anchored UI (popover, menu, toast) is not a satellite;** it sits where the product would put it.
17. **Two satellites are two kinds, not a stack.** A second satellite differs from the first in size and kind: a card and a small system object (a notification at its true size, a chip, a receipt), never two cards of one width on one edge, which read as a pile. A system banner sits where the system puts it, small, with the system's shadow, not a card's. Where the second object only points at something, use an annotation with a connector instead (`references/annotations.md`), as Stripe does; film flags `framing: twin satellites`.
18. **A satellite covers chrome, not content:** straddle where the window has a sidebar, header or margin (`examples/static-card`).
19. **Related surfaces get different jobs and weights;** the result sits in the hero's quiet margin, never hiding settings, trigger or payoff.
20. **A small illustration may need more air than the app itself.**

The layouts are recipes, not a requirement to crop every product; a whole window with even gutters is valid when its contents read and the brief asks.

## The layouts

| Layout | Hero | Satellite | Use for |
|---|---|---|---|
| **Pinned, bottom bleed** | Inset 8 to 12% left, right and top; 15 to 35% past the bottom; centered | Optional, straddling a side | Feature cards and bento tiles, their first composition (`examples/static-card`) |
| **Corner bleed** | Inset 10% top and left; 15 to 35% past right and bottom | Straddling the left or bottom edge | Heroes beside copy, their first composition (`examples/hero-demo`) |
| **Stage with gutters** | Inset 8 to 20% each side on a colored stage; off the bottom | Straddling one side, hero stays centered | Brand moments (`examples/raycast`) |
| **Satellite focus** | Cropped hard, mostly context | Large, 30 to 40% of hero width, straddling, carries the story | One small thing: a notification, a receipt, a diff (`examples/share`) |
| **Wide hero** | A 900 to 1100px window at 1:1, inset top, off the bottom and often both sides; realistic fidelity | A card or thread on its lower edge | Homepage heroes at full width (`examples/linear`) |
| **Row of windows** | Three or four at the same height, the outer ones off both sides | None | Agents, tabs or sessions side by side (`examples/window-row`) |
| **Device pair** | Desktop inset top and left, about 75 to 80% wide, off the bottom | Phone straddling the right edge, about a third outside, top in the upper half, present from frame one; `LockScreen stack="top"` if its bottom is cropped (`examples/device-pair`) | Cross-device stories |
| **Many of one** | A grid of one small thing at one size, off every edge | None; one tile in focus by depth (hero shadow, accent ring), the only one with words | Previews, deploys, templates, sessions: scale shown as repetition (`examples/many-of-one`) |
| **Fade crop** | A window inset top and sides, fading out over its last third | Optional | When a stage edge would cut the window at an arbitrary line (`examples/fade-crop`) |
| **Close-up** | The whole window scaled 1.3 to 1.6x, chrome and all, inset top and sides, off the bottom; the subject row whole across | None | A feature card about one control: a setting, a field, a button (`examples/close-up`) |
| **Panel over product** | The product inset top and left, off the bottom; its focal control whole | A settings panel straddling the product's right edge over its margin, never over the form; one leader, in neutral ink, from the panel's edge to the thing it changed, through empty ground | A setting and its effect: branding, theme, a toggle that changes the page (`examples/panel-annotation`) |
| **Overlapping windows** | A window inset top, off the bottom, its words clear of the stage edges | A smaller chromeless card in front whose edge lands on a structural line of the window (its sidebar edge), covering only filler | Two views of one event: the buyer's card over the merchant's dashboard (`examples/overlap`) |
| **Stacked cards** | Two components at one width and left edge, 12px apart, centered; the lower one off the bottom | None | A setting over the detail it drives: a plan over its usage (`examples/stacked-cards`) |
| **Opposite corners** | Copy bottom-left at the tile's inset; the product in a panel hung off the top-right corner, its words clear of the cut | None | Bento tiles with a line of copy (`examples/opposite-corners`) |
| **Tilted stack** | Three same-size cards in one cell, -6, 4 and -2 degrees, offset 12 to 20px; the straightest on top, the only one with words | None | Paper: receipts, tickets, cards gathered. The one place tilt earns its keep (`examples/tilted-stack`) |
| **Corner chip** | A window inset top-left, off the bottom | A small pill centered on the window's corner, half outside, over chrome only | One live fact about the whole product: people online, a status (`examples/corner-chip`) |
| **Monochrome row** | Three windows at one height, whole across, grayscale, faded at the foot by a mask | None | Customers or integrations, where their brand colors would fight (`examples/monochrome`) |

## Recipes

Position the hero with plain CSS inside the `Stage` render. Reserve a wider column so the satellite straddles the hero edge evenly: gutter plus half its width (`examples/static-card`).

```tsx
<Stage width={656} height={340} initial={{}} className="my-well">
  {() => (<>
    <Window url="dashboard.northwind.co" className="hero" style={{ position: 'absolute', left: 129, top: 24, width: 720, height: 420 }} />
    <div className="satellite" style={{ position: 'absolute', left: 24, top: 150, width: 210 }} />
  </>)}
</Stage>
```

```css
.my-well .ss-stage { overflow: hidden; background: var(--ss-well); border-radius: 12px; }
.my-well .hero { box-shadow: var(--ss-shadow-hero); }
.my-well .satellite { box-shadow: var(--ss-shadow-satellite); border-radius: 10px; background: var(--ss-surface); }
```

The shadow tokens in `kit/stage.css` (loaded by `kit/stageshow.css`), set by every theme:

- `--ss-shadow-hero`: the one shadow for a page's hero windows (`examples/gmail`).
- `--ss-shadow-window`: what `Window` draws by default; quieter, for a window that is not the hero.
- `--ss-shadow-satellite`: tighter on purpose, because it falls on a white window where a wide blur smears (`examples/payout-flow`).
- `--ss-shadow-ground`: a hairline and a long faint fall, for a small window or card on the ground (`examples/looks`).
- `--ss-shadow-float` for popovers, `-card` for small raised cards, `-lift` for a carried thing.

Fades are for moving or stacked content: a 32px edge mask on a track, or the last 25 to 30% of a stack or chart. Use `.ss-fade-b` and `.ss-fade-r`; their length is `--ss-fade` (64px by default, so set `--ss-fade: 32px` for a track).

A window can fade out instead of running off, at its foot only: the top and sides stay whole and hard-edged, the fade covers the last third and only filler is under it. Fade with a mask, never a color overlay, so the window dissolves into whatever it sits on. Never fade a side, never fade the focal content, never fade more than one window in a scene (`examples/fade-crop`).

## Small formats and the page

- **The page is the ground.** "White page" means a transparent stage: no plate (a backdrop or tinted field the window floats on) and no panel behind the device on a white or dark page. A hero's window bleeds or fills; whole and centered with air on four sides, it floats.
- **Unframed is the developer's call.** Asked for no framing, set `unframed` on the Stage and drop the ground: the window, card or phone sits whole, centered, with an even margin at least as deep as its shadow, so the shadow is never cut. Nothing bleeds, so nothing needs a crop rule; everything else in this file still holds, and so do restraint, story and motion. Never choose it on your own: a floating window is the fault this file exists to fix.
- **`compact` is a second design, not a squeeze.** Every demo that can sit in a phone column ships one at the column's width: 358 in a 390 viewport, switched on below the host width where the wide design stops fitting (`compact={{ below: 560, width: 358, height: 320 }}` for a wide scene; the height follows the design). Switch composition on `layout`: crop closer, drop or stack a satellite, keep action and payoff whole. A card that already fits at 358 needs none.
- **Small formats crop harder:** a 400px card holds a third of a dashboard at full size, not all of it at a third.
- **The stage is the shot.** The tile is cut to the stage's shape and the stage fills it edge to edge; never a stage boxed in another ground.
- **Size the design for the slot.** A lone card in a 680px column wants 500 to 560 wide, so its text reads at 15 to 20px.
- **A lone phone in a column of figures keeps the column's width,** centered at design size on the stage's own ground.
- **Moving a window keeps the bleed.** After any move or resize, recheck what the crop cuts and what overlaps, remove sliced placeholder actions, re-shoot the whole loop.

## Phones

- **A satellite phone starts at 40% of the window's visible width** and at least 220px wide; let it run off the bottom rather than shrink.
- **Notifications stay at true iOS proportion** (Live Activities excepted); a phone so small its notification needs enlarging is too small (`examples/phones`).
- **A phone cropped at the top loses its status bar and nav bar together.** The crop falls inside the content below the nav, never between the island and the nav.
- **In a 400px host a phone is cropped:** pinned a gutter from one edge, off the other, screen 1:1, stage a little taller than wide; never whole (`examples/phone-touch`).
- **A banner is native width and never cut.** A notification spans the screen minus 18pt each side, at the phone's own scale; nothing narrows it. A phone cropped at a side is composed so the banner shows whole (crop where no banner sits, or show the phone's full width) and film flags a cut banner as `cut by the crop`.

## Checks

`film.mjs` prints `framing:` and `cut by the crop:` on every shot; clear them on the still before motion work (`rehearse.md`, What to watch), or say why a line is deliberate. Boxes in flight are judged where they settle. Under a `Camera` the wide shot is judged as usual, moving frames skipped, and a settled zoom judged against the camera's own crop with its focus clear of the feather.

Is the hero's top-left visible? Is a bleed a deliberate crop, not a sliver? Does each satellite connect to its hero with clear depth? Is a faded window faded only at its foot, over filler, with a mask? Is the phone readable at the host's real width, and does a wide scene have its `compact` design (Small formats and the page, above)?

---

## Appendix: kit.md

# The kit, piece by piece

The reference for every part in `kit/`. SKILL.md has the map; read the entries for the parts a demo uses.

The kit is four tiers, and they are not equal:

- **The stage** (`stage.tsx`, `cursors.tsx`): the canvas, the script, the cursor, measuring and playback. Every demo is built on it.
- **Frames** (`window.tsx`, `phone.tsx`, `ios.tsx`, `messages.tsx`): windows, devices and system surfaces drawn from real geometry. Never draw these by hand: no hand-built window, phone, bubble, notification, status bar or home indicator.
- **Motion** (`motion/`): behaviors that have to hold up frame by frame. They bring motion, not a look; style what's inside them as the product does.
- **Small parts** (`parts/`, `controls/`, `code.tsx`, `chart.tsx`): quiet starting points. Restyle them to the product, or build the product's own when they don't match it.

## Specimen sheets

Catalogs of how each part behaves, one per tile, not compositions to copy. Use the scenes in SKILL.md for composition ideas, and look at any reference at the intended width before borrowing from it.

- `examples/controls/`: Field, Segmented, Toggle, Tabs, Code, Chart, a card dragged between columns with `Slot`, `Scroll`, a `Camera` push-in, and the `arrow` cursor with ripple clicks.
- `examples/glass/`: the glass theme on a window, a chip and a popover.
- `examples/brand-marks/`: the bundled payment and app artwork on light and dark surfaces; sources and licenses are in `kit/brands/SOURCES.md`.
- `examples/buttons/`: every Button variant and size, label and icon changes beside neighbors, a button in a narrow row.
- `examples/cards/`: Card padding and nested radius, a flush sectioned card, a sunken group, Divider in a card and a toolbar, Kbd in a field and a menu.
- `examples/kit-extras/`: Chip, Swap, Avatar rings, Meter tones, Menu hover, Expand, solid glyphs, BrandMark.
- `examples/parts/`: the newer parts (States, Check pending, Meter, Stream, Connector arrows, Popover and Menu, the satellite lock screen).
- `examples/looks/`: nine style studies: three invitation identities, then console, finance, canvas, conversation, research and a dimensional transfer receipt.
- `examples/chrome/` and `examples/phones/`: every window chrome and phone frame in the kit.

## The stage

### `Stage`

The canvas.

- **Size.** Design size and scale-to-fit. `compact`: a second design for narrow containers (the composition rule is in `framing.md`, Small formats and the page). A host wrapper marked `data-ss-wide` scales the wide design only for a slot sized by height, never for an ordinary tile, which draws 1:1.
- **Scene state** (`initial`), changed by the script's `Act` (below).
- **Children** are `(state, rect, layout) => JSX`. `rect(name)` measures any `data-target`, re-measured after transitions settle. `layout` is `'wide'` or `'compact'`: read it here, not with `useLook()`.
- **Playback.** `play`: `loop`, `once`, `hover`. Hover settles back with a glide when the pointer leaves. The stage stops and resets unfinished playback offscreen, restarts it on reentry, and preserves a completed once scene. Under reduced motion it shows `poster`.
- **The look.** `theme`, `palette`, `fidelity`; `tokens={{ ... }}` for one stage (see Look tokens); `accent`; `greys="cool"` swaps the warm canvas and well for cool ones, for macOS or a blue ground (light theme only).
- **`ground`**: what the scene sits on. `orbs` is a pale tile lit by a few soft color orbs, so glass has color to take; pass two or three colors to choose them. Leave it out for the plain ground.
- **`fill`**: grows past the design size to fill the container, up to 2×, for a hero or a docs plate; a host wrapper marked `data-ss-fill` does the same. `speed` plays the script faster (above 1) or slower.
- **`keys`**: where keycaps show: `bottom` (the default), `top`, `bottom-left` or `bottom-right`. Keep them clear of anything open, a menu reaching the bottom of a short stage included; film flags an overlap. Takes `{ wide, compact }` too.
- **`hover`**: targets for stills.
- **`specimen`** marks a sheet of parts (the kit's chrome, controls, phones sheets): film's composition checks (framing, voids, ladders, insets) stand down.
- **`unframed`**: for a developer who asks for no framing (`framing.md`, Small formats and the page). Leave out `ground` and keep the product whole with room for its shadow; film's bleed and floating checks stand down.
- **The cursor**: see below.

### `Act`

What a script gets.

- **Scene:** `set`, `put`, `snap(patch, scope?)` (no transitions, stage-wide or in one target), `wait`.
- **Pointer:** `move(to, { duration, path, onMove })` (`path` as drag's; `onMove(at, from, t)` gets each point, for a scrubbed readout), `click` (`{ double: true }`; `{ right: true }` for a context menu), `cursor`, `center`, `place` (at once, with no travel: only behind a cut), `enter(to)` (arrives from past the nearest frame edge, already moving).
- **`drag`**: dips, closes the open hand into `grab` at the bottom of the press and opens on release; over text or a canvas it selects and keeps its kind. `duration` sets its length. `{ cursor: 'preserve' }` retains the current kind through a product-specific drag such as arrow-based event creation or a resize edge. `{ path: (progress, from, to) => point }` supplies a constrained path in stage coordinates, with eased 0 to 1 progress and endpoints matching the current cursor and target.
- **Keys and text:** `type` (35ms per character by default); `key` (shows keycaps, resolves as the key comes up so the app can react).
- **Timing:** `stagger(items, fn, gap = 60)`; `mark(name)` for filming a beat. Start a move without awaiting it to run it alongside other beats.
- **Measuring:** `rect(name, { layout })`; `caret(name, at)` (the character a text selection reaches with the pointer at `at`; call it in a drag's `onMove` so the highlight tracks the I-beam).
- **Moves** travel in a shallow arc, timed by distance. Hovered targets and every target around them get `data-hover`; pressed get `data-pressed`. Targets can aim inside an element: `{ at: 'apply', x: 0.8, y: 0.6 }`.

### The cursor

`cursor={{ at, kind, style }}`; `at` can be `{ wide, compact }` when the compact design needs a different rest point.

- **Styles:** `real` (macOS cursors), `large` (1.5×), `circle` (the iPad's glass pointer), `touch` (a finger on a phone: a dot only where it taps or drags, nothing between), `arrow` (a solid rounded arrowhead, as illustrated demos draw it; an I-beam only over text). Never the macOS arrow on a phone.
- **Kinds** come from `data-cursor` on elements (`pointer`, `ibeam`, `crosshair`, `hand`, `open`, `grab`, `wait`, `resize-ns`, `resize-ew`, `resize-nwse`, `resize-nesw`), switching as the cursor crosses their edge.
- **`ripple: true`** sends a soft ring out from each click, for small stages or when clicks must read at a glance.
- **`idle`** (ms, 4000 by default, `false` to keep it on) fades a cursor that has rested that long after acting; `still: true` keeps it in the reduced-motion poster.
- Leave it out of stills unless pointing is the story.

### Timing

- **`EASE`** holds the kit's named curves as bezier arrays: `house` (moves inside a shot), `through` (into a cut), `settle` (out of a cut), `enter` (a cursor arriving already moving), `trip` (one long cursor trip), `camera` (the push-in). `easeCss('settle')` writes one as a CSS `cubic-bezier()`; `bezier('house')` turns one into a function of time 0 to 1, for motion you drive by hand.
- **`clock.now()`** is the stage's time. It is `performance.now()` in a live page and the stepped time when the playground pauses, steps or records, so time anything a script measures with it, never `Date.now()`.

## Frames

### `Window`

Chrome, chosen by props. See `examples/chrome/`.

- **Browser:** `url`, plus `nav` (back and forward), `tabs` and `urlShape="pill"`.
- **App:** `title`, centered in a plain bar. With a `toolbar` it moves left, 14px after the lights, as a unified toolbar; `lead` (the left toolbar slot) follows it and the toolbar sits on the right. `body` takes props for the content column.
- **Sidebar app:** `sidebar` runs full height and holds the traffic lights, the way Mail, Notes, Linear and Slack look. `sidebarWidth` sets its width (180 by default). Beside a `sidebar`, the title is the content column's heading at the column's 16px inset: pad the content 16px too, so the heading and the first row line up.
- **Grounds:** a plain or browser window's body is the canvas (a quiet gray); a sidebar window's content column is the surface (white, the sidebar on canvas). For a white page in a plain window, give its content `background: var(--ss-surface)`; keep one window's content one color.
- **The lights** sit in the same spot in every kind, as far from the left edge as their center is from the top, in every combination. `lights`: `color`, `grey` (glass's default) or `white` (glass, card or hairline over a strong color).
- **`chrome="glass"`**: a frosted browser for a colorful ground.
- **`chrome="terminal"`**: a dark terminal, one surface, `title` dim and centered (`northwind — zsh`). Fill it with `<Prompt path="~/app">command</Prompt>` lines, plain divs for output (classes `ok`, `err`, `dim` for status color, sparingly) and a `<Caret />` on the last prompt. Never hand-style a light window as a terminal. Its colors are tokens: `--ss-term-path`, `--ss-term-sigil`, `--ss-term-ok`, `--ss-term-err`, `--ss-term-dim` (and `--ss-term-bg`); set them on the window or the stage to match an accent.
- **`chrome="card"`**: one white card, pale dots, a wide pale address bar and a long soft shadow (a payments site's checkout browser).
- **`chrome="hairline"`**: a small quiet frame over a 1px rule with the address as bare text, for a window that is a detail, not the subject.
- **`receded`** fades it to 40% when something comes forward.
- **macOS 26 (Tahoe), each opt-in:** `sidebarStyle="floating"` (the sidebar as a rounded panel inset 8px, on a 24-radius window), `lightsSize="large"` (12px lights, 8px apart), `barSize="tall"` (a 64px icon-and-label toolbar: no fill or rule, 32px controls at the top with labels under them, lights and title level with them).
- **Several kinds passed:** a `chrome` other than the native one wins over everything (terminal, glass, card and hairline ignore `sidebar`, `tabs`, `nav` and `lead`); otherwise `sidebar` wins, then `tabs`; a `url` beside a `sidebar` puts the address in the content column's bar.

### `Phone`, `LockScreen`, `Notification`

A phone from real geometry at any `width`, its screen laid out in true points. The framing and sizing rules are in `framing.md`, Phones.

- **`frame`:** `photo` (optional caller-owned bezel through `--ss-phone-photo-light` / `--ss-phone-photo-dark`; no photograph ships; falls back to `pro` without one), `pro`, `silver`, `bezel`, `android`, `soft` (the pale, even-banded marketing-page phone, no island), `clay`, `outline`, `bare`.
- **Screen:** `wallpaper` (the screen is white by default, black with `dark`), `island`, `status`. `WALLPAPER` is the default lock screen ground, a soft blue to lilac gradient after the iPhone's own; pass it as the Phone's `wallpaper` with `dark`.
- **Size it for its text:** draw a phone that shows app text at 340 wide or more (about 0.85 of true size), and let it run off the stage rather than shrink it to fit. A bar on the screen sizes to its content with real padding under its last line, never a fixed height its text can overrun.
- **`LockScreen`** stacks notifications at the bottom as iOS does (iOS 16 and later). `size="satellite"` for a phone beside a window (no controls, notifications under the clock); `clock={false}` drops the date and clock. `stack="top"` puts notifications under the clock, for a phone the stage's bottom edge crops.
- **`Notification`:** always true iOS size (only Live Activities differ) and, as a banner, native width (the screen minus 18pt each side); the phone is sized and cropped around it, never the other way (`framing.md`, Phones). Bodies wrap to three lines. On an unlocked phone (in an app, on the home screen) pass `banner` and it drops in at the top under the island, over the app.

### `Thread`, `Bubble`, `Stamp`, `Receipt`, `Keyboard`

Messages, from the kit only.

- **`Thread`** pins a conversation to its bottom, glides older messages up when one arrives and puts tails on the last bubble of each run. `app` is `imessage` (true iOS bubbles), `sms` or `chat` (AI apps: a quiet bubble for the person, plain text for the reply, pair it with `Stream`).
- **`Bubble from="me" | "them"`** rises in from its tail corner. `avatar` puts a small `Avatar` beside a received bubble for a group chat. With `source` (the composer text's selector or target) it forms out of the input as iMessage sends: clear the field in the same update. With `typing` it holds the dots and grows into the message when typing ends, one object, never a swap. `tapback={{ emoji, show }}` adds a reaction (its motion is in `motion.md`, Phones in motion).
- **`Receipt`** rolls Delivered to Read and folds away with `show={false}`; keep it mounted.
- **`Keyboard`**: the iOS 27 keyboard at true points, full width under the composer. Pass `typed` and it pops each key and follows auto-capitals; `shift` forces shift on or off, `pressed` holds one key down (a letter, or `shift`, `delete`, `return`, `space`, `123`); `suggestions`, `dark`. Leave it out by default: most message demos read better without it. Show it only when typing is the story.

## Motion parts

### `Collapse`, `Fly`, `Toast`, `Spinner`

- **`Collapse`**: a height that opens and closes so what follows moves with it. `reveal="drop"` for a card or message, which arrives whole instead of being uncovered by the edge; `from="below"` for a chat message landing at the foot of a feed; `solid` for a surface unlike the ground (a dark log panel on a light window), which would otherwise fade through gray. On close the content dims then dissolves across the whole of the height's travel, never an empty box.
- **`Fly`**: an element carried along a soft arc from the source element's own `rect()` to the landing element's own `rect()`, never a slot or wrapper around it (a slot's rect makes it snap size on landing). `.ss-fly[data-go]` styles it in flight, to settle into its resting look before it lands. It is hidden until `go`, so it never doubles what it leaves, unless `held` shows it waiting at `from` (the thing being carried, or a chip budding off a value).
- **The handoff:** hide the source in the set that turns `go` on; when it lands, show the real element and hide the flyer in one set (unmount it), then `snap({ go: false })` while it is hidden, ready for the next loop.
- **The value-chip recipe:** `from` is the value's own text rect; the chip's child is drawn transparent, its words exactly over the value's (same size and weight, green, with the + in the padding to its left), and the value fades under it. With `held` it buds in where it sits, then on `go` its surface fades in during the flight (a keyframe on `.ss-fly[data-go]`), and the check or the rolling total comes only after it leaves.
- **`Toast`**: a confirmation that rises in (`--ss-toast-rise` sets how far).
- **`Spinner`**: a pending arc.

## Parts

| Piece | Use it for |
|---|---|
| `Row` | One row of a list: `lead` (an `Avatar`, a tile), `title`, `subtitle`, `meta` (a time, a count), `preview` (placeholder lines under the subtitle, as bar widths), `unread` (a dot hanging in the margin left of the lead, so the row never moves; give the list a few px of padding for it. A product that reserves a dot column on every row, as Mail and Messages do, pads the whole list instead, and Gmail puts the dot by the time; follow the product, never pad only the unread rows), `selected`, `pad`. The anatomy is fixed: lead and dot centered on the title and subtitle, title 4 to 6px above its subtitle; children (a `Toggle`, a chevron, a badge) trail at the end of the title line, and extra preview lines go inside `subtitle`. A title with no subtitle is a one-line row: the title plus the row's padding, no second line reserved. A `Bar` in any slot keeps the line's pitch. Inside a `Phone` it takes iOS sizes (17pt name, 15pt lines, 10pt dot) on its own; never restyle its `.ss-row__*` parts. |
| `Pin` | A comment pin: one rounded square with a single square corner (`corner`: `bl`, `br`, `tl`, `tr`), face and rim the same shape, an initial or `src`, `tone` accent or ink, `selected` for the open one. Place its square corner on the thing the comment is about. Never a disc with a corner stuck on. |
| `Avatar`, `Check`, `Icon` | Initials avatars (`Facepile` overlaps several, each cut out of the next: `names`, `size`, `overlap`; `plain`, or no `name`, for a plain disc in any fidelity: filler assignees and faces behind the one that matters; a named avatar takes a muted opaque color of its own by default (`tone="person"`), as Mail and Messages draw monograms; `tone="ink"` for a gray disc, `accent` for the person the story is about, `success` for a green disc, `ios` for the gray-blue gradient monogram with two initials that Contacts, Mail and Messages draw for a contact with no photo); a status check (`pending` turns an arc in the ring, `on` grows a solid disc and draws the tick: one mark from pending to done, never a spinner stacked over a check); a few line icons (including a card's `chip` and `contactless` arcs) and `Icon filled` system glyphs. Beyond these, the product's real icon pack or a set chosen on purpose, in one opaque color (`craft.md`, Icons and logos). Avatar `ring` marks a person's status, eased between states: `pending` (a quiet ring), `waiting` (the quiet ring with an accent arc going round: asked, not yet answered), `confirmed`, `declined`. |
| `Connector`, `Count`, `Roll`, `Meter` | Story pieces: a line that draws between two points and ends on a dot; a number whose changed digits roll from the old figure to the new one, last digit first (`duration`, `stagger`; it jumps inside a snap or offscreen); text that animates only the changed part; a usage bar that fills (`Meter tone` for its color). `Count` uses tabular digits but reserves no width for extra digits or punctuation: give it a stable slot when its neighbors must stay still. A unit the format writes after the figure (21°, 240ms, 12 min) sits in its own box, `.ss-count__unit`, a hair from the digits or a word space when the format has one; `--ss-count-unit-gap` widens the hair, and the class is where a smaller degree sign is styled. `Roll` measures and eases the changed span's width and moves what follows with it; `variant="fade"` for control labels. `delay` holds the old text before it rolls, so a total can change a beat after the edit that feeds it. When the whole control should keep its largest footprint, use `States` instead. |
| `Connector` extras | Endpoint dots default to a 3px radius, an accent fill (the line and dot both use `--ss-accent`), a 2px white rim and a subtle shadow: a starting treatment, so restyle them, or drop them with `dots="none"` (`both` puts one at each end), when something else explains the relationship better. `arrow` for direction (a request out, a response back), `label` for a word on the line ("POST", "200 OK") or a number for a step marker, `labelAt` (0 to 1 from `from`). Labels arrive after the line draws. `route="step"` (across, then down or up halfway, then across again) for several lines into one target: they merge into one level run before it. With `h` they would arrive from above and below and knot at its edge. Leave room between the columns, about 80px, so the bends and the merge don't crowd the target. `route="curve"` is the same level-out, level-in path as one soft S, for a looser diagram; labels and arrows follow the curve. |
| `States`, `Stream`, `Popover`, `Menu` | `States`: a control's states (label, spinner, done) stacked in one place and crossfaded, the box holding the largest (for an icon and label in a full-width button, stack each state's whole group in one cell and crossfade, so nothing slides sideways (`examples/form-error`); `Swap` is for a label whose box must resize in a line of text); `align` sets the alignment; each state keeps the line box a plain label would have, so a `Roll` or `Count` inside one shows whole, and a small line under a name sets its own line-height. `Stream`: text written word by word with every word already in its final place (no reflow), `mark` for changed words that join into runs. `Popover`: a floating surface that scales a touch from `origin` (a `PopoverOrigin`: `'top left'` by default, or a side such as `'bottom'` or `'right center'`), the side nearest its trigger, while its contents fade, never resizing as it opens; restyle it with `--ss-popover-bg` and `--ss-popover-shadow`, not `background` and `box-shadow`. It has 4px of padding by default (set your own on its class). Closing, it freezes its children and position as they were open until it has faded, so a reset never shows; the flip side is that a change made in the same set as `show: false` won't show either. To change what is inside before it closes (a row ticked, then the menu goes), make the change in one set, then close it in the next. `Menu`: its rows with a `value` highlight (the row's index), fixed `--ss-row` height; `targets` makes items highlight under the cursor. A filtering palette (rows that leave as you type) is not a Menu: build the list as rows in a `Collapse` each (`open` while it matches), so the rows below close up, and keep the highlight on the first match. |
| `Field`, `Segmented`, `Toggle`, `Tabs`, `Badge` | Form controls with their motion done: a text field (label, focus ring that never moves the text, placeholder that leaves on the first character, a caret solid while typing and blinking at rest, `password`, `status` valid or error, `chip` to commit the typed text as a filter chip where it was typed, with `remove` for its ×; put `data-target` on `box`), a segmented control and tabs whose highlight slides (`items`, `value` as the selected index, `targets` to name each item for the cursor), a switch, a status pill (`tone` neutral, accent, success, danger or warning; `dot`, or `icon` for a glyph beside the label, like a tick on Matched). Use these rather than building inputs by hand. |
| `Button` | A push button: `variant` primary, secondary (default), tertiary, ghost or danger; `size` small 24px, medium 28px (default) or large 32px; `icon` before the label, `trailingIcon` after it. Its padding never squeezes in a row (`flex: none`), the side with a glyph pads a little tighter, and the label centers on its letters. A text label that changes (Resolve to Resolved) crossfades and eases the width, so neighbors move with it; an `icon` added later grows its slot open. The cursor's click presses it. Put `data-target` on it. Never hand-build a button. |
| `Draft` | A comment being written that becomes the posted comment in place: `value` (the typed words, from `act.type`), `full` (the finished text, whose height it holds so the card never grows a line mid-typing), `editing`, `placeholder`. Put it in the comment's column (under the name); while editing, the box's edges sit on that column and the words are padded inside; on post the ring fades and the padding eases away. Restyle with `--ss-draft-ring`, `--ss-draft-radius`, `--ss-draft-pad-y`, `--ss-draft-pad-x`. Never hand-build a comment box. |
| `Card`, `Divider`, `Kbd` | `Card`: a surface whose padding is one value on every side (`pad` small 12, medium 16, large 20), children spaced by `gap` rather than margins, `tone` surface or sunken (a gray group inside a surface), `lift` for a soft shadow over the ground, `flush` for a sectioned card (each direct child padded by `pad`, a full-width hairline between them: a thread with its header and footer, a list of files, a settings group); a rounded box inside takes `border-radius: var(--ss-card-inner)` so the curves stay parallel. Build comment, receipt and settings cards from it. `Divider`: a hairline, `vertical` between toolbar buttons, `inset` in px. `Kbd`: a shortcut, `keys={['⌘', 'K']}` as keycaps, `plain` for flat gray text beside a menu item. |
| `Code`, `Chart` | `Code`: real code lines with numbers, quiet syntax color and diff lines (`{ text, kind: 'add' \| 'del' }`); `count` streams lines in without reflow; long lines fade at the edge. `Chart`: a smooth line with a soft area and an end dot, or `kind="bars"`; it draws in on `show` and eases between datasets when `data` changes. `chartPoints(props)` gives where it draws each point (a bar's top center) from the same props, for a tooltip, marker or hairline on a point: never repeat the chart's maths. |
| `Slot` | A gap in a list that opens and closes (`open`, `height`, `gap`), for moving a card between lists or columns (the dashed mark is drawn at the slot's full height and only fades; never animate a dashed border's size): the source's slot closes as the card lifts, the destination's opens (`dashed`) as it travels, and the card lands in it. Aim the drop at where the card will sit once the slot is open (measure the column, not the opening slot). Columns must be fixed widths (`minmax(0, 1fr)`) or they shift as the card changes column. |
| `Scroll` | A scrolling area: `<Scroll name="list">` and `a.scroll('list', 'row-5')` (or a px offset). The cursor moves over the area first and holds still while the content moves; macOS's overlay scrollbar shows while it scrolls and fades after (`bar="always"` keeps it, `bar="none"` hides it); edges soften only once scrolled. Scrolling craft is in `motion.md`. |
| `Camera` | Pushes in on part of the scene and back out: wrap the scene, set `focus` to `a.rect(name, { layout: true })` or null. The view feathers its edges while zoomed. When and how to push in is in `motion.md`, Scrolling and the camera. |
| `Follow`, `cellOf` | `Follow` springs an overlay onto a rect and keeps momentum when retargeted (selection rings, highlights). `cellOf` gives sticky cell borders for drags (`motion.md`, Drags and selection). |
| `Tooltip` | A small dark label centered under (or over, `side="above"`) a target rect, `gap` from it, fading in with `show`. Pass `at={rect('archive')}`; restyle its corner and color to the product's. |
| `Chip`, `Swap`, `Expand` | `Chip`: a filter chip with a remove x (`remove` names it for the cursor) that opens and closes its own width, `gap` the row's gap. `Swap id={step}`: replaced text, keyed on what changed, that crossfades while its box eases to the new size, so lines around it move instead of snapping. `Expand`: the iOS card-to-screen open as one element, clipped from `from` (a measured rect); with `face` (what the tapped thing looked like, a notification or an icon) it's an app launch: the window takes the app's surface (`--ss-expand-bg`) as it grows, the face fades early and the app's content fades in with the growth. Works inside a Phone: closed, it still draws its face at `from`, so keep it in a layer hidden until the launch. Put that layer at z-index 1, under the status bar and island, and set the Phone's `dark` to false as the app covers the top, so the status bar reads over it. |
| `BrandMark` | A real product mark from the local registry via `brand` (Visa, Mastercard, PayPal, Notion, Gmail and other common integrations), or a custom `name` and `src`. `size` sets the height, wide payment marks keep a wider footprint, `tile={false}` removes the tile, and `surface` overrides the automatic light or dark artwork. See `brands.md` and `examples/brand-marks/`. |
| `Bar`, `Text` | A placeholder line (`tone` 1 to 5). A line (numeric `w` over three times `h`) gives way in a row too narrow for it and never runs past its container; where it fits it is exactly `w`. An icon slot or dot keeps its size; `shrink` overrides either way. `Text` is real text, one line unless you pass `wrap`, that becomes a placeholder line in minimal fidelity (its width estimated from the text and a numeric `style.fontSize`; set `w` to be exact). `Text filler` is the other way round: words that show only at realistic fidelity and are a bar at standard and minimal, so filler rows are written once and the stage's fidelity decides. |
| `inset`, `box`, `between`, `contains` | Rect helpers for placing overlays from measured targets. A `Rect` is `{ x, y, width, height }`, including values from `rect()`; use `width` and `height`, not `w` and `h`. |
| Look tokens | Shape (`--ss-radius-sm`, `-md`, `-lg`, `-window`, `-pill`) and density (`--ss-control`, `--ss-row`) beside the color and type tokens; every rounded part reads them. Set a look with a class over `.ss-stage` or `Stage tokens={{ ... }}`. See `references/looks.md`. |
| `stageshow.css` | Every style at once (each component also imports its own). All kit CSS is in `@layer stageshow`, so a demo's own unlayered CSS always wins: restyle a part with a plain class, never `!important`. A few unlayered guards keep host CSS out of a stage: host element rules roll back to browser defaults, and a universal reset (Tailwind preflight) is handed back to the kit. A host rule with a class (`.article p`) still reaches in; exclude stages with `:not(:where(.ss-stage *))`. Tokens (five inks, surfaces, lines, text, one accent plus `--ss-accent-2` for gradients, status colors with `-soft` fills and `-text` shades, the well, `--ss-raised`, window, hero, satellite, ground and lift shadows; `Stage greys="cool"` swaps the warm canvas and well for cool ones), the looks, edge fades (`.ss-fade-b`, `-r`, `-br` with `--ss-fade`), the cursor, chrome, phones and keycaps. |

## Layout and CSS scope

In render code use the third `layout` argument; in a script use `a.layout`.
Both are `'wide'` or `'compact'`. Do not infer layout from a child element's
measured width: that element can be narrow in either composition.

`<Stage className="demo">` puts the class on the outer `.ss-fit` wrapper.
The inner `.ss-stage` owns `data-layout` and the design dimensions:

```css
.demo .ss-stage { background: #f5f5f5; }
.demo .ss-stage[data-layout="compact"] .card { width: 300px; }
```

`.demo[data-layout="compact"]` matches nothing. Scope the scene's other
selectors under `.demo` too. Measure the host width before choosing the
compact design size; the example dimensions are not defaults.

## Explicit replay

`Stage` has no imperative replay handle. Put a real, accessible Replay button
in the host and remount the demo at that story boundary:

```tsx
const [run, setRun] = useState(0)
return <>
  <button onClick={() => setRun(n => n + 1)}>Replay</button>
  <InviteDemo key={run} />
</>
```

The click explains the return to the starting picture. Keep the wrapper's size
fixed; for a soft restart, hide the scene before changing the key and reveal
the fresh one after. A keyed replay is deliberate: never use changing keys for
ordinary state changes, text changes or variant switches, which should keep
the moving object's identity. Set `play="once"` for a scene that waits for
Replay after its payoff, with a meaningful `poster` so reduced motion shows
the same complete still.

---

## Appendix: looks.md

# Looks

A look is a set of design tokens: color, type, shape and density. The kit's parts read them, so one look restyles every window, field, menu and badge at once while the motion, framing and craft rules stay the same. Use the product's own look whenever there is one: a demo in the product's real colors, radii and type reads as the product, not as a generic mock.

## The built-in looks

`Stage` takes `theme` (`light`, `dark`, `blueprint`, `glass`), `palette` (`accent`, `mono`) and `fidelity`. They are the starting point. A custom look sits on top of one of them, usually `light` or `dark`.

## The tokens

| Group | Tokens | Default |
|---|---|---|
| Surfaces | `--ss-canvas`, `--ss-surface`, `--ss-chrome`, `--ss-well`, `--ss-raised` | warm grays, white |
| Lines | `--ss-line`, `--ss-line-faint` | translucent black |
| Text | `--ss-text-strong`, `--ss-text`, `--ss-text-faint` | three grays |
| Icons | `--ss-icon`, `--ss-icon-faint` | opaque grays |
| Accent | `--ss-accent`, `--ss-accent-2`, `--ss-accent-soft`, `--ss-accent-text` | blue |
| Status | `--ss-success`, `--ss-danger`, `--ss-warning`, each with `-soft` and `-text` | green, red, amber |
| Type | `--ss-font`, `--ss-mono` | the system stacks |
| Shape | `--ss-radius-sm` (6), `--ss-radius-md` (8), `--ss-radius-lg` (10), `--ss-radius-window` (12), `--ss-radius-pill` (999) | px |
| Density | `--ss-control` (34, a text field), `--ss-row` (26, a menu row or segment) | px |
| Shadows | `--ss-shadow-hero`, `-satellite`, `-ground`, `-window`, `-float`, `-lift`, `-card` | see `framing.md` |

The placeholder inks (`--ss-ink-1` to `-5`) are the kit's, not the product's. Leave them unless the product's grays are a different temperature; then pick `Stage greys="cool"` or set the inks from the same gray family.

## Defining a look

As a stylesheet, which can also carry a dark variant:

```css
.look-acme .ss-stage {
  --ss-accent: #5b5bd6;
  --ss-font: "Inter", system-ui, sans-serif;
  --ss-radius-md: 6px;
  --ss-control: 32px;
}
.look-acme .ss-stage[data-theme="dark"] { --ss-surface: #18181b; }
```

```tsx
<Stage className="look-acme" theme="light" ...>
```

Or as values, for one stage: `<Stage tokens={{ '--ss-accent': '#5b5bd6', '--ss-radius-md': '6px' }}>`. Keep a product's look in one file next to its demos and use it on every stage of that product. `examples/looks/` has nine studies. Three invitation variants isolate token choices, including Radix Themes' public tokens (`radix.css`). `studies.tsx` adds a dark console, a financial overview, a creative canvas, a conversation and a research notebook, which change product anatomy, density and hierarchy as well as color. `skeuomorphic.tsx` adds a dimensional transfer receipt: layered paper, a translucent raised frame, coherent lighting and precise edge shadows. Skeuomorphic can mean restrained material depth in software UI, not an imitation appliance; keep the information clear and the physical cues behind it. These are examples, not a closed set: the brief may call for a language none of them use. Borrow the decisions, not an unrelated product's layout. For backgrounds and whole-grid relationships, read `backgrounds.md` and `bento.md`.

## From a codebase

When the product's code is at hand, its look is already written down. Read it before building anything:

1. **Find the tokens.** CSS custom properties (`:root { --color-primary ... }`), a Tailwind config (`theme.extend.colors`, `borderRadius`, `fontFamily`), theme files (`theme.ts`, a tokens JSON), or a component library's provider. Failing that, read the computed styles of the real components: a button, an input, a menu, a card.
2. **Map them.** The primary color to `--ss-accent`; the page and card backgrounds to `--ss-canvas` and `--ss-surface`; the text scale to the three text tokens; borders to `--ss-line`; the font stack to `--ss-font`; the radius scale to the shape tokens (the product's button or input radius to `-md`, its menu item to `-sm`, its popover or card to `-lg`); its input height to `--ss-control`, its menu row to `--ss-row`.
3. **Write the look file** and use it by default for every stage of that product.

Follow what the developer asks for. By default the demo is its own code, styled to match: the kit's small parts restyled with the product's tokens. When they ask for the demo to use their own components (their buttons, rows, avatars, design system), import those inside the stage instead of the kit's small parts. The stage, frames, cursor and motion parts still do their jobs around them: mark what the cursor touches with `data-target` and measure it with `rect()` as usual. Real components bring real density, so the restraint rules still apply: words where they carry meaning, quiet filler elsewhere. If a component fetches data or needs app context, give it fixed props or a small wrapper; a demo never calls a live service.

## From a public site

When the product is someone else's, approximate it from its public site: open it, read the computed styles of a button, an input, a menu and a card, and map them the same way. Take the values, not the assets: no unlicensed fonts or images. Use the kit's local brand marks where they fit (`brands.md`), or the project's own artwork under its terms.

## What a look doesn't change

A look sets visual tokens. The scene still takes on the product's own motion and interaction habits: the kit's timing and framing are defaults. Keep real interaction timing where it helps recognition, then give the audience reading time. Causality, continuous identity, legibility and reduced motion hold whatever the style. A small illustration may need more air than the app itself.

## Check it

Put a still of the demo next to a screenshot of the real product at the same scale. The accent, the grays' temperature, the radii and the type should match at a glance; if a control looks foreign, read its real computed styles again rather than nudging by eye.

---

## Appendix: motion.md

# Motion

The rules for everything that moves: the story, the loop, pace, text that changes, things that arrive and leave, the cursor, drags, scrolling and the camera. The still frame is in `craft.md`; each kit part's props are in `kit.md`.

## Index

1. [Story](#story): the shape, the beats, the payoff, satellites
2. [Loops](#loops): caused resets, data never rewinds, the seam, exits, conveyors
3. [Pace and easing](#pace-and-easing): two curves, fast feedback, overlap, stagger
4. [Changing text and values](#changing-text-and-values): change only what changed, footprints, numbers, chips
5. [Things that appear, travel and leave](#things-that-appear-travel-and-leave): nothing pops, whole arrivals, flights, handoffs, landings
6. [The cursor](#the-cursor): its kind, never over the label, every move explained, keys
7. [Drags and selection](#drags-and-selection): pickup, held cards, the grab offset, slots, I-beam selections
8. [Scrolling and the camera](#scrolling-and-the-camera)
9. [Phones in motion](#phones-in-motion): touch, swipes, the Dynamic Island, reactions
10. [Recipes](#recipes): page swaps, stepped demos, replay, annotations, motion on a page

## Story

Pick the shape from what the product is valued for; a demo forced into the wrong shape gets busier, not better.

- **How it feels to use:** the gesture is the story; a cursor does one satisfying thing and the result appears under its hand (`examples/hero-demo`).
- **A flow in an app:** a few screens told as one continuous object with the payoff on the last; no bolted-on second device (`examples/phone-touch`).
- **What the system does:** the consequence lands somewhere else; make the link visible (a value on a connector, a card flying into a list); usually no cursor (`examples/subscriptions`).
- **Beauty decides.** The calmer, fuller, better-framed version beats the one with more story (`examples/payout-flow`).
- **A hero loop is 10 to 16 seconds;** a repeat is a short beat, never the whole flow twice (`examples/subscriptions`).
- **Three to five beats building to a payoff;** one gesture and a response can be enough; add beats only when they clarify.
- **Open on a finished screen that works as a still.** The first real content is on screen before the beat. A thread opens with a real message, not bars (`examples/messages`).
- **A short history sits at the top of its pane** under the header, never pinned to the bottom with a void above; size the pane to what it holds.
- **The cursor rests on empty surface between beats,** near its next move, never on an unused control, never an I-beam over a button.
- **A satellite arrives at the beat it pays off,** carrying its payload, or is present from the first frame in a reserved column; never an empty parked object.
- **The payoff is visible at the shown size:** a panel, a window coming forward, a clear state change. A 16px avatar at the edge is not a payoff (`examples/hero-demo`).
- **A button whose label or icon changes changes on itself.** Put the new words in the same kit `Button` (`{done ? 'Resolved' : 'Resolve'}`, an `icon` that arrives) and it crossfades the label and eases its width so neighbors move with it. Never swap in a second button or a lookalike row for its new state.
- **A draft becomes the posted comment in place.** Use the kit's `Draft` (`<Draft value={s.draft} full={COMMENT} editing={typing} />`) in the column the comment's words belong to: it puts the typing box's edges on that column, holds the finished comment's height from the first keystroke, takes its typing shape at once and eases only on post. Posting adds no line: a time or "Just now" goes on the name's line and fades in, since a new line under the name shifts the name and pushes the comment down while its box is closing. Don't move it while typing to line the typed words up with the name (a margin shift on the editing state): the box's edge is what lines up, and the words sit inset by its padding. Don't hand-build the box: drawn by hand, its ring hangs past the column, runs into the name above, or drops a line's height in one frame.
- **The payoff arrives full.** A panel or card opens with its content; with `Collapse`, put the first lines in before `open`. Never a blank surface for a quarter second.
- **Things connect.** A `Connector` draws on over about a second after both ends are placed, routes around cards, and ends on a dot (`examples/story`).
- **A small label with a leader line can name what just happened** (`examples/hero-demo`); the full rules are in `annotations.md`.
- **Motion without hierarchy:** cover each moving element in turn; if the story gets clearer without it, cut it.
- **The poster is the frame most people see:** a thumbnail, reduced motion, a screenshot. Set `poster` to the beat that tells the story on its own (the row mid-swipe with Archive showing, the card over its new column), and let the result stay on screen after the action instead of tidying it away. Cover the motion and ask what happened; if the poster can't answer, choose another beat. A poster is never caught mid-change: a digit mid-roll, a label mid-morph or a surface mid-fade reads as a glitch when it holds still, so choose the frame after it lands.

## Loops

- **A reset removes what the loop added as one thing.** A reply and its reaction leave together, never reaction then message; a list that grew loses its new rows in one motion. The fewest steps that return the frame, with a seen cause where one exists.
- **A loop keeps a complete product picture:** open on context and return to it; a header over a blanked list is not an anchor. Film the seam at 60ms.
- **Every reset has a cause or is invisible,** in order: a seen cause (undo with its keycaps, clear, close), an exit around an anchor, a snap while hidden (`act.snap`). See `examples/subscriptions` and `examples/story`.
- **A loop never plays a navigation backwards.** An app opened from a notification doesn't shrink back into it, and a pushed screen doesn't slide back in reverse; no product does that. Undo the state in place, in a quick reverse stagger (the last change first, about 70ms apart), so the screen rewinds to its opening frame as one motion, or cut while something covers it. Don't lock the phone or go home to reset a story that happens inside one app: a black screen on a white page reads as the demo ending, not looping. A lock is the reset only for a lock-screen story.
- **Data never rewinds in view.** Snap it back hidden (off camera, under a closed panel, behind the exit) or bring the next loop's data in as new.
- **No dead air at the seam:** within about a second of the exit ending, the next action has begun.
- **Exiting around an anchor:** what the story added leaves in one reverse stagger, everything moving within half a second, 40 to 80ms apart, while product content stays. Never everything at once.
- **A story that accumulates runs as a conveyor:** exit the built batch, bring a fresh one in from the crop, reset unseen.
- **The payoff holds for 2s** before the exit (`examples/payout-flow`); nothing on screen sits still for more than three seconds.
- **A second scene earns its length** by adding something new (a different outcome, surface or side); repeating the beat doubles the loop for nothing (`examples/subscriptions`).
- **A looping video starts on a calm frame,** never mid fast motion.

## Pace and easing

- **Unhurried, on two curves.** Travel: `cubic-bezier(0.45, 0, 0.1, 1)`. Arrival from nowhere: `cubic-bezier(0.25, 0.8, 0.25, 1)` over 0.8 to 1s. Judge distance and overlap, not duration (`examples/payout-flow`).
- **Travel has a departure, clear travel and a soft arrival;** length alone does not make it fluid.
- **Choose durations and easings together by job;** one easing everywhere flattens the hierarchy; an accumulating number may take longer than its transfer (`choreography.md`).
- **UI feedback stays as quick as the real product;** only storytelling motion slows down. Feedback starts on the input; a presentation delay feels unresponsive.
- **Related responses overlap.** A changed setting leads its label, then its dependents, while the frame holds; a confirmation still follows its cause (`examples/choreography`).
- **Related updates can each take a different time;** the result still follows its cause.
- **Stagger groups in reading order 40 to 80ms apart** within a scene (`act.stagger` default 60); 80 to 120ms between tiles of a grid. One object enters whole; holds are beats too (`examples/calendar`).
- **Introducing a composition:** a small front-loaded movement can settle longer than its busy part; don't scale readable text much.
- **A small expressive icon may overshoot** while its card and text settle without bounce; keep the accent local; give the final state time to read.
- **Color changes between distant hues take about 200ms** (they pass through mud however done); let the label carry the slower motion.
- **Holding a result means stop:** a useful still needs no new pulse or repeated count.

## Changing text and values

- **Inspect the glyphs, not only the box.** Text can shimmer as a layer finishes; keep its transform layer through cleanup, never `will-change` over the whole scene.
- **Settle geometry before chasing a text shift.** Compare the last moving frame with the first settled one (`lands on a transform`, `steps in its box`).
- **Other text shifts:** a released measured width, a transform losing its layer, a late-loading font; inspect at real size.
- **A status word that changes (Queued, Running, Passed) rolls with `Roll`,** never two hand-built spans crossfading in place (they overlap mid-fade and read as a smudge). When several rows change at once, as a loop resets, cascade them about 60ms apart with `delay`: a column rolling in unison reads as flicker.
- **Every change moves.** Text that turns into a pill, a menu replaced by another in one frame, a number that jumps: a submenu slides, text rolls, a surface morphs.
- **Change only what changed.** `Roll` animates the changed span and moves what follows by its measured width; pick the anchor on purpose (`examples/story`).
- **Decide a control's footprint before its label transition:** `States` holds the largest, `Roll variant="fade"` resizes; never roll unchanged words (`examples/parts`).
- **Button states share one slot.** Keep the button mounted, variants in one grid cell, each icon-and-label variant default-centered; check shortest, longest and pending (`examples/hero-demo`).
- **Added content opens its space with its neighbor:** the icon's width and gap open together while the label travels; both close on removal (`examples/annotations`).
- **A right-pinned value changes against that edge** (`Roll align="end"`); a status icon beside it keeps a fixed slot (`examples/payout-flow`).
- **Numbers roll with `Count`,** last digit first, unchanged digits still; no per-frame lerp blur; give it a slot; hold the completed value (`examples/subscriptions`).
- **Typed text becomes a chip in place** (`Field chip`): the words stay, the surface grows around them, the x opens beside.
- **Result follows press feedback:** a small press and surface response before the result; change state after `a.click` completes.
- **An object keeps its identity when it changes** (a plus becoming a close): rotate the same strokes; replacing the icon skips the relationship.
- **A spinner turns before it is visible** and keeps turning through its fade out.

## Things that appear, travel and leave

- **A thing that grows as it travels takes the long settle.** A thumbnail becoming a card swells on a soft start and a long deceleration (the kit's `Fly` curves, 600ms or more); a quick ease-in-out lurches.
- **Nothing pops.** Everything has an entrance and stays mounted until its exit finishes; `Bubble` and `Fly` hand off at the same geometry.
- **No holes or blank frames.** What replaces something arrives as it leaves; reopening rows fade content in as their height finishes (`Collapse`) (`examples/subscriptions`).
- **Neighbors make room continuously** as the newcomer arrives; its fade rides with its travel, not before.
- **A new row carries the rows below it:** animate the containing track so the line below moves with its height, or reserve the space.
- **A resizing surface moves size, position and content as one transition,** never stretching its text, and retargets from its current geometry when interrupted (`examples/choreography`).
- **Replacing content keeps the container, alignment and reading interval,** masking only the moving slot.
- **Keep header, outer surface and action positions steady** while variable content changes inside; old and new content stay in tracks.
- **Solid things do not fade through.** Windows, phones and cards arrive by moving, opaque or nearly; a half-transparent phone is a ghost.
- **Cards, toasts, pills and reactions arrive whole from just above** (`Collapse reveal="drop"`), never uncovered by a hard edge; clip only rows of text.
- **Content arrives after its container:** a pin's number appears once its circle is nearly full size.
- **A popup fits before its first frame:** sized and scrolled before showing; it never corrects its size while opening (`examples/parts`).
- **An open surface holds its anchor.** A popover, palette, menu or sheet is pinned by the edge it opened from. Reserve height for the longest list (`anchor drift`, `examples/linear`).
- **Overlays close where they were:** keep `{ open, at }` apart, never a nullable `menu` point.
- **A zone becoming something else takes its new size** (a drop zone into an upload card); the fixed-footprint rule is for optional content inside a surface.
- **A value chip grows from the value's own words,** gains fill and lift as it departs, and wears one of its two looks, never a third color. The recipe is in `kit.md` (`examples/subscriptions`).
- **A dashed edge never changes size:** draw it at final size on its own layer and only fade it (`dashed edge resizes`, `examples/controls`).
- **Border style does not transition:** keep the solid hairline and fade a dashed `::before` layer out over it.
- **Switching versions morphs in place** or crossfades with the plate's height eased; never a flash or hard swap.
- **A released marquee fades;** it never sits still then vanishes.
- **A moving edge never slices text.** `Collapse` fades before and after the height moves; otherwise sequence fade and movement, or mask locally without softening the whole interface (`hard edge`).
- **One object, one trip, ending in its final place:** open the room (`Collapse`), measure the slot, then `Fly`; never land then re-lay out around it (`examples/subscriptions`).
- **After motion nothing moves.** A handoff is the same size, place and look on the swap frame. Measure the landing element itself, never its padded wrapper (`handoff shift`, `settle snap`, `fly size`).
- **A flight's ends are fixed at take-off** (`Fly` holds its rects when `go` turns true); a moving start retargets every frame and jumps.
- **A flyer changes to its resting look during the last third** (`.ss-fly[data-go]` with a delayed transition); never swap looks on the landing frame.
- **Landings are soft:** decelerate over the last third, back to size before arrival, no bounce, no ring pulse.
- **A selection ring or highlight moving between items uses `Follow`,** so it keeps momentum when retargeted; re-keying its entrance restarts it (`examples/figma`).
- **Look at every motion finding** (`appears, then moves`, `near-empty frames`, `lands on a transform`, `steps in its box`). Fix the real ones, name the intentional, never cut good motion to quiet a detector.

## The cursor

- **No cursor means no stand-in.** Never walk a focus ring, halo or spotlight between controls; states and timing carry a system story (`examples/cursors`).
- **The elements decide the cursor's kind** via `data-cursor` (`ibeam`, `hand`, `open`, `crosshair`, `resize-ns` or `resize-ew` on an edge that drags, `resize-nwse` or `resize-nesw` on a corner, with `drag(..., { cursor: 'preserve' })` so it doesn't close to a fist), switching mid-path as it crosses the edge, never after arriving (`examples/cursors`, `examples/cursor-resize`).
- **`drag()` closes and reopens the hand itself;** a drag over text stays an I-beam; `{ cursor: 'preserve' }` keeps the arrow for arrow-based creation (`examples/google-calendar`).
- **Native app buttons keep the arrow,** and a button inside a marked area is the arrow again unmarked; `cursor()` is only for kinds nothing implies (`wait`).
- **The I-beam and crosshair turn white with a dark edge on a dark stage;** the glass circle narrows into a bar over text.
- **The cursor never covers the words it clicks.** Aim inside the target but off its text (`x: 0.85, y: 0.6`). Rest off a changed label; park in a menu row's empty space (`covers`).
- **A state the click sets fades in, quickly.** A tool picked in a toolbar, a selected row, an active filter: its fill and color ease in over about 150ms and back out the same, never switch on in one frame. A set of options where one is chosen and the choice moves is a `Segmented` or `Tabs`, whose highlight slides.
- **The cursor stays where the press happened** while the result changes size; never pin it to a moving button edge.
- **A cursor changes style by morphing,** never popping (`examples/cursor-morph`).
- **Every move travels to the next action,** follows a held object or clears the way; the Stage fades a resting cursor after 4s.
- **Keyboard stories show the keys** with `act.key('cmd+k')`; the cursor can rest or leave (`examples/raycast`).

## Drags and selection

- **A pointer drag is one motion.** With a mouse the row follows the pointer the whole way and leaves on release; the short drag then throw is a finger's flick and reads as two motions under an arrow.
- **A drag starts where the thing is.** A file from outside enters already held with a fixed grab offset. Never a pickup at an empty point or a changing grip (`examples/freeform-drag`).
- **A text selection reads left to right** from a word boundary; dragging back from the end reads as a correction (`examples/google-docs`).
- **A text selection stays under the I-beam every frame:** drive it from `a.drag` with `a.caret(name, at)` in the drag's `onMove` and render from the character count. A highlight grown by time or a word count runs ahead of the cursor on one line and behind it on the next; `--gate` fails on `selection drift`. Never clamp it or hit-test with `caretRangeFromPoint` (`examples/google-docs`).
- **Pickup belongs to the press:** set `lifted` and the first carried position inside `onMove`, never before `drag()`; a long press shows press, hold, lift (`examples/calendar`).
- **A carried card is held, not slid:** scale 1.03, deeper shadow, a degree or two of tilt, following the hand's arc. The whole card tilts, words and all: a surface tilting under level text reads as a bug. Keep its text from hopping as it lands with a layer it holds throughout (`will-change: transform`), not by leaving the text out of the tilt. It settles flat on drop, with no selection outline in the air (`examples/controls`).
- **Constrained controls follow their mechanism:** give `drag` a `{ path }` so a knob turns on a circle; check the hand's radius all the way round (`examples/annotations`).
- **The grab offset is where the hand took hold:** derive it from the pickup fractions, share the `transform-origin`, keep stage translation outside the lifted transform (`examples/freeform-drag`).
- **A held item rides with the cursor exactly** from `onMove` on both axes with no transition; `Fly` is only for flights the cursor is not carrying.
- **Drop targets never travel:** the slot appears in a cell and jumps to the next, hides over the card's own cell; `cellOf` for sticky borders (`examples/freeform-drag`).
- **Moving a card between lists uses `Slot`:** source closes on lift, destination opens in flight, drop aims at the open slot, then the real card swaps in (`examples/controls`).

## Scrolling and the camera

- **Nothing scrolls unless the pointer is on it:** `a.scroll` moves the cursor in and holds it; scroll back before the loop ends, never at the seam (`examples/controls`).
- **Scrolling starts with whole rows;** fade only the edges hiding content once scrolled, and clear the fade at the end.
- **The camera needs a reason.** Push in only when the payoff would be too small to read at the shown size; cut any zoom nobody would miss.
- **Frame the wide shot as a good still before any push-in;** the zoom never rescues a weak frame.
- **A push-in frames the stage's shape:** `Camera` fits the focus to the aspect, so widen the focus to the content column rather than accept leftovers (`examples/calendar`).
- **One push-in per story,** in and back out; edges feather while zoomed; the cursor holds still while the view moves (`examples/controls`).
- **Inside an overlay, wrap only the region that zooms** in `Camera`, with `pad={0}` when the region is already the frame.

## Phones in motion

- **Act where people do.** A notification is tapped to open its app, and the reply, the accept or the purchase happens in the app. Its long-press actions are a shortcut few people use, so a story told through them reads as invented.
- **Touch on a phone uses `cursor={{ style: 'touch' }}`,** never the macOS arrow. In-app responses are UIKit-quick, `cubic-bezier(0.3, 0.75, 0.1, 1)` over 0.5s; `Expand` does card-to-screen (`examples/phone-touch`).
- **A swiped row stays in its list:** the action is the row's own back, the same height and edge to edge, revealed as the row slides off it, not a separate rounded card beside it with a gap. The list clips both, so the row never paints over a neighboring pane, and its text is cut only by that edge. Check the frame at the furthest point of the swipe at full size: it is the one people screenshot (`examples/swipe`).
- **A swipe is a flick:** a third of the screen in about a quarter second, lifting while moving. The page is thrown on over 0.5s with `cubic-bezier(0.25, 1, 0.5, 1)` (`examples/phone-touch`).
- **A reaction is `Bubble tapback`:** a white circle on the bubble's bottom corner, growing from the edge as the room opens on the same clock. It fades before the room closes.
- **Dynamic Island:** animate the black shape's box and radius together, never by stretching its contents; content lives on a separate unfiltered layer and fades into place (`examples/dynamic-island`).
- **Island timing:** 500ms underdamped growth, 380ms shrink delayed 120ms for content to clear, a press squeeze to 0.965.
- **Island filters** (blur 2.6, alpha matrix 9 -4) belong to that geometry; filter only the black shapes. Keep the dormant circle inside the pill and inspect the contour at contact, separation and rest.

## Recipes

- **A page swap inside one window** keeps the chrome and crossfades only the body (200ms, an 8px rise); tabs move with it; never slide whole pages sideways.
- **A stepped demo keeps its object across steps;** swapping a Stage's script is a cut. An outside-switched variant gets one stable `play="once"` script; verify skip, reverse and mid-play change.
- **Replay remounts at the story boundary** with a key; never changing keys for ordinary state, text or variant changes (`kit.md`, Explicit replay).
- **A look sets tokens only;** the scene keeps the product's own motion habits and real timing (`looks.md`).
- **Annotations** (leaders, connectors, flows, moving targets) have their own rules in `annotations.md`; `choreography.md` walks one content change end to end.
- **Motion on a page of demos or in a grid has one place to lead** (`bento.md`, rule 11).

---

## Appendix: products.md

# Product studies

These examples reproduce recognizable product interfaces. Use them when the brief needs product fidelity, denser content, native chrome or a specific interaction. They sit under **Real products** in the playground. They are illustrations, not working clients, and not affiliated with the products shown.

| Product | Source | Focus |
| --- | --- | --- |
| Figma | `examples/figma/` | Canvas objects, properties and comments |
| Linear | `examples/linear/` | Command menu, issue context and assignment |
| Slack | `examples/slack/` | Reactions, message layout and a thread reply |
| Raycast | `examples/raycast/` | Keyboard search and clipboard navigation |
| Finder | `examples/finder/` | Quick Look, file selection and drag |
| Finder with glass | `examples/finder-glass/` | Translucent window surfaces |
| Spotify | `examples/spotify/` | Library and media controls |
| Notion | `examples/notion/` | Document blocks and editing controls |
| Gmail | `examples/gmail/` | Inbox and message actions |
| Google Calendar | `examples/google-calendar/` | Event and calendar views |
| Google Docs | `examples/google-docs/` | Document editing and collaboration |
| PowerPoint | `examples/powerpoint/` | Slide editing |
| Excel | `examples/excel/` | Cells, selection and calculations |
| Wikipedia | `examples/wikipedia/` | Search suggestions and article navigation |
| Telegram | `examples/telegram/` | Phone conversation and message arrival |
| iMessage | `examples/imessage/` | Native composer and delivery feedback |

Some studies import `lucide-react`, which the playground installs. When copying one into a host, keep its local CSS and assets and install that icon dependency, or swap the icons for the host's own set. The kit itself needs React, react-dom and lucide-react (for its `Icon`). Product names, marks and imagery are covered by `NOTICE.md`.

Open the source and look at it at the intended width before borrowing. A recognizable interface can still have a weak crop, reset or transition, so give it the same rehearsal as a new scene. Being in this list is not a review.

---

## Appendix: rehearse.md

# Rehearse

A dress rehearsal: run the whole demo at real speed and watch it as the audience will, before anyone does. Read every image you make, and confirm the page you filmed runs the code you wrote. The rules the film lines enforce are in `framing.md`, `craft.md` and `motion.md`; this file is how to film and what to watch.

## Prove the still before choreography

Render the opening and the payoff at both shipping widths beside the gold at shown size; the reduced-motion poster is not the opening, and it has to work as the only frame (`motion.md`, Story). Ask the still questions in `verify.md` (Framing, Hierarchy and density), then:

- Can the viewer find the focal object and what changes before any branding or copy?
- Compare the quality (hierarchy, density, spacing, crop, material) against the gold, separately from whether every object in the brief is present.
- Do the same for the busiest mid-story frame and every resting state that changed. A clean tool report does not close a composition question.

## The host's own controls

A demo lives in a page with a picker, playback buttons and labels, and those get judged too. `scripts/layout.mjs` checks ordinary UI outside a Stage, including a bento tile's inner crop (`nested-composition-crop`):

```sh
node scripts/layout.mjs "<url>/?example=hero-demo" --select .pg --width 390 --report shots/host-layout.json --screenshot shots/host-layout.png --strict
```

Run it on the viewer page, the direct scene route and the real destination page at its real width. Moving geometry is reported as incomplete, not passed. Watch each control at rest, hover in and out, pressed, focused, label changed and interrupted mid-transition; geometry cannot vouch for text rendering, focus styling or a filtered silhouette.

## Film

`scripts/film.mjs` opens a page in headless Chrome and shoots the stage at a fixed interval into one contact sheet at true size. It prints console and `[stageshow]` warnings (loop seams, missing targets); `--help` lists every flag.

First time: copy `scripts/` beside `kit/`, `npm i -D playwright-core` (and `postcss` for the CSS check); `CHROME_PATH` picks another Chrome. The kit itself needs neither.

In the playground, film the direct `?capture=<name>` route (the ordinary viewer wraps the scene in an iframe); on a site, the real page URL (open an embedded frame's URL directly when needed). Still watch playback, pause, resume and Replay in the viewer yourself.

```sh
node scripts/film.mjs "<url>/?capture=hero-demo" --out shots/hero.png --every 1000 --count 18
node scripts/film.mjs <url> --out shots/still.png --still                        # one clean image of a still
node scripts/film.mjs <url> --out shots/phone.png --width 390 --every 2500 --count 6
node scripts/film.mjs <url> --out shots/drop.png --at drop --every 50 --count 24   # one beat, frame by frame
node scripts/film.mjs <url> --out shots/zoom.png --zoom 380,40,240,120 --still    # close-up, in stage design px
node scripts/film.mjs <url> --out shots/hover.png --hover --every 300             # play="hover": rest, hover, leave
node scripts/film.mjs <host-url> --select "#feature-demo" --report shots/report.json --strict
```

- **Selection and marks.** Film discovers every visible `.ss-stage` (hidden compact or wide twins skipped); `--select` narrows; `--at` and `--zoom` need one stage. Call `act.mark('drop')` at a beat and film with `--at drop`; never guess delays.
- **Close-ups.** `--zoom x,y,w,h` is in stage design pixels at high resolution; `--zoom target:<name>[,pad]` follows a `data-target` every frame. Stills wait for a rolling `Count` to land.
- **Hover stages.** `--hover` films rest, hover and the settle after leaving; the rest frame must stand as a still and leaving must glide back without a jump.
- **Looks and widths.** `--dark` films the dark theme; `--width 566` for a 550 column; `--slow 6 --every 40` samples a landing or press closely (stage and CSS both slow).
- **Jumps.** Film records geometry every animation frame and reports `jump:` and `drift:` candidates at their timestamps. Fix accidental ones; mark an intentional step narrowly with `data-snap`. `node scripts/jumps.mjs "<url>/?capture=<name>" --ms 30000 --report shots/jumps.json` runs a longer scan without screenshot overhead.
- **Coverage.** Empty, short or gapped recordings (gaps over 1.6x the typical interval, intervals over 40ms) are `inconclusive`, exit 2. Camera omissions and same-box text changes are listed for manual review.
- **Reports.** `--report <path>` writes JSON (`status` and `exitCode`, with each stage's `coverage`, `findings` and `manual` under `stages`); `--strict` exits 1 on candidates; `no-issues-detected` is not approval; exit 3 on persistent dev reloads.
- **Class clashes.** `node scripts/class-clash.mjs <demo folders>` (needs postcss) checks overlapping class namespaces. A scoped `.row` is fine, an unscoped one is not; complex roots are inconclusive. Check repeated demos together on the host too.

## Lines that are never intentional

Not candidates for judgment: fix the cause and re-shoot. `film.mjs --gate` ends `rehearsal passed` only when all are at 0. Clearing a line by hiding, removing or marking (`data-crop`, `data-snap`) the thing it points at is a bug, and the fresh eye re-judges every line you call intentional.

| Line | What it means |
|---|---|
| `framing:` | A gutter, bleed, crop or window shape `framing.md` forbids; a hero floating whole; a popover against an edge |
| `cut by the crop:` | An action or chip sliced by the stage edge; filler bleeds, actions read whole or not at all |
| `tight stack:` / `loose stack:` | A title on its subtitle with under 3px of ink between, or drifting past 10px in a small label (4 to 6px is right) |
| `tight mark:` | A status dot within 5px of the avatar or text, or outside its row (6px clear) |
| `tight inset:` | Words under 8px from a window's, card's or row's edge (12px is right) |
| `skeleton ladder:` | At realistic fidelity, a list in frame (4+ rows) where the wordless rows (at least 3) outnumber the worded ones |
| `onion skin:` | See-through fills overlapping at rest |
| `kit override:` | Your CSS reshaping a kit part's geometry (rows, bubbles, stamps, avatars, phones) |
| `unit wrapped:` | A stat's unit on its own line |
| `unsized text:` | Text in a window left at the stage's 16px baseline because nothing sized it |
| `clipped glyph:` | An icon drawn past its box |
| `loose list:` | Rows spread out to fill a pane |
| `fat row:` | A one-line row three times taller than its words |
| `empty pane:` | A void under a pane's or screen's content |
| `emoji icon:` | An emoji where an icon belongs |
| `anchor drift:` | An open popover moving as its list changes height |
| `uneven padding:` | A card or tile whose content sits about a third closer to one edge than the side inset, or past it |
| `mixed icons:` | Filled and outline glyphs side by side in one nav, list or toolbar |
| `tight control:` | A button or chip with under 8px between it and the field, line or card edge above it |
| `invented mark:` | A one-letter tile in a brand color beside a real company's name |
| `uneven inset:` | A bar, pill or row of controls whose children sit much closer to one end than the other |
| `uneven gutters:` | A window or panel in a tile much closer to one side than the other |
| `avatar alignment:` | A body under an avatar row starting under the avatar instead of at the name's edge |
| `spills its slot:` | Content running past the width it was laid out in, or closing its row's gap; a ring drawn as its own layer running into a neighbor's words or past its card |

A `[stageshow] selection drift` kit warning (a text selection that isn't under the I-beam) fails the gate too.

## Other film lines

Candidates, each named beside its rule. In `craft.md`: `touching` (text within 5px of a box) and `tight lines` (bars closer than the text they stand for), `lopsided`, `uneven`, `near-tangent`, `half-pixel glyph`, `squeezed`. In `motion.md`: `covers`, `dashed edge resizes`, `handoff shift`, `settle snap`, `fly size`, `hard edge`, `appears, then moves`, `near-empty frames`, `lands on a transform`, `steps in its box`. Defined only here:

- `clipped:` is a mark sliced by a container edge inside the stage; fix it, or mark the container `data-crop` only if the crop is deliberate.
- `unclipped:` means the page decides the crop: give the stage `overflow: hidden`. `double corner` means two rounded clips share an edge with different radii: give one the corner.
- `appears with no entrance` and `vanishes with no exit` can be missed in a sampling gap; film each appear and disappear at 50ms. Instant typing feedback may be intentional: `data-typing` or `data-snap` on the exact changing node, never a whole field or subtree.
- `shrunk, not laid out for the phone: drawn at 0.72` means the type will read small at that width: give it a `compact`. `grown past the design size` means it reads large; `small text: X renders at Npx` is text under 10px, checked at widths under 600.
- A pen tip intentionally leading a draw carries `data-lead`.

## What to watch

- **Framing first.** Film the still and clear every `framing:` and `cut by the crop:` line before motion work; after moving anything, re-shoot the whole loop.
- **Every frame, at the real width,** including the figure in view before it has loaded.
- **Measure, don't eyeball.** Compare computed styles across the page (one shadow, plate, radius set); sample a morph every animation frame, not from a sheet.
- **The loop, end to end.** Film one full loop plus the start of the next; investigate every `loop seam` warning.
- **Text and glyphs.** Inspect pixels at `--slow 4` after a move; a compositing layer is a possible fix, not proof the pixels stayed still. Nothing spills out of its box on any frame.
- **The whole drag,** hover to settle at speed, then stepped: the surface never lifts before the press; track the hand's hotspot through every transform. A temporary zero-size child at the grip point makes the browser project every transform (subtract the parent border); a hand-written matrix can miss separate `translate`, `rotate` or `scale`.
- **Overlays land.** Highlights, selections and markers sit on the thing they describe at every scale; check a drag box against the items it claims.
- **Crops explain themselves.** Every edge where screen meets stage fades, bleeds with intent, or is a real window edge.
- **Edges and corners.** Zoom into hover fills and selected rows: rounded corners intact under a parent's `overflow: hidden`.
- **The narrowest shipping host.** Film the whole loop at 390 and at the brief's own width when it names one, gutters included, read as closely as the wide pass.
- **Every look shipped,** filmed separately.
- **Check the host.** The demo works in the real page at every shipping width (plate, ground, padding, crop). Page backgrounds stay in the host; a component brings no full-page wrapper.
- **Reduced motion.** `--reduced` shows the poster, still and complete; overlays from `rect()` sit right in it; toggle the preference during playback and back. Drop presentation waits; keep task timing and reading time.
- **Live pacing.** The virtual clock proves geometry, not frame rate: log rAF timestamps against the transform on the real page; repeated poses then a jump mean a clock bug. Pause, offscreen, hidden tab and finished `once` scenes stop their work; resume and replay never skip a beat or replay an accumulation. Say which browser and device you checked.
- **Typecheck.** Run the host's typecheck (`npm run typecheck` from the skill folder); report unrelated failures separately, never filter them into a pass.
- **Blueprint grid.** Lines sit at `--ss-grid-x` and `--ss-grid-y`; set them on the Stage so a window's edge lands on a grid line.
- **What the tools can't sign off.** A contact sheet misses a one-frame flash; a scan does not know whether a morph, a story or a gesture is right. Watch playback at speed, slowed transitions, loop plus next start, an interruption, reduced motion, a return from offscreen; again after the final edit. The playground isolates each example in an iframe; Pause and Step advance one clock; Phone changes width but not touch, so check touch on a device or with input emulation.

Then put your sheet beside the closest gold's: is this instantly a real product, quiet, with one clear story? Iterate until yes.

## The last pass

`verify.md` from frames; `--gate` passing on the wide loop, the phone loop and `--states`; a fresh-eye review (`review.md`) returning nothing; `REHEARSAL.md` written beside the component. It lists the widths, looks, interactions and stages captured and the cases not. An empty, late or gapped capture is inconclusive, not a pass.

---

## Appendix: review.md

# Review

The brief for a fresh-eye review after rehearsal. Give the reviewer this file, `verify.md`, the `examples/` folder, the scene's URL and the frames the builder filmed, with a one-line brief that names the gold and attaches its still beside the scene's. Nothing else: not the builder's plan, not its reasons, never its REHEARSAL.md.

Your first question, before the checklist: does this composition answer this product and this page, or could it be any product in its category? A layout the brief did not shape (a window pinned with even margins whatever the product, the same phone framing every phone brief gets) is a finding, ranked with framing, even when every check passes. From the two stills, judge whether the scene gives its focal content as much of the frame as the gold does.

Start from the brief's own words. If it says "white page", a tinted plate behind the device is the first thing on your list; if it names a size, a look or a page color, hold the scene to it before anything else.

## The reviewer's brief

You are reviewing a faux product UI scene someone else built. You have the frames, the URL, `references/verify.md` and the gold examples in `examples/`. You have not seen the brief's intent beyond the one-line brief, and you do not need it: you are judging the picture.

Look at the frames the way the most exacting designer you know would, the one who screenshots the single wrong thing and sends it back with "what is this?". Then answer every item in `verify.md` from a frame, not from the code. If a frame you need does not exist (a beat at 40ms, a 4x zoom of a glyph, the phone width, `--states`), film it with `scripts/film.mjs` yourself before answering; a predicted failure is not a finding, and neither is a predicted pass.

Put the scene beside the gold example it is closest to and say the one difference.

Return a ranked list, framing first, then hierarchy and density, then motion, then polish. Each item: what you would screenshot, which frame shows it, and what the fix is in one line. Say what you could not check. If there is nothing, say "nothing" and list the frames you looked at.

Rules of the review:
- The bar for a finding is a frame. Quote the frame file.
- Rank by how much of the scene it spoils, not by how easy it is to fix.
- A line the builder judged intentional is not settled: look at the frame and judge it again.
- Do not fix anything. Do not soften a finding because the build is nearly there.
- A whole window floating with even margins, rows with more air between them than they are tall, a pane whose content stops well above its bottom, a list of gray bars where the eye lands, a phone drawn small: these are findings even when no film line names them.

Platform conventions are not placeholders. An iPhone messaging thread in Messages' blue with the plus and mic in its composer, a macOS window with its lights, an iOS banner at its true size: these are the product's chrome and stay. Send back an invented accent or a redrawn system control; never send back the convention.

---

## Appendix: teaching.md

# Teaching pairs

`teaching/` holds bad/good pairs: the same scene twice, with one thing wrong on the left. Open **Comparisons** in the playground (`?example=contrasts`) and pick a principle; only that pair mounts, so its controls stay nearby and the others don't keep running. Use **Replay pair** to restart both halves together.

Use a pair to diagnose a problem in your own demo: find the one that looks like your bug, then read why the good half works. The bad halves are never starting points. Watch at normal speed first, then pause and step through the transition. On a narrow screen the halves stack rather than shrink. Under reduced motion the motion pairs show matching endpoints, because the difference is in the transition, not the end state.

## Motion

Both halves share one stage and one timeline, with a duplicated stationary pointer so each gets exactly the same input at the same moment. That pointer is a teaching device; a product demo uses the Stage's real cursor and `a.click`. The first four pairs use a 180ms press and hold the result for 1.8s before returning. The longer ones play once and hold their ending.

| Failure | Look at | Correction |
| --- | --- | --- |
| Instant label replacement | "Open preview" becoming "Back to editor", then returning | A stable button and a clipped label slot; the old words leave as the new words enter (`Roll`). |
| Result without press feedback | "Save changes" under the pointer, before "Saved" appears | A small press and surface response before the result. In a demo, change state after `a.click` completes. |
| New row shoves its neighbors | "Standard shipping" below the delivery note | Animate the note's containing track so the line moves with its height. Reserving the space is the other option. |
| Object loses its identity | The plus becoming a close icon, then returning | Keep the same strokes and rotate them; replacing the icon skips the relationship between the shapes. |
| Exit is skipped | "Link copied" when its close control is pressed | Keep the message mounted for its 320ms exit, then remove it. |
| Interrupted motion restarts | The highlight heading to Month, redirected to Week after 200ms | Keep the highlight mounted and retarget from where it is; re-keying its entrance restarts it from Day. |
| Landing jumps at handoff | The 24px avatar when the flyer becomes the assignee | Measure the avatar itself with `rect()`, not its padded wrapper. The bad flight takes the wrapper's origin and lands four pixels off. |
| Loop erases accumulated work | Three files clearing after they have been added | Give the reset a visible cause: the good side presses Clear. |
| Added content shifts its neighbor | A status icon appearing beside a label | Open the icon's width and gap together while the label travels; close both on removal. |
| A list jumps around a new row | Existing rows during insertion and removal | Animate their space as the new row enters whole; let it exit before its space closes. |
| A changing action shoves another | The secondary action beside a growing label | Carry the neighbor with the changing width, not in one frame at the end. |
| Surface and content resize separately | A popup opening its details, returning, reversing | Surface and content on one coordinated geometry, with text that never stretches. |
| Drag starts from the wrong point | The file just after an off-center grab | Keep the pointer's offset inside the object through travel and release. |
| Spinner begins after appearing | The first saving-state frames | Start rotation before the spinner is visible; keep it turning through the fade out. |
| Text shifts as it settles | The changed label and the word "Optional" as the old label hides | Move the label by transform inside a stable grid. Margin travel on overlapping inline-grid items moves the shared baseline even while hidden. |
| A label hits a hard edge | Letters crossing the top and bottom of a label slot | Soften the moving boundary locally; resting text stays sharp and wholly inside the control. |
| Scrolling reveals a harsh crop | Rows crossing the viewport edge | Start with whole rows; after scrolling, fade only the edges hiding content, and clear the fade at the end. |
| Dependent changes start together | Currency, price, payment method and address in one checkout | Offset the related starts while their movements overlap. Same layout, curve and masks on both sides; see `choreography.md`. |

The neighbor pairs live in `teaching/relationships.tsx`, the drag and spinner pairs in `teaching/continuity.tsx`, the label and scroll edges in `teaching/edges.tsx`, and the baseline bug in `teaching/text-settle.tsx`. They are small standalone patterns, not imports from a library.

## Motion between neighbors

An insertion changes two things: the arriving object and the space of what was already there. Animate both. Fading an icon in while its label jumps still breaks the relationship. The rules are in `motion.md` (Changing text and values; Things that appear, travel and leave; The cursor): a label's icon opens its width and gap together, a list's height carries the rows below (`Collapse reveal="drop"`), the cursor stays where the press happened, a resizing surface moves size, position and content as one transition. For a changing control, a measured `Roll variant="fade"` resizes its label; keep the actions beside it in normal flex flow so they follow, because a transform that only moves the new label can't move its neighbor.

Watch the unchanged neighbor through an insertion and a removal, then the popup's reversal before its first move finishes. Matching endpoint screenshots prove nothing about the frames between.

## UI details (stills)

Thirteen still pairs in `teaching/composition.tsx`, same content on both sides, so the difference is framing and structure, not a prettier story. Each pair's rule lives in `craft.md` or `framing.md`; the pair shows it.

- **Framing:** clear gutters around the useful part; a window may continue past an edge, a cropped title or a status covering a row hides the story (`framing.md`, rules 2, 4 and 10).
- **Anatomy:** headings, values, metadata and actions read as different roles; related rows share columns (`craft.md`, Spacing and alignment).
- **Emphasis:** nested borders, shadows and accents make every subpart compete; quieten the supporting details before adding another container (`craft.md`, Restraint; Color and looks).
- **Compact:** reflow before shrinking; a desktop screen scaled into a small slot passes an overflow check while its text becomes unreadable (`framing.md`, Small formats and the page).
- **Edges:** near-tangents; check corners too (`craft.md`, Spacing and alignment).
- **Nested spacing:** carry the inset round the bottom (`craft.md`, Spacing and alignment).
- **Control alignment:** label and icons on one balanced row; judge the visible glyph, not its SVG box (`craft.md`, Spacing and alignment).
- **Density:** whitespace groups information (`craft.md`, Spacing and alignment).
- **Contrast:** quiet is not faint (`craft.md`, Color and looks).
- **Icons:** one construction, one stroke, one optical size (`craft.md`, Icons and logos).
- **Decoration:** a gradient or glow serves the story or goes (`craft.md`, Color and looks).
- **Task anatomy:** chrome for the task (`craft.md`, Chrome and devices).
- **Unread gutter:** an unread dot never pushes its row in (`kit.md`, Row).

## Whole scenes (stills)

Nine larger pairs in `teaching/scenes.tsx`, each 540 wide with a compact composition down to 280. The ground, the hero and the supporting pieces are judged as one picture.

- **Dashboard and phone:** each device gets a readable role; the phone never covers the amount or state it explains (`craft.md`, Chrome and devices). Compact stacks them and crops the phone's unused lower screen.
- **Window and satellite:** the result sits in the hero's quiet margin; a product's own popup is not a satellite (`framing.md`, rules 16 and 19).
- **Several windows:** choose the active step; supporting windows keep their titles and context while quieter contrast and shadow push them back (`craft.md`, Chrome and devices). Three equally loud surfaces compete even when all of them fit.
- **Colored grounds:** the background frames the product. Choose surface, text and accent against that ground; tinting everything alike removes the separation (`backgrounds.md`).
- **Dark and light materials:** a light document over a dark workspace stays a readable light document (`craft.md`, Color and looks).
- **Action and payoff:** a whole application becomes an unreadable thumbnail. Crop to the useful content at reading size and let chrome run off; the title, action and result stay whole (`framing.md`, Small formats and the page).
- **Result weight:** ask what the eye lands on first. A new file that is one thin row in a long list loses to the list; fewer, larger rows make it the heaviest thing in the frame (`examples/upload`).
- **Crop filler, never the story:** move the window or narrow the column until the last value that matters is whole (`framing.md`, rule 4).
- **One tile leads:** four equal tiles of heading and bars read as a template (`bento.md`, rule 2).

## Style (stills)

The same deploys card in every pair; the good side never changes, and each bad side has one fault. `?example=contrasts`, Style group.

- **Purple slop:** a violet-to-pink gradient ground, gradient text and a tinted card read as generated. The product's own neutrals, one accent on the thing that matters (`craft.md`, Color and looks).
- **Tiny text:** 9 to 10px type shrunk to fit more in reads as a wireframe. 13 to 14px names, 11 to 12px metadata, fewer rows.
- **Over-detailed:** a branch, hash, author, duration and badge on every row makes every row the subject. Real detail on the one row the story is about.
- **Glow:** colored light on the card, button or status is a neon template. One soft neutral shadow.
- **Capitals:** tracked caps on headings, labels and buttons. Sentence case, unless the product itself capitalizes.
- **Invented icons:** glyphs drawn for the demo, in rainbow tiles, filled beside outlined. The product's own set or one pack, one stroke, color only where it carries status; draw an icon only when no pack has it (`craft.md`, Icons and logos).
- **AI shorthand:** sparkles, wands and gradient "AI" chips say nothing about the feature. The product's own mark, or a plain label that says what happens (`craft.md`, Icons and logos).
- **Onion skin:** an icon in a translucent ink paints darker wherever its strokes cross or join. One opaque color; a lighter opaque gray for a quieter icon.

## Making a comparison

Change one thing. Same content, layout, endpoints and input timing; only the behavior being taught differs. No extra cards, status marks or decorative backgrounds competing for attention. Say the exact difference under each side, give the pair a replay, and make it readable at normal speed. If the lesson only shows at slow speed, the pair needs another go. How a bad example is marked on a page is in `craft.md`, A page of demos.

## What a pair can't show

Some faults need the real demo, not a contrived pair:

- **Other text shifts:** the baseline pair reproduces one cause; the others are in `motion.md`, Changing text and values.
- **Story continuity:** does the reset make sense for what the viewer just did? Compare `examples/story/`.
- **Handoff timing:** does the flying object vanish before its destination takes over? Compare `examples/subscriptions/` and inspect the frame where ownership changes.
- **Desktop at phone width:** can you read the important labels? A recognizable silhouette is not readable UI.
- **Motion without hierarchy:** `motion.md`, Story.

A checker can flag a jump and still miss a wrong path, an implausible gesture, a bad story or an unreadable crop. Say what the tools covered and what you watched yourself.

## Details

Six small pairs in `teaching/details.tsx`, `?example=contrasts`, Details group. Four move, two are stills; the scene is the same on both sides but for the one choice.

- **Throw a swipe at the finger's speed:** released, the row carries on at the speed it was moving and the gap closes in one ease. A pause at the hand-over, an ease-in from rest or a gap that snaps shut reads as harsh (`examples/swipe`).
- **Draw a reaction as the app does:** the real emoji in a small pill on the bubble's lower corner, ringed in the ground, scaling in from that corner. Never a drawn glyph in a disc over the words.
- **Draw a chart on from its start:** the line draws left to right, the area follows under it, the end dot lands when the line reaches it. Faded in whole, the trend is never seen (`examples/chart-scrub` for hover).
- **Balance a top bar:** one control and an empty side reads as unfinished. Put what the product puts there, or drop the bar.
- **Choose copy that fits:** unless the brief fixes them, pick names, emails and values whose length suits the layout: no truncated chips, wrapped names or ragged labels.
- **Pin a changing label to its icon:** in a fixed-width control the label sits against its chevron and grows away from it, so the gap never changes.

---

## Appendix: verify.md

# Verify

The last pass. Every answer comes from a frame you looked at, never from the code. Fix the largest visible failure first, re-shoot, return to the top, iterate until every answer is yes. The rules are in `framing.md`, `craft.md` and `motion.md`.

## Gate

- `film.mjs <url> --gate` on the wide loop ends `rehearsal passed`? (For a still, `--still --gate`.)
- The same at `--width 390`, and at the brief's own width when it names one?
- `--states --gate`: one sheet of the opening, every mark settled and the end, with nothing you would send back?

## Framing (first, because nothing else matters if this is wrong)

- One gutter, and the window or phone bleeds off at least one edge, or sits whole because the brief wants it?
- Is anything cut by the crop that has words on it, or that the eye needs whole?
- Is the ground the page the brief named, no plate behind the device on a white or dark page?
- Is any corner of the stage empty for no reason?
- Panes full: no void under a list (`empty pane:`), rows at their own pitch (`loose list:`)?
- Phone: nothing under the island, a sheet below the status bar, a cropped phone losing status bar and nav together?

## Hierarchy and density

- The closest gold's still beside yours: say the one difference. Is yours the sparser, flatter or smaller one, and why?
- Still: is the subject real words and values, with bars only beside it and on what the crop cuts?
- Label and value both words or both bars?
- Named avatars colored, gray discs only for filler?
- At realistic fidelity, does a list of six or more rows have at most as many placeholders as real rows?
- The heaviest mark sits on what the story is about?
- A date range: air between weeks, fading where the range continues, capped only on real start and end days?
- Bento: every tile a specific moment with its words on it; no tile that is a title over bars; stat and unit on one line?

## Motion (animated scenes)

- Each beat filmed at 40 to 80ms with `--at` and looked at: presses, morphs, hand-offs, exits, the seam?
- Nothing appears without an entrance or leaves without an exit, except `Bubble` and `Fly` with a visible hand-off?
- A swipe lands, presses, flicks a third of the screen, lifts still moving, and the page carries on as one motion?
- A reaction grows from the bubble's corner with the room opening on the same clock?
- A terminal's marks are glyphs in the grid, each line owning its own, swapped in place?
- Rolling numbers roll in the right direction and settle once?
- The loop ends where it began, or resets with a visible cause?

## Polish (last)

- Zoom every hand-drawn thing at 4x: would a stranger know what it is, and is any stroke clipped by its box?
- No translucent icon, no onion skin, no hand-drawn mark where the kit has one?
- Spacing even: words 12px from edges, stacks 4 to 6px of ink apart, dots 6px clear?
- Type: nothing under 10px on the phone, nothing wrapping that shouldn't?

## What you see, what you do

| You see | You do |
|---|---|
| A void under a list or pane (`empty pane:`) | More product into it until it runs off the crop, or crop the pane; never spread the rows |
| A one-line row three times taller than its words (`fat row:`) | Padding 12px (8px dense) and more rows; never air inside the row |
| Rows spaced wider than they are tall (`loose list:`) | Tighten the pitch to the row's padding; add rows |
| A whole window floating with even margins on a hero | Bleed it off two edges with one gutter, or fill it |
| Gray bars where the eye lands | Words there; bars beside it and off the crop stay |
| A label beside a real value drawn as a bar | Both words, or drop the row |
| A stat's unit on its own line (`unit wrapped:`) | Nowrap the pair, size the number to the tile, or move the unit to the lead |
| A phone drawn small, or whole, in a narrow host | Crop it: a gutter from one edge, off the other, screen 1:1 |
| A grabber or sheet under the island | Start the sheet below the status bar |
| A popover that shifts while open (`anchor drift:`) | Pin it by the edge it opened from; reserve the height |
| An emoji where an icon belongs (`emoji icon:`) | A drawn glyph from one family; emoji stay in messages and reactions |
| An icon cut by its box (`clipped glyph:`) | Fit the drawing in its viewBox, or use the kit's glyph |
| A reaction, dot or mark on the words | Move it to the edge or gutter the kit gives it |
| A gate line you think is intentional | Look again; if it still looks fine, say so in REHEARSAL.md with the frame; never clear it by hiding the thing |
| Ten film runs, gate green, frame unchanged | Stop. Fresh eye |

## Hand over

- `REHEARSAL.md` written beside the component? A template:

```md
# Rehearsal: <demo>
Gold: <example> (what you kept, what you changed)
Beats: 1 … 2 … 3 … payoff, loop <n>s
Captured: widths <wide, 390>, looks, states, reduced motion
Gate: <the last line of film.mjs --gate on the loop, pasted>
Film: <each gate line> → <frame> → <fix or why it stands>
Review: <reviewer's list> → <your response>
Assumptions:
Unresolved:
Not checked:
```
- Did you say what you did not watch?
