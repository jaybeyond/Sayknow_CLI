# Standalone MCP configuration

`skc mcp add` writes only the definition supplied on that invocation to SKC's own MCP config (`~/.skc/agent/mcp.json` by default, or `./.skc/mcp.json` with `--project`). `skc mcp list` and `skc mcp remove` print redacted definitions. These commands are storage-only: normal standalone startup does not consume registered definitions.

## Tool-result images

Successful MCP tool results forward PNG, JPEG, GIF, and WebP images (including
embedded resources with an image `mimeType` and base64 `blob`) to image-capable
models on providers whose tool-result transport carries images. Providers that
flatten tool results to text, including Kiro, receive the text markers instead.
Images follow the text block in their original order. Text keeps an image
or resource marker, with a coordinate-mapping note when an image is resized, and
retains the untrusted-content wrapper. Forwarded images also carry an explicit
notice that they are untrusted server content and must be treated as data, not
instructions.

Images use the built-in shared resizer: at most 1,568 pixels per dimension and
500 KiB per image, with the same recompression and `SKC_NO_WEBP` behavior. Each
result attempts at most 16 supported images (matching the pasted-image count
limit), processes at most 16 MiB of base64 source data (the MCP response budget),
and forwards at most 4 MiB of image-file bytes after resizing, before base64
encoding. Before native decoding, source images must have dimensions no larger
than 8,192 pixels per side and no more than 16 million pixels total. Supported
image bytes determine the forwarded MIME type when a server mislabels an image.
Images that are invalid, unsupported, or over these limits retain only their
text markers. Error results remain text-only. Models without
image input use the existing provider filtering and receive text instead of image
payloads.

## Use an explicit config

A caller can opt one top-level standalone session into one trusted config file:

```bash
skc --mcp-config /absolute/path/to/mcp.json
```

The path must be absolute and identify a regular file directly; symbolic links and other indirection are rejected. SKC reads the file through one open handle and rejects it if the path, file identity, size, or modification metadata changes during the read. It exposes only that file's MCP tools and owns the server processes for that session. It does not load server prompts, resources, instructions, sampling, or other config files. Expected read, parse, validation, and connection failures emit one sanitized warning and continue. Unexpected errors and final-catalog tool-name collisions clean up and abort startup.

There is no MCP config discovery or merge, reload while the session runs, subagent inheritance, or default behavior change. To use a stored registration, pass that exact stored config path with `--mcp-config`.

## Supported integrations

| Need | Use | Notes |
| --- | --- | --- |
| User trusts one MCP config for one standalone session | `skc --mcp-config /absolute/path/to/mcp.json` | Exact-file, top-level, tools-only opt-in; SKC owns cleanup. |
| External bot or multi-session controller | [Coordinator MCP](./hermes-mcp-bridge.md) | Coordinator MCP exposes SKC lifecycle and coordination tools. |
| External session control | [SDK machine interface](./sdk.md) | The SDK WebSocket protocol is the only external control interface. |
| Editor/ACP client owns MCP servers | ACP via `skc --mode acp` or `skc acp` | ACP remains a stdio editor protocol. |
| Codex / Claude Code delegation plugin | [Canonical sayknow-cli plugin](./hermes-mcp-bridge.md) | Installs Coordinator MCP plus SKC delegation commands. |

## Example: free web search with Parallel

[Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp) provides web search and page fetching over Streamable HTTP without an account or API key. Anonymous searches use Fast mode and have lower rate limits intended for exploration and light use.

Search objectives, queries, and fetch URLs are sent to Parallel when these tools are called; avoid including sensitive information.

From the project where you want the tools, register the server:

```bash
skc mcp add parallel-search --project \
  --type http --url https://search.parallel.ai/mcp \
  --header 'User-Agent=sayknow-cli/parallel-search-mcp' \
  --timeout 30000
skc mcp list --project
```

The registration is stored in `./.skc/mcp.json`. `list` confirms the stored definition and autoload eligibility; it does not test the remote connection. Start a new `skc` session in that project to load the server. The two tools are exposed as `mcp__parallel_search_web_search` and `mcp__parallel_search_web_fetch`. Use search for current information and fetch for a specific page that needs closer reading. Reuse one `session_id` across related calls in a conversation when supplying that optional argument.

This adds MCP tools alongside the built-in `web_search` tool; it does not select or configure the built-in Parallel API provider. Existing registrations are preserved, and an existing `parallel-search` entry is not overwritten unless you explicitly pass `--force`. Keep the positive timeout so remote discovery can complete in the background after the bounded startup wait described above. To remove the project registration:

```bash
skc mcp remove parallel-search --project
```

## Boundary

Standalone SKC does not inherit arbitrary MCP server configurations from Claude Code, Codex, OpenCode, or other tools. MCP servers often carry credentials, filesystem reach, browser state, approval semantics, and lifecycle that belong to the configuring host.

`--mode rpc`, `--mode rpc-ui`, and `--mode bridge` have been removed. Do not use the former RPC host-tool protocol to connect an MCP server; use the [SDK machine interface](./sdk.md) for supported external session control.

## Related docs

- [SDK machine interfaces](./sdk.md)
- [Coordinator MCP bridge](./hermes-mcp-bridge.md)
- [External control surface readiness](./external-control-readiness.md)