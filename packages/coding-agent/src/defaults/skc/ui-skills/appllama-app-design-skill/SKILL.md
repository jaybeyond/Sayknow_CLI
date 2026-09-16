---
name: appllama-app-design-skill
description: Build native-feeling, benchmark-quality mobile app screens (Expo / React Native). Use when designing or implementing any mobile UI — screens, flows, onboarding, paywalls, tab bars, sheets, settings, empty states — or when polishing motion, navigation, typography, dark mode, or perceived performance. Enforces Apple HIG fidelity, semantic colors, native controls, anti-slop discipline, navigation semantics (push vs replace, modal vs sheet vs overlay, the one-way doors where back must not exist), purposeful Reanimated motion, a full-motion simulator-verified iteration loop, and a study-real-apps-first workflow (pairs with the Appllama MCP). Trigger on "build a screen", "make this screen better", "design the onboarding", "wire up this flow", "polish the UI", "make it feel native", or any mobile design/implementation task.
license: MIT
metadata:
  author: Appllama (appllama.io)
  version: 1.3.0
---

# Appllama App Design Skill

## SKC invocation

SKC loads this skill automatically for matching frontend UI/UX work.
Do not wait for a follow-up question. Apply the craft rules immediately
and keep going on the user's actual task.

This skill's companion reference files are appended inline at the end of
this document. Read them there; they are not separate files on disk.


You are building screens that will sit on a phone next to the best-designed apps
in the world. The user will compare your output to those apps within seconds of
launching it. This skill defines the bar and the method for clearing it.

## The Prime Directive: study before you draw

Never design a screen from imagination when you can study how top apps solved
the same screen. Real, shipping, revenue-ranked apps encode thousands of hours
of design iteration and A/B testing. Your first move on any screen is research:

1. If the **Appllama MCP** is connected, pull real screens for the category and
   screen type you are building (see the `appllama-usage` skill for the exact
   research playbooks). Study 20–30 screens before writing a line of UI code.
2. Extract the **pattern, not the pixels**: layout skeleton, information
   hierarchy, control choices, spacing rhythm, where the primary CTA sits, what
   gets an illustration vs. plain text, how progress is communicated.
   Note: every Appllama image and video carries a small Appllama watermark in
   the top-left corner. It is provenance, not design — ignore it when reading
   a screen (it may sit over the status bar or a back button) and never
   reproduce it in anything you build.
3. Then design **your** screen: same proven skeleton, your product's voice.
   Copying a competitor's screen 1:1 is both lazy and legally risky; shipping a
   screen that ignores every convention users already know is worse.

## Platform baseline

Default stack assumptions (override only if the project already differs):

- **Expo + Expo Router**, React Native, TypeScript.
- `react-native-reanimated` for motion, `react-native-gesture-handler` for
  gestures, `@shopify/flash-list` (or FlashList v2) for any list that can grow.
- `expo-image` for images (and SF Symbols via `source="sf:name"` on iOS),
  `expo-video` / `expo-audio` (never the deprecated `expo-av`).
- `react-native-safe-area-context` for insets. Never hard-code notch numbers.
- `process.env.EXPO_OS` over `Platform.OS` for compile-time platform checks.

## Native fidelity laws

These are the details that separate "web page in a wrapper" from "native app".
Violating any of them is a finding, not a style preference.

1. **Semantic colors, both themes, day one.** Use system/semantic color tokens
   (e.g. `Color` from `expo-router` on iOS: `Color.ios.label`,
   `Color.ios.secondarySystemBackground`; Material dynamic colors on Android).
   Every screen must render correctly in light AND dark before it is "done".
   Never pass semantic color objects into Reanimated animated styles — resolve
   to strings first.
2. **Native controls over rebuilt ones.** Switch, Slider, SegmentedControl,
   context menus, date pickers: use the native control or a faithful wrapper.
   A rebuilt toggle that animates 50 ms differently than iOS's reads as fake
   instantly.
3. **SF Symbols / Material Symbols for iconography.** On iOS prefer SF Symbols
   (`expo-image` with `sf:` sources, or `expo-symbols`); they inherit weight,
   optical size, and Dynamic Type behavior. Do not mix three icon families on
   one screen.
4. **Typography is hierarchy.** Use the platform type ramp (Large Title / Title
   / Headline / Body / Footnote on iOS). One display size per screen. Tabular
   numerals (`fontVariant: ['tabular-nums']`) for anything that counts, times,
   or prices. `Text selectable` on data users may want to copy.
5. **Continuous corners.** `borderCurve: 'continuous'` on every rounded
   rectangle. Squircles are the single cheapest "feels iOS" win that exists.
6. **Shadows via CSS `boxShadow`**, not legacy `shadow*`/`elevation` props.
   Shadows are for elevation logic, not decoration — one elevation system per
   app.
7. **Spacing rhythm.** Pick a base unit (4 or 8) and never leave it. Prefer
   flexbox `gap` over margin stacking. ScrollView padding goes in
   `contentContainerStyle`, never on the ScrollView itself.
8. **Safe areas and the Dynamic Island are part of the design.** Screens must
   be verified with content scrolled under the island / status bar (does the
   blur/fade treatment hold?), with the home indicator (does the bottom CTA
   clear it?), and in landscape if supported.
9. **Navigation titles belong to the navigator.** Use the stack's native title
   (and large-title collapse behavior on iOS) rather than a hand-rolled header
   whenever possible.
10. **Haptics are punctuation.** Selection tick when a value passes a step,
    light impact when something snaps home, notification success/error for
    outcomes — on the same frame as the visual, one per user action, never
    the only feedback. Never on scroll, never in loops.
11. **Format numbers like a product, not a database**: 1.4M, 38k, $4.99. Trim
    trailing zeros. Localize dates.
12. **Root scroll behavior**: screens that can ever overflow wrap content in a
    ScrollView (first component in the route) with
    `contentInsetAdjustmentBehavior="automatic"`. Use `useWindowDimensions`,
    never `Dimensions.get()`.

## Navigation laws

Navigation is the part of a screen a screenshot can't show, and users feel
it in ten seconds. Every transition answers three questions: what is the
destination to here, must the user be able to come back, and what does back
(chevron, iOS edge swipe, Android hardware back) do afterwards.

1. **Push goes deeper, replace moves on.** `router.push` when the user will
   want to return here; `router.replace` / `<Redirect>` when coming back
   would land in a state the world has moved past; `router.dismissTo(href)`
   for "finish this flow and land on X". Back undoes *navigation*, never
   *events*.
2. **Presentation is meaning.** A self-contained task with steps →
   `presentation: 'modal'` with its own stack and its own Cancel/Done; a
   short interruption (picker, filters, item options) → `formSheet` with
   detents, drag-to-dismiss; immersive content → `fullScreenModal` with an
   explicit Close; something floating over a still-visible screen (confirm
   card, lightbox, coach mark) → `transparentModal` overlay; destructive
   confirms → action sheet; item actions → native context menu; share /
   web / photo picking → the system controller, never a rebuilt route. A
   sheet that grows a second step was a modal all along; if a link could
   open it, it is a route, not a `useState` sheet.
3. **One-way doors leave the stack.** Sign-in on a wall app, finished
   onboarding (Skip included), a purchase, a completed session: guard with
   `Stack.Protected` and land with `replace`, so back can never re-enter
   the old state — Android back from home exits the app, never shows
   Login; a paid paywall never re-opens. But keep the user's *place*:
   sign-in demanded by one action (save, follow, buy) is a modal over the
   screen that completes the action where it was tapped, and a paywall
   opened from a feature dismisses back onto the feature, unlocked — never
   `replace('/(tabs)')` from there.
4. **Back is blocked in exactly two cases** — an irreversible request in
   flight (seconds, with visible progress) and unsaved work in a modal
   (ask first), both via `usePreventRemove` on the modal's root screen.
   Transient in-screen state (selection mode, an expanded search, an open
   in-screen sheet) consumes the first back, then back leaves. Anything
   else that traps back — a funnel, a rating prompt — is a defect; the
   edge swipe works everywhere else.
5. **Tabs are peers.** No slide between tabs, each tab keeps its own stack,
   re-tapping the active tab pops to its root; full-attention screens
   (composer, player, checkout) live in the root stack *above* the tabs.
   Deep links land with a real stack underneath (`initialRouteName` /
   `withAnchor`); cold start lands by state, splash held until session
   state has resolved — never a Login flash before Home.
6. **Study the grammar, not just the pixels.** Walking a winning flow on
   Appllama, note what each step *is* — push, modal, sheet — and copy that
   consistency.

## Anti-slop laws

AI-built apps share a look, and users file it under "template" within seconds.
Each of these is a *default ban* — there is always an override when the brand
explicitly asks for the thing AND you can articulate why it fits this product.

1. **No AI-default styling.** Purple/indigo gradient CTAs with a glow,
   glassmorphism on every card, mesh-gradient heroes, confetti for minor
   events, sparkles in headings — that is the model's house style, not
   design. Your palette, materials, and layout come from the reference
   screens you studied, never from the priors you'd reach for unprompted.
2. **One accent, locked.** Pick one accent color and it is THE accent on
   every screen — no blue CTA on one screen and teal on the next, no new hue
   appearing in screen seven. Neutrals carry the app; the accent is spent
   where the money is (primary action, active state, progress).
3. **One grey family.** Warm greys or cool greys — never both in one app.
4. **Shape lock.** One corner-radius scale, stated as a rule ("actions are
   pills, cards 16, inputs 8") and never violated. Mixed radii without a
   stated rule read as assembled-from-parts.
5. **No emoji as iconography.** Icons are SF Symbols / Material Symbols
   (fidelity law 3). Emoji appear only when the product's voice is genuinely
   chat-native or playful — sparingly, in content, never in chrome.
6. **One label per intent.** "Get started", "Start now", and "Begin" are the
   same intent — pick one phrasing and use it everywhere it appears.
7. **Emphasis stays in the family.** Emphasize a word with weight or italic
   of the same typeface; injecting a serif word into a sans headline (or vice
   versa) for visual interest is amateur.
8. **Ship full state cycles, not the happy path.** Static-successful-state-
   only is the default failure mode: skeletons must match the final layout's
   shape, empty states are composed (and say how to fill them), errors are
   inline and specific.
9. **The slop pre-flight is mechanical.** Before any flow reaches the
   simulator pass, count: distinct accent hues (must be 1), distinct corner
   radii (all from the stated scale), emoji in UI chrome (0), gradients
   without a brand reason (0), duplicate labels for one intent (0). A failed
   count is a fix, not a judgment call.

## Motion laws

Motion is the highest-leverage polish surface and the easiest to overdo.
Decide in this order:

- **The frequency gate comes first.** Met 100+ times a day (tab switch,
  keyboard, scroll, back) → the platform default and nothing else; tens a
  day (press, row select) → near-imperceptible, under 150 ms; occasional
  (sheets, modals, toasts) → standard motion; delight only on rare,
  first-time moments. Tabs never slide; screen transitions stay native.
  Passing this gate with zero lines of code is a success — when unsure,
  the strongest move is to delete the animation.
- **Name the purpose in one word** — feedback, spatial continuity, state
  change, preventing a jarring cut, explanation, delight — or don't build
  it. Data the user is reading never moves for style.
- **If a finger was involved, it's a spring.** Start from the live value
  (capture it on grab), hand the release velocity into the spring, pick
  the target from projected momentum so a flick commits, rubber-band past
  boundaries, stay grabbable mid-flight. One vocabulary per app —
  `{ duration: 400, dampingRatio: 1 }` to settle, `{ 300, 0.8 }` for
  sheets — and bounce only when the gesture carried momentum.
- **Everything else is timing, under 300 ms, strong ease-out**
  (`Easing.bezier(0.23, 1, 0.32, 1)` — built-in curves are too weak; never
  ease-in on an entrance). Press feedback lands on press-*in*, 100–150 ms:
  scale 0.97 on buttons and cards, a background highlight (never scale) on
  list rows, opacity on bar buttons. Exits are faster than entrances and
  leave the way they came in; enter from `scale(0.95)` + fade, never
  `scale(0)`; menus grow from their trigger (centered modals exempt).
- **Gesture → animation never hops the JS thread.** Worklets + shared
  values (`.get()`/`.set()`; `scheduleOnRN` — Reanimated 4's `runOnJS` —
  only at gesture end), `transform`/`opacity` only, no `entering` on
  recycled list rows, never animate a header's height (translate inside a
  fixed clip), keyboard-tracking UI via `react-native-keyboard-controller`
  — never a keyboard listener plus a guessed duration.
- **Respect Reduce Motion**: your spatial motion collapses to cross-fades;
  native transitions stay the system's.
- The bar: 60 fps through the hero flow, measured on a **release build on
  the slowest device you support** — Expo Go and dev builds hide exactly
  the jank you're hunting
  ([references/performance.md](#appendix-performance-md)). Watch the
  recording once for feel, once frame by frame, and again next day with
  fresh eyes.

## State architecture

Screens that feel great are screens whose state is boring:

- **Server state** in TanStack Query (or the project's equivalent): caching,
  retries, optimistic updates. Never `useEffect`+`fetch`.
- **Client state** in a small atomic store (Zustand/Jotai). Broad "app state"
  contexts cause the re-render cascades that make UIs feel heavy.
- **Ephemeral UI state** (open/closed, focus, scroll) stays local to the
  component.
- **Optimistic by default**: taps reflect instantly, reconcile in the
  background, roll back loudly on failure.
- Uncontrolled `TextInput`s for high-frequency typing surfaces; controlled
  inputs are a top-3 cause of typing jank.
- Persist tiny client state in MMKV, not AsyncStorage, when latency shows.

## Perceived performance

- Skeletons only for content whose shape you know; otherwise progressive
  reveal. Never a full-screen spinner for a partial update.
- FlashList for every list; give stable keys.
- Preload the next screen's data on press-in, not on navigation-complete.
- Images: right-size sources, `expo-image` with `recyclingKey` in lists,
  thumbhash/blurhash placeholders.
- Cold-start TTI and bundle discipline live in
  [references/performance.md](#appendix-performance-md) — apply the
  measure → optimize → re-measure loop, never blind memoization.

## Image & illustration assets

When a screen calls for illustration, empty-state art, hero imagery, or icons
beyond the symbol set:

- Generate assets with the **best image model available to you** (e.g. an
  imagegen tool or the Higgsfield MCP/CLI if connected) at the **highest
  quality settings**, then downscale to @1x/@2x/@3x. Never upscale.
- One visual language per app: pick a style (gradient-mesh, flat-duotone,
  3D-clay, hand-drawn, mascot style) and generate ALL assets in that same style, same
  palette, same lighting. A mixed-style asset set reads as template slop.
- Prompt for **transparent or solid-flat backgrounds** matched to your surface
  color; composite artifacts (white halos, wrong-color mattes) are an
  automatic redo.
- Full asset pipeline and prompt patterns:
  [references/image-assets.md](#appendix-image-assets-md).

## The simulator loop (non-negotiable)

A screen does not exist until you have seen it running. The loop:

1. Implement → launch in the iOS Simulator (or Android emulator).
2. Screenshot and **actually look**: alignment, optical centering, spacing
   rhythm, truncation with long content, dark mode, Dynamic Type at XL.
3. Run the **full-motion pass** below — screenshots prove layout; they prove
   nothing about motion.
4. Fix, relaunch, re-verify. Repeat until you cannot find a defect — then run
   the checklist in [references/simulator-loop.md](#appendix-simulator-loop-md)
   once more.

Do not declare a screen finished from code review alone. Do not stop at "looks
fine" — stop at "cannot find a flaw at 100% zoom".

### The full-motion pass (mandatory, per flow)

Every flow is evaluated as **moving pictures in the simulator, never as
stills**. Screen-record the entire flow end to end
(`xcrun simctl io booted recordVideo flow.mov`), exercising ALL of it:

- every screen transition, push/pop, tab switch
- every back path — chevron, edge swipe, Android hardware back — and, after
  each one-way door (sign-in, onboarding done, purchase, finished session),
  an attempt to go back that must fail to re-enter the old state
- every modal and sheet: present, drag, dismiss — and cancel mid-drag
- the keyboard, both directions: appear (does the layout glide, is the
  focused input visible?) and dismiss (does anything jump-cut?)
- every user interaction: press states, gesture follow-through, interrupted
  gestures, rapid taps, scroll flings at the extremes

Watch the recording **twice**: once at full speed for feel, once scrubbing
frame by frame. You are hunting:

- dropped or stuttered frames — the bar is a sustained **60 fps** through
  every transition, measured, not vibed
- one-frame flashes: white/unstyled first paint, wrong-theme frames mid-
  transition, color pops where a surface briefly renders the wrong token
- layout jumps, double-render pops, springs that clip or overshoot into
  content, elements that reflow after appearing

The whole recording must play like one native piece — smooth end to end,
zero UX glitches. One glitchy frame means the flow is not done.

## Definition of done, per screen

- [ ] Studied 10+ real reference screens for this screen type (via Appllama
      MCP when available) and can name the pattern you adopted
- [ ] Navigation answered: what this screen *is* (push / modal / sheet /
      overlay / replace), what back does from it on iOS and Android, and —
      behind a one-way door — that back cannot re-enter the old state
- [ ] Light + dark mode verified in the simulator
- [ ] Safe areas / Dynamic Island / home indicator verified
- [ ] Long-content, empty, loading, and error states designed — not defaulted
- [ ] Motion: the full flow screen-recorded and scrubbed — entrances,
      presses, transitions, modals, keyboard — native feel, zero glitch or
      wrong-color frames; Reduce Motion respected; 60 fps measured on a
      release build on the slowest supported device
- [ ] Dynamic Type XL doesn't break layout; text is selectable where useful
- [ ] All tap targets ≥ 44pt; contrast passes in both themes
- [ ] Assets: single style family, crisp at @3x, no compositing halos
- [ ] List surfaces virtualized; no controlled-input jank; no re-render storms
      (profiled, not guessed)

## References

| File | Load when |
|---|---|
| [references/native-controls.md](#appendix-native-controls-md) | Choosing/wiring iOS+Android native controls, menus, pickers, sheets |
| [references/motion.md](#appendix-motion-md) | Any Reanimated work: gestures, transitions, springs, layout animations |
| [references/performance.md](#appendix-performance-md) | Jank, slow TTI, big bundles, memory leaks, profiling method |
| [references/image-assets.md](#appendix-image-assets-md) | Generating illustrations/icons/hero art with image models |
| [references/simulator-loop.md](#appendix-simulator-loop-md) | Final verification checklist + device matrix |

---

## Appendix: image-assets.md

# Image & illustration assets — generation pipeline

App-quality artwork is generated, curated, and post-processed — never "one
prompt, ship it". This is the pipeline.

## 1. Define the style system BEFORE generating anything

Write down, once per app:

- **Style family**: flat-duotone / gradient-mesh / 3D-clay / paper-collage /
  hand-drawn-ink / photographic. Pick ONE.
- **Palette**: 3–5 hexes lifted from the app's design tokens, including the
  exact surface color assets will sit on.
- **Lighting/texture**: soft top-left studio light, matte, no specular — or
  whatever fits; but the same words in every prompt.
- **Subject grammar**: mascot? abstract shapes? objects? People (and if so,
  what rendering style)?

Every asset prompt = style system + subject. This is what makes 12 assets
read as one commissioned set instead of 12 stock images.

## 2. Generate with the best tool available

Use whatever image generation capability is present in your environment — an
imagegen tool, the Higgsfield MCP/CLI, or another state-of-the-art model.
Rules:

- **Highest quality settings, largest size**, then downscale. Target at least
  2× the largest rendered size (an asset shown at 200 pt needs ≥ 1200 px for
  @3x). Never upscale a small generation.
- Generate **3–4 candidates** per asset, pick the best, regenerate the rest of
  the set to match the winner if the winner drifted in style.
- For icon sets and repeated elements, generate a **sheet** in one prompt
  (same lighting/palette guaranteed), then slice.
- Backgrounds: ask for the exact surface hex as a solid background, or true
  transparency if the tool supports it. Inspect edges at 400% — halos, matte
  fringes, or JPEG blocking around the subject mean regenerate or run a
  background-removal pass.

## 3. Prompt patterns that work

```
[subject], [style family] illustration, [palette words + hexes],
[lighting], solid background #0F0F13, centered composition,
generous negative space, app illustration, no text, no watermark
```

- Always append `no text` — models love baking in gibberish labels.
- For empty states: subject should be *quiet* (a resting object, a soft
  scene), not a busy hero.
- For celebration/success: motion implied by composition (confetti arcs,
  tilt), not literal speed lines.
- For onboarding heroes: leave the upper or lower third empty for the
  headline; say so in the prompt ("composition weighted to bottom half").

## 4. Post-process

1. Trim to content + consistent padding.
2. Export @1x/@2x/@3x PNG (or a single high-res + let expo-image scale, for
   full-bleed art). WebP for large photographic assets.
3. Verify on-device in BOTH themes: an asset generated on a dark ground often
   shows a halo on light ground. If the app is dual-theme, either generate
   theme twins or use assets on theme-invariant surfaces.
4. Check file sizes: a decorative illustration should not cost 2 MB. Target
   < 200 KB per screen-level asset after compression.

## 5. App icon & store assets

- App icon: generate at 1024×1024, no transparency, no rounded corners (the
  OS masks it). Test it at 60 px — if the concept dies small, simplify.
- Screenshot frames/marketing come later; do not let store-asset style drift
  from in-app style.

## 6. Quality gate

Reject an asset if ANY of:
- Style drifts from the set (different lighting, palette, line weight)
- Halo/fringe on its background at 400% zoom
- Baked-in text or watermark artifacts
- Composition fights the layout (subject cropped by safe areas, focal point
  under a button)
- Looks like clip-art / default-model-style with no art direction

---

## Appendix: motion.md

# Motion — Reanimated patterns that read as native

Motion quality is judged in the first 10 seconds of using an app. This file is
the working reference for gesture-driven and system-driven animation.

## The two families of motion

| Family | Driver | Curve | Examples |
|---|---|---|---|
| **Responsive** (user is touching it) | Gesture position/velocity | Spring, seeded with gesture velocity | Sheet drag, swipe-to-dismiss, pull-to-refresh, card pan |
| **Narrative** (system initiated) | Time | `withTiming`, ease-out, 150–350 ms | Screen entrances, fades, reveals, toasts |

Mixing them up is the #1 tell of non-native motion: a sheet that closes on a
fixed 300 ms timing after a fling feels dead; a button that springs for 800 ms
on tap feels like a toy.

## Springs

```ts
// The designer form (duration is perceptual): critically damped, no oscillation
const SNAP = { duration: 400, dampingRatio: 1 };
// Playful: one soft overshoot — use sparingly (celebrations, mascots)
const POP = { duration: 400, dampingRatio: 0.8 };

offset.set(withSpring(dest, { ...SNAP, velocity: event.velocityY }));
```

- Always pass the **gesture velocity** into the spring when a gesture releases.
- One spring vocabulary per app. Define `SNAP`/`POP` once, import everywhere.

## Gesture → animation, all on the UI thread

```ts
const pan = Gesture.Pan()
  .onChange((e) => { offset.set(offset.get() + e.changeY); })   // worklet
  .onEnd((e) => {
    const dismiss = offset.get() > H * 0.3 || e.velocityY > 800;
    offset.set(withSpring(dismiss ? H : 0, { ...SNAP, velocity: e.velocityY }));
    if (dismiss) scheduleOnRN(onClose);   // react-native-worklets; replaces the deprecated runOnJS
  });
```

Rules:
- Never read/write React state inside `onChange`. `scheduleOnRN` only at
  gesture end, for navigation/effects — and read/write shared values with
  `.get()`/`.set()`, never during render.
- Thresholds combine **distance OR velocity** — a fast flick from 10 px away
  must dismiss.
- Interruptible: starting a new gesture mid-spring must grab the current
  animated value, not the destination.

## Entrances, exits, layout

```tsx
<Animated.View
  entering={FadeInDown.duration(220).springify().damping(30)}
  exiting={FadeOut.duration(150)}
  layout={LinearTransition.springify().damping(30)}
/>
```

- Stagger list entrances by index (`delay(index * 40)`), cap the stagger at
  ~8 items — beyond that, enter as a block.
- Exits are always faster than entrances (~0.7×).
- `layout` transitions on containers whose children reorder/resize — this is
  what makes filter chips, expanding cards, and reordering lists feel expensive.

## Shared-element feel without shared elements

True shared-element transitions are still niche; fake the continuity:
- Keep the tapped thumbnail's position stable while the detail screen fades in
  over it (measure with `measure()` in a worklet).
- Match corner radius and aspect ratio between the origin card and the
  destination hero so the eye reads them as the same object.

## Scroll-linked effects

```ts
const y = useScrollViewOffset(scrollRef);
const headerStyle = useAnimatedStyle(() => ({
  opacity: interpolate(y.value, [0, 64], [0, 1], Extrapolation.CLAMP),
  transform: [{ translateY: interpolate(y.value, [-100, 0], [-50, 0], Extrapolation.CLAMP) }],
}));
```

Standard native behaviors worth reproducing exactly:
- Large title collapses into the nav bar between ~0 and ~52 pt of scroll.
- Content scrolling under a translucent bar gets a fade/blur mask, not a hard
  clip.
- Overscroll stretch on hero images (`interpolate` negative offsets into scale).

## Reduce Motion

```ts
const reduceMotion = useReducedMotion(); // react-native-reanimated
// spatial → opacity-only
entering={reduceMotion ? FadeIn.duration(150) : SlideInDown.springify()}
```

Every spatial animation needs its cross-fade fallback. This is an accessibility
requirement, not a nice-to-have.

## Performance guardrails

- Animate only `transform` and `opacity` where possible; animating layout
  props (width/height/padding) forces layout every frame.
- One `useAnimatedStyle` per animated node; don't share a giant style across
  20 list items.
- Never allocate inside a worklet's hot path (no `.map`, no object spread per
  frame).
- If a transition stutters: profile first (see performance.md) — the usual
  culprits are a JS-thread stall from a heavy render committed mid-animation,
  or an image decode on the UI thread.

---

## Appendix: native-controls.md

# Native controls — use the platform's, wire them right

A native-feeling app is mostly assembled from controls the OS already ships.
Rebuild a control only when the design genuinely diverges — and then match the
platform's timing and haptics so it still reads as native.

## Control selection table

| Need | iOS | Android | Package |
|---|---|---|---|
| Toggle | Switch | Material Switch | `react-native` `Switch` (renders native on both) |
| Single choice, 2–5 options | Segmented control | Tabs / segmented buttons | `@react-native-segmented-control/segmented-control` |
| Value in a range | Slider | Material Slider | `@react-native-community/slider` |
| Date / time | Wheel or inline calendar | Material pickers | `@react-native-community/datetimepicker` (`display="inline"` for calendars on iOS) |
| Contextual actions | Context menu (long-press/tap) | Popup menu | `zeego` (native menus on both) — never a JS dropdown for item actions |
| Destructive confirm | Action sheet | Bottom sheet / dialog | `ActionSheetIOS` via `@expo/react-native-action-sheet` |
| Bottom sheet content | Detented sheet | Bottom sheet | `@gorhom/bottom-sheet` (see notes) |
| Search | Nav-bar integrated search | SearchView | Expo Router `headerSearchBarOptions` |
| Pull to refresh | UIRefreshControl | SwipeRefreshLayout | `RefreshControl` on the ScrollView/list |
| Haptics | UIImpactFeedbackGenerator | Vibrator | `expo-haptics` |
| In-app browser | SFSafariViewController | Custom Tabs | `expo-web-browser` |

## Menus (zeego / native context menus)

Item-level actions (rename, share, delete) belong in a native context menu
anchored to the element, with SF Symbols on iOS:

```tsx
<ContextMenu.Root>
  <ContextMenu.Trigger>{card}</ContextMenu.Trigger>
  <ContextMenu.Content>
    <ContextMenu.Item key="share" onSelect={share}>
      <ContextMenu.ItemTitle>Share</ContextMenu.ItemTitle>
      <ContextMenu.ItemIcon ios={{ name: 'square.and.arrow.up' }} />
    </ContextMenu.Item>
    <ContextMenu.Item key="delete" destructive onSelect={confirmDelete}>
      <ContextMenu.ItemTitle>Delete</ContextMenu.ItemTitle>
      <ContextMenu.ItemIcon ios={{ name: 'trash' }} />
    </ContextMenu.Item>
  </ContextMenu.Content>
</ContextMenu.Root>
```

Destructive items: `destructive` role + a confirm step (action sheet), never a
bare tap-to-delete.

## Bottom sheets

- Detents should be content-derived (`enableDynamicSizing`) or the platform
  set (medium/large) — arbitrary 37%/63% detents feel arbitrary.
- The sheet's drag must hand off to inner scroll correctly: use the
  library's provided `BottomSheetScrollView`/`BottomSheetFlashList`, never a
  plain ScrollView inside.
- Backdrop: fade in with sheet position (`interpolate` on `animatedIndex`),
  tap-to-dismiss, and dim to the platform's standard (~40% black).
- Keyboard: `keyboardBlurBehavior="restore"`, and test with the keyboard up —
  half the bottom-sheet bugs in the wild are keyboard interactions.

## Forms and inputs

- Labels above fields, not placeholders-as-labels.
- `keyboardType`, `autoComplete`, `textContentType` on every input — enables
  autofill and the right keyboard. `textContentType="oneTimeCode"` for OTPs.
- Return-key chaining: `returnKeyType="next"` + focus the next field;
  final field submits.
- Validate on blur or submit, never on keystroke; errors appear beneath the
  field in the platform's error color and *stay* until fixed.
- Wrap forms in a keyboard-avoiding strategy you have actually tested
  (`react-native-keyboard-controller` is the current best answer).

## Navigation patterns

- Stack for drill-in, tabs for top-level destinations, modal for
  self-contained tasks. Do not put a back-navigable flow inside a modal deeper
  than 2 steps — use a stack inside the modal with its own header.
- iOS: swipe-back must always work (don't block the interactive pop gesture).
- Tab bars: 3–5 items, SF Symbols with the filled variant for the active tab,
  labels always on (icon-only tab bars fail recognition tests).
- Deep links: every screen reachable by URL via Expo Router's file routes.

## When you DO rebuild a control

Match the OS's numbers, not your instincts:
- iOS switch: thumb travel ~22 pt in ~0.2 s with a slight squish; haptic on
  toggle.
- Pressed states: opacity 0.4 for plain-text buttons, scale 0.97 + slight
  darken for filled buttons, spring back on release.
- Selection cells: checkmark animates in with a short fade+scale, row flashes
  the selection color for ~150 ms.
- Always add the platform haptic the real control would emit.

---

## Appendix: performance.md

# Performance — measure, fix, re-measure

Perceived quality is half design, half frame rate. This reference is the
method; never optimize on vibes.

## The loop

1. **Measure** a baseline for the exact interaction that feels bad (FPS during
   the transition, TTI from cold start, commit counts during typing).
2. **Optimize** the one thing the measurement indicts.
3. **Re-measure** the same way.
4. **Validate** with a number: 45 → 60 fps, TTI 3.2 s → 1.8 s. No number, no
   claim.

Do not recommend `useMemo`/`useCallback`/`React.memo` without profiler
evidence of wasted renders. Do not flag "stale closure risk" without a repro.
Measure the target interaction, not tree depth.

## FPS & re-renders (highest impact)

- Long or growable list on ScrollView → replace with FlashList. This single
  swap fixes more RN jank than everything else combined.
- Re-render storms: profile with React DevTools; the classic causes are a
  broad context/store consumed by leaves, inline object/array props into
  memoized children, and parent state that should be local.
- Prefer atomic state (Zustand selectors, Jotai atoms) so a change re-renders
  only its consumers.
- React Compiler: enable once profiling shows cascading re-renders; it
  replaces most manual memoization. Watch for bailouts (mutations, non-plain
  patterns) — a bailed-out hot component silently loses the win.
- `useDeferredValue` for expensive derived UI (filter results, search
  highlighting) behind fast-changing inputs.

## Typing performance

Controlled TextInputs re-render the tree per keystroke. For search bars and
forms: uncontrolled inputs (`defaultValue` + `onChangeText` into a ref or
store), commit to state on submit/debounce.

## Startup / TTI

- Measure only cold starts, with `react-native-performance` markers.
- Native navigation (`react-native-screens`) enabled.
- Defer everything not needed for first paint: heavy SDK init, analytics,
  below-the-fold data.
- Hermes: check bundle compression guidance for your RN version (mmap).
- Inspect the bundle when it grows: `npx react-native bundle … --dev false`
  then `source-map-explorer`. Barrel imports (`import { x } from '@/components'`)
  are the classic silent bloat — import from the source file.

## Memory

- Symptoms: growing RSS while navigating back and forth. Hunt JS leaks with
  heap snapshots (retained listeners, intervals, subscriptions in effects
  missing cleanup) before blaming native.
- Lists: `recyclingKey` on `expo-image` items, no inline closures capturing
  huge parent scopes in `renderItem`.

## Animations

- Anything janky mid-gesture: confirm the animation runs as a worklet on the
  UI thread; a single `runOnJS` in `onChange` is enough to ruin it.
- Heavy screens committed during a transition stall the JS thread and hitch
  even UI-thread animations — defer the destination screen's expensive work
  until `InteractionManager.runAfterInteractions` / after the transition ends.

## Budgets to hold

| Metric | Budget |
|---|---|
| Transition/gesture FPS | 60 (no dropped frames in the hero flow) |
| Cold-start TTI (mid-tier device) | < 2 s |
| Keystroke → echo | < 50 ms |
| List scroll (FlashList) | blank-cell-free at fling speed |
| JS bundle (initial) | watch the trend; investigate any +10% jump |

---

## Appendix: simulator-loop.md

# The simulator loop — verification checklist & device matrix

A screen is finished when it survives this checklist on a real simulator, not
when the code compiles. Budget as many loop iterations as it takes; the goal
is "cannot find a flaw", not "looks fine".

## Loop mechanics

1. Launch on the iOS Simulator (primary) — `npx expo start` + `i`, or your
   dev build. Android emulator second.
2. Screenshot the screen (simctl: `xcrun simctl io booted screenshot s.png`,
   or your agent's screenshot tool). **Open the screenshot and study it** —
   do not trust memory of what you wrote.
3. Interact: tap every control, type overlong text, background/foreground the
   app, rotate if supported.
4. For motion: screen-record the ENTIRE flow
   (`xcrun simctl io booted recordVideo m.mov`) — not just the hero
   transition. Watch it at full speed for feel, then scrub frame by frame.
   Stills cannot catch a one-frame flash, a dropped spring, or a keyboard
   jump-cut; only the recording can.
5. Fix → relaunch → re-verify. Never batch more than a few fixes between
   looks; regressions hide in batches.

If a UI-testing tool (e.g. Maestro) is available, script the flow's happy
path once it stabilizes — taps, assertions, screenshots — so later changes
re-verify for free.

## Per-screen checklist

**Layout**
- [ ] Nothing clipped by the Dynamic Island / status bar; scrolled content
      passes *under* it with the intended fade/blur, not a hard edge
- [ ] Bottom CTA clears the home indicator (safe-area inset respected)
- [ ] Optical alignment: icons vs text baselines, centered things actually
      look centered (check at 2× zoom)
- [ ] Spacing rhythm consistent (no rogue 13px gaps in an 8pt system)
- [ ] Long text: 2× length titles truncate/wrap by design, not by accident
- [ ] Empty state, loading state, error state each verified by forcing them

**Theming & type**
- [ ] Dark mode AND light mode screenshots taken and inspected
- [ ] Dynamic Type at XL: no overlap, no clipped labels
- [ ] Contrast: secondary text still readable in both themes

**Motion (evaluated on the full-flow recording, never on stills)**
- [ ] Entrance plays once, correctly, on first mount (and NOT again on
      back-navigation)
- [ ] Gesture follows the finger 1:1; release springs with velocity;
      cancelling mid-gesture settles cleanly
- [ ] Frame-by-frame: no pop at animation start/end, no double-render flash,
      no one-frame white/wrong-theme/wrong-color frames during transitions
- [ ] Every modal/sheet cycle recorded: present, drag, dismiss, cancel —
      smooth in both directions
- [ ] Keyboard appear AND dismiss recorded: layout glides with it, focused
      input stays visible, nothing jump-cuts or reflows after settling
- [ ] Sustained 60 fps through every transition of the flow (measure with
      the perf monitor / Instruments, don't eyeball)
- [ ] Reduce Motion enabled → spatial animations become fades

**Interaction**
- [ ] Every tappable ≥ 44pt; press states visible; haptics where native
      controls would have them
- [ ] Keyboard: appears with the right type, doesn't cover the focused input,
      dismisses sensibly
- [ ] Back gesture (iOS edge swipe) works everywhere it should
- [ ] Rapid double-taps don't double-navigate or double-submit

**State**
- [ ] Background the app mid-flow → return: state intact
- [ ] Kill and relaunch: persisted state restores, ephemeral state resets
- [ ] Offline: actions queue or fail loudly — never silently

## Device matrix (minimum)

| Profile | Why |
|---|---|
| Latest iPhone Pro (Dynamic Island) | Primary design target |
| iPhone SE-class (small, no island) | Layout compression + button reachability |
| Latest Pixel (Android) | Material behaviors, back gesture, font metrics |
| One tablet/iPad IF the app claims support | Otherwise explicitly letterbox |

Run the full checklist on the primary; on the others, verify layout,
safe areas, and the hero flow.
