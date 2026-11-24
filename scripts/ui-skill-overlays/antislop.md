## SKC: how this bundled copy runs

### Order and precedence

`stageshow` stays the design center and loads first. antislop is the filter on top of it: the purpose test, the R-01 to R-40 rules and the Delivery Gate. It sets no direction of its own, so the direction comes from `stageshow` and the project's `DESIGN.md`. Where the two disagree on framing, hierarchy or motion, `stageshow` decides; the Hard Gate rules (Group 1) still apply to every result.

### Mode in SKC

Resolve the mode once per session:

1. Use an explicit `during` or `after` choice from the conversation first.
2. Otherwise use a saved `during` or `after` from `~/.config/antislop/settings.json` (Windows: `%APPDATA%\antislop\settings.json`, with the same home fallback). Read only `mode` as data. Never modify settings unless the user explicitly asks.
3. Otherwise infer from the request: building or editing UI is `during`; reviewing or auditing an existing interface without requesting changes is `after`. Ask only when the requested action remains materially ambiguous.

In `during`, apply the rules while working and run the Delivery Gate. In `after`, report numbered findings by rule and priority. Keep the review read-only until the user requests fixes; write a report file only when requested.

The three steps that run in both modes still apply: direction before building (R-37), ask before creating any asset (R-23), and the Delivery Gate before delivering.

### Updates

The upstream installer and update routes do not apply: SKC ships antislop (release 3.2.32, commit `7f6a03d`), and a new SKC release updates it. Do not run `npx antislop-ai`.
