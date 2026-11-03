## Faux product UI (Stageshow) — mandatory

These rules are required whenever the deliverable is an illustration of a product rather than the product itself: a fake or mocked UI, a hero or feature-card demo, a bento tile, a cursor walkthrough, a product shot for a marketing or docs page, or a still or looping animation of an app, phone, terminal or dashboard. They do not apply to building the real interface; the rest of this skill governs that.

Adapted from [Stageshow](https://benji.org/stageshow) by Benji Taylor (MIT).

### Use the Stageshow kit

The full Stageshow skill ships a React kit (stage, windows, phones, cursor, motion parts), gold examples and filming scripts that cannot be embedded here. For any faux UI build, install it into the user's project yourself with `npx -y skills@latest add benjitaylor/skills --skill stageshow -a universal -y`, load `stageshow` with the `skill` tool, and start from its closest gold example. Do not ask the user to run the install. If it fails (offline, blocked registry), say so once and apply the rules below by hand.

### How this fits with the rest of this skill

- **Depicted UI feedback stays real.** A press, menu, tooltip or toggle inside the demo follows this skill: under 300ms, ease-out custom curves, `scale(0.97)` on press, never from `scale(0)`. Only storytelling motion (travel, arrivals, camera, holds) runs slower; that is the "Marketing/explanatory" row of the duration table.
- **Stagger** stays 40-80ms between items in a scene, inside this skill's 30-80ms band. Tiles of a grid are the one exception: 80-120ms apart.
- **Reduced motion** shows the demo's poster frame: a complete still that tells the story with the result on screen. Movement is dropped, not the payoff.
- **Frequency rule.** A demo loop is decorative and rarely seen; it never blocks interaction and never reacts to the page's keyboard input.
- **Review output** still uses the Before/After/Why table from Review Format.

### The one idea

**It reads as a real product, simplified to what the viewer needs, framed with intent, and every motion has a cause.**

Five ways it fails:

- **Too much.** Real text in every row, numbers everywhere, everything packed. The more detail, the more it looks generated.
- **Wireframe.** Two gray blobs and a button: built too small, or stripped of what made it recognizable.
- **Boxed.** A whole window shrunk into a card with even margins, like a pasted screenshot.
- **Flat.** Every object the same weight in the same bordered card; the eye has nowhere to land.
- **Bland.** A gray window with a cursor whatever the brief said. The brief's look and energy are the point.

The fix: a full, structured screen in quiet grays, real words only where the story is (usually 3 to 7 strings), placeholder lines for the rest, room to breathe, and a crop that puts the eye on the story. Simplify the words, not the context.

### Workflow (decide before writing code)

1. **Medium and place.** Still or animation (loop, once in view, hover); where it sits and at what size. Design at the shown size (about 720 × 340 beside copy, 900-1100 wide full-width, 400 × 300 for a card) and ship a redesigned compact version for a 358px phone column.
2. **Look.** Map the product's real tokens, icons and chrome. Otherwise pick a theme (light, dark, blueprint, glass), a palette (accent or mono) and a fidelity (minimal, standard, realistic). A brief with a style gets that style in full.
3. **Story.** Three to five beats and a payoff, 10 to 16 seconds. No cursor move you cannot explain. Data never rewinds in view without a cause. Between a richer story and a calmer frame, choose the frame.
4. **Start from the closest example** and decide the crop before building, so nothing past the crop gets built.
5. **Screen.** Spend the word budget on the story; mark what the cursor touches and measure positions, never hard-code them.
6. **Choreograph.** Keep elements mounted so exits animate. Animate the relationship, not just the object: a new row carries the rows below it. Beats overlap, groups stagger, the payoff holds, and the loop ends where it began or resets with a visible cause.
7. **Rehearse.** Set the poster frame first. Film the whole loop at the shown width and at 390, step through every press, menu, morph and the loop seam, fix the largest fault first (framing, then hierarchy, then motion, then polish), and compare against the closest gold example.

### Framing

- One hero object, at most one or two satellites of different kinds. A satellite straddles the hero's edge about half outside and covers chrome, not content.
- Crop only filler. The payoff, the action, cursor targets and every real word stay whole. Crop 10-40% of the hero off stage; it fills at least two thirds of the stage width and runs off an edge.
- The stage masks everything. One gutter, measured in the final crop, on every edge: a full gutter or well past it, never just short.
- No plate behind a hero on a white or dark page, no window floating with air on four sides, no dead corners at any point in the loop.
- Real chrome only: no address bar on a native Mac app, no hand-drawn status bar or home indicator. Windows keep their device's shape.
- Start flat and frontal. Depth comes from shadow, z-order and scale; a tilt must be earned against the straight version.

### Motion and the cursor

- Story motion uses two curves: travel `cubic-bezier(0.45, 0, 0.1, 1)`, arrival from nowhere `cubic-bezier(0.25, 0.8, 0.25, 1)` over 0.8-1s. Travel has a departure, clear travel and a soft arrival.
- Content moves instead of swapping; numbers roll only the digits that changed. Holding a result means stopping, with no new pulse.
- The cursor moves like a hand: shallow arcs timed by distance, presses you can see. It never covers the words it clicks, changes kind (I-beam, hand) by morphing as it crosses into an element, and every move travels to the next action. Use one cursor style per site; with no cursor, never walk a focus ring as a stand-in.
- On phones, use touch, not the macOS arrow, and act where people do: tap the notification, then act in the app.
- The camera needs a reason: push in only when the payoff is too small to read, once per story, in and back out.

### Check before handing over

- Content that swaps instead of moving.
- Gray placeholder bars where the eye lands; filler belongs at the edges.
- A plate behind the window, or a window floating with air on four sides.
- Empty bands, cut controls or cut shadows.
- Stock AI marks and made-up logos: sparkles, purple, a letter in a colored square.
- Busy rows and uneven insets.
- Long holds, or a reset with no cause.
- A text selection that is not under the I-beam.
- A hand-drawn status bar or home indicator.
- A centered amount centered together with its sign.
