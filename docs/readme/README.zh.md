<p align="center">
  <img src="../../assets/hero.png" alt="Sayknow-CLI autonomous coding-agent hero illustration" width="100%" />
</p>

<h1 align="center">Sayknow-CLI</h1>

<p align="center">
  <strong>编码应当如思考般自然。</strong><br />
  一个专注的编码智能体运行器，面向访谈式需求澄清、经评审的计划、tmux 原生执行与持久化验证。
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
  <b>中文</b> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.de.md">Deutsch</a>
</p>

<p align="center">
  <img src="../../assets/character.png" alt="Sayknow-CLI character mascot" width="320" />
</p>

> Sayknow-CLI 是一个实验性的、处于 beta 阶段的项目。请预期会有粗糙之处，并在依赖其结果完成重要工作之前先行验证输出。

## Languages

界面已本地化为 **7 种语言**——English、한국어（韩语）、
中文（简体）、日本語（日语）、Español（西班牙语）、
Français（法语）以及 Deutsch（德语）。首次运行时它会自动检测你的系统区域设置；
你可以随时在 **Settings → Appearance → Language** 中切换，或者使用例如
`LANG=ja_JP.UTF-8 skc` 的方式启动。未翻译的字符串会回退到英文，而
品牌/技术名称（Claude、OpenAI、MCP……）在所有语言环境中均保持原样。

## What is Sayknow-CLI?

Sayknow-CLI（`skc`）是一个外部编码智能体框架（harness）。它从你选择的仓库或工作树（worktree）中运行，然后为智能体提供一个精简、明确的工作流界面：

```text
deep-interview -> ralplan -> ultragoal
                         └─ optional team execution when parallel tmux workers help
```

它有意不做成 Codex CLI、Claude Code、OpenCode 或 Claw Code 的隐藏插件。当你需要结构化的规划、持久化的证据、tmux 支持的工作进程或一个隔离的工作树时，就在这些工具旁边启动 `skc`。

## Install

```sh
npm install -g sayknow-cli       # 或：bun install -g sayknow-cli
skc --version
```

已内置 macOS·Linux·Windows 的预编译原生模块，无需 Rust 工具链或构建步骤。更新：`npm install -g sayknow-cli@latest` 或在终端运行 `skc update`。

> 如果你之前是从源码（git clone）安装的，只需一次性切换：`rm -f ~/.local/bin/skc && npm install -g sayknow-cli`。源码/开发安装请参见[英文 README](../../README.md#install-from-source-development)。

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

在 SKC 会话内部，使用公共工作流界面：

```text
/skill:deep-interview clarify ambiguous requirements
/skill:ralplan build and critique the implementation plan
skc ultragoal create-goals --brief-file <approved-plan>
skc ultragoal complete-goals
```

仅当协同的 tmux 工作进程能带来实质性帮助时，才加上 `skc team ...`。

## Core capabilities

- **先访谈，不靠猜**：`deep-interview` 把模糊的请求转化为具体的需求。
- **先规划，再变更**：`ralplan` 在代码改动之前评审方案。
- **带证据地执行**：`ultragoal` 跟踪目标、修订、检查以及完成证据。
- **在有用时并行化**：`team` 为较大的任务协调 tmux 支持的工作进程。
- **保持外部化且可评审**：从所选的仓库或工作树中运行，无需给另一个智能体运行时打补丁。
- **提供商出故障也能继续**：默认模型受阻（缺少凭据、配额耗尽、认证或服务器错误）时，会话会换用另一个提供商的模型继续进行；`/fallback` 用于查看和编辑这条回退链。因重启或瞬时故障而中断的步骤会在同一模型上自动恢复一次。Z.AI `1113` 这类配额响应只请求一次就会切换，不会白白耗尽重试预算。
- **长会话始终留在上下文窗口内**：压缩（compaction）之后，Codex 会从一个全新的、提供商可见的基线开始，而不是一路增长到 `context_length_exceeded`；压缩摘要的措辞也经过调整，避免被提供商拒绝。
- **按含义查找代码**：手头没有可供 grep 的名称时，`locate` 工具能根据一句普通描述找到相应行为所在的位置。
- **把工作交给合适的模型**：`/model` 可按角色和细分用途分配模型；子智能体任务声明 `specialty` 后，就会落到你为这类工作选定的模型上。
- **在会话内完成交付**：`github` 和 `gitlab` 工具可以创建和查看 pull/merge request 及 CI，无需离开 SKC。
- **证明测试确实跑在这份代码上**：`verification-receipts` 插件为每次测试运行保存一份回执（receipt），并在代码此后发生变化时告诉你。
- **随时回到任意会话**：`alt+r` 打开恢复选择器，`ctrl+q` 继续最近一次会话，此外还有 `/star`、`/fork`、`/rename`，以及用于导入 Codex 和 Claude Code 记录的 `/import-session`。

## Workflow surface

Sayknow-CLI 内置四项默认工作流技能：

| Skill            | What it does                                                          |
| ---------------- | --------------------------------------------------------------------- |
| `deep-interview` | 在规划或代码改动之前澄清模糊的需求。     |
| `ralplan`        | 在变更之前构建并评审实现计划。          |
| `ultragoal`      | 在执行、修订、验证与证据收集的全过程中跟踪目标。 |
| `team`           | 当并行执行值得时，协调 tmux 支持的工作进程。  |

以及四个捆绑的角色智能体：

| Agent       | What it does                                       |
| ----------- | -------------------------------------------------- |
| `executor`  | 有边界的实现、修复与重构。      |
| `architect` | 只读的架构与代码评审评估。 |
| `planner`   | 只读的排序与验收标准。 |
| `critic`    | 只读的计划评审与可执行性审查。  |

没有庞杂的默认技能堆砌：SKC 通过把这一精简方法做得更好来持续改进。

## Built-in tools

智能体通过以下工具开展工作。标记为 *需启用* 的工具默认关闭，需在 **Settings → Tools**（或 `~/.skc/config.yml` 中列出的键）里开启。

| Area | Tools |
| ---- | ----- |
| 文件与代码 | `read`、`write`、`edit`、`find`、`search`、`locate`（按描述查找代码）、`ast_grep` / `ast_edit`（语法感知的搜索与重写）、`lsp` |
| Shell 与运行时 | `bash`、`eval`（JS/Python 单元）、`ssh`、`debug`、`bisect`、`calc` |
| 委派与跟踪 | `task`（子智能体）、`subagent`、`job`、`monitor`、`cron`、`irc`（与运行中的智能体对话）、`todo_write`、`goal`、`checkpoint` / `rewind` |
| Git 托管 | `github`（*需启用*，`github.enabled`）：通过 `gh` 处理 pull request、推送和 CI 运行 · `gitlab`（*需启用*，`gitlab.enabled`，需要 [`glab`](https://gitlab.com/gitlab-org/cli)）：`mr_create`（若已有打开的 MR 则直接返回，不会重复创建）、`mr_view`、`mr_list`、`ci_status`，支持 gitlab.com 和自托管实例 |
| 网页与设备 | `web_search`、`browser`、`computer`、`render_mermaid` |
| 发现 | `search_tool_bm25`（按需激活隐藏工具和 MCP 工具）、`skill`、`skill_discovery`、`ask` |

用 `--tools read,bash,...` 为单次运行指定工具集；插件、自定义和 MCP 工具的名称同样可以写在这里。

## Plugins

SKC 会加载插件包（工具、hook、技能、MCP 服务器）：安装时校验哈希，之后一旦有文件被改动，该插件包就会被隔离。使用 `skc plugin install|list|...` 管理插件。

**`verification-receipts`**（随本仓库提供）回答的问题是“测试真的在当前这份代码上通过了吗？”：

- `verification_run` 使用 `bun test` 或 `node --test` 运行明确指定的测试文件，并保存一份不可变的回执：每个文件的通过/失败计数，外加工作树的指纹。
- `verification_status` 无需重跑测试即可重新计算该指纹，并报告 `fresh`；代码一旦改动则报告 `stale`。
- `verification_loop` 及其 hook 会在后台 `task` 已结束、却没有 fresh 回执时提醒你。

它仅供参考（advisory），只支持 POSIX，且 `node --test` 需要 Node 24.11.1+。它不包含在 npm 包中，请从源码检出中安装：

```sh
git clone https://github.com/jaybeyond/Sayknow_CLI.git
skc plugin install ./Sayknow_CLI/packages/coding-agent/bundles/verification-receipts --user
```

## Works beside your existing agent or bot

| Tool or bot | Recommended SKC command | Boundary |
| ----------- | ----------------------- | -------- |
| Codex CLI | `skc --tmux --worktree <name>` or `skc` | `--worktree` 指定一个由 SKC 管理的同级工作树；对于已存在的路径，请先 `cd` 到那里。 |
| Claude Code | `skc --tmux` or `skc --tmux --worktree <name>` | SKC 不会成为 Claude Code 的扩展。 |
| OpenCode | `skc` or `skc --tmux` | 目前仅支持外部运行器（external-runner）工作流。 |
| Claw Code | `skc --tmux --worktree <name>` | SKC 不会安装到 Claw Code 中，也不会替代它。 |
| External controller / bot | `skc mcp-serve coordinator` plus `skc setup hermes` for compatible config, or `skc --mode rpc` for a subprocess worker | 任何具备 MCP/RPC 能力的 bot 都通过通用的 coordinator/RPC 契约来驱动 SKC，而非抓取滚动回显（scrollback scraping）。 |

关于通用第三方 bot 的设置以及与提供商无关的冒烟测试，请参阅 [`docs/bot-integration.md`](docs/bot-integration.md)。关于在 MCP、RPC、ACP 与 Bridge/HTTPS 各界面上的就绪度分级，请参阅 [`docs/external-control-readiness.md`](docs/external-control-readiness.md)。关于更底层的协议细节，请参阅 [`docs/hermes-mcp-bridge.md`](docs/hermes-mcp-bridge.md)、[`docs/rpc.md`](docs/rpc.md) 以及 [`docs/bridge.md`](docs/bridge.md)。关于远程操作员界面的路线图，请参阅 [`docs/sayknow-remote.md`](docs/sayknow-remote.md)（网页方向盘）以及 [`docs/telegram-remote.md`](docs/telegram-remote.md)（Telegram 生命周期按钮）。

## Configuration

提供商的重试、恢复与回退行为位于 `~/.skc/config.yml`（以下为默认值）：

```yaml
retry:
  requestMaxRetries: 4
  streamMaxRetries: 100
  maxRetries: 3
  maxDelayMs: 300000
  autoResume: true          # 中断的步骤在同一模型上自动恢复一次
  maxSilentTimeouts: 3      # 连续出现这么多次无输出超时后停止
fallback:
  auto: true                # 默认模型受阻时，换用另一个已登录的提供商继续
  maxAttempts: 3            # 链中每个模型的尝试次数，用完后切换到下一个
```

`requestMaxRetries` 在流（stream）建立之前生效。`streamMaxRetries` 仅适用于可安全重放的瞬时流失败。无效的认证、不受支持的模型/提供商、格式错误的请求、上下文溢出、用户中止以及永久性配额失败会在当前模型上快速失败（fail-fast）；启用 `fallback.auto` 时，受阻的默认模型随后会交接给链中的下一个模型（`/fallback` 可查看和编辑这条链）。

## TUI identity

默认的 TUI 标识是 SKC 的 **ink-octopus**（章鱼墨汁）主题——温暖的石墨色、纸色文字、唯一的琥珀色强调——用于深色终端，浅色终端使用 **blue-octopus**（蓝章鱼）。还捆绑了一个暖色调的 **red-octopus**（红章鱼）变体，供偏好更深、高对比度配色的用户使用。另有三个迁移主题——`claude-code`、`codex` 和 `opencode`——分别复刻了这些工具的外观，以便于视觉迁移，可从 Settings 或 `/theme` 中选择。显式的用户主题设置仍然优先生效。

### Bundled theme grid

从 Settings（`Appearance -> Dark theme` / `Light theme`）或 `/theme` 中选择。

| Theme | Visual feel | Best fit |
| --- | --- | --- |
| `blue-octopus` | 蓝章鱼配色，带触手蓝点缀。 | 浅色终端的默认主题。 |
| `red-octopus` | 暖色调红章鱼变体，状态对比强烈。 | 高对比度的深色替代方案。 |
| `ink-octopus` | 章鱼墨汁 — 温暖的石墨色背景、纸色文字、唯一的琥珀色强调。 | 深色终端的默认主题。 |
| `glow-octopus` | 深海生物荧光 — 青黑底色配荧光绿，辅以紫色。 | 需要鲜明强调色的深色终端。 |
| `violet-octopus` | 梅紫色深色底配薰衣草强调，辅以杏色。 | 柔和多彩的深色备选。 |
| `claude-code` | 受 Claude Code 启发的深色配色，带赤陶色和粉色高光。 | 在不离开 SKC 的情况下保留 Claude Code 的肌肉记忆。 |
| `codex` | 清爽的深蓝灰配色，编码会话对比更锐利。 | 类似 Codex 的深色工作区。 |
| `opencode` | 受 OpenCode 启发的深色配色，终端点缀更鲜明。 | 在捆绑选择器中保留 OpenCode 的肌肉记忆。 |

## Development

安装依赖、构建原生绑定，并设置本地默认值：

```sh
bun install
bun run build:native
bun run install:defaults
```

`@sayknow-cli/natives` 的 `.node` 二进制文件已被 gitignore，且在任何 CLI 调用（`install:defaults`、`dev:link`、测试）之前都是必需的。

### Canonical: build and link the dev `skc`

要让全局 `skc` 命令运行**此检出的 TypeScript 源码**（对每一次编辑都即时生效，且技能/原生绑定均可用），请把它链接到你的 `PATH`：

```sh
bun install
bun run dev:link
```

`dev:link` 会把 `skc` → `packages/coding-agent/src/cli.ts` 软链接到 `~/.local/bin`（可用 `SKC_DEV_LINK_DIR` 覆盖），替换该受管目标，如果另一个 `skc` 仍在 `PATH` 上更靠前地遮蔽它则会发出警告并失败，并运行 `--smoke-test` 以确认 `@sayknow-cli/natives` 能够加载。使用 `bun run install:dev` 进行完整的引导（install + link + `setup defaults`）。

随时检查你的 `skc` 是否已经漂移（源码错误，或一个无法加载技能的已编译二进制文件）：

```sh
bun run dev:doctor
```

> 在日常开发中**不要**使用已编译的二进制文件。`bun --cwd=packages/coding-agent run build` 会产出一个独立的 `dist/skc`，但 `bun build --compile` 生成的二进制无法动态加载 `@sayknow-cli/natives`，因此技能会以 `Cannot find module '@sayknow-cli/natives' from '/$bunfs/root/skc'` 失败。通过 `dev:link` 从源码运行可避免此问题。仅在验证发布版本时才构建该二进制文件。

不进行链接，直接从源码运行 CLI：

```sh
bun packages/coding-agent/src/cli.ts --help
```

默认工作流定义存放在源码中，而非已提交的 `.skc` 副本：

```text
packages/coding-agent/src/defaults/skc/skills/<name>/SKILL.md
packages/coding-agent/src/prompts/agents/<role>.md
```

对于工作流定义或品牌重塑界面（rebrand-surface）的改动，请运行项目门禁（gates）：

```sh
bun scripts/check-visible-definitions.ts
bun scripts/verify-g002-gates.ts
bun scripts/rebrand-inventory.ts --strict
bun test packages/coding-agent/test/default-skc-definitions.test.ts
```

关于逐包（package-by-package）的对照图，请参阅 [`docs/codebase-overview.md`](docs/codebase-overview.md)。

## Contributors

欢迎通过 GitHub Issues 和 Pull Requests 进行贡献、提交错误报告以及参与发布验证。

## Inspirations and lineage

Sayknow-CLI 默认的 TUI 标识是章鱼家族：深色默认 ink-octopus，浅色默认 blue-octopus，以及 red-octopus、glow-octopus、violet-octopus 备选。它还捆绑了 `claude-code`、`codex` 和 `opencode` 迁移主题，其配色受这些工具启发，以便从它们迁移过来的用户能获得熟悉的外观。它在一个小型智能体框架家族的经验之上构建，同时有意保持公共 SKC 界面的专注。历史归属保留在 [`NOTICE.md`](NOTICE.md) 中。

## License

MIT。参见 [`LICENSE`](LICENSE)。
