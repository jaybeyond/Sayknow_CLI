<p align="center">
  <img src="../../assets/hero.png" alt="Sayknow-CLI 自律型コーディングエージェントのヒーローイラスト" width="100%" />
</p>

<h1 align="center">Sayknow-CLI</h1>

<p align="center">
  <strong>コーディングは、考えることのように感じられるべきだ。</strong><br />
  インタビュー、レビュー済みプラン、tmux ネイティブ実行、そして永続的な検証のための、集中型コーディングエージェントランナー。
</p>

<p align="center">
  <a href="https://github.com/jaybeyond/Sayknow_CLI/releases"><img alt="Release" src="https://img.shields.io/github/v/tag/jaybeyond/Sayknow_CLI?sort=semver&label=release&style=flat-square&color=2f9bff"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/github/license/jaybeyond/Sayknow_CLI?style=flat-square&color=green"></a>
  <a href="https://github.com/jaybeyond/Sayknow_CLI/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/jaybeyond/Sayknow_CLI?style=flat-square&color=f5c518"></a>
  <a href="https://github.com/jaybeyond/Sayknow_CLI/issues"><img alt="Issues" src="https://img.shields.io/github/issues/jaybeyond/Sayknow_CLI?style=flat-square"></a>
  <a href="https://bun.sh"><img alt="Built with Bun" src="https://img.shields.io/badge/built%20with-Bun-fbf0df?style=flat-square&logo=bun&logoColor=black"></a>
  <a href="#languages"><img alt="i18n" src="https://img.shields.io/badge/i18n-7%20languages-2f9bff?style=flat-square"></a>
</p>

<p align="center">
  <a href="../../README.md">English</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.zh.md">中文</a> ·
  <b>日本語</b> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.de.md">Deutsch</a>
</p>

<p align="center">
  <img src="../../assets/character.png" alt="Sayknow-CLI キャラクターマスコット" width="320" />
</p>

> Sayknow-CLI は実験的なベータ段階のプロジェクトです。粗削りな部分があることを想定し、重要な作業で頼る前には出力を検証してください。

## Languages

インターフェースは **7 言語** にローカライズされています — English、한국어 (韓国語)、
中文 (简体 / 簡体字中国語)、日本語 (Japanese)、Español (スペイン語)、
Français (フランス語)、そして Deutsch (ドイツ語)。初回起動時にシステムロケールを
自動検出します。**Settings → Appearance → Language** でいつでも切り替えられるほか、
たとえば `LANG=ja_JP.UTF-8 skc` のように起動することもできます。未翻訳の文字列は英語に
フォールバックし、ブランド名や技術名 (Claude、OpenAI、MCP、…) はすべてのロケールで
そのまま表示されます。

## Sayknow-CLI とは?

Sayknow-CLI (`skc`) は外部コーディングエージェントのハーネスです。選択したリポジトリまたは worktree から実行され、エージェントに対して小さく明示的なワークフロー面を提供します:

```text
deep-interview -> ralplan -> ultragoal
                         └─ optional team execution when parallel tmux workers help
```

これは意図的に、Codex CLI、Claude Code、OpenCode、Claw Code 向けの隠しプラグインにはなっていません。構造化されたプランニング、永続的なエビデンス、tmux ベースのワーカー、または分離された worktree が欲しいときに、それらのツールと並べて `skc` を起動してください。

## Install

> Sayknow-CLI はまだ npm に公開されていません — ソースからインストールしてください。これは Bun
> のモノレポであり、グローバルの `skc` コマンドはローカルのチェックアウトからリンクされます。

```sh
# 1. Install Bun (if you don't have it)
curl -fsSL https://bun.sh/install | bash      # macOS / Linux

# 2. Clone and bootstrap (installs deps, builds native bindings, links `skc`)
git clone https://github.com/jaybeyond/Sayknow_CLI.git
cd Sayknow_CLI
bun run install:dev

# 3. Verify
skc --version
skc --smoke-test
```

`bun run install:dev` は `bun install` を実行し、`skc` をあなたの `PATH` にリンクし (`dev:link`
経由)、ローカルのデフォルトをセットアップします。その後は `skc` がこのチェックアウトの
ソースを実行します — 更新するには `git pull` してください。グローバルにリンクしたくない
場合は、リポジトリから `bun run dev` で直接実行してください。

### Windows (native install)

クリーンな Windows 11 マシンでは、まず Bun をインストールし、その後ソースからビルドします:

```powershell
# 1. Install Bun
powershell -c "irm bun.sh/install.ps1|iex"

# 2. Restart the terminal so PATH and the Bun runtime refresh, then confirm Bun
bun --version

# 3. Clone, bootstrap, and verify skc
git clone https://github.com/jaybeyond/Sayknow_CLI.git
cd Sayknow_CLI
bun run install:dev
skc --version
skc --smoke-test
```

`dev:link` は `skc` ランチャーをあなたの `PATH` に配置します。`skc` がコマンドとして解決
されるには、そのディレクトリが `PATH` 上にある必要があります — インストール後に `skc` が
「not recognized」になる場合は、PowerShell を再起動 (またはサインアウト/サインイン) してください。

トラブルシューティング:

- **`skc` が古い Bun ランタイムを報告する。** 上記の Bun インストーラーを再実行し、
  ターミナルを再起動して、`bun --version` が `skc --version` の期待する値と一致することを
  確認してください。それでも古い Bun が優先される場合は、`%USERPROFILE%\.bun\bin` が
  `PATH` の先頭にあることを確認し、それをシャドウしている古い Bun のインストールを削除して
  ください。
- **`skc.exe` は存在するのに `skc` が「not recognized」になる。** ランチャーは
  インストールされているものの `PATH` 上にありません。`echo $env:Path` に
  `%USERPROFILE%\.bun\bin` が含まれていることを確認し、ターミナルを再起動してください。

## Quick start

```sh
# Run directly in the current checkout
skc

# Use a tmux-backed leader session
skc --tmux

# Use an isolated worktree for risky or reviewable work
# --worktree takes an optional branch-like name, not a filesystem path.
skc --tmux --worktree my-task-branch

# If you already created a worktree directory, launch from that directory instead.
cd ../my-task-worktree && skc --tmux
```

SKC セッション内では、公開されているワークフロー面を使用してください:

```text
/skill:deep-interview clarify ambiguous requirements
/skill:ralplan build and critique the implementation plan
skc ultragoal create-goals --brief-file <approved-plan>
skc ultragoal complete-goals
```

`skc team ...` は、協調する tmux ワーカーが実質的に役立つときにのみ追加してください。

## Core capabilities

- **推測する前にインタビューする**: `deep-interview` は曖昧なリクエストを具体的な要件に変えます。
- **変更する前にプランニングする**: `ralplan` はコード変更の前にアプローチをレビューします。
- **エビデンスとともに実行する**: `ultragoal` はゴール、リビジョン、チェック、完了エビデンスを追跡します。
- **役立つときに並列化する**: `team` はより大きなタスクのために tmux ベースのワーカーを協調させます。
- **外部かつレビュー可能であり続ける**: 別のエージェントランタイムにパッチを当てることなく、選択したリポジトリまたは worktree から実行します。

## Workflow surface

Sayknow-CLI は 4 つのデフォルトワークフロースキルを同梱しています:

| Skill            | What it does                                                          |
| ---------------- | --------------------------------------------------------------------- |
| `deep-interview` | プランニングやコード変更の前に、曖昧な要件を明確化します。     |
| `ralplan`        | 変更の前に実装プランを構築し批評します。          |
| `ultragoal`      | 実行、リビジョン、検証、エビデンスを通じてゴールを追跡します。 |
| `team`           | 並列実行に価値があるときに tmux ベースのワーカーを協調させます。  |

そして 4 つの同梱ロールエージェント:

| Agent       | What it does                                       |
| ----------- | -------------------------------------------------- |
| `executor`  | 範囲を限定した実装、修正、リファクタリング。      |
| `architect` | 読み取り専用のアーキテクチャおよびコードレビュー評価。 |
| `planner`   | 読み取り専用のシーケンシングと受け入れ基準。 |
| `critic`    | 読み取り専用のプラン批評と実行可能性レビュー。  |

肥大化したデフォルトスキルの動物園はありません: SKC はこの小さなメソッドをより良くすることで改善されます。

## Works beside your existing agent or bot

| Tool or bot | Recommended SKC command | Boundary |
| ----------- | ----------------------- | -------- |
| Codex CLI | `skc --tmux --worktree <name>` or `skc` | `--worktree` は SKC が管理する兄弟 worktree に名前を付けます。既存のパスを使う場合は、まずそこへ `cd` してください。 |
| Claude Code | `skc --tmux` or `skc --tmux --worktree <name>` | SKC は Claude Code の拡張機能にはなりません。 |
| OpenCode | `skc` or `skc --tmux` | 現時点では外部ランナーのワークフローのみです。 |
| Claw Code | `skc --tmux --worktree <name>` | SKC は Claw Code にインストールされたり、置き換えたりはしません。 |
| External controller / bot | `skc mcp-serve coordinator` plus `skc setup hermes` for compatible config, or `skc --mode rpc` for a subprocess worker | MCP/RPC 対応のボットはどれも、スクロールバックのスクレイピングではなく、汎用のコーディネーター/RPC コントラクトを通じて SKC を駆動します。 |

汎用的なサードパーティボットのセットアップとプロバイダー非依存のスモークテストについては、[`docs/bot-integration.md`](docs/bot-integration.md) を参照してください。MCP、RPC、ACP、Bridge/HTTPS 各面にわたる準備状況の分類については、[`docs/external-control-readiness.md`](docs/external-control-readiness.md) を参照してください。より低レベルのプロトコル詳細については、[`docs/hermes-mcp-bridge.md`](docs/hermes-mcp-bridge.md)、[`docs/rpc.md`](docs/rpc.md)、および [`docs/bridge.md`](docs/bridge.md) を参照してください。リモートオペレーター面のロードマップについては、[`docs/sayknow-remote.md`](docs/sayknow-remote.md) (web steering wheel) と [`docs/telegram-remote.md`](docs/telegram-remote.md) (Telegram lifecycle button) を参照してください。

## Configuration

プロバイダーのリトライバジェットは `~/.skc/config.yml` にあります:

```yaml
retry:
  requestMaxRetries: 4
  streamMaxRetries: 100
  maxRetries: 3
  maxDelayMs: 300000
```

`requestMaxRetries` はストリームが確立される前に適用されます。`streamMaxRetries` はリプレイ安全な一時的ストリーム障害にのみ適用されます。無効な認証、サポートされていないモデル/プロバイダー、不正な形式のリクエスト、コンテキストオーバーフロー、ユーザーによる中断、および恒久的なクォータ障害は、引き続きフェイルファストのままです。

## TUI identity

デフォルトの TUI アイデンティティは SKC の **blue-octopus** テーマ — 青い頭足類のマスコット — で、ダークおよびライトの両方のターミナルに対応します。より暗めでハイコントラストなパレットを好む人のために、温かみのある **red-octopus** バリアントも同梱されています。さらに 3 つの移行用テーマ — `claude-code`、`codex`、`opencode` — がそれらのツールの見た目を再現しており、視覚的な移行を容易にし、Settings または `/theme` から選択できます。ユーザーが明示的に設定したテーマは引き続き優先されます。

### Bundled theme grid

Settings (`Appearance -> Dark theme` / `Light theme`) または `/theme` から選択してください。

| Theme | Visual feel | Best fit |
| --- | --- | --- |
| `blue-octopus` | デフォルトの SKC アイデンティティ — テンタクルブルーのアクセントを持つ青いタコのパレット。 | ダークおよびライトのターミナルのデフォルト。 |
| `red-octopus` | 強いステータスコントラストを持つ温かみのある赤いタコのバリアント。 | ハイコントラストなダークの代替。 |
| `claude-code` | テラコッタとピンクのハイライトを持つ Claude Code 風のダークパレット。 | SKC を離れずに Claude Code の体に染み付いた操作感を。 |
| `codex` | よりシャープなコーディングセッションのコントラストを持つ、くっきりしたダークブルーグレーのパレット。 | Codex ライクなダークワークスペース。 |
| `opencode` | よりパンチの効いたターミナルアクセントを持つ OpenCode 風のダークパレット。 | 同梱のピッカーで OpenCode の体に染み付いた操作感を。 |

## Development

依存関係をインストールし、ネイティブバインディングをビルドし、ローカルのデフォルトをセットアップします:

```sh
bun install
bun run build:native
bun run install:defaults
```

`@sayknow-cli/natives` 用の `.node` バイナリは gitignore されており、あらゆる CLI 呼び出し (`install:defaults`、`dev:link`、テスト) の前に必要です。

### Canonical: build and link the dev `skc`

グローバルの `skc` コマンドが **このチェックアウトの TypeScript ソース** を実行するようにする (すべての編集に即座に反映され、スキル/ネイティブが動作する) には、それをあなたの `PATH` にリンクします:

```sh
bun install
bun run dev:link
```

`dev:link` は `skc` → `packages/coding-agent/src/cli.ts` を `~/.local/bin` にシンボリックリンクし (`SKC_DEV_LINK_DIR` で上書き可能)、その管理対象ターゲットを置き換え、別の `skc` が `PATH` 上でより前にそれをシャドウしている場合は警告して失敗し、`--smoke-test` を実行して `@sayknow-cli/natives` がロードされることを確認します。完全なブートストラップ (install + link + `setup defaults`) には `bun run install:dev` を使用してください。

あなたの `skc` がドリフトしていないか (誤ったソース、またはスキルをロードできないコンパイル済みバイナリ) は、いつでも確認できます:

```sh
bun run dev:doctor
```

> 日常の開発にコンパイル済みバイナリを **使わないでください**。`bun --cwd=packages/coding-agent run build` はスタンドアロンの `dist/skc` を生成しますが、`bun build --compile` のバイナリは `@sayknow-cli/natives` を動的にロードできないため、スキルは `Cannot find module '@sayknow-cli/natives' from '/$bunfs/root/skc'` で失敗します。`dev:link` を通じてソースから実行すれば、これを回避できます。バイナリのビルドはリリースを検証するときのみ行ってください。

リンクせずに CLI をソースから直接実行します:

```sh
bun packages/coding-agent/src/cli.ts --help
```

デフォルトのワークフロー定義はソースにあり、コミットされた `.skc` のコピーにはありません:

```text
packages/coding-agent/src/defaults/skc/skills/<name>/SKILL.md
packages/coding-agent/src/prompts/agents/<role>.md
```

ワークフロー定義またはリブランド面の変更については、プロジェクトのゲートを実行してください:

```sh
bun scripts/check-visible-definitions.ts
bun scripts/verify-g002-gates.ts
bun scripts/rebrand-inventory.ts --strict
bun test packages/coding-agent/test/default-skc-definitions.test.ts
```

パッケージごとのマップについては、[`docs/codebase-overview.md`](docs/codebase-overview.md) を参照してください。

## Contributors

コントリビューション、バグレポート、リリース検証は GitHub の Issues と Pull Request を通じて歓迎しています。

## Inspirations and lineage

Sayknow-CLI のデフォルト TUI アイデンティティは頭足類のペアです: デフォルトの blue-octopus と、温かみのある red-octopus の代替。また、`claude-code`、`codex`、`opencode` の移行用テーマも同梱しており、これらのパレットはそれらのツールにインスパイアされているため、移行してくるユーザーが見慣れた見た目を得られます。これは、公開された SKC 面を意図的に集中させたまま、小さなエージェントハーネス一族からの教訓の上に構築されています。歴史的な帰属表示は [`NOTICE.md`](NOTICE.md) に保持されています。

## License

MIT。[`LICENSE`](LICENSE) を参照してください。
