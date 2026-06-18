<p align="center">
  <img src="../../assets/hero.png" alt="Ilustración principal del agente de codificación autónomo Sayknow-CLI" width="100%" />
</p>

<h1 align="center">Sayknow-CLI</h1>

<p align="center">
  <strong>Programar debería sentirse como pensar.</strong><br />
  Un ejecutor de agentes de codificación enfocado en entrevistas, planes revisados, ejecución nativa en tmux y verificación duradera.
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
  <b>Español</b> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.de.md">Deutsch</a>
</p>

<p align="center">
  <img src="../../assets/character.png" alt="Mascota personaje de Sayknow-CLI" width="320" />
</p>

> Sayknow-CLI es un proyecto experimental en fase beta. Espera asperezas y verifica los resultados antes de confiar en él para trabajos importantes.

## Languages

La interfaz está localizada en **7 idiomas** — English, 한국어 (coreano),
中文 (简体 / chino simplificado), 日本語 (japonés), Español,
Français (francés) y Deutsch (alemán). Detecta automáticamente la configuración regional de tu sistema en
el primer arranque; cámbiala en cualquier momento en **Settings → Appearance → Language**, o inícialo
con, por ejemplo, `LANG=ja_JP.UTF-8 skc`. Las cadenas no traducidas recurren al inglés, y
los nombres de marca/técnicos (Claude, OpenAI, MCP, …) se mantienen literales en todas las configuraciones regionales.

## ¿Qué es Sayknow-CLI?

Sayknow-CLI (`skc`) es un arnés externo de agentes de codificación. Se ejecuta desde el repositorio o worktree que elijas y luego le da al agente una superficie de flujo de trabajo pequeña y explícita:

```text
deep-interview -> ralplan -> ultragoal
                         └─ optional team execution when parallel tmux workers help
```

Intencionadamente no es un plugin oculto para Codex CLI, Claude Code, OpenCode o Claw Code. Inicia `skc` junto a esas herramientas cuando quieras planificación estructurada, evidencia persistente, workers respaldados por tmux o un worktree aislado.

## Install

```sh
npm install -g sayknow-cli       # o: bun install -g sayknow-cli
skc --version
```

El paquete incluye binarios nativos precompilados para macOS, Linux y Windows, así que no necesitas Rust ni paso de compilación. Para actualizar: `npm install -g sayknow-cli@latest` o ejecuta `skc update` en la terminal.

> ¿Vienes de una instalación desde el código fuente (git clone)? Cambia una sola vez: `rm -f ~/.local/bin/skc && npm install -g sayknow-cli`. Para la instalación desde el código (desarrollo), consulta el [README en inglés](../../README.md#install-from-source-development).

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

Dentro de una sesión de SKC, usa la superficie pública del flujo de trabajo:

```text
/skill:deep-interview clarify ambiguous requirements
/skill:ralplan build and critique the implementation plan
skc ultragoal create-goals --brief-file <approved-plan>
skc ultragoal complete-goals
```

Añade `skc team ...` solo cuando los workers coordinados de tmux ayuden de forma significativa.

## Capacidades principales

- **Entrevistar antes de suponer**: `deep-interview` convierte solicitudes vagas en requisitos concretos.
- **Planificar antes de mutar**: `ralplan` revisa el enfoque antes de los cambios de código.
- **Ejecutar con evidencia**: `ultragoal` rastrea objetivos, revisiones, comprobaciones y evidencia de finalización.
- **Paralelizar cuando sea útil**: `team` coordina workers respaldados por tmux para tareas más grandes.
- **Mantenerse externo y revisable**: ejecútalo desde un repositorio o worktree elegido sin parchear otro runtime de agente.

## Superficie del flujo de trabajo

Sayknow-CLI incluye cuatro skills de flujo de trabajo predeterminadas:

| Skill            | Qué hace                                                              |
| ---------------- | --------------------------------------------------------------------- |
| `deep-interview` | Aclara requisitos ambiguos antes de planificar o cambiar código.      |
| `ralplan`        | Construye y critica un plan de implementación antes de mutar.         |
| `ultragoal`      | Rastrea objetivos a través de ejecución, revisión, verificación y evidencia. |
| `team`           | Coordina workers respaldados por tmux cuando vale la pena la ejecución paralela. |

Y cuatro agentes de rol incluidos:

| Agent       | Qué hace                                           |
| ----------- | -------------------------------------------------- |
| `executor`  | Implementación acotada, correcciones y refactorizaciones. |
| `architect` | Evaluación de arquitectura y revisión de código de solo lectura. |
| `planner`   | Secuenciación y criterios de aceptación de solo lectura. |
| `critic`    | Crítica de planes y revisión de accionabilidad de solo lectura. |

Sin un zoológico de skills predeterminadas desbordante: SKC mejora haciendo mejor este pequeño método.

## Funciona junto a tu agente o bot existente

| Herramienta o bot | Comando SKC recomendado | Límite |
| ----------- | ----------------------- | -------- |
| Codex CLI | `skc --tmux --worktree <name>` o `skc` | `--worktree` nombra un worktree hermano gestionado por SKC; para una ruta existente, haz `cd` allí primero. |
| Claude Code | `skc --tmux` o `skc --tmux --worktree <name>` | SKC no se convierte en una extensión de Claude Code. |
| OpenCode | `skc` o `skc --tmux` | Solo flujo de trabajo de ejecutor externo por ahora. |
| Claw Code | `skc --tmux --worktree <name>` | SKC no se instala dentro de Claw Code ni lo reemplaza. |
| Controlador / bot externo | `skc mcp-serve coordinator` más `skc setup hermes` para una configuración compatible, o `skc --mode rpc` para un worker en subproceso | Cualquier bot con capacidad MCP/RPC controla SKC mediante el contrato genérico coordinator/RPC, no mediante scraping del scrollback. |

Para la configuración genérica de bots de terceros y pruebas de humo independientes del proveedor, consulta [`docs/bot-integration.md`](docs/bot-integration.md). Para la clasificación de preparación a través de las superficies MCP, RPC, ACP y Bridge/HTTPS, consulta [`docs/external-control-readiness.md`](docs/external-control-readiness.md). Para los detalles de protocolo de más bajo nivel, consulta [`docs/hermes-mcp-bridge.md`](docs/hermes-mcp-bridge.md), [`docs/rpc.md`](docs/rpc.md) y [`docs/bridge.md`](docs/bridge.md). Para la hoja de ruta de las superficies de operador remoto, consulta [`docs/sayknow-remote.md`](docs/sayknow-remote.md) (volante web) y [`docs/telegram-remote.md`](docs/telegram-remote.md) (botón de ciclo de vida de Telegram).

## Configuration

Los presupuestos de reintento del proveedor viven en `~/.skc/config.yml`:

```yaml
retry:
  requestMaxRetries: 4
  streamMaxRetries: 100
  maxRetries: 3
  maxDelayMs: 300000
```

`requestMaxRetries` se aplica antes de que se establezca un stream. `streamMaxRetries` se aplica solo a fallos transitorios de stream que son seguros de reproducir. La autenticación inválida, los modelos/proveedores no compatibles, las solicitudes malformadas, el desbordamiento de contexto, las cancelaciones del usuario y los fallos permanentes de cuota siguen siendo de fallo rápido.

## Identidad de la TUI

La identidad predeterminada de la TUI es el tema **blue-octopus** de SKC — la mascota del cefalópodo azul — tanto para terminales oscuras como claras. También se incluye una variante cálida **red-octopus** para quienes prefieren una paleta más oscura y de alto contraste. Tres temas de migración adicionales — `claude-code`, `codex` y `opencode` — reflejan el aspecto de esas herramientas para facilitar la migración visual y se pueden seleccionar desde Settings o `/theme`. Los ajustes de tema explícitos del usuario siguen prevaleciendo.

### Cuadrícula de temas incluidos

Elige desde Settings (`Appearance -> Dark theme` / `Light theme`) o `/theme`.

| Tema | Sensación visual | Mejor uso |
| --- | --- | --- |
| `blue-octopus` | Identidad predeterminada de SKC — paleta de pulpo azul con acentos azul-tentáculo. | Predeterminado para terminales oscuras y claras. |
| `red-octopus` | Variante cálida de pulpo rojo con fuerte contraste de estado. | Alternativa oscura de alto contraste. |
| `claude-code` | Paleta oscura inspirada en Claude Code con resaltados terracota y rosa. | Memoria muscular de Claude Code sin salir de SKC. |
| `codex` | Paleta nítida azul-gris oscuro con un contraste de sesión de codificación más marcado. | Un espacio de trabajo oscuro al estilo Codex. |
| `opencode` | Paleta oscura inspirada en OpenCode con acentos de terminal más vibrantes. | Memoria muscular de OpenCode en el selector incluido. |

## Development

Instala las dependencias, compila los bindings nativos y configura los valores predeterminados locales:

```sh
bun install
bun run build:native
bun run install:defaults
```

El binario `.node` para `@sayknow-cli/natives` está en gitignore y es necesario antes de cualquier invocación del CLI (`install:defaults`, `dev:link`, tests).

### Canónico: compilar y enlazar el `skc` de desarrollo

Para hacer que el comando global `skc` ejecute **el código fuente TypeScript de esta copia** (sensible a cada edición, con skills/natives funcionando), enlázalo a tu `PATH`:

```sh
bun install
bun run dev:link
```

`dev:link` crea un symlink de `skc` → `packages/coding-agent/src/cli.ts` en `~/.local/bin` (sobrescríbelo con `SKC_DEV_LINK_DIR`), reemplaza ese objetivo gestionado, advierte y falla si otro `skc` aún lo oculta antes en `PATH`, y ejecuta `--smoke-test` para confirmar que `@sayknow-cli/natives` carga. Usa `bun run install:dev` para el bootstrap completo (install + link + `setup defaults`).

Comprueba en cualquier momento si tu `skc` se ha desviado (fuente incorrecta, o un binario compilado que no puede cargar skills):

```sh
bun run dev:doctor
```

> **No** uses el binario compilado para el desarrollo diario. `bun --cwd=packages/coding-agent run build` produce un `dist/skc` independiente, pero un binario `bun build --compile` no puede cargar dinámicamente `@sayknow-cli/natives`, por lo que las skills fallan con `Cannot find module '@sayknow-cli/natives' from '/$bunfs/root/skc'`. Ejecutar desde el código fuente mediante `dev:link` evita esto. Compila el binario solo al validar una release.

Ejecuta el CLI directamente desde el código fuente sin enlazarlo:

```sh
bun packages/coding-agent/src/cli.ts --help
```

Las definiciones de flujo de trabajo predeterminadas viven en el código fuente, no en copias `.skc` comprometidas:

```text
packages/coding-agent/src/defaults/skc/skills/<name>/SKILL.md
packages/coding-agent/src/prompts/agents/<role>.md
```

Para cambios en las definiciones de flujo de trabajo o en la superficie de rebranding, ejecuta las puertas del proyecto:

```sh
bun scripts/check-visible-definitions.ts
bun scripts/verify-g002-gates.ts
bun scripts/rebrand-inventory.ts --strict
bun test packages/coding-agent/test/default-skc-definitions.test.ts
```

Para un mapa paquete por paquete, consulta [`docs/codebase-overview.md`](docs/codebase-overview.md).

## Contributors

Las contribuciones, los informes de errores y la validación de releases son bienvenidos a través de GitHub Issues y Pull Requests.

## Inspiraciones y linaje

La identidad predeterminada de la TUI de Sayknow-CLI es la pareja de cefalópodos: blue-octopus como predeterminado con un red-octopus cálido como alternativa. También incluye los temas de migración `claude-code`, `codex` y `opencode`, cuyas paletas están inspiradas en esas herramientas para que los usuarios que migran de ellas obtengan un aspecto familiar. Se basa en las lecciones de una pequeña familia de arneses de agentes mientras mantiene la superficie pública de SKC intencionadamente enfocada. La atribución histórica se conserva en [`NOTICE.md`](NOTICE.md).

## License

MIT. Consulta [`LICENSE`](LICENSE).
