import type { ThinkingLevel } from "@sayknow-cli/agent-core";
import { type Component, padding, truncateToWidth, visibleWidth } from "@sayknow-cli/tui";
import { formatBuildLabel } from "../../build-metadata";
import { formatKeyHint, type KeyDisplayContext } from "../../config/keybindings";
import { type MsgKey, t } from "../../i18n";
import { theme } from "../../modes/theme/theme";

export interface RecentSession {
	name: string;
	timeAgo: string;
}

export interface LspServerInfo {
	name: string;
	status: "idle" | "ready" | "error" | "connecting";
	fileTypes: string[];
}

export interface WelcomeRoleBinding {
	role: string;
	model: string;
}

/**
 * Workspace and runtime facts shown in the launch ledger. Every field is
 * optional: the ledger renders what is known and fills the rest in as the
 * asynchronous probes (git status, context files, MCP) settle.
 */
export interface WelcomeSnapshot {
	/** Display path of the project directory (already home-shortened). */
	cwd?: string;
	/** Current branch, `"detached"`, or `null` outside a git repository. */
	branch?: string | null;
	gitChanges?: { staged: number; unstaged: number; untracked: number } | null;
	/** Latest commits as `<short-sha> <subject>` onelines, newest first. */
	recentCommits?: readonly string[];
	thinkingLevel?: ThinkingLevel | string;
	/** Display name of the active model preset. */
	profile?: string;
	roles?: readonly WelcomeRoleBinding[];
	mcp?: { connected: number; total: number };
	skills?: number;
	/** Display names of the loaded project instruction files (AGENTS.md, …). */
	contextFiles?: readonly string[];
}

export type WelcomeLogoMode = "unicode" | "square" | "ascii";
export interface WelcomeComponentOptions {
	getViewportRows?: () => number | undefined;
	getReservedBottomRows?: (termWidth: number) => number;
	changelogMarkdown?: string;
	rightGutterWidth?: number;
	collapseChangelog?: boolean;
	buildLabel?: string;
	keyDisplayContext?: KeyDisplayContext;
	skipLogoAnimation?: boolean;
	snapshot?: WelcomeSnapshot;
}

/** Below this width the ledger and the activity column stack instead of sitting side by side. */
const TWO_COLUMN_MIN_WIDTH = 100;
const COLUMN_GAP = 4;
const MIN_RIGHT_COLUMN = 36;
const DEFAULT_WHATS_NEW_ROWS = 3;
const MAX_WHATS_NEW_ROWS = 12;
const DEFAULT_SESSION_ROWS = 3;
const MAX_LSP_ROWS = 3;
const MAX_COMMIT_ROWS = 3;

/** Stagger between two ledger sections appearing during the launch reveal. */
const SECTION_STAGGER_MS = 55;
/** How long the whole ledger stays in dim ink before the first section takes its colors. */
const SECTION_SETTLE_MS = 90;

function flowKeyItems(context: KeyDisplayContext): ReadonlyArray<{ key: string; label: string }> {
	const newlineKey = context.platform === "win32" ? "alt+enter" : "ctrl+j";
	return [
		{ key: "/", label: "commands" },
		{ key: "#", label: "actions" },
		{ key: "!", label: "shell" },
		{ key: "$", label: "python" },
		{ key: "?", label: "keymap" },
		{ key: "ctrl+l", label: "model" },
		{ key: "shift+tab", label: "reasoning" },
		{ key: "tab", label: "complete" },
		{ key: newlineKey, label: "newline" },
		{ key: "ctrl+c", label: "clear" },
	];
}

const WORKFLOWS: ReadonlyArray<{ command: string; key: MsgKey }> = [
	{ command: "/deep-interview", key: "welcome.wf.deepInterview" },
	{ command: "/ralplan", key: "welcome.wf.ralplan" },
	{ command: "/ultragoal", key: "welcome.wf.ultragoal" },
	{ command: "/team", key: "welcome.wf.team" },
];

/** A block of rows revealed together during the launch intro. */
interface Section {
	lines: string[];
}

/**
 * Sayknow-CLI launch surface: an open, borderless ledger. The left column is
 * the state of this workspace — path, branch, model, reasoning, preset, role
 * agents, tooling — so the first screen answers "what am I about to run with".
 * The right column carries activity: what changed, recent sessions, workflows
 * and keys. No enclosing box and no hero wordmark: the octopus mark and the
 * facts carry the identity.
 */
export class WelcomeComponent implements Component {
	#animStart: number | null = null;
	#animTimer: NodeJS.Timeout | null = null;
	#snapshot: WelcomeSnapshot;

	constructor(
		private readonly version: string,
		private modelName: string,
		private providerName: string,
		private recentSessions: RecentSession[] = [],
		private lspServers: LspServerInfo[] = [],
		private readonly logoMode: WelcomeLogoMode = "unicode",
		private readonly options: WelcomeComponentOptions = {},
	) {
		this.#snapshot = { ...options.snapshot };
	}

	invalidate(): void {}

	/**
	 * Play a short one-shot reveal: sections appear top to bottom a few frames
	 * apart, each settling from dim into its colors. Launch happens once per
	 * session, so a sub-second reveal is affordable; it never blocks input.
	 * Safe to call multiple times — subsequent calls reset and replay.
	 */
	playIntro(requestRender: () => void): void {
		this.#stopAnimation();
		if (this.options.skipLogoAnimation) {
			requestRender();
			return;
		}
		this.#animStart = performance.now();
		requestRender();
		this.#animTimer = setInterval(() => {
			const elapsed = performance.now() - (this.#animStart ?? 0);
			if (elapsed >= INTRO_MS) {
				this.#stopAnimation();
			}
			requestRender();
		}, INTRO_TICK_MS);
		this.#animTimer.unref?.();
	}

	dispose(): void {
		this.#stopAnimation();
	}

	#stopAnimation(): void {
		if (this.#animTimer != null) {
			clearInterval(this.#animTimer);
			this.#animTimer = null;
		}
		this.#animStart = null;
	}

	setModel(modelName: string, providerName: string): void {
		this.modelName = modelName;
		this.providerName = providerName;
	}

	setRecentSessions(sessions: RecentSession[]): void {
		this.recentSessions = sessions;
	}

	setLspServers(servers: LspServerInfo[]): void {
		this.lspServers = servers;
	}

	/** Merge newly probed workspace facts into the ledger. */
	setSnapshot(patch: WelcomeSnapshot): void {
		this.#snapshot = { ...this.#snapshot, ...patch };
	}

	render(termWidth: number): string[] {
		const gutterWidth = this.#rightGutterWidth(termWidth);
		const width = Math.max(0, termWidth - gutterWidth);
		if (width < 4) return [];

		const targetRows = this.#targetRows(termWidth);
		if (targetRows !== undefined && targetRows <= 0) return [];

		const header = this.#fitToWidth(this.#headerLine(width), width);
		if (targetRows === 1) return this.#withRightGutter([header], gutterWidth);

		const rule = theme.fg("borderMuted", this.#ruleGlyph().repeat(width));
		const bodyRows = targetRows === undefined ? undefined : Math.max(0, targetRows - 2);

		const twoColumn = width >= TWO_COLUMN_MIN_WIDTH;
		const leftWidth = twoColumn
			? Math.min(Math.max(44, Math.floor(width * 0.52)), width - COLUMN_GAP - MIN_RIGHT_COLUMN)
			: width;
		const rightWidth = twoColumn ? width - leftWidth - COLUMN_GAP : width;

		const ledger = this.#ledgerSections(leftWidth);
		const ledgerRows = ledger.reduce((sum, section) => sum + section.lines.length, 0);
		const activityBudget =
			bodyRows === undefined ? undefined : twoColumn ? bodyRows : Math.max(0, bodyRows - ledgerRows - 1);
		const activity = this.#activitySections(rightWidth, activityBudget);

		const reveal = this.#revealState(ledger.length + activity.length);
		const leftLines = this.#revealLines(ledger, 0, reveal);
		const rightLines = this.#revealLines(activity, ledger.length, reveal);

		const body: string[] = [];
		if (twoColumn) {
			const rows = bodyRows ?? Math.max(leftLines.length, rightLines.length);
			const left = this.#clip(leftLines, rows);
			const right = this.#clip(rightLines, rows);
			const gap = padding(COLUMN_GAP);
			for (let i = 0; i < rows; i++) {
				body.push(this.#fitToWidth(left[i] ?? "", leftWidth) + gap + this.#fitToWidth(right[i] ?? "", rightWidth));
			}
		} else {
			const stacked = [...leftLines, "", ...rightLines];
			const rows = bodyRows ?? stacked.length;
			for (const line of this.#clip(stacked, rows)) body.push(this.#fitToWidth(line, width));
			while (body.length < rows) body.push(padding(width));
		}

		return this.#withRightGutter([header, rule, ...body], gutterWidth);
	}

	// ── Header ──────────────────────────────────────────────────────────────

	#headerLine(width: number): string {
		const buildLabel = this.options.buildLabel ?? formatBuildLabel();
		const mark = theme.icon.pi ? `${theme.icon.pi} ` : "";
		const left = ` ${mark}${theme.bold(theme.fg("text", "Sayknow-CLI"))}${theme.fg("dim", ` v${this.version} · ${buildLabel}`)}`;
		const tagline = theme.fg("muted", t("welcome.tagline"));
		const room = width - visibleWidth(left) - visibleWidth(tagline) - 1;
		return room >= 2 ? `${left}${padding(room)}${tagline} ` : left;
	}

	#ruleGlyph(): string {
		return this.logoMode === "ascii" ? "-" : "─";
	}

	// ── Left column: workspace ledger ───────────────────────────────────────

	#ledgerSections(width: number): Section[] {
		const labels = {
			workspace: t("welcome.label.workspace"),
			branch: t("welcome.label.branch"),
			commits: t("welcome.label.commits"),
			model: t("welcome.label.model"),
			reasoning: t("welcome.label.reasoning"),
			preset: t("welcome.label.preset"),
			roles: t("welcome.label.roles"),
			tools: t("welcome.label.tools"),
		};
		const labelWidth = Math.max(...Object.values(labels).map(label => visibleWidth(label))) + 2;
		const valueWidth = Math.max(1, width - labelWidth - 1);
		const row = (label: string, value: string): string =>
			` ${theme.fg("dim", label)}${padding(Math.max(0, labelWidth - visibleWidth(label)))}${this.#truncate(value, valueWidth)}`;
		const continuation = (value: string): string => ` ${padding(labelWidth)}${this.#truncate(value, valueWidth)}`;
		const snapshot = this.#snapshot;
		const sep = theme.fg("dim", " · ");

		// Where
		const where: string[] = [];
		if (snapshot.cwd)
			where.push(row(labels.workspace, theme.fg("statusLinePath", this.#shortenFromLeft(snapshot.cwd, valueWidth))));
		if (snapshot.branch !== undefined) {
			const branch =
				snapshot.branch === null
					? theme.fg("dim", t("welcome.noGit"))
					: `${theme.fg(this.#isDirty() ? "statusLineGitDirty" : "statusLineGitClean", snapshot.branch)}${this.#gitChangeSummary(sep)}`;
			where.push(row(labels.branch, branch));
		}
		(snapshot.recentCommits ?? []).slice(0, MAX_COMMIT_ROWS).forEach((oneline, index) => {
			const space = oneline.indexOf(" ");
			const value =
				space > 0
					? `${theme.fg("accent", oneline.slice(0, space))} ${theme.fg("muted", oneline.slice(space + 1))}`
					: theme.fg("muted", oneline);
			where.push(index === 0 ? row(labels.commits, value) : continuation(value));
		});

		// Brain
		const brain: string[] = [];
		const hasModel = this.modelName !== "Unknown" && this.modelName.length > 0;
		brain.push(
			row(
				labels.model,
				hasModel
					? `${theme.bold(theme.fg("statusLineModel", this.modelName))}${sep}${theme.fg("muted", this.providerName)}`
					: `${theme.fg("accent", t("welcome.chooseModel"))}${sep}${theme.fg("dim", t("welcome.modelHint"))}`,
			),
		);
		if (snapshot.thinkingLevel) {
			const level = String(snapshot.thinkingLevel);
			brain.push(row(labels.reasoning, theme.getThinkingBorderColor(level as ThinkingLevel)(level)));
		}
		brain.push(row(labels.preset, snapshot.profile ? theme.fg("text", snapshot.profile) : theme.fg("dim", "—")));
		const roles = snapshot.roles ?? [];
		if (roles.length === 0) {
			brain.push(row(labels.roles, theme.fg("dim", t("welcome.rolesInherit"))));
		} else {
			const roleWidth = Math.max(...roles.map(role => visibleWidth(role.role))) + 2;
			roles.forEach((binding, index) => {
				const value = `${theme.fg("muted", binding.role)}${padding(roleWidth - visibleWidth(binding.role))}${theme.fg("text", binding.model)}`;
				brain.push(index === 0 ? row(labels.roles, value) : continuation(value));
			});
		}

		// Hands
		const hands: string[] = [];
		const toolFacts: string[] = [];
		if (snapshot.mcp) {
			const { connected, total } = snapshot.mcp;
			const color = total === 0 ? "dim" : connected === total ? "success" : "warning";
			toolFacts.push(`${theme.fg("muted", "MCP")} ${theme.fg(color, total === 0 ? "0" : `${connected}/${total}`)}`);
		}
		if (snapshot.skills !== undefined) {
			toolFacts.push(`${theme.fg("muted", t("welcome.skills"))} ${theme.fg("text", String(snapshot.skills))}`);
		}
		if (snapshot.contextFiles !== undefined) {
			const files = snapshot.contextFiles;
			const shown = files.length === 0 ? theme.fg("dim", "—") : theme.fg("text", files[0]!);
			const more = files.length > 1 ? theme.fg("dim", ` +${files.length - 1}`) : "";
			toolFacts.push(`${theme.fg("muted", t("welcome.rules"))} ${shown}${more}`);
		}
		const lspLines = this.#lspLines();
		const toolRows = [...(toolFacts.length > 0 ? [toolFacts.join(sep)] : []), ...lspLines];
		toolRows.forEach((value, index) => {
			hands.push(index === 0 ? row(labels.tools, value) : continuation(value));
		});

		return [where, brain, hands].filter(lines => lines.length > 0).map(lines => ({ lines: [...lines, ""] }));
	}

	#lspLines(): string[] {
		if (this.lspServers.length === 0) return [theme.fg("dim", t("welcome.noLsp"))];
		const lines = this.lspServers.slice(0, MAX_LSP_ROWS).map(server => {
			const icon =
				server.status === "ready"
					? theme.styledSymbol("status.success", "success")
					: server.status === "error"
						? theme.styledSymbol("status.error", "error")
						: theme.styledSymbol("status.pending", "muted");
			return `${icon} ${theme.fg("muted", server.name)} ${theme.fg("dim", server.fileTypes.slice(0, 3).join(" "))}`;
		});
		const hidden = this.lspServers.length - MAX_LSP_ROWS;
		if (hidden > 0) lines.push(theme.fg("dim", `+${hidden} LSP`));
		return lines;
	}

	#isDirty(): boolean {
		const changes = this.#snapshot.gitChanges;
		return !!changes && changes.staged + changes.unstaged + changes.untracked > 0;
	}

	#gitChangeSummary(sep: string): string {
		const changes = this.#snapshot.gitChanges;
		if (changes === undefined) return "";
		if (changes === null) return "";
		if (!this.#isDirty()) return `${sep}${theme.fg("dim", t("welcome.clean"))}`;
		const parts: string[] = [];
		if (changes.staged > 0) parts.push(theme.fg("statusLineStaged", `+${changes.staged}`));
		if (changes.unstaged > 0) parts.push(theme.fg("statusLineDirty", `~${changes.unstaged}`));
		if (changes.untracked > 0) parts.push(theme.fg("statusLineUntracked", `?${changes.untracked}`));
		return `${sep}${parts.join(" ")}`;
	}

	// ── Right column: activity ──────────────────────────────────────────────

	#activitySections(width: number, rowBudget: number | undefined): Section[] {
		const keyRows = this.#flowKeyRows(width);
		const heading = (label: string, note?: string): string =>
			` ${theme.bold(theme.fg("accent", label))}${note ? theme.fg("dim", `  ${note}`) : ""}`;
		const sessionCount = this.recentSessions.length;
		const sessionBaseline = sessionCount === 0 ? 1 : Math.min(DEFAULT_SESSION_ROWS, sessionCount);

		// Fixed rows: 4 headings + 3 blank separators + workflows + keys + baseline trail.
		const fixedRows = 4 + 3 + WORKFLOWS.length + keyRows.length + sessionBaseline;
		const spare = rowBudget === undefined ? 0 : Math.max(0, rowBudget - fixedRows - DEFAULT_WHATS_NEW_ROWS);
		const whatsNewLimit =
			rowBudget === undefined
				? 5
				: Math.max(1, Math.min(MAX_WHATS_NEW_ROWS, DEFAULT_WHATS_NEW_ROWS + Math.ceil(spare / 2)));
		const whatsNew = this.#whatsNewLines(width, whatsNewLimit);
		const sessionLimit =
			rowBudget === undefined
				? sessionBaseline
				: Math.min(sessionCount, sessionBaseline + Math.max(0, rowBudget - fixedRows - whatsNew.length));

		const changelog = this.options.changelogMarkdown?.trim();
		const version = changelog ? this.#latestChangelogVersion(changelog) : undefined;

		const workflowWidth = Math.max(...WORKFLOWS.map(item => visibleWidth(item.command))) + 2;
		return [
			{ lines: [heading(t("welcome.whatsNew"), version ? `v${version}` : undefined), ...whatsNew, ""] },
			{ lines: [heading(t("welcome.sessionTrail")), ...this.#sessionTrailLines(width, sessionLimit), ""] },
			{
				lines: [
					heading(t("welcome.workflows")),
					...WORKFLOWS.map(
						item =>
							`  ${theme.fg("accent", item.command)}${padding(workflowWidth - visibleWidth(item.command))}${theme.fg("muted", t(item.key))}`,
					),
					"",
				],
			},
			{ lines: [heading(t("welcome.flowKeys")), ...keyRows] },
		];
	}

	#flowKeyItemText(item: { key: string; label: string }): string {
		const context = this.options.keyDisplayContext ?? { platform: process.platform };
		return `${theme.fg("text", formatKeyHint(item.key, context))}${theme.fg("dim", ` ${this.#flowKeyLabel(item.label)}`)}`;
	}

	#flowKeyLabel(label: string): string {
		switch (label) {
			case "commands":
				return t("welcome.commands");
			case "actions":
				return t("welcome.actions");
			case "shell":
				return t("welcome.shell");
			case "python":
				return t("welcome.python");
			case "keymap":
				return t("welcome.keymap");
			case "model":
				return t("welcome.model");
			case "reasoning":
				return t("welcome.reasoning");
			default:
				return label;
		}
	}

	#flowKeyRows(width: number): string[] {
		const contentWidth = Math.max(1, width - 2);
		const separator = theme.fg("dim", "  ");
		const rows: string[] = [];
		let current = "";
		for (const item of flowKeyItems(this.options.keyDisplayContext ?? { platform: process.platform })) {
			const segment = this.#flowKeyItemText(item);
			const next = current ? `${current}${separator}${segment}` : segment;
			if (current && visibleWidth(next) > contentWidth) {
				rows.push(`  ${current}`);
				current = segment;
			} else {
				current = next;
			}
		}
		if (current) rows.push(`  ${current}`);
		return rows;
	}

	#sessionTrailLines(width: number, limit: number): string[] {
		if (this.recentSessions.length === 0) {
			return [`  ${theme.fg("dim", t("welcome.noSessions"))}`];
		}
		const lines: string[] = [];
		for (const session of this.recentSessions.slice(0, Math.max(1, limit))) {
			const time = theme.fg("dim", session.timeAgo);
			const nameBudget = Math.max(1, width - 2 - visibleWidth(session.timeAgo) - 2);
			const name = this.#truncate(session.name, nameBudget);
			const pad = padding(Math.max(1, width - 2 - visibleWidth(name) - visibleWidth(session.timeAgo)));
			lines.push(`  ${theme.fg("muted", name)}${pad}${time}`);
		}
		return lines;
	}

	#whatsNewLines(width: number, maxRows: number): string[] {
		const rowLimit = Math.max(1, Math.floor(maxRows));
		const changelog = this.options.changelogMarkdown?.trim();
		if (!changelog) return [`  ${theme.fg("dim", t("welcome.readyPrompt"))}`];

		const version = this.#latestChangelogVersion(changelog);
		const items = this.options.collapseChangelog ? [] : this.#changelogItems(changelog);
		if (items.length === 0) {
			return [
				`  ${theme.fg("muted", `Updated to v${version}`)}`,
				`  ${theme.fg("dim", `Use ${theme.bold("/changelog")} for details`)}`,
			].slice(0, rowLimit);
		}

		const bullet = `  ${theme.md.bullet} `;
		const textWidth = Math.max(1, width - visibleWidth(bullet));
		const visibleCount = items.length > rowLimit ? Math.max(1, rowLimit - 1) : rowLimit;
		const lines = items
			.slice(0, visibleCount)
			.map(item => `${theme.fg("accent", bullet)}${theme.fg("muted", this.#truncate(item, textWidth))}`);
		if (items.length > lines.length && lines.length < rowLimit) {
			lines.push(`  ${theme.fg("dim", `… ${theme.bold("/changelog")} for full notes`)}`);
		}
		return lines;
	}

	#latestChangelogVersion(markdown: string): string {
		const versionMatch = markdown.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/);
		return versionMatch?.[1] ?? this.version;
	}

	#changelogItems(markdown: string): string[] {
		const items: string[] = [];
		let inFence = false;
		for (const rawLine of markdown.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (line.startsWith("```")) {
				inFence = !inFence;
				continue;
			}
			if (inFence || !line || /^#{1,6}\s+/.test(line) || /^-{3,}$/.test(line)) continue;
			const withoutBullet = line
				.replace(/^[-*]\s+/, "")
				.replace(/^\d+\.\s+/, "")
				.replace(/^>\s*/, "");
			const cleaned = this.#stripMarkdown(withoutBullet);
			if (cleaned) items.push(cleaned);
		}
		return items;
	}

	#stripMarkdown(text: string): string {
		return text
			.replace(/`([^`]+)`/g, "$1")
			.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
			.replace(/\*\*([^*]+)\*\*/g, "$1")
			.replace(/__([^_]+)__/g, "$1")
			.replace(/\*([^*]+)\*/g, "$1")
			.replace(/[_~]/g, "")
			.trim();
	}

	// ── Launch reveal ───────────────────────────────────────────────────────

	/** How many sections are visible, and which one is still settling, at this frame. */
	/** Number of sections that have taken their colors; the rest are still drawn, but in dim ink. */
	#revealState(sectionCount: number): { colored: number } {
		if (this.#animStart == null) return { colored: sectionCount };
		const elapsed = performance.now() - this.#animStart;
		return { colored: Math.min(sectionCount, Math.floor((elapsed - SECTION_SETTLE_MS) / SECTION_STAGGER_MS) + 1) };
	}

	/**
	 * Every fact is on screen from the first frame; the intro only lets color
	 * spread top to bottom, like ink soaking in. Content never waits on the effect.
	 */
	#revealLines(sections: Section[], offset: number, reveal: { colored: number }): string[] {
		const lines: string[] = [];
		sections.forEach((section, index) => {
			if (offset + index < reveal.colored) {
				lines.push(...section.lines);
				return;
			}
			for (const line of section.lines) lines.push(theme.fg("dim", Bun.stripANSI(line)));
		});
		return lines;
	}

	// ── Layout helpers ──────────────────────────────────────────────────────

	#clip(lines: string[], rows: number): string[] {
		if (rows <= 0) return [];
		if (lines.length <= rows) return lines;
		if (rows === 1) return [theme.fg("dim", " …")];
		return [...lines.slice(0, rows - 1), theme.fg("dim", " …")];
	}

	#truncate(text: string, width: number): string {
		return visibleWidth(text) > width ? truncateToWidth(text, width) : text;
	}

	/** Keep the tail of a long path — the project directory is the part that identifies it. */
	#shortenFromLeft(value: string, width: number): string {
		if (visibleWidth(value) <= width) return value;
		if (width <= 1) return "…";
		let tail = value;
		while (tail.length > 0 && visibleWidth(tail) > width - 1) tail = tail.slice(1);
		return `…${tail}`;
	}

	/** Fit string to exact width with native ANSI/wide-glyph truncation and padding. */
	#fitToWidth(str: string, width: number): string {
		const visLen = visibleWidth(str);
		if (visLen > width) return truncateToWidth(str, width, null, true);
		return str + padding(width - visLen);
	}

	#rightGutterWidth(termWidth: number): number {
		const configured = this.options.rightGutterWidth ?? 0;
		if (!Number.isFinite(configured) || configured <= 0) return 0;
		const gutterWidth = Math.floor(configured);
		return Math.min(gutterWidth, Math.max(0, termWidth - 4));
	}

	#withRightGutter(lines: string[], rightGutterWidth: number): string[] {
		if (rightGutterWidth <= 0) return lines;
		const gutter = padding(rightGutterWidth);
		return lines.map(line => line + gutter);
	}

	#targetRows(termWidth: number): number | undefined {
		const viewportRows = this.options.getViewportRows?.();
		if (typeof viewportRows !== "number" || !Number.isFinite(viewportRows) || viewportRows <= 0) {
			return undefined;
		}
		const reservedRows = Math.max(0, Math.floor(this.options.getReservedBottomRows?.(termWidth) ?? 0));
		return Math.max(0, Math.floor(viewportRows) - reservedRows);
	}
}

/** Upper bound on the reveal: enough for every section to land and settle. */
const INTRO_MS = 12 * SECTION_STAGGER_MS + SECTION_SETTLE_MS;
/** Resolve the intro cadence without making tests mutate global process state. */
export function resolveWelcomeIntroTickMs(
	platform: NodeJS.Platform = process.platform,
	tmux = process.env.TMUX,
): number {
	return platform === "win32" && tmux ? 100 : 33;
}

/** Render at 30fps directly, but cap native Windows multiplexers at 10fps to avoid ConPTY output backpressure. */
const INTRO_TICK_MS = resolveWelcomeIntroTickMs();
