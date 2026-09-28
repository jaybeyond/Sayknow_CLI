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
4. **Compare the leaders.** The six best files are shown together in one choice question ("which one most directly implements it?"), and reordered by Jev's probability for each. Scored one at a time, near-equal files (0.62 vs 0.60) came out in near-random order; this step raised top-1 from 46% to 68% on the development set.
5. **Return** files scoring 0.5 or more, then files from 0.3 marked `weak`, up to `limit`. When none reach 0.3, the three best are shown as leads.

Ceilings per call: 100 Jev requests plus one for the comparison, 480 judged files, folder depth 8, 8 requests in flight.

## What is sent to TypeSafe

The question, folder paths and file names, and each candidate file's outline. The outline comes from the native structural summariser with every body and comment elided, plus the member lines of class-like bodies (methods and fields at the body's own indentation). For the 1-2% of files the parser rejects, a line-based fallback keeps top-level declarations and method signatures one indent level in. From each kept line:

- comments, imports, lone brackets and union/intersection member lines are dropped;
- initialisers are cut: `const LIMIT = 42` is sent as `const LIMIT`, `private token = "…"` as `private token`. Function-valued initialisers keep their parameters, since those are the signature.

Function bodies, comments and literal values are never sent. Measured on `packages/coding-agent/src` (1,438 files, 17.4 MB), one search sent 290 KB: 10% of the judged files' source, 1.7% of the tree, about 72K Jev input tokens (about $0.003 at the listed $0.042/M).

## Output

A header with counts (folders and files judged, Jev requests, time), then ranked files, each with up to 12 outline lines as `L<line> <declaration>`. The result is a lead, not proof: it can miss files. Read the listed lines next.

## Measured

Known-answer benchmark: the question is the first sentence of an exported declaration's doc comment, with code spans and the declared name removed; the answer is the file that declares it. Doc comments are never sent to Jev, so the question does not leak. Compared with a keyword ranking over the same files with comments and strings removed (`grep` over code, IDF-weighted) and, as an upper bound that sees the answer's own words, the same ranking over full text.

Tuned on 120 questions (`coding-agent/src`, `ai/src`), then measured once on **152 held-out questions** from files not used in tuning, including packages never seen (`tui`, `utils`, `agent`):

| Held-out (n) | locate top-1 | top-5 | top-10 | keyword, code only: top-1 / top-5 | keyword, with comments: top-1 / top-5 |
| --- | --- | --- | --- | --- | --- |
| All (152) | 70-72% | 81-82% | 84% | 27% / 55% | 76% / 97% |
| `coding-agent/src`, 1,273 files (90) | 57-61% | 71-72% | 74-77% | 13% / 40% | 67% / 94% |
| Small packages, 22-190 files (62) | 89% | 95% | 95-97% | 47% / 76% | 90% / 100% |

Ranges are two runs of the same question set (Jev's judgements vary slightly between runs). Per search on the large tree: about 68 Jev requests, 4.7-5.4 s, about 6 KB returned to the coding model; small packages: 9 requests, 1 s, about 3 KB. Of the large-tree misses, about a third are files never judged because the per-call file cap was reached, and a sixth are folders Jev scored too low to enter.

The comment-including keyword row is not a fair baseline (the question's words are in the answer's own comment); it shows what a search that can read comments would get. Real questions from a user or an agent are not copies of doc comments, and results there can differ.

## Use something else when

You already know a name, path or exact string: `search` and `find` are faster and free.
