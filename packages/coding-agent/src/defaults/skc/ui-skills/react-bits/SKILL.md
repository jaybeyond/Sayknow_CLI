---
name: react-bits
description: Reach for the React Bits registry instead of hand-rolling animated React UI. Use when building or polishing animated text, animated backgrounds, cursor/hover effects, carousels, or other motion-heavy React components. Covers when React Bits is the right call, how to install a single component with shadcn, which variant to pick (JS/TS x CSS/Tailwind), and the license boundary. Trigger on "animated text", "animated background", "make this hero pop", "add a shiny/blur/glitch text effect", "particle background", "cursor effect", or any animated React component request.
---

# React Bits

## SKC invocation

SKC loads this skill automatically for matching frontend UI/UX work.
Do not wait for a follow-up question. Apply the rules immediately
and keep going on the user's actual task.

This is SKC's own guidance for using the third-party
[React Bits](https://reactbits.dev) registry
([DavidHDev/react-bits](https://github.com/DavidHDev/react-bits)).
SKC does not bundle React Bits components; you install the one you need
into the user's project from the upstream registry.

## When to use it

Use React Bits when the request is an **animated or interactive React
component** that the catalog below already solves — animated text, animated
backgrounds, cursor and hover effects, scroll effects, carousels, decorative
motion.

Do not use it when:

- The project is not React. Nothing here is portable to plain HTML, Vue, or
  React Native as-is. (Official ports exist for Vue and Svelte; they are
  separate projects.)
- A plain CSS transition does the job. Pulling in a decorative component for a
  150ms fade is over-engineering — the bundled `animate` skill covers that.
- The surface is data the user reads or acts on. Decorative motion belongs on
  marketing and hero surfaces, not on a banking table.
- The component would be the product. See the license section.

Run the frequency and purpose gate from the `animate` skill first. A component
the user sees a hundred times a day should not be animated, whatever the
catalog offers.

## Installing one component

React Bits ships through the shadcn registry. Install exactly the component you
need — never the whole catalog.

```bash
npx shadcn@latest add @react-bits/<Component>-<Variant> --yes
```

`<Variant>` is one of `JS-CSS`, `JS-TW`, `TS-CSS`, `TS-TW`. Match the project:
TypeScript + Tailwind means `TS-TW`, plain JS with stylesheets means `JS-CSS`.
Read the repo before choosing; do not default to one blindly.

```bash
# TypeScript + Tailwind project
npx shadcn@latest add @react-bits/BlurText-TS-TW --yes
```

**Precondition:** the project must be shadcn-initialized — `components.json`
must exist at the project root. Without it the CLI stops and asks to create
one, which will hang a non-interactive run. Check for `components.json` first;
if it is missing, either run `npx shadcn@latest init` (only with the user's
agreement — it rewrites config and CSS) or copy the component source from
[reactbits.dev](https://reactbits.dev) by hand instead.

The component lands in the project's configured components alias (typically
`src/components/<Component>.tsx`). It is ordinary project source from that
point on: read it, adapt the props, restyle it. Do not treat it as a
node_modules dependency.

## After installing

- Check the component's dependencies actually installed; several pull
  `motion`, `gsap`, `three`, or `ogl`. A 3D background is not free.
- Reduced motion still applies. Most of these components animate
  unconditionally — add a `prefers-reduced-motion` guard yourself.
- Tune the props to the product. Shipping the demo defaults verbatim is how
  every site using this library ends up looking identical.
- Background and 3D components are the expensive ones. Measure before shipping
  one above the fold on mobile.

## License boundary

React Bits is **MIT + Commons Clause**. Using a component in the user's
application, website, or product — including commercially — is explicitly
allowed. Selling, sublicensing, or redistributing the components themselves,
alone or bundled or ported, is not.

That is why SKC installs from the upstream registry instead of vendoring the
components. Do not copy the catalog into a shared internal package that is
itself distributed as a component library.

## Catalog

169 components. Names below are exact registry names — append the variant
suffix when installing.

### Text animations

ASCIIText, BlurText, CircularText, CountUp, CurvedLoop, DecryptedText, DepthText, EchoText, FallingText, FoldText, FuzzyText, GlitchText, GradientText, MagicRings, MaskedHeading, ParticleText, RotatingText, ScrambledText, ScrollFloat, ScrollReveal, ScrollVelocity, ShinyText, Shuffle, SplitFlapText, SplitText, StrokeText, TextCursor, TextPressure, TextType, TrueFocus, VariableProximity, WarpText

### Animations

AnimatedContent, Antigravity, BlobCursor, ClickSpark, Crosshair, Cubes, ElasticMesh, ElectricBorder, FadeContent, GhostCursor, GlareHover, GlowCursor, GradualBlur, HalftoneReveal, ImageTrail, LaserFlow, LogoLoop, Magnet, MagnetLines, MetaBalls, MetallicPaint, Noise, OrbitImages, PixelSwap, PixelTrail, PixelTransition, Ribbons, RippleDistortion, ScrollExpand, ShapeBlur, SpecularButton, SplashCursor, StarBorder, StickerPeel, Strands, SwarmCursor, TargetCursor

### Components

AccordionGallery, AnimatedList, BorderGlow, BounceCards, BubbleMenu, CardNav, CardSwap, Carousel, ChromaGrid, CircularGallery, Counter, CursorGrid, CurvedInput, DecayCard, DepthCarousel, Dock, DomeGallery, DriftWall, ElasticSlider, FlowingMenu, FluidGlass, FlyingPosters, Folder, GlassIcons, GlassSurface, GooeyNav, InfiniteMenu, InfiniteSpiral, Lanyard, LineSidebar, MagicBento, Masonry, ModelViewer, MorphSlider, OptionWheel, PillNav, PixelCard, ProfileCard, ScrollStack, SpotlightCard, Stack, StaggeredMenu, Stepper, TiltedCard

### Backgrounds

AcidSquares, AeroShards, Aurora, Balatro, Ballpit, Beams, CRTWarp, ColorBends, DarkVeil, Dither, DotField, DotGrid, EvilEye, FaultyTerminal, Ferrofluid, FloatingLines, Galaxy, GhostFibers, GradientBlinds, GradientWaves, Grainient, GridDistortion, GridMotion, GridScan, Hyperspeed, Iridescence, LetterGlitch, LightPillar, LightRays, LightTunnel, Lightfall, Lightning, LineWaves, LiquidChrome, LiquidEther, MoltenMetal, Orb, Particles, PixelBlast, Plasma, PlasmaWave, Prism, PrismaticBurst, Radar, RippleGrid, Scanner, ShapeGrid, ShapeWaves, SideRays, Silk, SlicedWaves, SoftAurora, Threads, Topography, Waves, WebThreads
