# `locate`

Find where behaviour lives by describing what the code does. Relevance is judged by Jev (TypeSafe), in the style of [jevgrep](https://github.com/dzhng/jevgrep), but inside SKC and using the stored TypeSafe key.

- Source: `packages/coding-agent/src/tools/locate.ts` (tool), `packages/coding-agent/src/tools/locate-core.ts` (walk, outlines)
- Prompt: `packages/coding-agent/src/prompts/tools/locate.md`
- Setting: `locate.enabled` (Settings → Tools → Locate, on by default)

## When it is offered

Only when `locate.enabled` is on **and** a TypeSafe key is stored (`/provider typesafe`). Without the hosted model every judgement would fall to an uncalibrated LLM, which costs more than the search saves, so the tool is simply absent.

## Parameters

| Name | Type | Notes |
| --- | --- | --- |
| `query` | string | What the code does, as a question or description |
| `path` | string? | Directory to search, default the working directory. Filesystem root is refused. |
| `limit` | number? | Most files to return, 1-40, default 12 |

## How it searches

1. **List** files under `path` with the native glob: `.gitignore` respected, hidden files skipped, lock/binary/media/map files dropped.
2. **Walk folders.** A folder with at most 40 files is taken whole. A bigger one is split: its subfolders are sent to Jev in batches of 12, each shown as its path, file count, and up to 14 file names and 6 subfolder names. A subfolder is entered when it scores at least `max(0.35, 0.55 × best sibling score)`; the two best siblings above 0.2 are always entered so a flat spread never dead-ends. A failed request keeps its folders.
3. **Judge files** in batches of 8, most promising folders first. Each file is shown as its path and its **outline**: declaration lines only.
4. **Rank** by Jev's score. Files at 0.5 or above are returned with their outline and line numbers. When none qualify, the three best are shown as weak leads.

Ceilings per call: 100 Jev requests, 480 judged files, folder depth 8, 8 requests in flight.

## What is sent to TypeSafe

The question, folder paths and file names, and each candidate file's outline. The outline comes from the native structural summariser with every body and comment elided, plus the member lines of class-like bodies (methods and fields at the body's own indentation). From each kept line:

- comments, imports, lone brackets and union/intersection member lines are dropped;
- initialisers are cut: `const LIMIT = 42` is sent as `const LIMIT`, `private token = "…"` as `private token`. Function-valued initialisers keep their parameters, since those are the signature.

Function bodies, comments and literal values are never sent. Measured on `packages/coding-agent/src` (1,438 files, 17.4 MB), one search sent 290 KB: 10% of the judged files' source, 1.7% of the tree, about 72K Jev input tokens (about $0.003 at the listed $0.042/M).

## Output

A header with counts (folders and files judged, Jev requests, time), then ranked files, each with up to 12 outline lines as `L<line> <declaration>`. The result is a lead, not proof: it can miss files. Read the listed lines next.

## Measured

Six questions on this repository whose answers were known in advance (the SDK broker idle stop, TypeSafe key reload on 401, the automatic fallback picker, the session-host guard, the launch card, the `/fallback` command): the expected file ranked first in all six. A search took 2.6-12 s and 28-71 Jev requests, and returned about 3 KB to the coding model. For comparison, a keyword `grep` for the same concepts matched 85-194 files and 350 KB-1.1 MB of lines.

## Use something else when

You already know a name, path or exact string: `search` and `find` are faster and free.
