# Changelog

## [Unreleased]

## [0.6.3] - 2026-09-25

## [0.6.2] - 2026-09-24

### Fixed

- `/model` list search now matches vendor-style version punctuation. Typing `opus 5.5` (or just `5.5`) in the ALL or provider tab returned "No matching models" even though `anthropic/claude-opus-5-5` was in the list, because those tabs fuzzy-matched only `${id} ${provider}` and `5.5` cannot be a subsequence of `5-5`. The ALL/provider tabs now use the same punctuation-insensitive pipeline as the CANONICAL tab (id + provider + display name, alpha-token and compact-substring prefilters, fuzzy only for ranking/typo rescue), so `opus 5.5`, `5.5`, `opus55` and `opus-5-5` all land on Opus 5.5.

## [0.6.1] - 2026-09-24

### Added

- New built-in model profile `claude-opus-5-5` (`/model` → CLAUDE group, or `skc --mpreset claude-opus-5-5`). Opus 5.5 was bundled in the catalog in 0.6.0 but no preset referenced it, so it only appeared in the model list, never in the preset landing view. The preset is additive and tuned to Opus 5.5's own envelope rather than copied from `claude-opus`: it costs less than Opus 5 ($4/$20 vs $5/$25) at the same 1M context and 128K output and accepts the `max` adaptive level, so `architect` runs at `max` and `planner` at `medium` instead of the Opus 5 preset's `xhigh`/`low`, while `executor` stays on `claude-sonnet-5` so mechanical work does not pay Opus rates.

### Changed

- After an Anthropic login, the automatically recommended preset is now `claude-opus-5-5` instead of `claude-opus` — newer generation, cheaper per token, same context window. `claude-opus` is unchanged and still selectable for the Opus 5 cost/effort shape. The provider's descriptor default remains `claude-sonnet-4-6`; no model default was promoted to an Opus.

## [0.6.0] - 2026-09-24

### Added

- The 13 bundled UI skills are now part of the typed decision instead of 20 hand-written regexes. Measured recall of the pattern table on real Korean prompts was 5/8; a prompt like "이 부분 손보기 전에 어떻게 갈지부터 같이 정하고 넘어가자" matched nothing and the skill never activated. The picked skill still arrives as the same hidden `developer` reminder, now labelled `semantic match` when the model answered and `matched` when a pattern did.
- Workflow routing and UI skill selection are **one** decision call, not two. The triage asks both questions in a single request (`questions: ["workflow", "uiSkill"]`), and a prompt the pattern table already answered drops that question from the request instead of paying for it — so adding UI routing cost zero extra round trips.
- The skill keyword table now fills itself. Every answered routing decision mines ordered two-stem shingles from the prompt into `~/.skc/agent/learned-skill-keywords.json`. A shingle is promoted to a real keyword after 2 independent prompts when the backend reports calibrated confidence ≥ 0.9, or 3 when it only ranks; a single contradicting answer blocks that shingle permanently, so a coincidence cannot become a rule. Learned entries carry strictly negative priority — a hand-written keyword always wins — and a promoted pattern answers for free on the next matching prompt. `decisions.keywordLearning: false` turns the store off; `SKC_LEARNED_KEYWORDS_PATH` relocates it.
- Routing and learning work in whatever language the prompt is written in. Mining uses the platform Unicode segmenter, so Chinese, Japanese and Thai prompts with no spaces come apart into words (Han runs the ICU dictionary misses fall back to character bigrams; hiragana-only tokens are dropped as grammar); non-ASCII alphabets are kept instead of discarded, and a learned stem gets a Unicode word boundary in spaced scripts and a bare substring match in unspaced ones. The length floor that skips the model on "ok thanks" is measured in signal rather than code units, so a six-character Chinese request is no longer thrown away. Measured against the hosted `jev` backend: 40/40 across ko, en, zh, ja, es and ru, and a ralplan phrasing repeated twice in Chinese, Japanese or Russian promotes a keyword that fires on an unseen sentence in that language.
- The Codex host gets the same router. `skc codex-native-hook` ran the hand-written keyword table and nothing else: the semantic stage had a parameter waiting for it since it shipped, and learned keywords were never loaded there, so a phrasing learned in a CLI session did nothing under Codex. The hook now runs all three stages — hand-written keywords, learned keywords, then one typed decision for whatever those missed — on the same backend chain (TypeSafe key, else a running local runtime, else the small model of the provider you are logged into) and feeds the answer back into the learned table. Because the hook is a fresh process per prompt, credentials and the model registry are opened only on a prompt the tables did not fully answer and closed before it exits; a prompt they did answer still costs the same ~0.3s it did before. Measured through the real hook subprocess: a Chinese ralplan phrasing routed by the model on the first prompt fired from the learned table on the next one.

### Changed

- Typed decisions (`decisions.enabled`) are now **on by default**. The keyword stage of workflow routing still runs first and free; the model stage only spends a small-model call on turns the table did not answer. Set `decisions.enabled: false` to route on the keyword table alone.
- The small-model fallback now ranks the **provider you are chatting with** first. Measured on a registry with Anthropic, Codex and Z.ai keys: price order put four free `zai/glm-*` reasoning tiers ahead of `claude-haiku-4-5`, and the first took 8.9s — past the 8s service deadline, so the answer was nothing. Haiku next to Opus, mini next to GPT is also the model you would have picked by hand.
- The routing decision now goes through the session's own `streamFn` instead of a bare `completeSimple`, so it gets the same proxy, credential-invalidation and retry wrapping as the turn, and a host that injects a transport intercepts it. Hosts opt sessions in with `AgentSessionConfig.semanticWorkflowRouting` (`createAgentSession` does); a bare `AgentSession` never routes, so scripted transports are not consumed by a call they did not script. While the decision is in flight the session reports `isStreaming`, so a second `prompt()` queues or rejects as it would mid-turn, and `abort()` cancels the decision.
- `task.modelRouting.enabled` now defaults to **true**. The tier lists it reads are empty until you set them, so nothing changes for anyone who has not configured them — but shipping it off meant a user who *had* configured tiers still got no routing, which made the whole feature dead code.

### Fixed

- The small-model fallback answered **nothing** on any registry with an Anthropic key: the cheapest qualifying entry, `claude-3-haiku-20240307`, is retired and returns 404, and the backend logged it as "model did not emit the forced tool call" and gave up. The three retired Claude 3.x ids are now dropped from the catalog *and* from stale on-disk cache rows, the backend logs the real status, and a candidate that errors or blows a 3.5s attempt budget is skipped for the next one and remembered for ten minutes so the stall is paid once, not per prompt.
- A local runtime contributes **one** candidate — the smallest chat model — and embedding models (`nomic-embed-text`) are no longer offered a chat call. Measured with Ollama: five local models ranked ahead of every hosted one, each timed out on cold start, and the hosted model was never reached before the deadline.
- A decision request whose caller had already aborted — measured: `abort()` landing during the previous backend's credential lookup — ran a full attempt budget of silence, because an abort listener added to a signal that has already fired never runs. Every backend now checks the signal after each await.

## [0.5.26] - 2026-09-23
### Added

- `/model` role rows now open a second level so a model can be assigned to a *detailed use* rather than only to a whole role. `planner`/`architect` offer backend architecture and frontend design, `executor` offers implementation and testing, `critic` offers review; `default` has none and still assigns in one keystroke. The two bulk rows deliberately stay canonical-only — an action that also rewrote five detailed-use overrides could not be undone from the same menu. Assignments persist to the new `task.modelRouting.specialtyModels` record, whose keys are allowlisted to those five ids. Saving one while `task.modelRouting.enabled` is off persists it and says so instead of silently enabling a feature you did not ask for. First-level rows are now stable descriptors rather than positional index arithmetic, which is what previously made every added row a chance to assign a model to the wrong role.
- Subagent model routing now runs **one classification per child task** instead of one per `task` call. A batch shares an agent but not a workload, so an implementation slice and a test slice in the same call no longer have to share a single verdict. Each child dispatches its own ordered chain — detailed-use model, then tier model, then the role's configured chain — so a detailed-use model that cannot authenticate still falls through to something the role can actually run. A high-risk assignment skips the detailed-use axis entirely, because a lateral swap can move sideways into something weaker.
- Receipts and progress now carry what the router **requested** separately from what the spawn ran on. Because the dispatched value is a fallback chain, conflating the two would let a receipt claim a detailed-use model was used when the chain actually fell through to the baseline. When the decision backend is an ordinary LLM it returns no probabilities at all, so the record carries an ordinal clarity score and `calibrated: false` rather than a fabricated confidence.
- The `task` tool accepts `.specialty` per task. Declaring the kind of work is the deterministic path to a detailed-use model: no classifier runs, `task.modelRouting.enabled` is not consulted, and no confidence bar applies — if the user assigned a model to that specialty under `/model`, the child runs on it and leaves it only on a transport error (429, 5xx, auth, quota), when the child session's fallback chain advances to the role baseline composed behind it. A declared specialty ignores the menu's role grouping on purpose: the setting is one flat map, and a frontend build delegated to `executor` should get the frontend model. Receipts mark these `declared: true` so they cannot be mistaken for a classifier verdict. Auto-detection from assignment text is unchanged and still opt-in.

### Fixed

- Model-selector suites that assert UI copy now pin the locale — and restore it. They previously inherited whatever `language` the developer had configured, because a sibling suite restores the real agent directory and reloads real settings, and one suite pinned Korean without putting it back — so whether they passed depended on test file ordering.
- The first-level `/model` role rows (`Set as EXECUTOR (Executor)`) were hardcoded English inside an otherwise localized menu. They now go through i18n in all seven locales; the redundant `(Name)` suffix is dropped where the locale does not need it, and the role tag stays verbatim because it is the same identifier receipts and `/model` arguments use.
- Login, `--list-models`, `/model`, and `/model provider/id` now refresh provider catalogs online so newly published Kimi/Grok (and other OpenAI-compatible) ids appear without waiting for a bundled `models.json` regen or a 2h cache TTL.

## [0.5.22] - 2026-09-19

### Added

- TypeSafe (hosted System One `jev`) as a typed-decision backend. Add the key with `TYPESAFE_API_KEY=<key> skc setup typesafe`; it is verified against the live API before being stored, because the decision service fails open and an unverified bad key would be swallowed silently forever. Removing it (`--remove`) falls back to your logged-in model. The key is read from the environment, never a flag — this repo already refuses raw `--api-key` values because they leak into shell history and the process list.
- Decision backends now resolve in order: TypeSafe when a key exists (the only backend that returns calibrated probabilities), otherwise the model you are already logged into. TypeSafe is deliberately **not** registered in the chat-provider registry: it has no stream, no messages and no text output, so giving it a `Model` shape would put a non-chat endpoint in the model picker.
- Typed decisions (`decisions.enabled`, default off): a small, reusable service that asks the model you are already logged into a typed question and gets back a value your code can branch on. Type safety comes from a forced tool call with enum-constrained fields, so an option outside the declared set cannot reach the caller. No extra vendor, no extra key.
- Workflow-skill routing now has a semantic second stage. The literal keyword table stays first and free; the model is consulted only when it matches nothing. Measured over 23 prompts × 3 runs against `claude-opus-5`: keyword-only **0/27 in Korean** (43% overall), hybrid **69/69 (100%)** with zero false activations on the 18 negative cases, p50 1.46s. Reproduce with `bun scripts/eval-skill-routing.ts --repeat 3`.

### Fixed

- `NativeRuntimeCompatibilityError` now lists only the causes that actually fired and names the file the process loaded `@sayknow-cli/natives` from. A pure version mismatch used to read "required workflow arbitration methods are **available**", which described a healthy runtime while refusing to start every session and extension.
- `dev:link` / `dev:doctor` fail on (and `dev:link` removes) nested installs under `packages/<pkg>/node_modules` that shadow a workspace package, and verify that `@sayknow-cli/natives` resolves to the same version as the `coding-agent` runtime that loads it. A published `@sayknow-cli/natives` copy left inside `packages/coding-agent/node_modules` wins resolution over the workspace link and breaks every SDK session.
- `dev:doctor` accepts this checkout's bun-linked `bin/skc.js` wrapper — the one `install:dev` itself creates — instead of reporting it as drift, but only when the wrapper is byte-identical to the expected workspace wrapper and `@sayknow-cli/coding-agent/cli` resolves back to this checkout's `src/cli.ts`.

## [0.5.21] - 2026-09-17

### Changed

- `skc auth-gateway` (`serve`, `status`, `check`) now falls back to the local SQLite credential store when no broker is configured, matching `discoverAuthStorage()` precedence. A configured broker still wins and never degrades to local credentials. Single-machine users no longer have to run `skc auth-broker serve` alongside the gateway.
- `skc auth-gateway status --json` reports `source` (`broker`/`local`), `dbPath`, and `credentialCount` in both modes; `ready` now requires a bearer token **and** at least one credential (`reason`: `token_missing`, `no_credentials`, `broker_unavailable`, `local_store_unavailable`).

## [0.5.20] - 2026-09-17

### Fixed

- Widen npm post-publish visibility wait from ~6 minutes to ~15 minutes. `coding-agent` tarball CDN lag timed out 0.5.14–0.5.19 before the root `sayknow-cli` package could publish.

## [0.5.19] - 2026-09-16

### Fixed

- Pin UI-skill hook tests to a unique `session_id` so CI's `SKC_SESSION_ID` cannot stale-skip ralplan activation and drop workflow context from "consensus plan … animation".

## [0.5.18] - 2026-09-16

### Fixed

- Isolate `UserPromptSubmit` hook tests with an explicit `cwd`/`stateDir` so Linux CI cannot resolve a repo-root ralplan session and skip seeding workflow state for "consensus plan … animation".

## [0.5.17] - 2026-09-16

### Fixed

- Compute the bundled UI-skill directive before workflow-state lookups in `UserPromptSubmit`, and isolate each lookup so a Linux CI recovery/activation failure cannot return empty context for `animate` / `ralplan` routing.

## [0.5.16] - 2026-09-16

### Fixed

- Native skill hooks never throw out of `UserPromptSubmit` / `Stop`. A failed install-root or state lookup returns empty context instead of aborting the turn, which is what collapsed the bundled UI-skill directive in Linux CI.

## [0.5.15] - 2026-09-16

### Fixed

- Native `UserPromptSubmit` UI-skill routing no longer lets a failed install-root lookup swallow the bundled skill directive. Candidate `SKILL.md` probes are best-effort, and hook tests isolate `home` so a runner's `~/.agents/skills` cannot pollute CI.

## [0.5.14] - 2026-09-16

### Added

- Bundled frontend UI/UX craft skills so SKC sessions can invoke them without a separate user install: Emil Kowalski's web craft set (`emil-design-eng`, `animate`, `review-animations`, `improve-animations`, `find-animation-opportunities`, `pick-ui-library`, `prototype`, `mobile-native`, `animation-vocabulary`, `apple-design`, `ask-sonner`) and Appllama's native mobile build bar (`appllama-app-design-skill`). These are not public workflow skills; the four workflows remain `deep-interview`, `ralplan`, `ultragoal`, and `team`. `appllama-usage` is deliberately excluded because it only drives the paid Appllama MCP, which SKC does not ship. Each skill's companion reference files are inlined as appendices by `scripts/build-ui-skill-bundle.ts`, since only `SKILL.md` is compiled into the binary and a bundled skill's `baseDir` is a virtual path.
- The native `UserPromptSubmit` hook routes frontend UI/UX prompts to the matching bundled UI skill automatically, in English and Korean, so the agent loads `animate`, `review-animations`, `pick-ui-library`, `mobile-native`, `appllama-app-design-skill`, `ask-sonner`, or the `emil-design-eng` baseline without the user naming a skill. Detection is additive to workflow-keyword activation, seeds no workflow mode state, and stays silent for non-frontend prompts and for SKC's own terminal-only UI work.
- Transition-shaped prompts route to the `transitions-dev` skill ([transitions.dev](https://github.com/Jakubantalik/transitions.dev)). When it is absent the agent installs it itself with upstream's own non-interactive command (`-a universal`, landing in `<project>/.agents/skills/`, a root SKC loads) through the `bash` tool, so the user never types an install command; when present it is loaded directly. The collection is deliberately **not** vendored: upstream licenses only its CLI and Refine tooling under MIT, while the transitions carry a clause forbidding repackaging or publishing the collection — which is what bundling into the SKC binary would do. Installing into the user's own project is explicitly permitted.
- `skc setup ui-skills` installs the routed-but-unbundled frontend skills into the current project (`<project>/.agents/skills/`, a root SKC's agents provider loads), with `--check` to audit and `--force` to reinstall. It runs upstream's own publisher CLI and verifies the payload landed, so a silent installer failure is reported instead of being treated as success.
- Animated-React-component prompts route to a new bundled `react-bits` skill covering the [React Bits](https://reactbits.dev) registry: when to reach for it, the per-component `npx shadcn@latest add @react-bits/<Component>-<Variant>` install, the `components.json` precondition that otherwise hangs a non-interactive run, post-install duties (dependency weight, reduced-motion guards), and a catalog of all 169 component names. The skill is SKC-authored guidance plus factual metadata — React Bits ships no agent skill of its own, and its MIT + Commons Clause license forbids redistributing the components, so no component source is bundled.

### Fixed

- Runtime skill discovery ranks project `.skc/skills` ahead of the user-home catalog before applying the result limit, so a populated `~/.skc/skills` cannot hide a project skill (ported from upstream v0.16.5 skill-convention budget ranking).
- Session-import URL redaction no longer caps the scheme at 16 characters. The scheme-character run is boundary-anchored so long and digit-prefixed credential URLs still redact without quadratic scanning (ported from upstream #5402).

## [0.5.13] - 2026-09-15
### Fixed

- Session-import's cross-process idempotency test no longer depends on Bun child stdout surviving a contended file lock. The child writes its result to a file as well as stdout, so a silent empty pipe on Linux CI cannot fail a successful import.


## [0.5.12] - 2026-09-15
### Added

- `skc ultragoal succession offer|adopt|status` gives an approved Ultragoal an explicit, audited path from the repository it was planned in to the repository its implementation belongs to (ported from upstream #5353). The source run fences the selected unfinished goals immediately; the target adopts a fresh pending plan with verbatim brief/objectives and unresolved obligations as provenance, not inherited completion authority.
- Custom OpenAI-compatible providers in `models.yml` auto-populate `/model` from their live `/v1/models` catalog without a manual `discovery:` block, and auto-classify each discovered model's wire API family (ported from upstream #5187). Explicit `discovery` config and the local `openaiCompat` proxy lane are unchanged.

### Fixed

- Session import redaction now bounds the URL-credential scheme to 16 characters so large credential-free transcripts scan in linear time instead of quadratic (ported from upstream #5346). Markdown-wrapped `https://user:pass@host` credentials remain redacted.
- File-lock acquisition timeouts are a typed `FileLockAcquireError` with the lock path, retry count, and holder, instead of an untyped string. Empty `.lock` directories left by a crash between `mkdir` and writing `info` are reclaimable by GC (the SKC-shaped subset of upstream #5378/#5381; this tree has no `.lock.pending.<pid>.<uuid>` staging).
- `writeGuardedJsonAtomic` honors `lockHeld`, so callers already inside `withWorkflowStateLock` (succession offer/adopt, start/checkpoint) no longer self-deadlock.
- Under tmux, a successful sixel DA1 no longer turns INLINE transcript images back on. Ghostty answers that query with ";4" even though it never paints sixel, so every screenshot was smuggled through DCS passthrough onto the outer image plane and stacked over the chat. The probe now enables overlay sixel (the pet) only; inline sixel stays off unless tmux itself owns `terminal-features=sixel`.


## [0.5.11] - 2026-09-10

### Fixed

- Telegram tool activity and reasoning summaries flow again. The native notifications server (`crates/skc-notifications`) still admitted only the legacy `tool_activity_v1` token while the daemon and SDK host negotiated `tool_activity_v2`, so every tool-activity and reasoning-summary frame was silently dropped. Ported the upstream protocol constants: v2 is canonical, v1 stays receive-only for legacy clients.
- `bisect` recognizes git 2.55's quoted convergence line (`<sha> is the first 'bad' commit`). On newer git every bisect ran to the step limit and reported no conclusion.
- `/resume` with an explicit `--session-dir` no longer fails closed: the interactive selector called the managed-only candidate preparation unconditionally. It now lists through the read-only picker inventory, uses strict adoption only for managed destinations, and tags switches with the selector resume origin.
- Model registry: `getAvailable()` is memoized (keyed on disabled providers and credential env, invalidated on auth-generation changes and catalog rebuilds), provider-discovery 401/403 errors name the provider and the `providers.<id>.apiKey` / `apiKeyEnv` surface through a redacted URL, and the resolver forwards the session id so parent-session canonical stickiness reaches bare subagent overrides.
- Thinking/effort selector awaits the session's control-level change and surfaces errors instead of closing optimistically. Command palette hints use the configured key display strings.
- Status line custom editor caught up with upstream: usage-mode row, stable description-area height, parent preview refresh on edit and cancel, and `usage` merged into segment options.
- Hidden `__gateway` telegram subcommand imports `@sayknow-cli/telegram-remote` by package name instead of a cross-package relative path that does not exist in published installs.
- Deep-interview skill: ported the "Per-question advisory fanout lanes" subsection that the v0.5.0 sync missed.
- Stdio RPC client reports the child's exit code and stderr when the child exits before `ready`, instead of a misleading JSONL parse error.
- `ask` tool caught up with the SDK contract: the parameter schema is stage-gated for deep interviews (topology vs post-topology vs ordinary asks), and SDK-routed asks consume the typed `awaitAnswerRequest` receipt and settlement (commit / resolve-without-commit / invalid) instead of only the legacy `awaitAnswer` path, so remote answers fire at invocation time.
- Model profile activation raises typed `UnknownModelProfileError` / registry errors, so an SDK child that fails profile activation reports `code` and `details` through readiness and `BrokerResponse` instead of a bare `spawn_failed`.
- SDK host shutdown awaits the native notifications server's `stopAndWait()`; a failing stop is no longer recorded as a successful `hostStopped` during rollback.
- `mupdf` compiled-binary test and the Python SDK real-session tests run against whichever native addon variant CI built.

### CI

- Main CI is green again for the first time since the v0.11.6 sync. The `runtime-check` shard now downloads the native addon artifact, the planner (`scripts/ci-dev-affected.ts`) was rebuilt on the upstream v0.12.0 model with the fork's deltas (including the isolated production SDK host shard), the install smoke Dockerfile publishes the platform native packages, and roughly one hundred stale test contracts carried over from the v0.11.6/v0.12.0 syncs (rebrand strings, retired `--mode rpc`, catalog growth, default theme, golden HMAC domains) were realigned to the fork's intended behavior without removing or skipping tests.

## [0.5.10] - 2026-09-10

### Added

- Added built-in `grok-46-{eco,medium,pro}` model profiles for official `xai/grok-4.6` (500K context, reasoning effort through `xhigh`). xAI provider recommendation now defaults to `grok-46-medium`, web search defaults to `grok-4.6`, and the Grok CLI vendor catalog registers the model with the documented effort cap.

## [0.5.9] - 2026-09-10

### Fixed

- Fixed published-install startup crash from the 0.5.8 PDF wasm embed. The asset was imported from `../../../../node_modules/mupdf/dist/mupdf-wasm.wasm`, which only exists in the monorepo checkout — after `bun install -g` / `skc update` the same relative path resolved outside the package and aborted before the TUI opened. The wasm is now vendored under `packages/coding-agent/vendor/mupdf/` and imported package-locally so source installs and compiled binaries both resolve it.

## [0.5.7] - 2026-09-10

### Added

- Added opt-in `reasoningLanguage: english`. Model reasoning quality on technical work is generally better in English, but that previously meant answering in English too. With the setting on, the system prompt gains a `<reasoning-language>` block asking the agent to reason in English while keeping user-facing answers in the language the user used; correctness, safety, and communication requirements are explicitly unchanged. The default `off` adds nothing to the prompt.
- Added opt-in `compaction.adaptive.*` settings — `enabled`, `baseThresholdPercent`, `aggression`, `turnWindow`, and `minThresholdPercent` — and wired a per-session call-rate tracker into the auto-compaction threshold decision. Adaptive mode is disabled by default and the existing fixed `compaction.thresholdTokens` / `compaction.thresholdPercent` precedence is preserved. `getGroup("compaction")` flattens dotted keys, so the nested options object is assembled explicitly at the decision site rather than inferred, and a completed compaction resets the tracker in exactly one place.

### Fixed

- Restored PDF conversion in standalone binaries (ported from upstream #5433). Compiled releases kept mupdf `--external`, but compiled-Bun module resolution cannot satisfy markit's bare `import("mupdf")`, and mupdf's Emscripten loader cannot find `mupdf-wasm.wasm` inside the bunfs — so every standalone PDF read fell back to raw bytes behind a generic "PDF support requires 'mupdf'" note while the real cause was discarded. mupdf is now bundled: the wasm is embedded via `with { type: "file" }` and routed to the loader through a `locateFile` hook seeded before the first mupdf import, markit-ai's bundler-hostile `require("mupdf")` image-render call is patched to a dynamic import (`patches/markit-ai@0.5.3.patch`), and conversion failures re-run the import so diagnostics carry the actual error. The fetch tool also accepts any non-empty markit conversion instead of discarding short documents (e.g. the 14-character W3C dummy.pdf) into a raw-bytes fallback.

## [0.5.4] - 2026-08-28

Sayknow-CLI descends from an upstream MIT agent harness; see [`NOTICE.md`](../../NOTICE.md).
This file tracks the **fork's own releases**; upstream's full feature history lives
in that project. Each release notes the upstream version it is built on.


## [0.5.3] - 2026-08-28

### Added

- Added zero-configuration oMLX and loopback-safe SGLang discovery through the shared OpenAI-compatible registry, including reviewed oMLX model profiles, thinking-effort preservation, schemas, and local-provider tests.
- Added explicit-file `/import-session` support for Codex rollout JSONL, Claude Code JSONL, and claude.ai exports with bounded redacted context, quarantined unmappable records, durable provenance, workspace-scoped idempotent native publication, and ACP isolation for path-bearing import, export, and move commands.
### Fixed

- Imported-session targets activate only through an idle-only session transition; a response or turn that wins the activation race leaves the reused or newly published target intact for later resume instead of interrupting active work.

- LSP, DAP, and stdio MCP protocol writes now serialize complete write/flush transactions, await sink backpressure, propagate peer-close failures, and terminalize stale transports on fatal writes or stdout EOF instead of leaving delayed unhandled EPIPE errors or timeout-bound pending requests.
- Managed sessions now sample transcript size proactively only through a retained exact-file authority, treat unavailable sampling as unknown, and recover an authority-bound `content_too_large` append by atomically rewriting the exact live entry set; failed rewrites latch persistence and roll back volatile branch mutation before later appends.
- Explicit empty tool selections such as `--no-tools` now remain authoritative across goal/workflow restoration, session branching, and plan-mode transitions instead of silently reactivating built-in tools.
- `config set` and `config reset` now report success only after durable persistence; atomic YAML writes retain their original resolved target and fail closed on symlink or target-identity retargeting.
- `skc --worktree` now installs Bun, npm, or pnpm dependencies from the worktree's own matching lockfile instead of linking a package checkout to the source tree's `node_modules`; nested package roots keep their cwd, legacy owned links are migrated, unrelated links are refused, and repeated launches reuse the local install location.
- Release publication now emits Sayknow-owned SHA-256 manifests, and standalone installers plus `skc update` verify the selected platform binary before replacing an installation; missing or mismatched integrity metadata and concurrent installers fail closed.

### Changed

- The command palette now exposes availability-gated follow-up, queue editing, immediate-send, and transcript-turn actions; their default keybindings remain unchanged, while user remaps dispatch through the shared action registry.
- Korean and emoji escapes in `ask` question text and option labels now recover as display-only content while ids and workflow metadata remain fail-closed.
- The todo HUD can be expanded from its action/keybinding, startup can skip the logo sweep, and provider or MCP OAuth URLs copy only through an explicit remappable action.
- **Upstream independence.** Retired the upstream sync/regeneration pipeline
  (`rebrand/` layer plus the generation scripts); this tree is now the single
  source of truth and upstream fixes are ported by cherry-pick only. See
  `docs/FORK_MAINTENANCE.md`.
- `bun run release` now enforces the fork policy end to end: runs from the
  `sayknow-fork` branch, tags `sayknow-vX.Y.Z`, checks monotonicity against the
  fork tag series only, refuses same-version plain `v` tags on origin, and the
  release attaches both release-evidence JSONs for the daily public-sync live
  check.
- Scrubbed upstream brand references from public docs, the embedded docs
  index, and test fixtures (also fixing two fixture assertions the original
  rename had broken). MIT attribution remains in `LICENSE` and `NOTICE.md`.

## [0.5.2] — 2026-08-14

Built on upstream **v0.12.0**.

### Fixed (unattended workflow gates were unanswerable through the control plane)

`UnattendedSessionControlPlane.emitGate` opened gates without a broker
continuation, so every gate it emitted was quarantined as
`opened_without_continuation` and could never be answered; its `advance` hook
also settled the waiter early, violating the broker's post-advance liveness
check, and accepted gates then failed terminalization for lack of a proof. The
control plane now registers a live continuation, settles waiters in
`completeAccepted` (mirroring the session-side emitter), and declares the
designed `not_published` terminal proof. The ask tool regained the fork's gate
semantics on top of that: a negotiated unattended emitter wins over an attended
UI, clarification answers surface the user's question instead of aborting as a
cancel, multi-select keeps its empty-"Next" semantics through the gate schema,
and gate metadata carries the Next/Done navigation label again.

### Fixed (ask wire schema: deep-interview intent branches and gate addressing)

The deep-interview intent contract is enforced **on the wire** again: ask's
`deepInterview` metadata is a union of three mutually exclusive strict branches
(ordinary round / Round-0 `intent_contract` locked to `component:
"review-topology"` / post-Round-0 `intent_review` with `round >= 1`), so a
provider that only sees the JSON schema cannot combine a manifest lock with a
reduction review or attach either to the wrong round. Questions also regained
the `workflowGate` stage/kind override for addressing non-deep-interview gates,
and such overridden questions are excluded from the interview recorder.

### Fixed (`SKC_PY` / `PI_PY` / `PI_JS` eval backend selection was ignored)

`resolveEvalBackends` existed but the eval tool never called it: backend
allowance was read from settings only, so `SKC_PY=js` still spawned the Python
kernel. The tool now resolves allowance through the documented precedence
(`SKC_PY`, then legacy `PI_PY`/`PI_JS`, then `eval.py`/`eval.js` settings).

### Fixed (stale model discovery result could overwrite a fresher one)

Overlapping `refreshProvider` calls for the same provider raced without any
ordering guard: whichever fetch *completed* last published its discovery state
and model list, so a slow stale response could erase the models a fresher
refresh had just delivered. Discovery now carries a monotonic per-provider
sequence and only the newest-started refresh may publish state or contribute
models.

### Fixed (post-merge repair: type-check and test contracts realigned)

The upstream merges left the workspace `check` red for several releases: test
files frozen at fork v0.4.7 kept exercising APIs their source had since dropped
(session-sticky canonical model resolution, `getSelectorSuppressionStatus`,
`refreshPresetProfiles`, the pre-broker in-process `AcpAgent`, the fork-era
bridge-client `WorkflowGate` surface). Stale suites superseded by current
coverage were removed, the survivors were realigned to the shipped APIs, the
form-elicitation bridge kept its only coverage via a ported focused suite, the
`node-pty` dev dependency the merge dropped from `@sayknow-cli/tui` is restored,
and the extracted model helper modules (`config/model-auth`,
`config/model-bindings-applier`, `config/model-discovery-manager`) are now
explicitly unexported, matching the documented package surface.

### Fixed (todo_write truncation and retry loops)

Structurally complete JSON tool calls now execute even when a Responses provider
hits its output-token limit before emitting the final item event. Invalid todo
payloads retry at most once, while transport failures and repeated errors fail
open so the requested work continues without visible todo tracking.

### Fixed (v0.5.0 upstream merge reverted the fork's tmux graphics support)

The v0.12.0 upstream merge overwrote `packages/tui/src/tui.ts` and silently
dropped three fork-only behaviors, which is why the pet was unavailable in every
tmux session and `packages/tui/test/sixel-probe.test.ts` shipped with three
failing tests:

- the capability probe refused to run under any multiplexer, so
  `isSixelMultiplexerEnabled()` became dead code
- the sixel probe was no longer wrapped in tmux's DCS passthrough envelope, so
  tmux answered for a client it knows nothing about
- the `CSI 16 t` cell-size query lost its passthrough wrapper (the v0.4.6 fix),
  so tmux reported a cell size the outer terminal never uses

All three are restored, with the probe deadline back at 600 ms under tmux to
cover the passthrough round trip.

### Fixed (transcript images stacked over the text under tmux)

Enabling the sixel probe under tmux also switched INLINE graphics on, and the
inline path wrapped every raster in the DCS passthrough envelope. Passthrough
writes pixels straight into the OUTER terminal's image plane at its *physical*
cursor: tmux neither positions that cursor for the pane nor records the pixels,
so tool-result screenshots landed in the wrong row and survived every repaint —
each render stacked another copy over the transcript.

Inline placements now follow the same ownership rule the pet already used:

- tmux advertising the `sixel` terminal-feature (which the SKC tmux profile sets
  automatically) parses the raster into its own screen model, so the raster is
  written raw and scroll / erase / resize move the image with its text.
- Without that feature the inline render returns the `[image/png …]` placeholder
  instead. An image welded to the outer terminal's physical cursor for the rest
  of the session is worse than no image.
- Absolutely positioned overlays (the pet) are unaffected: they carry their own
  coordinates through the envelope and remain the only passthrough user.

### Added (Sayknow Pet under tmux on kitty-protocol terminals)

Ghostty, Kitty and WezTerm implement kitty graphics and no sixel at all, so the
sixel probe alone left them with no pet inside tmux. SKC now also forwards a
kitty capability query (`a=q`) through the passthrough envelope. tmux cannot
answer it on the terminal's behalf — it does not implement the protocol — so an
`OK` coming back is genuine end-to-end evidence, unlike tmux's compile-time DA1
sixel claim.

- A successful query enables a dedicated **overlay** channel
  (`setTmuxOverlayImageProtocol`) rather than inline image rendering: absolutely
  positioned art can carry its own cursor addressing through the envelope, while
  inline placements would land at tmux's stale physical cursor.
- Overlay payloads now carry the pane origin (`#{pane_top}`, `#{pane_left}`, and
  top status lines), so a split window or a top status bar no longer draws the
  pet in the wrong place. This also fixes the pre-existing sixel-fallback path.
- `allow-passthrough` is requested pane-locally at startup, so a tmux pane the
  user created by hand works without manual configuration.
- Kill switch: `SKC_KITTY_MULTIPLEXER=0`.
- The tmux-specific unavailable warning no longer tells users to leave the
  multiplexer or to force sixel; it names the actual requirement.

Verified end to end on Ghostty 1.3.1 + tmux 3.6b: pane passthrough is enabled
automatically, the probe reports `ImageProtocol.Kitty`, and the outer terminal's
real cell metrics (16x34) replace the 9x18 default.

## [0.5.1] — 2026-07-29

Built on upstream **v0.12.0**.

### Fixed (Sayknow Pet still left sixel residue under tmux)

0.5.0 gave tmux ownership of the pet's sixel, which is the real fix — but it only
takes effect for a client that attaches *after* the feature is set, because tmux
computes client features at attach time. Every already-attached client kept
falling back to DCS passthrough, and that fallback still erased at tmux level
while its pixels lived in the outer terminal. So the residue persisted for
exactly the people who already had a session open.

- **The erase now rides the same envelope as the draw.** When the frame goes out
  through passthrough, the erase does too, reaching the terminal that actually
  holds the image; the absolute coordinates match because the draw used the same
  ones. When tmux owns the sixel, the erase stays at tmux level as before.
- **`terminal-features` is set with the correct scope.** It is a *server* option,
  so the previous `set-option -aq -t <target>` silently ignored the target. Now
  `set-option -saq`.
- Added a regression test that pins the multiplexer environment and asserts draw
  and erase share one envelope. The pet suite previously inherited whatever
  terminal the developer ran it in, so it passed on CI and failed inside tmux;
  the environment is now pinned per test.

## [0.5.0] — 2026-07-28

Built on upstream **v0.12.0** (previous fork release tracked v0.11.6).

### Security (inherited from upstream v0.12.0)

Every path below trusted the caller's `cwd/.env`, so **opening a hostile repository
was enough** to trigger it. All now resolve through the non-project resolver
(launching shell plus SKC/user-owned files); shell and user configuration are
unchanged.

- **Provider base URLs** — `<PROVIDER>_BASE_URL` is derived generically, so a planted
  `.env` could redirect authenticated traffic for *every* provider.
- **Browser launch overrides** — could pick the browser binary, route all traffic
  through an attacker proxy, and disable certificate validation.
- **Spawned command overrides** (`SKC_SDK_SESSION_COMMAND`,
  `SKC_HARNESS_PROCESS_START_COMMAND`) — chose which binary those paths execute.
- **Smithery origin / API base / API key** — the auth session the user is sent to,
  and the credential sent with every call.
- **Native skill hook config dirs** — could point the hook at a directory the repo
  ships and inject its own `skills.customDirectories`, bypassing escalation guards.

Also: **memory consolidation now redacts GitHub tokens.** The scrubber covered AWS
ids, JWTs, and keyword-prefixed keys, but `ghp_` / `gho_` / `github_pat_` carry none
of those markers, so a token reached `MEMORY.md` and `memory_summary.md` verbatim —
and that summary is injected into every later session.

### Changed (upstream replaced two surfaces the fork had ported)

- The typed deep-interview **draft** CLI was reverted upstream and replaced with a
  staged-transition surface (`stage --for <transition> --input '<json>'`, `check`,
  `apply`, `discard`; one pending draft per session, no `--draft-id`). The fork
  follows upstream here rather than keeping a surface upstream retired.
- The fork's `absoluteClear` multiplexer width-reflow repair is superseded by
  upstream's width-settle repair, which runs once per settled width sequence
  instead of once per SIGWINCH. Upstream's implementation is kept.

### Fixed (Sayknow Pet leaves sixel residue under tmux)

- **Give tmux ownership of the pet's sixel instead of smuggling it past tmux.**
  The pet was drawn with DCS passthrough, which writes pixels straight into the
  outer terminal's image plane, while the erase was an `ECH` that only ever
  reached tmux's cell buffer. tmux never recorded the image, so nothing could
  remove it — every frame stacked another vertical band above the pet.

  This is the same root cause behind the oversize/frozen animation (0.4.6) and
  the viewport scroll (0.4.7): tmux's screen model and the real screen disagreed.
  Those releases each patched the *draw* path; the *erase* path was never
  revisited, so the residue survived all three fixes.

  SKC-launched sessions now append `terminal-features ,*:sixel`, and the widget
  sends the frame directly whenever tmux claims sixel. tmux 3.4+ parses it into
  its own screen model (`screen_write_sixelimage`) and re-renders it, so the
  existing erase actually deletes the image and scroll/resize/copy-mode stay
  consistent. Passthrough remains only as the fallback for terminals or tmux
  builds that do not claim sixel.

### Fixed (rebrand leakage)

- **Stop creating legacy-branded recovery paths.** `recovery_fs` and
  `path_identity` still wrote legacy-branded recovery and removal marker
  directories on disk: the rename never reached them, so recovery state landed
  under an upstream-branded directory name. 24 residual tokens are gone and the
  build now fails instead of shipping them.

### Fixed (fork pipeline)

The fork layer is regenerated as `gen-tree(upstream tag) = codemod + deletions +
overlay + patches + identity`. Five defects made that identity false:

- **Overlay swallowed upstream changes.** 66 upstream-owned files were carried as
  whole-file overlays, so every upstream edit to them was silently discarded —
  including `packages/tui`'s `node-pty` dependency. Ownership is now decided by
  the base tree: present upstream ⇒ patch, absent ⇒ overlay (45 → 134 patches).
- **Release versions leaked into patch context.** A version bump invalidated the
  context lines of unrelated hunks, so patches rejected on every release. Version
  text is now neutralized on both sides of extraction and restored by the identity
  stamp.
- **Deletions were unrepresentable.** Upstream files the fork drops (`crates/skc-sdk`
  and others) reappeared on each sync; they are now declared and replayed.
- **Binary assets were declared as patches**, producing unappliable
  "Binary files differ" stubs. They are demoted to overlay automatically.
- **The codemod never converged.** Overlay and patch payloads carry upstream text
  that the single first pass cannot see, so the idempotence gate could not pass.

`gen-tree` also refuses to run against the fork repo itself — an empty argument
previously codemodded and version-stamped the working tree in place.

### Added (ported from upstream)

- `ServerHandle::push_frame_and_wait` in `skc-notifications`, so the SDK can await
  per-connection delivery receipts instead of fire-and-forget broadcast.
- `Process.signalRoot` napi binding for pinned single-process signalling.
- Worker integration attempts accept an `AbortSignal` and bail between git probes.
- The deep-interview staged-transition surface (`stage`, `check`, `apply`, `discard`,
  `initialize-context`, `confirm-topology`).

## [0.4.7] — 2026-07-24

### Fixed (Sayknow Pet scroll under tmux)

- **Wrap the pet's sixel draw (save-cursor + position + sixel + restore-cursor)
  in a single tmux DCS passthrough unit.** The pet uses `DECSC`/`DECRC`
  (`\x1b7`/`\x1b8`) to stay cursor-neutral, but those bytes were emitted outside
  the passthrough envelope, so only tmux saw them — the outer terminal received
  just the cursor-advancing sixel via passthrough, never restored its cursor,
  and scrolled the whole viewport up on every animation frame (leaving the pet
  pinned in place). The save/restore now travels with the sixel through
  passthrough, so the outer cursor returns and nothing scrolls. The footprint
  clears stay tmux-level so tmux still repaints the vacated cells. Only affected
  tmux + a sixel terminal.

## [0.4.6] — 2026-07-23

### Fixed (Sayknow Pet sizing/animation under tmux)

- **Wrap the terminal cell-pixel-size query (`CSI 16 t`) in tmux's DCS
  passthrough envelope.** Under tmux the query was answered by tmux itself with
  a wrong cell size, so the sixel pet was encoded far too large — it overflowed
  the composer and its animation froze (the oversized sprite resolved to an
  out-of-bounds position, so each animation frame's overlay payload became
  `null` and never redrew). The outer terminal now reports its real cell size,
  so the pet renders at its intended 2-row height and animates. Only affected
  tmux + a sixel terminal (the 0.4.5 pet-in-tmux path); non-multiplexed
  rendering was already correct.

## [0.4.5] — 2026-07-23

### Added (Sayknow Pet in tmux)

- **Auto-enable the Sayknow Pet (and inline sixel graphics) under tmux when the
  outer terminal genuinely supports sixel.** Previously graphics were
  unconditionally suppressed under any multiplexer because tmux advertises
  compile-time sixel support (`DA1 ";4"`) regardless of the attached terminal,
  and no code emitted the DCS passthrough envelope. Now:
  - The startup sixel capability probe runs under tmux with its DA1 +
    XTSMGRAPHICS queries wrapped in tmux's `\ePtmux;…\e\\` passthrough envelope,
    so the **outer** terminal answers — a positive reply is genuine end-to-end
    evidence, not tmux's unreliable self-report. screen/zellij (no passthrough
    envelope) stay suppressed.
  - Sixel render output (pet frames + inline images) is wrapped in the same
    passthrough envelope under tmux.
  - SKC-launched tmux sessions set `allow-passthrough on` (pane-scoped, quiet on
    tmux < 3.3) automatically.
  - Probe-gated and safe: terminals that do not actually render sixel through
    tmux (e.g. Ghostty, which uses the kitty protocol and has no sixel) never
    activate it, so no garbage escapes are emitted. Set `SKC_SIXEL_MULTIPLEXER=0`
    to force the pre-0.4.5 behavior (graphics off under tmux).

## [0.4.4] — 2026-07-22

### Fixed (workflow arbitration native)

- **Port `skc-notifications` to upstream v0.11.6 and switch pi-natives to
  `sdk.rs`.** 0.4.x synced upstream's coding-agent, whose SDK bus requires the
  native `NotificationServer` arbitration API (`registerArbitratedAsk`,
  `retireIfUnclaimed`, `stopAndWait`). But the fork's `skc-notifications` crate
  was stuck at upstream v0.9.1, so `crates/pi-natives/src/sdk.rs` (restored from
  v0.11.6) could not compile against it and was dropped from `lib.rs`. The
  shipped `notifications.rs` `NotificationServer` lacked the arbitration
  methods, so every SDK session startup threw `NativeRuntimeCompatibilityError`
  ("required workflow arbitration methods are missing") — extensions failed to
  load and no session could start on 0.4.1–0.4.3.
- Upgrades `crates/skc-notifications` v0.9.1 → v0.11.6 (adds the
  `broker_protocol`/`control`/`query`/`reverse` modules and the `hmac` workspace
  dependency), wires `mod sdk;` and retires `notifications.rs`. This restores
  the arbitration API **and** the SKC v3 SDK connection lane
  (`onSdkFrame`/`sendTo`/`onConnectionClose`/`registerWorkflowGateAsk`/
  `pushTurnStreamUnchecked`), which was also dead in 0.4.1–0.4.3. No native
  method that the fork already relied on is removed (`sdk.rs`'s
  `NotificationServer` is a strict superset of `notifications.rs`).

## [0.4.3] — 2026-07-21

### Fixed (cross-platform native publish)

- **pi-natives ps.rs: restore `Process.incarnation` getter.** The fork's
  `crates/pi-natives/src/ps.rs` predated upstream v0.11.x's
  `#[napi(getter)] incarnation` method; the chat/telegram daemon control
  runtimes (`sdk/bus/{chat,telegram}-daemon-control.ts`) read
  `processRef.incarnation` for ownership authority, so typecheck failed
  with `Property 'incarnation' does not exist on type 'Process'`.
- **sdk/bus/index.ts: use `NotificationServer.stop()` instead of `stopAndWait()`.**
  The fork's `NotificationServer` (notifications.rs) is synchronous and
  pre-upstream-split; the v0.11.x TS calls `stopAndWait()` which is the
  upstream async variant. TODO(port): add `stop_and_wait` to
  pi-natives/src/notifications.rs when the daemon API is ported forward.

### Strategy change

v0.4.3 is published entirely by CI (no local `bun publish`). v0.4.2's
release hit an integrity-evidence conflict because the darwin-arm64
subpackage was published both locally (from a Mac-built .node) and from
CI (from a CI-built .node) with different SRI hashes; `ci-release-publish`
correctly rejected the second one. For v0.4.3 all 9 main packages + 5
platform subpackages publish from a single CI run.

## [0.4.2] — 2026-07-21

### Fixed (post-0.4.0 publish)

- **Native loader: nested node_modules fallback.** Bun's `-g` install creates a
  nested layout where each workspace package owns its own `node_modules/`. The
  loader's single hardcoded platform-subpackage path
  (`../../natives-<platform>/native`) assumed npm's flat hoist, so `bun install
  -g sayknow-cli` could not resolve the .node and crashed at startup with
  `Failed to load pi_natives native addon`. Added a third candidate path that
  covers `natives/node_modules/@sayknow-cli/natives-<platform>/native`.
- **Catalog resolution via `bun install`.** v0.4.0 was published with stale
  `bun.lock` workspace versions (still pinned to 0.3.16), so `bun publish`
  resolved `catalog:` deps to 0.3.16 and the umbrella ended up depending on
  the previous release's `@sayknow-cli/coding-agent`. v0.4.2 republishes after
  regenerating `bun.lock` from the bumped catalog (0.4.2 everywhere).
- **Native version sentinel.** Rebuilt `pi_natives.darwin-arm64.node` after the
  version bump so it exposes `__piNativesV0_4_2` (the v0.4.0 binary's
  `__piNativesV0_4_0` failed the loader's release-match check).

### Deprecated (on npm)

- `sayknow-cli@0.4.0` and `@sayknow-cli/*@0.4.0` — broken catalog: resolution.
- `sayknow-cli@0.4.1` and `@sayknow-cli/*@0.4.1` — loader missing nested
  `node_modules` fallback.

## [0.4.0] — 2026-07-21

### Changed

- Synced onto upstream **v0.11.6** (from v0.6.0), a 5-minor-version jump
  bringing v0.7–v0.11 evolution: managed chat daemon (#2782, #2785, #2786), Telegram
  lock auto-reconciliation (#2781), compiled startup import-cycle fix (#2779), legacy
  daemon tombstone reclamation (#2780), nextest CI hardening (#2777), and the new
  `/handoff` slash command (#2746).
- Rebrand layer regenerated via `extract-fork-layer`: **485 overlay files** (was 188) —
  captures fork-owned content in `notifications/`, `modes/rpc/`, `modes/bridge/`,
  `modes/shared/agent-wire/`, `python/skc-rpc/`, and `crates/skc-notifications/` that
  prior extractions had missed.
- CI workflow: `sayknow-v*` tag prefix now drives every release-gated job
  (`native`, `binaries`, `publish`) via a global prefix check.
- `crates/pi-natives` overlay now ships the fork's actual `skc-notifications` path
  dep instead of the codemod-renamed `skc-sdk` straggler.

### Added

- **SDK subpath exports.** `@sayknow-cli/coding-agent/sdk` and `./sdk/bus/*` are now
  declared in `package.json#exports`, matching upstream's `sdk/` directory split.
- **MRU-aware model fallback** ported from old `sdk.ts` into `sdk/session.ts`:
  when no model is explicitly selected, the fallback ranks candidates by
  most-recently-used, then each provider's curated default, then catalog order
  (was first-catalog-match, which cold-started users on ancient models).
- **i18n: settings tabs.** New `settings.tab.notifications` key; the
  `td()`-wrapped setting label/description/options helpers in `settings-selector.ts`
  cover all tabs including `integrations` and `notifications`.
- **Team runtime fork extensions** now declared in `SkcTeamStartOptions` /
  `SkcTeamConfig`: `mailboxDeliveryTransport`, `skc_session_id`, `platform`.
  `WorkerHeartbeatFile` / `WorkerStatusFile` are now properly exported from
  `team-runtime.ts`.

### Removed

- **Dead patches dropped** from the rebrand manifest:
  - `ci-release-publish.ts` patch — superseded by upstream's richer retry loop
    (`visibilityRetries`, `isTransientVisibilityError`).
  - `sdk.ts` `guardToolForUltragoalAsk` simplification — upstream expanded the
    signature with `UltragoalAskGuardContext`; the fork's single-arg form is obsolete.
  - `interactive-mode.ts` `getPlanReviewHelpText` `t("nav.hint")` — the function was
    removed upstream when plan review moved to `plan-preview-overlay.ts`.

### Known issues (test debt)

- 67 test errors remain from upstream API drift (`model-profile-activation`,
  `model-registry`, `sdk-*`, etc.). All product code typechecks clean (0 src errors)
  and brand/i18n/welcome suites pass (40/40). Test mock migration is filed as a
  follow-up.

## [0.3.0] — 2026-06-23

### Changed

- Synced onto upstream **v0.7.1** (from v0.6.5), bringing 0.7.0's mobile
  notifications SDK + managed Telegram daemon and 0.7.1's fixes (assistant
  notification lead-in, stale tmux session reuse, packaged native imports, and the
  glm-zcode Z.AI provider) while preserving the Sayknow-CLI brand.

### Added

- **Decepticon red-team integration.** Vendored [Decepticon](https://github.com/PurpleAILAB/Decepticon)
  as a git submodule (`vendor/decepticon`) plus `python/decepticon-bridge` — an
  `skc-rpc` host-tool bridge that exposes Decepticon's red-team agents to skc
  (`decepticon_run_agent` / `decepticon_list_agents`).
- **Ponytail default rule.** Bundled the ponytail "lazy senior dev" ruleset as an
  always-on default rule: pick the simplest working solution first (YAGNI, reuse,
  stdlib/native first) without ever cutting validation, error handling, security,
  or accessibility. Adapted from [ponytail](https://github.com/DietrichGebert/ponytail) (MIT).

## [0.2.7] — 2026-06-23

### Added

- **Plugin install security scan (advisory).** Newly installed plugins/skills are now
  statically scanned before activation for risky patterns — `curl|bash` download-and-exec,
  `eval`/dynamic import, credential/secret access, obfuscation, cron persistence, and
  package-install markers — with risk scoring. Findings surface as warnings in the install
  output and in `plugin doctor`. Controlled by `plugins.security.scanMode`
  (`warn` = default, `off`, `block`) and `plugins.security.riskThreshold`. Warn-only by
  default — it never blocks an install unless you opt into `block` mode.

## [0.2.6] — 2026-06-22

### Fixed

- The welcome screen's "Updated to vX" line now reflects the running release.
  0.2.5 shipped without its own changelog entry, so a fresh launch reported
  "Updated to v0.2.4"; every release now carries a matching entry.

## [0.2.5] — 2026-06-22

### Changed

- Synced onto upstream **v0.6.5** (from v0.6.0), bringing its latest
  features and fixes while preserving the Sayknow-CLI brand. The new welcome
  logo-mode support renders the blue **SAYKNOW** wordmark in every mode.

### Fixed

- Hardened shutdown against terminal/volume I/O errors: an asynchronous EIO/EPIPE
  stdout write failure during teardown (controlling terminal hang-up or a stalled
  external volume) is now swallowed instead of crashing the process into a
  "[Process exited] — press any key to restart" loop.
- Regenerated the bundled config JSON schema so it matches the v0.6.5 settings.

## [0.2.4] — 2026-06-19

### Added

- The model selector is now fully localized — the preset list ("Model presets",
  "Create custom preset", "Browse all models"), the apply/default scope menu,
  action menus, and hints follow the interface language. Model and provider names
  (Claude, Codex, …) stay verbatim.

### Fixed

- Release builds no longer fail spuriously on a timing-flaky pi-shell
  process-reaping test: the Rust test runner now retries flaky tests
  (`cargo nextest --retries 2`).

## [0.2.3] — 2026-06-19

### Fixed

- `skc update` and the binary installer pointed at a non-existent repo path
  (`jaybeyond/sayknow-cli`, lowercased by the rebrand) and 404'd. They now use the
  real repo `jaybeyond/Sayknow_CLI`, so in-app updates and the install script work.

### Changed

- **Now on npm.** Install and upgrade with `npm install -g sayknow-cli`
  (`@latest` to upgrade, or `skc update`). The READMEs lead with the npm install;
  building from source moved to its own "Install from source (development)" section.

## [0.2.2] — 2026-06-18

### Fixed

- Model selection on a fresh launch (no saved default, no session to restore) now
  resumes the model you used last — and brand-new users land on a modern default —
  instead of cold-starting onto the oldest model in the catalog.
- The model selector no longer lets the "log in for an unauthenticated preset" flow
  hijack the selection of an already-authenticated model.
- Continuous integration is green: the rebrand codemod now re-applies Biome's
  organize-imports/format pass, the fork version is stamped into the native version
  sentinel, the generated JSON schemas are current, and the default-theme references
  are consistent across runtime, settings, and docs.

### Changed

- The default theme is **blue-octopus** for both dark and light terminals, with
  **red-octopus** as the bundled warm, high-contrast alternate.

## [0.2.0] — 2026-06-18

### Changed

- Synced onto upstream **v0.6.0** (52 commits, +27k lines), bringing its
  new features and fixes — including the opt-in `skc rlm` research mode, the goal
  `pause` operation, steer-by-default while busy, and the experimental
  desktop-control tool surface — while preserving the Sayknow-CLI brand and the
  improvements below.

## [0.1.0] — 2026-06-17

Initial Sayknow-CLI release, forked from upstream v0.5.4.

### Added

- **Internationalization — 7 languages:** English, 한국어, 中文 (简体), 日本語,
  Español, Français, Deutsch. System-locale auto-detection on first run, a
  `Settings → Appearance → Language` switch, and translated settings, slash-command
  descriptions, status/error messages, and the welcome screen. Brand and technical
  names (Claude, OpenAI, MCP, …) stay verbatim. Localized READMEs live under
  `docs/readme/`.
- **Blue-octopus identity:** a blue octopus mascot 🐙, the `blue-octopus` default
  theme (with a warm `red-octopus` alternate), a `SAYKNOW` wordmark welcome screen,
  and the tagline _"Coding should feel like thinking."_
- **Richer status bar:** a visual context-usage bar plus input/output tokens, cache
  reads, token rate, cost, rate-limit quota, and elapsed time.

### Changed

- Rebranded the upstream harness → **Sayknow-CLI** (`skc`, `@sayknow-cli/*`) and reset the
  version to 0.1.0.
- The model selector now starts OAuth login directly when you pick an
  unauthenticated preset, instead of only printing a hint.
- The input caret now shows as soon as the composer is focused, not only after the
  first keystroke.

### Fixed

- OAuth login: guard against concurrent logins and let `Esc` cancel an in-flight
  login — previously two logins could collide on the fixed callback port and freeze
  the UI with no way back.

### Removed

- The GitHub star reminder is disabled by default.
