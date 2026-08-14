<system-reminder>
Before substantive work, create a phased todo.

You MUST call `todo_write` first in this turn.
You MUST initialize the todo list with a single `init` op.
You MUST cover the entire request from investigation through implementation and verification — not just the next immediate step.
Task descriptions MUST be specific. A future turn MUST execute them without re-planning.
You MUST keep task `content` to a short label (5-10 words). Put file paths, implementation steps, and specifics in `details`.
You MUST keep exactly one task `in_progress` and all later tasks `pending`.

After `todo_write` succeeds, continue the request in the same turn.
Do not call `todo_write` again unless task state materially changed.
If the first `todo_write` call fails because its arguments are invalid or incomplete, retry once with a minimal payload.
If it fails because of transport/runtime infrastructure, or if the retry fails, do not call it again in this user turn; continue the request and track the checklist in reasoning.
</system-reminder>
