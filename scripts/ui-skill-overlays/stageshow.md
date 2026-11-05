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
