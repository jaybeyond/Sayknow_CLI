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

```sh
npm install -g sayknow-cli       # ou : bun install -g sayknow-cli
skc --version
```

Le paquet embarque des binaires natifs précompilés pour macOS, Linux et Windows : aucune chaîne d'outils Rust ni étape de compilation. Pour mettre à jour : `npm install -g sayknow-cli@latest` ou lancez `skc update` dans le terminal.

> Vous veniez d'une installation depuis les sources (git clone) ? Basculez une seule fois : `rm -f ~/.local/bin/skc && npm install -g sayknow-cli`. Pour l'installation depuis les sources (développement), voir le [README en anglais](../../README.md#install-from-source-development).

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
- **Continuer quand un provider tombe** : quand le modèle par défaut est bloqué (identifiants absents, quota, erreurs d'authentification ou serveur), la session continue sur un modèle d'un autre provider ; `/fallback` affiche et modifie cette chaîne. Une étape interrompue par un redémarrage ou un échec transitoire reprend d'elle-même une fois, sur le même modèle. Les réponses de quota comme le `1113` de Z.AI passent à la suite après une seule requête au lieu d'épuiser le budget de retry.
- **Les longues sessions restent dans la fenêtre de contexte** : après une compaction, Codex repart d'une base neuve visible par le provider au lieu de grossir jusqu'à `context_length_exceeded`, et les résumés de compaction sont formulés pour que les providers ne les refusent pas.
- **Trouver le code par son sens** : l'outil `locate` trouve où se situe un comportement à partir d'une simple description, quand vous n'avez aucun nom à passer à grep.
- **Router le travail vers le bon modèle** : `/model` attribue les modèles par rôle et par usage détaillé ; les tâches de subagent déclarent une `specialty` pour tomber sur le modèle que vous avez choisi pour ce type de travail.
- **Livrer depuis la session** : les outils `github` et `gitlab` ouvrent et inspectent les pull/merge requests et la CI sans quitter SKC.
- **Prouver que les tests ont tourné sur ce code** : le plugin `verification-receipts` enregistre un reçu pour chaque exécution de tests et vous signale quand le code a changé depuis.
- **Revenir à n'importe quelle session** : sélecteur de reprise `alt+r`, `ctrl+q` pour reprendre la plus récente, `/star`, `/fork`, `/rename` et `/import-session` pour les transcripts Codex et Claude Code.

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

## Built-in tools

L'agent travaille à travers ces outils. Les outils marqués *opt-in* restent désactivés tant que vous ne les activez pas dans **Settings → Tools** (ou via la clé indiquée dans `~/.skc/config.yml`).

| Area | Tools |
| ---- | ----- |
| Fichiers et code | `read`, `write`, `edit`, `find`, `search`, `locate` (trouver du code à partir d'une description), `ast_grep` / `ast_edit` (recherche et réécriture tenant compte de la syntaxe), `lsp` |
| Shell et runtime | `bash`, `eval` (cellules JS/Python), `ssh`, `debug`, `bisect`, `calc` |
| Délégation et suivi | `task` (subagents), `subagent`, `job`, `monitor`, `cron`, `irc` (dialoguer avec les agents en cours d'exécution), `todo_write`, `goal`, `checkpoint` / `rewind` |
| Hébergement Git | `github` (*opt-in*, `github.enabled`) : pull requests, pushes et exécutions CI via `gh` · `gitlab` (*opt-in*, `gitlab.enabled`, nécessite [`glab`](https://gitlab.com/gitlab-org/cli)) : `mr_create` (renvoie la MR déjà ouverte au lieu d'en créer un doublon), `mr_view`, `mr_list`, `ci_status` pour gitlab.com et les instances auto-hébergées |
| Web et appareils | `web_search`, `browser`, `computer`, `render_mermaid` |
| Découverte | `search_tool_bm25` (active à la demande les outils masqués et MCP), `skill`, `skill_discovery`, `ask` |

Choisissez le jeu d'outils d'une exécution avec `--tools read,bash,...` ; les noms d'outils de plugins, personnalisés et MCP y sont aussi acceptés.

## Plugins

SKC charge des bundles de plugins (outils, hooks, skills, serveurs MCP) dont le hash est vérifié à l'installation et qui sont mis en quarantaine si un fichier change par la suite. Gérez-les avec `skc plugin install|list|...`.

**`verification-receipts`** (inclus dans ce dépôt) répond à la question « les tests passent-ils vraiment sur le code tel qu'il est maintenant ? » :

- `verification_run` exécute des fichiers de test explicites avec `bun test` ou `node --test` et enregistre un reçu immuable : le nombre de réussites/échecs par fichier, plus une empreinte de l'arbre de travail.
- `verification_status` recalcule cette empreinte sans relancer les tests et indique `fresh`, ou `stale` dès que le code a changé.
- `verification_loop` et ses hooks vous préviennent quand une `task` en arrière-plan s'est terminée sans reçu à jour.

Il est purement indicatif, réservé à POSIX, et nécessite Node 24.11.1+ pour `node --test`. Il ne fait pas partie du paquet npm ; installez-le depuis un checkout :

```sh
git clone https://github.com/jaybeyond/Sayknow_CLI.git
skc plugin install ./Sayknow_CLI/packages/coding-agent/bundles/verification-receipts --user
```

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

Le comportement de retry, de reprise et de fallback du provider se trouve dans `~/.skc/config.yml` (les valeurs ci-dessous sont celles par défaut) :

```yaml
retry:
  requestMaxRetries: 4
  streamMaxRetries: 100
  maxRetries: 3
  maxDelayMs: 300000
  autoResume: true          # reprendre une seule fois une étape interrompue, sur le même modèle
  maxSilentTimeouts: 3      # s'arrêter après ce nombre de timeouts sans aucune sortie
fallback:
  auto: true                # continuer sur un autre provider connecté quand le modèle par défaut est bloqué
  maxAttempts: 3            # tentatives par modèle de la chaîne avant de passer au suivant
```

`requestMaxRetries` s'applique avant qu'un stream ne soit établi. `streamMaxRetries` ne s'applique qu'aux échecs de stream transitoires sûrs pour le replay. L'authentification invalide, les modèles/providers non pris en charge, les requêtes malformées, le débordement de contexte, les abandons par l'utilisateur et les échecs de quota permanents échouent immédiatement sur le modèle courant ; avec `fallback.auto`, un modèle par défaut bloqué passe ensuite la main au modèle suivant de la chaîne (`/fallback` l'affiche et la modifie).

## TUI identity

L'identité TUI par défaut est le thème SKC **ink-octopus** — encre de poulpe : graphite chaud, texte couleur papier, un seul accent ambre — pour les terminaux sombres, avec **blue-octopus** pour les terminaux clairs. Une variante chaleureuse **red-octopus** est également incluse pour ceux qui préfèrent une palette plus sombre et à fort contraste. Trois thèmes de migration supplémentaires — `claude-code`, `codex` et `opencode` — reflètent l'apparence de ces outils pour faciliter la migration visuelle et sont sélectionnables depuis Settings ou `/theme`. Les réglages de thème explicites de l'utilisateur l'emportent toujours.

### Bundled theme grid

Choisissez depuis Settings (`Appearance -> Dark theme` / `Light theme`) ou `/theme`.

| Theme | Visual feel | Best fit |
| --- | --- | --- |
| `blue-octopus` | Palette poulpe bleu avec des accents bleu tentacule. | Par défaut pour les terminaux clairs. |
| `red-octopus` | Variante chaleureuse poulpe rouge avec un fort contraste d'état. | Alternative sombre à fort contraste. |
| `ink-octopus` | Encre de poulpe — fond graphite chaud, texte couleur papier, un seul accent ambre. | Par défaut pour les terminaux sombres. |
| `glow-octopus` | Bioluminescence abyssale — noir sarcelle avec un vert lumineux et un violet secondaire. | Terminaux sombres qui veulent un accent vif. |
| `violet-octopus` | Sombre prune avec des accents lavande et un abricot secondaire. | Alternative sombre douce et colorée. |
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

L'identité TUI par défaut de Sayknow-CLI est la famille de poulpes : ink-octopus par défaut en sombre, blue-octopus par défaut en clair, et red-octopus, glow-octopus et violet-octopus en alternatives. Il inclut aussi les thèmes de migration `claude-code`, `codex` et `opencode` dont les palettes sont inspirées de ces outils afin que les utilisateurs qui en proviennent retrouvent une apparence familière. Il s'appuie sur les leçons d'une petite famille de harnais d'agents tout en gardant la surface publique SKC volontairement ciblée. L'attribution historique est conservée dans [`NOTICE.md`](NOTICE.md).

## License

MIT. Voir [`LICENSE`](LICENSE).
