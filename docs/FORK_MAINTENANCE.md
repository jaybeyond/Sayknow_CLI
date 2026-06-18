# Fork maintenance — keeping Sayknow-CLI synced with upstream

Sayknow-CLI is a **rebranded fork** of upstream `gajae-code`. We track upstream
releases without re-doing the rename by hand each time: the fork is a
**reproducible function of `{upstream tag, our fork layer}`**.

```
fork tree  =  gen-tree(clean upstream tag)
           =  codemod  +  fork-identity  +  overlay  +  patches
```

Verified: `gen-tree(v0.5.4)` byte-reproduces the `sayknow-fork` branch (excluding
regenerated lockfiles + `*.generated.ts`).

## Branch / remote topology

| ref | meaning |
| --- | --- |
| `upstream` (remote) | `github.com/Yeachan-Heo/gajae-code` — read-only source |
| `origin` (remote) | `github.com/jaybeyond/Sayknow_CLI` — our fork |
| `main` (local) / `origin/main` | our shippable fork (local branch `sayknow-fork` → `origin/main`) |
| `origin/upstream-mirror` | pristine upstream mirror (tag `upstream/v0.5.4`) |
| tag `sayknow-v0.1.0` | fork release; tag `upstream/v0.5.4` | the upstream base it was generated from |

Backed up: `git push origin sayknow-fork:main` (done). Local branch `sayknow-fork`
tracks `origin/main`.

## The four layers

1. **codemod** — `scripts/apply-rebrand.ts`: deterministic brand rename
   (`gajae/gjc → sayknow/skc`, paths, `@sayknow-cli` scope) + identity
   special-cases (`can1357`/`Yeachan-Heo → jaybeyond`, discord → placeholder).
   Skips `bun.lock`/`Cargo.lock` (integrity hashes). Reproduces ~1885 files with
   **zero residual tokens**.
2. **fork-identity** — `scripts/apply-fork-identity.ts` + `rebrand/identity.json`:
   stamps the fork **version** (`0.1.0`) onto workspace `package.json` + root
   catalog + `Cargo.toml`, as minimal format-preserving edits. **Bump the version
   here**, never with a global replace (that would corrupt CHANGELOG/lockfiles).
3. **overlay** — `rebrand/overlay/**`: whole files we own outright (i18n module,
   `blue-octopus`/`red-octopus` themes, octopus assets, brand docs). Copied over
   the codemod output. **No line-level merge → zero conflict.**
4. **patches** — `rebrand/patches/NN-*.patch`: the ~17 **in-place edits** to
   upstream-owned files (welcome redesign, theme default, i18n wiring, tests).
   Applied with `git apply --reject`. **This is the only conflict-prone layer.**

`rebrand/manifest.json` declares which files are `patch` / `regenerate` /
`toolingOnly`; everything else that differs becomes overlay automatically.

## Sync to a new upstream release

```sh
bash scripts/sync-upstream.sh v0.5.5          # fetch tag, regenerate, run gates G1–G4
```

This produces a generated, gate-verified tree in a temp worktree (it does **not**
auto-commit). Then **adopt** it:

```sh
# review the generated tree printed by the sync command, then:
rsync -a --delete --exclude .git <generated-wt>/ .
bun install                  # refresh lockfiles
git add -A && git commit -m "sync: upstream v0.5.5"
git tag sayknow-v0.<n>.0     # bump rebrand/identity.json first if releasing
```

### When a patch conflicts (upstream changed a patched file)

`git apply --reject` leaves `*.rej` files in the generated worktree. For each:

1. Open the `.rej` and the target file, apply the change by hand.
2. Re-extract so the patch matches the new upstream base:
   ```sh
   # after upstream is mirrored + codemod+finalizer applied to <base>:
   bun scripts/extract-fork-layer.ts --base <base> --fork <fixed-tree> --apply
   ```
3. Commit the refreshed `rebrand/patches/`.

**Lever:** the fewer in-place edits, the fewer future conflicts. Prefer expressing
new fork features as *new files* (overlay) or additive hooks rather than edits to
upstream files. Today only ~17 files are patches; keep it small.

## Gates (run by `sync`, or manually)

| gate | check |
| --- | --- |
| **G1** | no residual `gajae/gjc/red-claw/...` tokens in the generated tree |
| **G2** | codemod idempotence — a *second* `apply-rebrand` changes **0 files** (diff-based; the printed hit-count is unreliable, do not gate on it) |
| **G3** | `bun --cwd=packages/coding-agent run check:types` |
| **G4** | `bun test` brand/i18n/welcome suites |

## Publishing to npm

`scripts/publish-npm.ts` publishes the 9 workspace packages in dependency order
using **`bun publish`** (not `npm publish`): bun resolves `catalog:`/`workspace:`
deps to concrete versions at pack time, so the packages actually install. Plain
`npm publish` leaves `catalog:` in the tarball and breaks `bun install -g sayknow-cli`.

One-time prerequisites (need your npm account — the script can't do these):

1. Create the **`@sayknow-cli`** org/scope on npmjs.com (Settings → Add Organization
   → free unlimited public). All 9 packages are `@sayknow-cli/*`.
2. `bunx npm login`

Then:

```sh
bun run build:native                       # build the platform .node first
bun scripts/publish-npm.ts --dry-run       # preview tarballs (no login needed)
bun scripts/publish-npm.ts                 # publish for real
```

After publishing, `bun install -g sayknow-cli` works.

> **Native binary is platform-specific.** `@sayknow-cli/natives` bundles a prebuilt
> `.node` for the machine you publish from (e.g. `darwin-arm64`). A publish from an
> Apple-Silicon Mac works for Apple-Silicon Mac users; **Linux / Windows / Intel-Mac
> users get a "failed to load native addon" error.** Full cross-platform support
> needs each platform's `.node` built in CI (`scripts/ci-release-build-binaries.ts`)
> and shipped together — a follow-up, not a single-machine publish.

## Regenerating the fork from scratch (audit)

```sh
git worktree add --detach /tmp/u v0.6.0
bun scripts/gen-tree.ts /tmp/u --build
diff -rq /tmp/u . -x .git -x node_modules -x bun.lock -x Cargo.lock -x '*.generated.ts'
# → empty means the fork is fully reproducible from upstream + the fork layer
```
