# Import external sessions

Sayknow CLI can reconstruct or idempotently reuse a local session from an explicit Codex or Claude transcript file:

```text
/import-session <transcript-file> [--provider codex|claude]
```

Quote paths containing spaces. Format detection is automatic; `--provider` narrows detection and fails when the file is a different provider format.

## Supported formats

- Codex rollout JSONL containing `session_meta` and `response_item` records.
- Claude Code transcript JSONL containing user and assistant records.
- A claude.ai conversation export JSON object or array.

Native SKC transcripts and unknown data are rejected rather than guessed. The command never enumerates provider history directories or reads live provider process state.

## Safety contract

The source must be one explicitly selected regular file. Symbolic links, directories, invalid UTF-8, empty files, files larger than 64 MiB, and files whose identity changes while being read are rejected. Hard links are accepted because selection is explicit; the imported source is opened read-only and is never modified.

Import is available in the local interactive CLI only. Path-bearing `/import-session`, `/export`, and `/move` commands are neither advertised nor executable over ACP; blocked invocations are consumed without echoing their arguments.

Activation acquires an idle-only session transition after import finishes. If a response or turn starts first, the imported session remains durable and resumable from the session picker while the active work continues unchanged.

Every imported string passes through deterministic credential redaction before persistence. Redaction covers API keys and tokens, private keys, JWTs, authorization values (including JSON and non-Bearer schemes), secret assignments, and credentials embedded in URLs. A summary reports only counts and redaction kinds, never secret values.

Only the redacted source basename and exact source-byte digest enter durable provenance. The selected path and the provider's original workspace path are omitted from reconstructed model context and operator errors.

Records that cannot be mapped are not silently discarded. They are quarantined in a model-invisible custom entry as bounded metadata containing the record position, byte count, reason, and SHA-256 digest. Up to 512 digest records are retained while the total count and truncation flag remain authoritative; raw quarantined content is never persisted.

## Reconstructed context

Sayknow maps user and assistant text plus bounded tool evidence into provider-neutral context. Claude thinking blocks and command metadata do not enter model context. The reconstructed context is deterministic and bounded:

- At most 5,000 normalized messages are admitted.
- Individual messages and tool evidence are bounded.
- Oversized conversations retain a head and continuation tail separated by an explicit elision marker.
- Provenance is persisted as a custom entry outside model context.
- Reconstructed context is persisted as a display-styled custom message.

A newly materialized transcript records the provider, source format, source basename, exact source-byte SHA-256, source byte count, source session id/title when available, converter and sanitizer versions, mapped/quarantined/redacted/omitted counts, import timestamp, and SKC session id.

## Materialization and recovery

Import first performs a strict, bounded inventory of native SKC sessions for the requested workspace only. The same source digest, provider, format, converter, and sanitizer versions reuse that workspace's verified target; importing the same file into another workspace creates a separate target. This workspace filter never enumerates provider directories. A new target leaves the current session untouched until the local UI switches, and the source file is never renamed, deleted, or rewritten.

The native workspace lookup inspects at most 512 session candidates and 128 MiB of descriptor-bound transcript bytes. Exceeding either limit fails closed before publication.

Before reporting success, Sayknow flushes and reopens the new transcript and verifies that its reconstructed context is continuable. If materialization or verification fails, the unpublished partial session and its artifacts are removed; the current session and source file remain unchanged. Cleanup is verified, and an unverifiable cleanup is reported as a terminal cleanup error rather than hidden.

If local switching is cancelled after successful materialization, the imported session remains available from the session picker.
