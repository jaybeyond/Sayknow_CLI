# Non-compaction auto-retry policy

This document describes the standard API-error retry path in `AgentSession`.

It explicitly excludes context-overflow recovery via auto-compaction. Overflow is handled by compaction logic and is documented separately in [`compaction.md`](../docs/compaction.md).

## Implementation files

- [`../src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`../src/config/settings-schema.ts`](../packages/coding-agent/src/config/settings-schema.ts)
- [`../src/modes/controllers/event-controller.ts`](../packages/coding-agent/src/modes/controllers/event-controller.ts)
- [`sdk.md`](./sdk.md) for the external machine interface.

## Scope boundary vs compaction

Retry and compaction are checked from the same `agent_end` path, but they are intentionally separated:

1. `agent_end` inspects the last assistant message.
2. `#isRetryableError(...)` runs first.
3. If retry is initiated, compaction checks are skipped for that turn.
4. Context-overflow errors are hard-excluded from retry classification (`isContextOverflow(...)` short-circuits retry).
5. Overflow therefore falls through to `#checkCompaction(...)` instead of standard retry.

So: overload/rate/server/network-style failures use this retry policy; context-window overflow uses compaction recovery.

## Retry classification

`#isRetryableError(...)` requires all of the following:

- assistant `stopReason === "error"`
- `errorMessage` exists
- message is **not** context overflow
- `errorMessage` matches transient transport/envelope patterns or `isUsageLimitError(...)`

Current retryable inputs are regex/string-classified:

- transient transport/envelope failures, including Anthropic stream-envelope failures before `message_start`
- overloaded/provider-returned-error wording
- rate limit / usage limit / too many requests
- HTTP-like server classes: 429, 500, 502, 503, 504
- service unavailable / server/internal error
- provider-suggested retry wording, including OpenAI `retry your request` failures
- network/connection/socket failures, refused/closed connections, upstream connect/reset-before-headers, socket hang up, timeout/timed out, fetch failed, terminated, retry delay wording, and unexpected socket close messages

Managed fallback uses structured transport facts and typed provider error codes when available. A structured classification of `other` becomes the bounded `unknown` fallback class; error prose cannot promote it to quota or transient. Regex classification is retained only as a legacy fallback.

## Retry lifecycle and state transitions

Session state used by retry:

- `#retryAttempt: number` (`0` means idle)
- `#retryPromise: Promise<void> | undefined` (tracks in-progress retry lifecycle)
- `#retryResolve: (() => void) | undefined` (resolves `#retryPromise`)
- `#retryAbortController: AbortController | undefined` (cancels backoff sleep)

Flow (`#handleRetryableError`):

1. Read `retry` settings group.
2. If `retry.enabled === false`, stop immediately (`false`, no retry started).
3. Increment `#retryAttempt`.
4. Create `#retryPromise` once (first attempt in a chain).
5. Default transient same-model recovery is bounded by one shared step budget: 7 upstream requests and 15 minutes after the first failure. Every concrete request counts, including hidden SDK resends, credential/token fetches, and websocket frames. An explicit `retry.maxRetries` or `fallback.maxAttempts` keeps its own attempt unit and also stays inside that budget. Unknown/no-code errors stop after `retry.maxRetries`.
6. Compute exponential full-jitter delay. Default transient recovery uses a 1s base and 30s cap; explicit `retry.baseDelayMs` / `retry.maxDelayMs` win. Legacy parsed provider retry-after values override computed backoff and are capped at `retry.maxDelayMs`, while managed typed Retry-After values are intentionally uncapped.
7. On a managed fallback chain, quota/rate-limit failures first try another logged-in account of the same provider (`markUsageLimitReached(...)`) and auth failures invalidate the matching credential; if the active credential changes, force delay to `0`, otherwise use the applicable backoff. This credential maintenance (account rotation, restore, usage probes) spends the same step budget as inference: every token/usage HTTP request is admitted as kind `"token"`, and maintenance never runs when no step budget is active, so it cannot send unadmitted credential HTTP.
8. Eligible ordered role-array fallback chains advance on entry-budget exhaustion. A selected fallback entry remains sticky until the head selector's rate-limit cooldown expires, when `retry.fallbackRevertPolicy: cooldown-expiry` probes it again on a new turn. Transient failures never change the model.
9. Emit `auto_retry_start`.
10. A failure with no public output removes the trailing assistant error message from agent runtime state (kept in persisted session history). A failure after public text keeps that text exactly as shown and never deletes or re-emits it. When the step is not inside a managed fallback attempt, the model API is `openai-completions` or `anthropic-messages` (not the pi-native transport), and the public tail is plain text, the session checkpoints the text and appends one hidden continuation instruction on the same model. Otherwise (a managed attempt, another API, a tail with tool calls, images, or signed/redacted thinking) the step pauses with its output preserved, and the user resumes it with a new message.
11. Sleep with abort support.
12. Schedule `agent.continue()` through the post-prompt task scheduler (`delayMs: 1`) for the same prompt generation.
13. A process restart with an unconsumed continuation instruction does not send it automatically.
14. Consecutive first-event or idle timeouts with no output (`retry.maxSilentTimeouts`, default 3, range 1-7) close the step's admission early. The counter resets when an attempt produces output or the model changes; it never raises the 7-request / 15-minute budget.

### Automatic resume of an interrupted step

With `retry.autoResume` (default `true`) an interrupted step resumes once per user turn without a new user message, on the interrupted model. The resume never switches models or advances a fallback chain. Inside the resumed run, a transient failure under the default shared step budget may still retry on the same model. Any other failure stops with the provider error instead of moving to the next chain entry. This includes quota, auth, and any failure when `fallback.maxAttempts` is set.

- **When it runs:**
  - after a transient failure (or no-output timeout) that follows executed tools or a visible text prefix, when the step's budget can still admit a request;
  - on startup continuation (`--continue` with no new input) when the last recovery checkpoint records an unfinished step.
- **Not resumed:** rate-limit and quota failures. A stale continuation instruction found at startup is also left for the user.
- **Budget:**
  - **In-process:** a resume spends what is left of the interrupted step's budget.
  - **Restart:** the old budget, deadline and request outcome are unknown and never reused. The resumed step gets a small fresh envelope of 2 requests within 120 seconds, with an armed deadline. Later steps of the resumed run use the normal budget.
- **Tools whose outcome was not observed:** each such call receives an error result saying it was interrupted and not re-run. This only arises after a restart. In process, every executed call already has a result, so the resume keeps all tools. While any exist, the resumed turn sees and may run only the built-in `read`, `search`, `find`, `ast_grep` and `locate` tools. A tool qualifies only as the built-in instance with a unique wire name; extension, MCP and name-alike tools never do. Tools behind extension or hook interception wrappers are still identified by their built-in class. The selected tool set is not changed. The restriction ends when the run settles or a user message reaches the model; merely queuing a message does not lift it.
- **Durability first:** the resume marker, placeholders and hidden instruction are written and flushed before anything is sent. A failed write sends nothing.
- **It pauses as before** when any of these hold:
  - a resume marker already exists after the last user message;
  - the last answer already finished;
  - unobserved remote work was recorded, including a persisted `uncertain` reason or a Cursor/pi-native step;
  - the tail holds signed/redacted thinking or partial tool calls;
  - a visible prefix that the current serializer cannot replay;
  - the checkpoint's model differs from the current model;
  - the budget is spent;
  - user input is queued;
  - no restart-safe tool is available while unobserved calls exist.
- **Uncertainty is persisted:** in-step uncertainty is written to the step's `in_flight` checkpoint together with its `selector`, `api` and `transport`. The next admission and every resume decision wait for that write. A failed write closes admission for that step only and is reported; the next user message starts normally.

### What resets retry counters

`#retryAttempt` resets to `0` in these cases:

- first successful non-error, non-aborted assistant message after retries started (emits `auto_retry_end { success: true }`)
- retry cancellation during backoff sleep
- max retries exceeded path

`#retryPromise` resolves/clears when retry chain ends (success, cancellation, or max-exceeded), via `#resolveRetry()`.

## Backoff and max-attempt semantics

Settings:

- `retry.enabled` (default `true`)
- `retry.maxRetries` (default `3`)
- `retry.baseDelayMs` (default `2000`)
- `retry.maxDelayMs` (default `300000`)
- `retry.requestMaxRetries` (default `5`) — provider request retries before a stream is established; counts retries, not the initial request
- `retry.streamMaxRetries` (default `5`) — provider stream replay retries for replay-safe transient stream failures; counts retries, not the initial stream attempt

Attempt numbering:

- attempt counter is incremented before max-check
- start events use current attempt (1-based)
- max-exceeded end event reports `attempt: this.#retryAttempt - 1` (last attempted retry count)

Backoff uses capped exponential full jitter: attempt `k` waits a random delay in `[0, min(base × 2^(k-1), max))`.

- Default shared-budget transient recovery uses a 1000 ms base and a 30 s cap, so the maximum jitter windows are 1000 / 2000 / 4000 ms for attempts 1 / 2 / 3. An explicitly set `retry.baseDelayMs` or `retry.maxDelayMs` replaces the corresponding default.
- Every other path (explicit `retry.maxRetries`, non-transient classes, managed per-entry budgets) uses `retry.baseDelayMs` (default `2000`) and `retry.maxDelayMs` (default `300000`); with the 2000 ms default the windows are 2000 / 4000 / 8000 ms.

`retry.maxDelayMs` caps every legacy session retry delay, including provider retry-after hints, which otherwise take precedence over computed backoff. Managed fallback intentionally does not cap typed Retry-After values because it retries within its separate per-entry budget. Default transient recovery is bounded by the shared step budget (7 requests, 15 minutes after the first failure); unknown/no-code errors are bounded by `retry.maxRetries`. Setting `retry.enabled` to `false` disables automatic same-model recovery.

## Abort mechanics

### Explicit retry abort

`abortRetry()`:

- aborts `#retryAbortController` (if present)
- resolves retry promise (`#resolveRetry()`) so awaiters are unblocked

If abort hits while sleeping, catch path emits:

- `auto_retry_end { success: false, finalError: "Retry cancelled" }`
- resets attempt/controller

### Global operation abort interaction

`abort()` calls `abortRetry()` before aborting the active agent stream. This guarantees retry backoff is cancelled when user issues a general abort.

### TUI interaction

On `auto_retry_start`, EventController:

- swaps `Esc` handler to `session.abortRetry()`
- renders loader text: `Retrying (attempt/maxAttempts) in Ns… (esc to cancel)`

On `auto_retry_end`, it restores prior `Esc` handler and clears loader state.

## Streaming and prompt completion behavior

`prompt()` ultimately waits on `#waitForRetry()` after `agent.prompt(...)` returns.

Effect:

- a prompt call does not fully resolve until any started retry chain finishes (success/failure/cancel)
- retry lifecycle is part of one logical prompt execution boundary

This prevents callers from treating a retrying turn as complete too early.

## Controls: settings and SDK actions

### Configuration knobs

The standard retry controls are defined in the settings schema under `retry`:

- `retry.enabled`
- `retry.maxRetries`
- `retry.baseDelayMs`
- `retry.maxDelayMs`
- `retry.autoResume` (automatic resume of an interrupted step; default `true`)
- `retry.maxSilentTimeouts` (consecutive no-output timeouts before a step stops; default 3)

Fallback candidates are configured as ordered selector arrays on preset `model_mapping` roles, top-level `modelRoles`, or `task.agentModelOverrides`; `fallback.maxAttempts` controls the total request-time attempts per concrete entry. Resolution-time unavailable, unauthenticated, and unknown entries advance immediately without consuming that budget. For the session default, `fallback.models` and (with `fallback.auto`) one model per other logged-in provider are appended after the configured chain; see [Fallback chains](./models.md#fallback-chains).

On settings load, a source-aware one-shot migration still reads legacy `retry.fallbackChains` and combines the effective role chain with its ordered, deduplicated legacy tail into the corresponding role array. The legacy key is ignored after migration; it is not a retry configuration surface.

Programmatic toggles in session:

- `setAutoRetryEnabled(enabled)` writes `retry.enabled`
- `autoRetryEnabled` reads `retry.enabled`
- `isRetrying` reports whether retry lifecycle promise is active

### External control

External clients observe retry lifecycle through the [SDK machine interface](./sdk.md). The removed RPC command surface and `RpcClient` helpers are not supported.

## Event emission and failure surfacing

Session-level retry events:

- `auto_retry_start { attempt, maxAttempts, delayMs, errorMessage }`
- `auto_retry_end { success, attempt, finalError? }`
- `model_fallback_switched { eventId, from, to, reason, role, scope, activeIndex, chainLength, attemptsUsed }` — emitted once for each real fallback-model switch

Propagation:

- emitted through `AgentSession.subscribe(...)`
- forwarded to extension runner as extension events
- exposed to external clients through SDK event subscriptions
- in the TUI, `model_fallback_switched` updates the fallback-model status/notice and `EventController` consumes retry lifecycle events for loader/error UI

Final failure surfacing:

- On max-exceeded or cancellation, `auto_retry_end.success === false`
- TUI shows: `Retry failed after N attempts: <finalError>`
- Extensions/hooks receive `auto_retry_end` with same fields
- SDK clients receive the same event stream

## Permanent stop conditions

Retry stops and will not auto-continue when any of these occur:

- `retry.enabled` is false, or legacy retry settings have not been explicitly configured (`legacyRetryConfigured` fail-closed gate)
- error is not retry-classified
- error is context overflow (delegated to compaction path)
- max retries exceeded
- user cancels retry through the session/SDK action or `Esc` during retry loader
- global abort (`abort`) cancels retry first
- the step dispatched remote work whose effects cannot be observed or proven unsent: a broker forced credential refresh or broker OAuth refresh, a pi-native gateway dispatch, a Cursor agent run, or a custom OAuth provider refresh. The step stops with the original provider error; no automatic resend, visible-text continuation, credential rotation, or fallback request is admitted for it (every further upstream request of that step is refused as `cancelled`)
- the shared step budget refuses admission (`request_limit`, `deadline`, or `cancelled`). A refusal is the budget's own terminal answer and is never itself retry-classified; a backoff that would end past the deadline stops locally without contacting upstream

Manual retry (`retry()`, `/retry`) is refused while the latest persisted `recovery_checkpoint` on the branch is unresolved (not `completed` with all of its visible messages present), or while the last unfinished step left unobservable remote work unresolved. In both cases only a new user prompt resumes the session, and no upstream request is sent for the interrupted step. Switching sessions, branching, forking, handoff, and rollback re-derive this state from the persisted checkpoints of the resulting transcript and drop in-memory uncertainty that belonged to the previous transcript.

A new retry chain can still start later on a future retryable error after counters reset.

## Operational caveats

- Managed fallback uses typed transport facts and provider error codes; regex text matching is limited to the legacy retry path.
- Retry strips the failing assistant error from **runtime context** before re-continue, but session history still keeps that error entry. Exception: a visible-text continuation never removes the tail; the public text stays in runtime context and history exactly as shown, and one hidden continuation instruction is appended after it.
- SDK clients observe retry state through session events and state updates.
- Fallback state is driven by the configured ordered role array and remains on a selected fallback entry across later user prompts. A real model change emits the canonical `model_fallback_switched` event rather than a legacy retry-fallback event.
- Temporary provider-session scopes retain and restore their own fallback controller and provider state when unwound; an authoritative model selection commits those temporary scopes.

## Provider request/stream retry budgets

`retry.requestMaxRetries` and `retry.streamMaxRetries` are a separate attempt unit from session auto-retry, but not a separate request envelope. Defaults:

```yaml
retry:
  requestMaxRetries: 5
  streamMaxRetries: 5
```

`requestMaxRetries` maps to provider SDK/fetch retry counts for request setup failures such as retryable 5xx/408/429/network errors. `streamMaxRetries` maps to provider-specific stream replay loops that are safe to repeat without duplicating visible assistant output. Inside a session model step the session owns request resends: `requestMaxRetries` is forced to 0 for that step, so a retryable HTTP failure (including its `Retry-After`) reaches the session retry layer instead of waiting inside the SDK. `requestMaxRetries` keeps its meaning for direct SDK callers and other paths without a session step. Any remaining stream-level resend is admitted through the same shared step budget (7 upstream requests, 15 minutes after the first failure) as kind `"resend"` just before it is sent, and a resend records a recoverable failure, which starts the 15-minute deadline if it has not started yet. After a step reports unobservable remote work (uncertain upstream), no resend is admitted for it. Once that budget refuses admission, the provider loop ends with the admission error and sends nothing, even if its configured count is not used up. Raising either setting therefore cannot extend recovery beyond the step budget. Providers that cannot safely replay a stream continue to surface the terminal error so the session-level auto-retry layer can decide whether to retry the turn.

Fail-fast cases stay fail-fast: invalid credentials (after any credential-refresh path is exhausted), unsupported model/provider configuration, malformed requests, context overflow, explicit user aborts, and permanent quota failures are not treated as transient provider budget candidates.
