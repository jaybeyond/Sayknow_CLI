<p align="center">
  <img src="../../assets/hero.png" alt="Sayknow-CLI autonomous coding-agent hero illustration" width="100%" />
</p>

<h1 align="center">Sayknow-CLI</h1>

<p align="center">
  <strong>Programmieren sollte sich wie Denken anfühlen.</strong><br />
  Ein fokussierter Coding-Agent-Runner für Interviews, geprüfte Pläne, tmux-native Ausführung und dauerhafte Verifizierung.
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
  <a href="README.ja.md">日本語</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.fr.md">Français</a> ·
  <b>Deutsch</b>
</p>

<p align="center">
  <img src="../../assets/character.png" alt="Sayknow-CLI character mascot" width="320" />
</p>

> Sayknow-CLI ist ein experimentelles Projekt im Beta-Stadium. Rechnen Sie mit Ecken und Kanten und überprüfen Sie die Ausgaben, bevor Sie sich bei wichtiger Arbeit darauf verlassen.

## Languages

Die Oberfläche ist in **7 Sprachen** lokalisiert — English, 한국어 (Koreanisch),
中文 (简体 / Vereinfachtes Chinesisch), 日本語 (Japanisch), Español (Spanisch),
Français (Französisch) und Deutsch. Beim ersten Start erkennt sie automatisch
Ihre System-Locale; wechseln Sie jederzeit unter **Settings → Appearance → Language**
oder starten Sie z. B. mit `LANG=ja_JP.UTF-8 skc`. Nicht übersetzte Zeichenketten
fallen auf Englisch zurück, und Marken-/Fachbegriffe (Claude, OpenAI, MCP, …)
bleiben in allen Locales unverändert.

## Was ist Sayknow-CLI?

Sayknow-CLI (`skc`) ist ein externes Coding-Agent-Harness. Es läuft aus dem von Ihnen gewählten Repository oder Worktree und gibt dem Agenten dann eine kleine, explizite Workflow-Oberfläche:

```text
deep-interview -> ralplan -> ultragoal
                         └─ optional team execution when parallel tmux workers help
```

Es ist bewusst kein verstecktes Plugin für Codex CLI, Claude Code, OpenCode oder Claw Code. Starten Sie `skc` neben diesen Tools, wenn Sie strukturierte Planung, dauerhafte Nachweise, tmux-gestützte Worker oder einen isolierten Worktree wünschen.

## Installation

```sh
npm install -g sayknow-cli       # oder: bun install -g sayknow-cli
skc --version
```

Das Paket enthält vorgefertigte native Addons für macOS, Linux und Windows – keine Rust-Toolchain und kein Build-Schritt nötig. Aktualisieren: `npm install -g sayknow-cli@latest` oder `skc update` im Terminal.

> Früher aus dem Quellcode (git clone) installiert? Einmalig umsteigen: `rm -f ~/.local/bin/skc && npm install -g sayknow-cli`. Für die Installation aus dem Quellcode (Entwicklung) siehe die [englische README](../../README.md#install-from-source-development).

## Schnellstart

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

Verwenden Sie innerhalb einer SKC-Sitzung die öffentliche Workflow-Oberfläche:

```text
/skill:deep-interview clarify ambiguous requirements
/skill:ralplan build and critique the implementation plan
skc ultragoal create-goals --brief-file <approved-plan>
skc ultragoal complete-goals
```

Fügen Sie `skc team ...` nur hinzu, wenn koordinierte tmux-Worker spürbar helfen.

## Kernfunktionen

- **Interview vor dem Raten**: `deep-interview` verwandelt vage Anfragen in konkrete Anforderungen.
- **Plan vor der Veränderung**: `ralplan` prüft den Ansatz vor Codeänderungen.
- **Ausführen mit Nachweisen**: `ultragoal` verfolgt Ziele, Revisionen, Prüfungen und Abschlussnachweise.
- **Parallelisieren, wenn sinnvoll**: `team` koordiniert tmux-gestützte Worker für größere Aufgaben.
- **Extern und überprüfbar bleiben**: Laufen Sie aus einem gewählten Repo oder Worktree, ohne eine andere Agent-Runtime zu patchen.

## Workflow-Oberfläche

Sayknow-CLI liefert vier Standard-Workflow-Skills:

| Skill            | Was es tut                                                          |
| ---------------- | --------------------------------------------------------------------- |
| `deep-interview` | Klärt mehrdeutige Anforderungen vor Planung oder Codeänderungen.     |
| `ralplan`        | Erstellt und kritisiert einen Implementierungsplan vor der Veränderung.          |
| `ultragoal`      | Verfolgt Ziele durch Ausführung, Revision, Verifizierung und Nachweise. |
| `team`           | Koordiniert tmux-gestützte Worker, wenn parallele Ausführung sich lohnt.  |

Und vier mitgelieferte Rollen-Agenten:

| Agent       | Was es tut                                       |
| ----------- | -------------------------------------------------- |
| `executor`  | Begrenzte Implementierung, Fixes und Refactorings.      |
| `architect` | Schreibgeschützte Architektur- und Code-Review-Bewertung. |
| `planner`   | Schreibgeschützte Sequenzierung und Abnahmekriterien.     |
| `critic`    | Schreibgeschützte Plan-Kritik und Umsetzbarkeitsprüfung.  |

Kein wucherndes Standard-Skill-Zoo: SKC verbessert sich, indem es diese kleine Methode besser macht.

## Funktioniert neben Ihrem bestehenden Agenten oder Bot

| Tool oder Bot | Empfohlener SKC-Befehl | Grenze |
| ----------- | ----------------------- | -------- |
| Codex CLI | `skc --tmux --worktree <name>` oder `skc` | `--worktree` benennt einen SKC-verwalteten Geschwister-Worktree; für einen bestehenden Pfad wechseln Sie zuerst mit `cd` dorthin. |
| Claude Code | `skc --tmux` oder `skc --tmux --worktree <name>` | SKC wird keine Claude-Code-Erweiterung. |
| OpenCode | `skc` oder `skc --tmux` | Heute nur External-Runner-Workflow. |
| Claw Code | `skc --tmux --worktree <name>` | SKC installiert sich nicht in Claw Code und ersetzt es nicht. |
| Externer Controller / Bot | `skc mcp-serve coordinator` plus `skc setup hermes` für kompatible Konfiguration oder `skc --mode rpc` für einen Subprozess-Worker | Jeder MCP-/RPC-fähige Bot steuert SKC über den generischen Coordinator-/RPC-Vertrag, nicht durch Scrollback-Scraping. |

Für generisches Drittanbieter-Bot-Setup und anbieterunabhängige Smokes siehe [`docs/bot-integration.md`](docs/bot-integration.md). Für die Reife-Klassifizierung über MCP-, RPC-, ACP- und Bridge/HTTPS-Oberflächen siehe [`docs/external-control-readiness.md`](docs/external-control-readiness.md). Für tiefergehende Protokolldetails siehe [`docs/hermes-mcp-bridge.md`](docs/hermes-mcp-bridge.md), [`docs/rpc.md`](docs/rpc.md) und [`docs/bridge.md`](docs/bridge.md). Für die Roadmap der Remote-Operator-Oberflächen siehe [`docs/sayknow-remote.md`](docs/sayknow-remote.md) (Web-Steuerrad) und [`docs/telegram-remote.md`](docs/telegram-remote.md) (Telegram-Lifecycle-Button).

## Konfiguration

Provider-Retry-Budgets liegen in `~/.skc/config.yml`:

```yaml
retry:
  requestMaxRetries: 4
  streamMaxRetries: 100
  maxRetries: 3
  maxDelayMs: 300000
```

`requestMaxRetries` gilt, bevor ein Stream aufgebaut wird. `streamMaxRetries` gilt nur für replay-sichere, vorübergehende Stream-Fehler. Ungültige Authentifizierung, nicht unterstützte Modelle/Provider, fehlerhafte Requests, Kontextüberlauf, Benutzerabbrüche und dauerhafte Kontingentfehler bleiben fail-fast.

## TUI-Identität

Die Standard-TUI-Identität ist das SKC-**blue-octopus**-Theme — das blaue Kopffüßer-Maskottchen — sowohl für dunkle als auch für helle Terminals. Eine warme **red-octopus**-Variante ist ebenfalls dabei für alle, die eine dunklere, kontrastreiche Palette bevorzugen. Drei zusätzliche Migrations-Themes — `claude-code`, `codex` und `opencode` — spiegeln das Aussehen dieser Tools für einen einfachen Augen-Umstieg wider und sind über Settings oder `/theme` auswählbar. Explizite Benutzer-Theme-Einstellungen gewinnen weiterhin.

### Raster der mitgelieferten Themes

Wählen Sie über Settings (`Appearance -> Dark theme` / `Light theme`) oder `/theme`.

| Theme | Visueller Eindruck | Beste Eignung |
| --- | --- | --- |
| `blue-octopus` | Standard-SKC-Identität — blaue Oktopus-Palette mit tentakelblauen Akzenten. | Standard für dunkle und helle Terminals. |
| `red-octopus` | Warme rote Oktopus-Variante mit starkem Status-Kontrast. | Kontrastreiche dunkle Alternative. |
| `claude-code` | Von Claude Code inspirierte dunkle Palette mit terrakotta- und pinkfarbenen Highlights. | Claude-Code-Muskelgedächtnis, ohne SKC zu verlassen. |
| `codex` | Klare dunkle blaugraue Palette mit schärferem Coding-Session-Kontrast. | Ein Codex-ähnlicher dunkler Arbeitsbereich. |
| `opencode` | Von OpenCode inspirierte dunkle Palette mit kräftigeren Terminal-Akzenten. | OpenCode-Muskelgedächtnis im mitgelieferten Picker. |

## Entwicklung

Abhängigkeiten installieren, native Bindings bauen und lokale Standardwerte einrichten:

```sh
bun install
bun run build:native
bun run install:defaults
```

Die `.node`-Binärdatei für `@sayknow-cli/natives` ist gitignored und vor jeder CLI-Ausführung erforderlich (`install:defaults`, `dev:link`, Tests).

### Kanonisch: Entwickler-`skc` bauen und verlinken

Damit der globale Befehl `skc` **den TypeScript-Quellcode dieses Checkouts** ausführt (live bei jeder Bearbeitung, mit funktionierenden Skills/Natives), verlinken Sie ihn in Ihren `PATH`:

```sh
bun install
bun run dev:link
```

`dev:link` legt einen Symlink `skc` → `packages/coding-agent/src/cli.ts` nach `~/.local/bin` an (überschreibbar mit `SKC_DEV_LINK_DIR`), ersetzt dieses verwaltete Ziel, warnt und schlägt fehl, falls ein anderes `skc` es weiter vorne im `PATH` überschattet, und führt `--smoke-test` aus, um zu bestätigen, dass `@sayknow-cli/natives` geladen wird. Verwenden Sie `bun run install:dev` für das vollständige Bootstrap (Installation + Link + `setup defaults`).

Prüfen Sie jederzeit, ob Ihr `skc` abgedriftet ist (falsche Quelle oder eine kompilierte Binärdatei, die keine Skills laden kann):

```sh
bun run dev:doctor
```

> Verwenden Sie für die tägliche Entwicklung **nicht** die kompilierte Binärdatei. `bun --cwd=packages/coding-agent run build` erzeugt ein eigenständiges `dist/skc`, aber eine mit `bun build --compile` erstellte Binärdatei kann `@sayknow-cli/natives` nicht dynamisch laden, sodass Skills mit `Cannot find module '@sayknow-cli/natives' from '/$bunfs/root/skc'` fehlschlagen. Die Ausführung aus dem Quellcode über `dev:link` vermeidet dies. Bauen Sie die Binärdatei nur, wenn Sie ein Release validieren.

Führen Sie die CLI direkt aus dem Quellcode ohne Verlinkung aus:

```sh
bun packages/coding-agent/src/cli.ts --help
```

Standard-Workflow-Definitionen liegen im Quellcode, nicht in committeten `.skc`-Kopien:

```text
packages/coding-agent/src/defaults/skc/skills/<name>/SKILL.md
packages/coding-agent/src/prompts/agents/<role>.md
```

Für Änderungen an Workflow-Definitionen oder Rebrand-Oberflächen führen Sie die Projekt-Gates aus:

```sh
bun scripts/check-visible-definitions.ts
bun scripts/verify-g002-gates.ts
bun scripts/rebrand-inventory.ts --strict
bun test packages/coding-agent/test/default-skc-definitions.test.ts
```

Für eine Paket-für-Paket-Übersicht siehe [`docs/codebase-overview.md`](docs/codebase-overview.md).

## Mitwirkende

Beiträge, Fehlerberichte und Release-Validierung sind über GitHub Issues und Pull Requests willkommen.

## Inspirationen und Herkunft

Die Standard-TUI-Identität von Sayknow-CLI ist das Kopffüßer-Paar: blue-octopus als Standard mit einem warmen red-octopus als Alternative. Es liefert außerdem die Migrations-Themes `claude-code`, `codex` und `opencode`, deren Paletten von diesen Tools inspiriert sind, damit Benutzer, die von ihnen wechseln, einen vertrauten Look erhalten. Es baut auf Erkenntnissen aus einer kleinen Familie von Agent-Harnesses auf und hält die öffentliche SKC-Oberfläche bewusst fokussiert. Die historische Zuordnung wird in [`NOTICE.md`](NOTICE.md) geführt.

## Lizenz

MIT. Siehe [`LICENSE`](LICENSE).
