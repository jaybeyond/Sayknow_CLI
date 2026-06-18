<p align="center">
  <img src="../../assets/hero.png" alt="Sayknow-CLI autonomous coding-agent hero illustration" width="100%" />
</p>

<h1 align="center">Sayknow-CLI</h1>

<p align="center">
  <strong>코딩은 사고처럼 느껴져야 합니다.</strong><br />
  인터뷰, 검토된 계획, tmux 네이티브 실행, 견고한 검증을 위한 집중형 코딩 에이전트 러너.
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
  <b>한국어</b> ·
  <a href="README.zh.md">中文</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.de.md">Deutsch</a>
</p>

<p align="center">
  <img src="../../assets/character.png" alt="Sayknow-CLI character mascot" width="320" />
</p>

> Sayknow-CLI는 실험적인 베타 단계 프로젝트입니다. 거친 부분이 있을 수 있으니 중요한 작업에 의존하기 전에 출력 결과를 검증하세요.

## Languages

인터페이스는 **7개 언어** — English, 한국어 (Korean),
中文 (简体 / Simplified Chinese), 日本語 (Japanese), Español (Spanish),
Français (French), Deutsch (German) — 로 현지화되어 있습니다. 첫 실행 시
시스템 로케일을 자동으로 감지하며, 언제든지 **Settings → Appearance → Language** 에서
전환하거나 예를 들어 `LANG=ja_JP.UTF-8 skc` 로 실행할 수 있습니다. 번역되지 않은 문자열은
English로 대체되며, 브랜드/기술 이름(Claude, OpenAI, MCP, …)은 모든 로케일에서 그대로 유지됩니다.

## What is Sayknow-CLI?

Sayknow-CLI(`skc`)는 외부 코딩 에이전트 하니스입니다. 선택한 저장소나 워크트리에서 실행되며, 에이전트에게 작고 명시적인 워크플로 표면을 제공합니다:

```text
deep-interview -> ralplan -> ultragoal
                         └─ optional team execution when parallel tmux workers help
```

이것은 의도적으로 Codex CLI, Claude Code, OpenCode, Claw Code의 숨겨진 플러그인이 아닙니다. 구조화된 계획, 지속적인 증거, tmux 기반 워커, 또는 격리된 워크트리를 원할 때 이러한 도구들 옆에서 `skc`를 시작하세요.

## Install

> Sayknow-CLI는 아직 npm에 게시되지 않았습니다 — 소스에서 설치하세요. 이것은 Bun
> 모노레포이므로, 전역 `skc` 명령은 로컬 체크아웃에서 링크됩니다.

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

`bun run install:dev`는 `bun install`을 실행하고, `skc`를 (via
`dev:link`) `PATH`에 링크하며, 로컬 기본값을 설정합니다. 그 이후로 `skc`는 이 체크아웃의
소스를 실행합니다 — 업데이트하려면 `git pull` 하세요. 전역으로 링크하지 않으려면, 저장소에서
`bun run dev`로 직접 실행하세요.

### Windows (native install)

깨끗한 Windows 11 머신에서는, 먼저 Bun을 설치한 다음 소스에서 빌드하세요:

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

`dev:link`는 `skc` 런처를 `PATH`에 배치합니다. `skc`가 명령으로 인식되려면 그
디렉터리가 `PATH`에 있어야 합니다 — 설치 후 `skc`가 "not recognized"라면 PowerShell을
재시작(또는 로그아웃/로그인)하세요.

Troubleshooting:

- **`skc`가 오래된 Bun 런타임을 보고합니다.** 위의 Bun 설치 프로그램을 다시 실행하고, 터미널을
  재시작한 다음, `bun --version`이 `skc --version`이 기대하는 것과 일치하는지 확인하세요.
  여전히 오래된 Bun이 우선한다면, `%USERPROFILE%\.bun\bin`이
  `PATH`의 맨 앞에 있는지 확인하고 그것을 가리는 오래된 Bun 설치를 제거하세요.
- **`skc.exe`는 존재하지만 `skc`가 "not recognized"입니다.** 런처는 설치되어
  있지만 `PATH`에 없습니다. `echo $env:Path`에 `%USERPROFILE%\.bun\bin`이
  나열되어 있는지 확인한 다음, 터미널을 재시작하세요.

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

SKC 세션 내부에서는, 공개 워크플로 표면을 사용하세요:

```text
/skill:deep-interview clarify ambiguous requirements
/skill:ralplan build and critique the implementation plan
skc ultragoal create-goals --brief-file <approved-plan>
skc ultragoal complete-goals
```

조율된 tmux 워커가 실질적으로 도움이 될 때만 `skc team ...`을 추가하세요.

## Core capabilities

- **추측하기 전에 인터뷰**: `deep-interview`는 모호한 요청을 구체적인 요구사항으로 바꿉니다.
- **변경하기 전에 계획**: `ralplan`은 코드 변경 전에 접근 방식을 검토합니다.
- **증거와 함께 실행**: `ultragoal`은 목표, 수정, 점검, 완료 증거를 추적합니다.
- **유용할 때 병렬화**: `team`은 더 큰 작업을 위해 tmux 기반 워커를 조율합니다.
- **외부에서 검토 가능하게 유지**: 다른 에이전트 런타임을 패치하지 않고 선택한 저장소나 워크트리에서 실행합니다.

## Workflow surface

Sayknow-CLI는 네 가지 기본 워크플로 스킬을 제공합니다:

| Skill            | What it does                                                          |
| ---------------- | --------------------------------------------------------------------- |
| `deep-interview` | 계획이나 코드 변경 전에 모호한 요구사항을 명확히 합니다.     |
| `ralplan`        | 변경 전에 구현 계획을 구축하고 비평합니다.          |
| `ultragoal`      | 실행, 수정, 검증, 증거를 거쳐 목표를 추적합니다. |
| `team`           | 병렬 실행이 가치가 있을 때 tmux 기반 워커를 조율합니다.  |

그리고 네 가지 번들 역할 에이전트:

| Agent       | What it does                                       |
| ----------- | -------------------------------------------------- |
| `executor`  | 범위가 정해진 구현, 수정, 리팩터.      |
| `architect` | 읽기 전용 아키텍처 및 코드 리뷰 평가. |
| `planner`   | 읽기 전용 순서 결정 및 수용 기준.      |
| `critic`    | 읽기 전용 계획 비평 및 실행 가능성 검토.  |

광범위한 기본 스킬 동물원은 없습니다: SKC는 이 작은 방법을 더 좋게 만들어 개선됩니다.

## Works beside your existing agent or bot

| Tool or bot | Recommended SKC command | Boundary |
| ----------- | ----------------------- | -------- |
| Codex CLI | `skc --tmux --worktree <name>` or `skc` | `--worktree`는 SKC가 관리하는 형제 워크트리의 이름을 지정합니다. 기존 경로의 경우 먼저 그곳으로 `cd` 하세요. |
| Claude Code | `skc --tmux` or `skc --tmux --worktree <name>` | SKC는 Claude Code 확장이 되지 않습니다. |
| OpenCode | `skc` or `skc --tmux` | 현재로서는 외부 러너 워크플로만 지원합니다. |
| Claw Code | `skc --tmux --worktree <name>` | SKC는 Claw Code에 설치되거나 그것을 대체하지 않습니다. |
| External controller / bot | 호환 가능한 구성을 위한 `skc mcp-serve coordinator` 및 `skc setup hermes`, 또는 서브프로세스 워커를 위한 `skc --mode rpc` | MCP/RPC 지원 봇이라면 무엇이든 스크롤백 스크래핑이 아니라 일반 coordinator/RPC 계약을 통해 SKC를 구동합니다. |

일반 서드파티 봇 설정 및 공급자 독립적 스모크에 대해서는 [`docs/bot-integration.md`](docs/bot-integration.md)를 참조하세요. MCP, RPC, ACP, Bridge/HTTPS 표면 전반의 준비도 분류에 대해서는 [`docs/external-control-readiness.md`](docs/external-control-readiness.md)를 참조하세요. 더 낮은 수준의 프로토콜 세부 사항에 대해서는 [`docs/hermes-mcp-bridge.md`](docs/hermes-mcp-bridge.md), [`docs/rpc.md`](docs/rpc.md), [`docs/bridge.md`](docs/bridge.md)를 참조하세요. 원격 운영자 표면 로드맵에 대해서는 [`docs/sayknow-remote.md`](docs/sayknow-remote.md)(웹 스티어링 휠) 및 [`docs/telegram-remote.md`](docs/telegram-remote.md)(Telegram 라이프사이클 버튼)를 참조하세요.

## Configuration

공급자 재시도 예산은 `~/.skc/config.yml`에 있습니다:

```yaml
retry:
  requestMaxRetries: 4
  streamMaxRetries: 100
  maxRetries: 3
  maxDelayMs: 300000
```

`requestMaxRetries`는 스트림이 설정되기 전에 적용됩니다. `streamMaxRetries`는 재생 안전한 일시적 스트림 실패에만 적용됩니다. 잘못된 인증, 지원되지 않는 모델/공급자, 잘못된 형식의 요청, 컨텍스트 오버플로, 사용자 중단, 영구적인 할당량 실패는 즉시 실패(fail-fast)로 유지됩니다.

## TUI identity

기본 TUI 정체성은 SKC **blue-octopus** 테마 — 파란 두족류 마스코트 — 로, 다크 및 라이트 터미널 모두에 적용됩니다. 더 어둡고 고대비 팔레트를 선호하는 사람들을 위해 따뜻한 **red-octopus** 변형도 번들로 제공됩니다. 세 가지 추가 마이그레이션 테마 — `claude-code`, `codex`, `opencode` — 는 쉬운 눈 마이그레이션을 위해 해당 도구들의 모습을 그대로 따르며 Settings 또는 `/theme`에서 선택할 수 있습니다. 명시적인 사용자 테마 설정이 여전히 우선합니다.

### Bundled theme grid

Settings (`Appearance -> Dark theme` / `Light theme`) 또는 `/theme`에서 선택하세요.

| Theme | Visual feel | Best fit |
| --- | --- | --- |
| `blue-octopus` | 기본 SKC 정체성 — 촉수 블루 액센트가 있는 파란 문어 팔레트. | 다크 및 라이트 터미널의 기본값. |
| `red-octopus` | 강한 상태 대비를 가진 따뜻한 빨간 문어 변형. | 고대비 다크 대안. |
| `claude-code` | 테라코타와 핑크 하이라이트가 있는 Claude Code 영감 다크 팔레트. | SKC를 떠나지 않고 Claude Code 근육 기억을 유지. |
| `codex` | 더 날카로운 코딩 세션 대비를 가진 선명한 다크 블루그레이 팔레트. | Codex 같은 다크 작업 공간. |
| `opencode` | 더 강렬한 터미널 액센트를 가진 OpenCode 영감 다크 팔레트. | 번들 선택기에서의 OpenCode 근육 기억. |

## Development

의존성을 설치하고, 네이티브 바인딩을 빌드하고, 로컬 기본값을 설정하세요:

```sh
bun install
bun run build:native
bun run install:defaults
```

`@sayknow-cli/natives`용 `.node` 바이너리는 gitignore되어 있으며 모든 CLI 호출(`install:defaults`, `dev:link`, 테스트) 전에 필요합니다.

### Canonical: build and link the dev `skc`

전역 `skc` 명령이 **이 체크아웃의 TypeScript 소스**(모든 편집에 즉시 반영되며, 스킬/네이티브가 작동함)를 실행하도록 하려면, `PATH`에 링크하세요:

```sh
bun install
bun run dev:link
```

`dev:link`는 `skc` → `packages/coding-agent/src/cli.ts`를 `~/.local/bin`에 심볼릭 링크하고(`SKC_DEV_LINK_DIR`로 재정의 가능), 그 관리되는 대상을 교체하며, 다른 `skc`가 여전히 `PATH`에서 더 앞쪽에 있어 그것을 가린다면 경고하고 실패하며, `--smoke-test`를 실행하여 `@sayknow-cli/natives`가 로드되는지 확인합니다. 전체 부트스트랩(install + link + `setup defaults`)을 위해서는 `bun run install:dev`를 사용하세요.

당신의 `skc`가 표류했는지(잘못된 소스, 또는 스킬을 로드할 수 없는 컴파일된 바이너리) 언제든지 확인하세요:

```sh
bun run dev:doctor
```

> 일상적인 개발에는 컴파일된 바이너리를 **사용하지 마세요**. `bun --cwd=packages/coding-agent run build`는 독립 실행형 `dist/skc`를 생성하지만, `bun build --compile` 바이너리는 `@sayknow-cli/natives`를 동적으로 로드할 수 없으므로 스킬이 `Cannot find module '@sayknow-cli/natives' from '/$bunfs/root/skc'`로 실패합니다. `dev:link`를 통해 소스에서 실행하면 이를 피할 수 있습니다. 릴리스를 검증할 때만 바이너리를 빌드하세요.

링크 없이 소스에서 직접 CLI를 실행하세요:

```sh
bun packages/coding-agent/src/cli.ts --help
```

기본 워크플로 정의는 커밋된 `.skc` 사본이 아니라 소스에 있습니다:

```text
packages/coding-agent/src/defaults/skc/skills/<name>/SKILL.md
packages/coding-agent/src/prompts/agents/<role>.md
```

워크플로 정의 또는 리브랜드 표면 변경의 경우, 프로젝트 게이트를 실행하세요:

```sh
bun scripts/check-visible-definitions.ts
bun scripts/verify-g002-gates.ts
bun scripts/rebrand-inventory.ts --strict
bun test packages/coding-agent/test/default-skc-definitions.test.ts
```

패키지별 맵에 대해서는 [`docs/codebase-overview.md`](docs/codebase-overview.md)를 참조하세요.

## Contributors

기여, 버그 보고, 릴리스 검증은 GitHub Issues와 Pull Request를 통해 환영합니다.

## Inspirations and lineage

Sayknow-CLI의 기본 TUI 정체성은 두족류 쌍입니다: 기본값인 blue-octopus와 따뜻한 red-octopus 대안. 또한 해당 도구들에서 옮겨오는 사용자들이 익숙한 모습을 얻도록 팔레트가 그 도구들에서 영감을 받은 `claude-code`, `codex`, `opencode` 마이그레이션 테마를 번들로 제공합니다. 공개 SKC 표면을 의도적으로 집중된 상태로 유지하면서, 작은 에이전트 하니스 계열에서 얻은 교훈을 바탕으로 만들어졌습니다. 역사적 출처 표기는 [`NOTICE.md`](NOTICE.md)에 보관되어 있습니다.

## License

MIT. [`LICENSE`](LICENSE)를 참조하세요.
