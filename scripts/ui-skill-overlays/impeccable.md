## SKC: how this bundled copy runs

### Order and precedence

`stageshow` stays the design center and loads first. This skill adds Impeccable's steering vocabulary on top: the refine passes (`polish`, `bolder`, `quieter`, `distill`, `clarify`, `colorize`, `typeset`, `layout`, `harden`, `adapt`) and the evaluation passes (`critique`, `audit`). Where the two disagree on framing, hierarchy or motion, `stageshow` decides; interaction timing follows `emil-design-eng`. A pinned brief still wins over both, as "The brief wins" below says.

### The engine is not bundled

The `scripts/impeccable` launcher and the native engine binary it downloads on first run are not shipped with SKC. Therefore:

- Skip Setup step 1. Do not run the launcher and do not send the "Context loading did not run" message; go straight to the **Launcher unavailable** path: read an existing `PRODUCT.md` and `DESIGN.md` without inventing missing context, then follow Setup steps 2-3.
- Every `.pi/skills/impeccable/scripts/impeccable <verb>` command below (`detect`, `critique-storage`, `live-server`, `live-inject`, `pin`, `hooks`, `doctor`) is unavailable. Skip that command and keep the manual part of the step. Snapshot persistence and trends are skipped.
- In `critique`, the detector counts as missing: gather Assessment B's browser evidence with the session's browser or screenshot tool when it has one, and open the report with the degraded banner `critique` requires.
- Live mode is unavailable, so ignore the "When invoked from live mode" parameter contracts.
- Do not install the Impeccable CLI (`npx impeccable ...`) or fetch the engine unasked. If the user explicitly asks for the detector, upstream's route is `npx impeccable detect <files or URL>`.

### What is bundled and what replaces the rest

The bundled references are appended inline at the end of this document: read `reference/<name>.md` as the `## Appendix: <name>.md` section. Bundled: `craft-floor`, `mode-operate`, `mode-persuade`, `mode-read`, `operate`, `critique`, `audit`, `polish`, `bolder`, `quieter`, `distill`, `clarify`, `colorize`, `typeset`, `layout`, `harden`, `adapt`.

| Upstream reference (not bundled) | Use instead |
| --- | --- |
| `new-work.md`, `craft.md`, `shape.md`, `init.md` (new surface or replacement visual world) | `stageshow`, then this skill's refine passes |
| `animate.md`, `delight.md` | `animate`, `find-animation-opportunities` |
| `ios.md`, `android.md`, `audit.native.md`, `adapt.native.md` | `appllama-app-design-skill` for native app screens, `mobile-native` for a web app on a phone |
| `live.md`, `live-setup.md`, `generate.md` | `prototype` |
| `routing.md`, `document.md`, `extract.md`, `onboard.md`, `optimize.md`, `overdrive.md`, `visualize.md`, `component-review.md`, `region-map.md`, `hooks.md`, `doctor.md` | Not available. Do the work with the bundled references, and if the user names one of these commands, say once that it is not bundled. |

With no specific command, treat the request as general design work (the Routing "Otherwise" rule); there is no command menu to present.
