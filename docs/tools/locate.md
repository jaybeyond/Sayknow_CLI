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
2. **Walk folders.** A folder with at most 40 files is taken whole. A bigger one is split: its subfolders are sent to Jev in batches of 12, each shown as its path, file count, and up to 14 file names and 6 subfolder names. A subfolder is entered when it scores at least `max(0.35, 0.55 × best sibling score)`; the two best siblings above 0.2 are always entered, and so are the two folders whose names and file names share the most words with the query (Jev judges folders from names alone and sometimes undersells the obvious one). A failed request keeps its folders.
3. **Judge files** in batches of 8, most promising folders first (a path that contains query words goes ahead within its folder). Each file is shown as its path and its **outline**: declaration lines only. When an outline is longer than 2,000 characters, declarations sharing words with the query are kept first.
4. **Local keyword score.** Every listed file up to 512 KB is read on this machine and scored by the query words it contains (identifiers split into words, rarer words weigh more), comments and strings included. It is added to Jev's score at weight 0.3, orders files within the cap, adds the two best-scoring folders at each depth, and puts the twelve best files up for judgement even when their folder was not entered. None of this text is sent.
5. **Compare the leaders.** The six best files are shown together in one choice question ("which one most directly implements it?"), and reordered by Jev's probability for each. Scored one at a time, near-equal files (0.62 vs 0.60) came out in near-random order; this step raised top-1 from 46% to 68% on the development set.
6. **Return** files scoring 0.5 or more, then files from 0.3 marked `weak`, up to `limit`. When none reach 0.3, the three best are shown as leads.

Ceilings per call: 100 Jev requests plus one for the comparison, 480 judged files, folder depth 8, 8 requests in flight.

## What is sent to TypeSafe

The question, folder paths and file names, and each candidate file's outline. The outline comes from the native structural summariser with every body and comment elided, plus the member lines of class-like bodies (methods and fields at the body's own indentation). For the 1-2% of files the parser rejects, a line-based fallback keeps top-level declarations and method signatures one indent level in. Lines inside block comments (`/* … */`, Rust `/*! … */`), Python docstrings, multi-line strings (including Rust `r#"…"#`), trailing `#`/`//` comments, lines that begin with a string literal, and statements (`return`, `assert`, `raise`, …) are dropped. An audit over all 15 benchmark repositories (73,508 outline lines) found no comment or string content; the 38 lines that do not look like code are type parameters and field declarations. From each kept line:

- comments, imports, lone brackets and union/intersection member lines are dropped;
- initialisers are cut: `const LIMIT = 42` is sent as `const LIMIT`, `private token = "…"` as `private token`. Function-valued initialisers keep their parameters, since those are the signature.

Function bodies, comments and literal values are never sent. Measured on `packages/coding-agent/src` (1,438 files, 17.4 MB), one search sent 290 KB: 10% of the judged files' source, 1.7% of the tree, about 72K Jev input tokens (about $0.003 at the listed $0.042/M).

## Output

A header with counts (folders and files judged, Jev requests, time), then ranked files, each with up to 12 outline lines as `L<line> <declaration>`. The result is a lead, not proof: it can miss files. Read the listed lines next.

## Measured

Benchmark on 15 public repositories (Python: requests, flask, httpx, fastapi, pydantic; TypeScript: hono, vite, zod, got; Go: gin, cobra, fzf; Rust: ripgrep, axum, clap), 292 questions. Each question is a real commit subject (maintenance and tooling commits dropped); the answer is the one to three non-test source files that commit changed, still present at `HEAD`. A hit is any answer file in the top k. Tuning used seven repositories (requests, httpx, hono, got, gin, ripgrep, axum); the other eight were run once, after tuning stopped.

Held-out repositories (154 questions), top-1 / top-3 / top-5 / top-10:

| | locate | keyword grep over full text |
| --- | --- | --- |
| All | 51% / 73% / 78% / 86% | 27% / – / 58% / 69% |
| Python (54) | 50% / 67% / 70% / 83% | 20% / – / 54% / 67% |
| TypeScript (40) | 33% / 65% / 70% / 75% | 25% / – / 50% / 68% |
| Go (40) | 70% / 88% / 93% / 100% | 43% / – / 80% / 88% |
| Rust (20) | 55% / 80% / 85% / 90% | 15% / – / 40% / 45% |

The local keyword score raised top-5 from 70% to 78% and top-10 from 75% to 86% on the held-out set; top-1 stayed at 51%. Per search: about 46 Jev requests, 4.7 s, 5 KB returned. In large trees (vite, fastapi, pydantic) the per-call file cap is still reached in about a fifth of searches.

Commit subjects are terse and sometimes name a module, so they are neither easier nor harder than a user's question in any uniform way; treat these as relative numbers.

## Use something else when

You already know a name, path or exact string: `search` and `find` are faster and free.
