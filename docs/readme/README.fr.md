<p align="center">
  <img src="../../assets/hero.png" alt="Illustration héros de l'agent de codage autonome Sayknow-CLI" width="100%" />
</p>

<h1 align="center">Sayknow-CLI</h1>

<p align="center">
  <strong>Coder devrait ressembler à réfléchir.</strong><br />
  Un exécuteur d'agent de codage ciblé pour les entretiens, les plans révisés, l'exécution native tmux et la vérification durable.
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
  <b>Français</b> ·
  <a href="README.de.md">Deutsch</a>
</p>

<p align="center">
  <img src="../../assets/character.png" alt="Mascotte personnage de Sayknow-CLI" width="320" />
</p>

> Sayknow-CLI est un projet expérimental en phase bêta. Attendez-vous à des aspérités et vérifiez les résultats avant de vous y fier pour un travail important.

## Languages

L'interface est localisée en **7 langues** — English, 한국어 (coréen),
中文 (简体 / chinois simplifié), 日本語 (japonais), Español (espagnol),
Français (français) et Deutsch (allemand). Elle détecte automatiquement la locale de votre système au
premier lancement ; changez-en à tout moment dans **Settings → Appearance → Language**, ou lancez
avec par exemple `LANG=ja_JP.UTF-8 skc`. Les chaînes non traduites se rabattent sur l'anglais, et
les noms de marque/techniques (Claude, OpenAI, MCP, …) restent verbatim dans toutes les locales.

## What is Sayknow-CLI?

Sayknow-CLI (`skc`) est un harnais d'agent de codage externe. Il s'exécute depuis le dépôt ou le worktree que vous choisissez, puis donne à l'agent une surface de workflow réduite et explicite :

```text
deep-interview -> ralplan -> ultragoal
                         └─ optional team execution when parallel tmux workers help
```

Ce n'est volontairement pas un plugin caché pour Codex CLI, Claude Code, OpenCode ou Claw Code. Lancez `skc` à côté de ces outils lorsque vous voulez une planification structurée, des preuves persistantes, des workers adossés à tmux, ou un worktree isolé.

## Install

> Sayknow-CLI n'est pas encore publié sur npm — installez depuis les sources. C'est un monorepo
> Bun, donc la commande globale `skc` est liée depuis votre checkout local.

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

`bun run install:dev` exécute `bun install`, lie `skc` à votre `PATH` (via
`dev:link`), et configure les valeurs par défaut locales. Après cela, `skc` exécute la
source de ce checkout — `git pull` pour mettre à jour. Si vous préférez ne pas lier globalement, exécutez-le
directement avec `bun run dev` depuis le dépôt.

### Windows (native install)

Sur une machine Windows 11 vierge, installez d'abord Bun, puis compilez depuis les sources :

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

`dev:link` place le lanceur `skc` sur votre `PATH`. Ce répertoire doit être sur le
`PATH` pour que `skc` se résolve comme une commande — redémarrez PowerShell (ou déconnectez/reconnectez-vous)
si `skc` est « not recognized » après l'installation.

Dépannage :

- **`skc` signale un ancien runtime Bun.** Relancez l'installateur Bun ci-dessus, redémarrez
  le terminal, et confirmez que `bun --version` correspond à ce que `skc --version`
  attend. Si une version plus ancienne de Bun l'emporte toujours, assurez-vous que `%USERPROFILE%\.bun\bin` est
  en premier sur le `PATH` et supprimez toute installation Bun obsolète qui le masquerait.
- **`skc.exe` existe mais `skc` est « not recognized ».** Le lanceur est installé
  mais pas sur le `PATH`. Confirmez que `%USERPROFILE%\.bun\bin` est listé dans
  `echo $env:Path`, puis redémarrez le terminal.

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

À l'intérieur d'une session SKC, utilisez la surface de workflow publique :

```text
/skill:deep-interview clarify ambiguous requirements
/skill:ralplan build and critique the implementation plan
skc ultragoal create-goals --brief-file <approved-plan>
skc ultragoal complete-goals
```

Ajoutez `skc team ...` uniquement lorsque des workers tmux coordonnés aident concrètement.

## Core capabilities

- **Interviewer avant de deviner** : `deep-interview` transforme des demandes vagues en exigences concrètes.
- **Planifier avant de muter** : `ralplan` révise l'approche avant les changements de code.
- **Exécuter avec des preuves** : `ultragoal` suit les objectifs, les révisions, les vérifications et les preuves de complétion.
- **Paralléliser quand c'est utile** : `team` coordonne des workers adossés à tmux pour les tâches plus importantes.
- **Rester externe et révisable** : exécutez depuis un dépôt ou un worktree choisi sans patcher un autre runtime d'agent.

## Workflow surface

Sayknow-CLI fournit quatre skills de workflow par défaut :

| Skill            | What it does                                                          |
| ---------------- | --------------------------------------------------------------------- |
| `deep-interview` | Clarifie les exigences ambiguës avant la planification ou les changements de code.     |
| `ralplan`        | Construit et critique un plan d'implémentation avant la mutation.          |
| `ultragoal`      | Suit les objectifs à travers l'exécution, la révision, la vérification et les preuves. |
| `team`           | Coordonne des workers adossés à tmux lorsque l'exécution parallèle en vaut la peine.  |

Et quatre agents de rôle inclus :

| Agent       | What it does                                       |
| ----------- | -------------------------------------------------- |
| `executor`  | Implémentation bornée, correctifs et refactorisations.      |
| `architect` | Évaluation d'architecture et de revue de code en lecture seule. |
| `planner`   | Séquençage et critères d'acceptation en lecture seule. |
| `critic`    | Critique de plan et revue d'actionnabilité en lecture seule.  |

Pas de ménagerie tentaculaire de skills par défaut : SKC s'améliore en rendant cette petite méthode meilleure.

## Works beside your existing agent or bot

| Tool or bot | Recommended SKC command | Boundary |
| ----------- | ----------------------- | -------- |
| Codex CLI | `skc --tmux --worktree <name>` or `skc` | `--worktree` nomme un worktree frère géré par SKC ; pour un chemin existant, faites d'abord `cd` à cet endroit. |
| Claude Code | `skc --tmux` or `skc --tmux --worktree <name>` | SKC ne devient pas une extension de Claude Code. |
| OpenCode | `skc` or `skc --tmux` | Workflow d'exécuteur externe uniquement aujourd'hui. |
| Claw Code | `skc --tmux --worktree <name>` | SKC ne s'installe pas dans Claw Code et ne le remplace pas. |
| External controller / bot | `skc mcp-serve coordinator` plus `skc setup hermes` for compatible config, or `skc --mode rpc` for a subprocess worker | Tout bot capable de MCP/RPC pilote SKC via le contrat générique coordinator/RPC, et non par grattage de scrollback. |

Pour la configuration générique d'un bot tiers et les smokes indépendants du provider, voir [`docs/bot-integration.md`](docs/bot-integration.md). Pour la classification de readiness à travers les surfaces MCP, RPC, ACP et Bridge/HTTPS, voir [`docs/external-control-readiness.md`](docs/external-control-readiness.md). Pour les détails de protocole de plus bas niveau, voir [`docs/hermes-mcp-bridge.md`](docs/hermes-mcp-bridge.md), [`docs/rpc.md`](docs/rpc.md) et [`docs/bridge.md`](docs/bridge.md). Pour la roadmap des surfaces d'opérateur distant, voir [`docs/sayknow-remote.md`](docs/sayknow-remote.md) (volant de direction web) et [`docs/telegram-remote.md`](docs/telegram-remote.md) (bouton de cycle de vie Telegram).

## Configuration

Les budgets de retry du provider se trouvent dans `~/.skc/config.yml` :

```yaml
retry:
  requestMaxRetries: 4
  streamMaxRetries: 100
  maxRetries: 3
  maxDelayMs: 300000
```

`requestMaxRetries` s'applique avant qu'un stream ne soit établi. `streamMaxRetries` ne s'applique qu'aux échecs de stream transitoires sûrs pour le replay. L'authentification invalide, les modèles/providers non pris en charge, les requêtes malformées, le débordement de contexte, les abandons par l'utilisateur et les échecs de quota permanents restent en fail-fast.

## TUI identity

L'identité TUI par défaut est le thème SKC **blue-octopus** — la mascotte céphalopode bleue — pour les terminaux sombres comme clairs. Une variante chaleureuse **red-octopus** est également incluse pour ceux qui préfèrent une palette plus sombre et à fort contraste. Trois thèmes de migration supplémentaires — `claude-code`, `codex` et `opencode` — reflètent l'apparence de ces outils pour faciliter la migration visuelle et sont sélectionnables depuis Settings ou `/theme`. Les réglages de thème explicites de l'utilisateur l'emportent toujours.

### Bundled theme grid

Choisissez depuis Settings (`Appearance -> Dark theme` / `Light theme`) ou `/theme`.

| Theme | Visual feel | Best fit |
| --- | --- | --- |
| `blue-octopus` | Identité SKC par défaut — palette poulpe bleu avec des accents bleu tentacule. | Par défaut pour les terminaux sombres et clairs. |
| `red-octopus` | Variante chaleureuse poulpe rouge avec un fort contraste d'état. | Alternative sombre à fort contraste. |
| `claude-code` | Palette sombre inspirée de Claude Code avec des touches terracotta et rose. | La mémoire musculaire de Claude Code sans quitter SKC. |
| `codex` | Palette bleu-gris sombre et nette avec un contraste de session de codage plus marqué. | Un espace de travail sombre à la manière de Codex. |
| `opencode` | Palette sombre inspirée d'OpenCode avec des accents de terminal plus percutants. | La mémoire musculaire d'OpenCode dans le sélecteur inclus. |

## Development

Installez les dépendances, compilez les bindings natifs et configurez les valeurs par défaut locales :

```sh
bun install
bun run build:native
bun run install:defaults
```

Le binaire `.node` pour `@sayknow-cli/natives` est gitignored et requis avant toute invocation de la CLI (`install:defaults`, `dev:link`, tests).

### Canonical: build and link the dev `skc`

Pour que la commande globale `skc` exécute **la source TypeScript de ce checkout** (sensible à chaque édition, avec skills/natives fonctionnels), liez-la à votre `PATH` :

```sh
bun install
bun run dev:link
```

`dev:link` crée un lien symbolique `skc` → `packages/coding-agent/src/cli.ts` dans `~/.local/bin` (à surcharger avec `SKC_DEV_LINK_DIR`), remplace cette cible gérée, avertit et échoue si un autre `skc` le masque encore plus tôt sur le `PATH`, et exécute `--smoke-test` pour confirmer que `@sayknow-cli/natives` se charge. Utilisez `bun run install:dev` pour le bootstrap complet (install + link + `setup defaults`).

Vérifiez à tout moment si votre `skc` a dérivé (mauvaise source, ou un binaire compilé qui ne peut pas charger les skills) :

```sh
bun run dev:doctor
```

> N'utilisez **pas** le binaire compilé pour le développement quotidien. `bun --cwd=packages/coding-agent run build` produit un `dist/skc` autonome, mais un binaire `bun build --compile` ne peut pas charger dynamiquement `@sayknow-cli/natives`, donc les skills échouent avec `Cannot find module '@sayknow-cli/natives' from '/$bunfs/root/skc'`. L'exécution depuis la source via `dev:link` évite cela. Ne compilez le binaire que lors de la validation d'une release.

Exécutez la CLI depuis la source directement sans lier :

```sh
bun packages/coding-agent/src/cli.ts --help
```

Les définitions de workflow par défaut résident dans la source, et non dans des copies `.skc` commitées :

```text
packages/coding-agent/src/defaults/skc/skills/<name>/SKILL.md
packages/coding-agent/src/prompts/agents/<role>.md
```

Pour les changements de définition de workflow ou de surface de rebrand, exécutez les portes du projet :

```sh
bun scripts/check-visible-definitions.ts
bun scripts/verify-g002-gates.ts
bun scripts/rebrand-inventory.ts --strict
bun test packages/coding-agent/test/default-skc-definitions.test.ts
```

Pour une carte package par package, voir [`docs/codebase-overview.md`](docs/codebase-overview.md).

## Contributors

Les contributions, les rapports de bugs et la validation de release sont les bienvenus via les GitHub Issues et les Pull Requests.

## Inspirations and lineage

L'identité TUI par défaut de Sayknow-CLI est la paire de céphalopodes : blue-octopus comme valeur par défaut avec une alternative chaleureuse red-octopus. Il inclut aussi les thèmes de migration `claude-code`, `codex` et `opencode` dont les palettes sont inspirées de ces outils afin que les utilisateurs qui en proviennent retrouvent une apparence familière. Il s'appuie sur les leçons d'une petite famille de harnais d'agents tout en gardant la surface publique SKC volontairement ciblée. L'attribution historique est conservée dans [`NOTICE.md`](NOTICE.md).

## License

MIT. Voir [`LICENSE`](LICENSE).
