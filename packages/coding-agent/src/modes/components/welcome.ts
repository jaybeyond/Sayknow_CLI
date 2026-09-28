import type { ThinkingLevel } from "@sayknow-cli/agent-core";
import {
	type Component,
	type PetSkinId,
	padding,
	renderPetHalfBlocks,
	type SayknowPixelFrameName,
	truncateToWidth,
	visibleWidth,
} from "@sayknow-cli/tui";
import { formatBuildLabel } from "../../build-metadata";
import { formatKeyHint, type KeyDisplayContext } from "../../config/keybindings";
import { type MsgKey, t } from "../../i18n";
import { theme } from "../../modes/theme/theme";

export interface RecentSession {
	name: string;
	timeAgo: string;
	/** Session file; present when the row can be opened from the card. */
	path?: string;
}

/**
 * Workspace facts on the launch card. Every field is optional: the card renders
 * what is known and fills in git state once the asynchronous probe settles.
 */
export interface WelcomeSnapshot {
	/** Display path of the project directory (already home-shortened). */
	cwd?: string;
	/** Current branch, `"detached"`, or `null` outside a git repository. */
	branch?: string | null;
	gitChanges?: { staged: number; unstaged: number; untracked: number } | null;
	thinkingLevel?: ThinkingLevel | string;
}

export type WelcomeLogoMode = "unicode" | "square" | "ascii";
export interface WelcomeComponentOptions {
	getViewportRows?: () => number | undefined;
	getReservedBottomRows?: (termWidth: number) => number;
	changelogMarkdown?: string;
	rightGutterWidth?: number;
	/** Show only the version on the release line, without its first note. */
	collapseChangelog?: boolean;
	buildLabel?: string;
	keyDisplayContext?: KeyDisplayContext;
	skipLogoAnimation?: boolean;
	snapshot?: WelcomeSnapshot;
	/** Key bound to the resume picker (`app.session.resume`); the card names it. */
	resumeKey?: string;
	/** Key bound to `app.session.continue`, which resumes the first session on the card. */
	continueKey?: string;
	/** Which Sayknow pet stands on the card (default red). */
	petSkin?: PetSkinId;
	/** Called when a session row is opened by click or Enter. */
	onOpenSession?: (session: RecentSession) => void;
}

/** Left margin of the card, and the widest the card grows on wide terminals. */
const MARGIN = 2;
const MAX_CARD_WIDTH = 76;
/** Gap between the pet and the wordmark. */
const MARK_GAP = 3;
/** Recent sessions on the card; the resume picker has the rest. */
const SESSION_ROWS = 3;

/**
 * The wordmark: SAYKNOW in the brand's box-drawing letters, then CLI. Each row is the
 * SAYKNOW part and the CLI part, drawn in different colors.
 */
// biome-ignore format: preserve letter layout
const WORDMARK: ReadonlyArray<readonly [string, string]> = [
	["╔═╗╔═╗╦ ╦╦╔═╔╗╔╔═╗╦ ╦", "╔═╗╦  ╦"],
	["╚═╗╠═╣╚╦╝╠╩╗║║║║ ║║║║", "║  ║  ║"],
	["╚═╝╩ ╩ ╩ ╩ ╩╝╚╝╚═╝╚╩╝", "╚═╝╩═╝╩"],
];
const WORDMARK_GAP = 2;
const WORDMARK_WIDTH = 21 + WORDMARK_GAP + 7;

/** ASCII-safe stand-in for the pet when the banner must avoid block glyphs. */
const MARK_ASCII = [" .--. ", "( oo )", " )  ( ", "/\\/\\/\\"] as const;
const MARK_ASCII_WAVE = "\\/\\/\\/";

/**
 * Intro: the pet does a short para-para (tentacles sway left, right, left) and
 * lands on its resting pose while color spreads down the card.
 */
const INTRO_POSES: readonly SayknowPixelFrameName[] = ["danceL", "danceR", "danceL", "base"];
const SECTION_STAGGER_MS = 55;
const SECTION_SETTLE_MS = 90;
const WAVE_STEP_MS = 140;
const INTRO_MS = INTRO_POSES.length * WAVE_STEP_MS;

/** A block of rows that takes its colors together during the intro. */
interface Section {
	lines: string[];
	/** When the viewport is short, the section with the highest rank is dropped first. */
	dropRank: number;
	/** Session index per line, for rows that open a session. */
	sessionRows?: Array<number | undefined>;
}

/**
 * Sayknow-CLI launch card: the wordmark with the pet beside it, who and where you are
 * (version, model and reasoning, project and branch), the release line after an update,
 * the three most recent sessions — which can be opened from the card with a click or
 * ↓ then Enter — and a single row of keys.
 */
export class WelcomeComponent implements Component {
	#animStart: number | null = null;
	#animTimer: NodeJS.Timeout | null = null;
	#snapshot: WelcomeSnapshot;
	/** Highlighted session row while picking with the keyboard; undefined when not picking. */
	#selected: number | undefined;
	/** Session index per rendered line, from the last frame. */
	#lineSessions: Array<number | undefined> = [];
	#interactive = true;

	constructor(
		private readonly version: string,
		private modelName: string,
		private providerName: string,
		private recentSessions: RecentSession[] = [],
		private readonly logoMode: WelcomeLogoMode = "unicode",
		private readonly options: WelcomeComponentOptions = {},
	) {
		this.#snapshot = { ...options.snapshot };
	}

	invalidate(): void {}

	/**
	 * Play the short launch intro. Content is fully readable from the first frame;
	 * only color and the tentacles move. Safe to call again — it restarts.
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
			if (elapsed >= INTRO_MS) this.#stopAnimation();
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
		if (this.#selected !== undefined && this.#selected >= this.#openable().length) this.#selected = undefined;
	}

	/** Merge newly probed workspace facts into the card. */
	setSnapshot(patch: WelcomeSnapshot): void {
		this.#snapshot = { ...this.#snapshot, ...patch };
	}

	// ── Picking a session ───────────────────────────────────────────────────

	/** Sessions on the card that can be opened (they have a file). */
	#openable(): RecentSession[] {
		return this.recentSessions.slice(0, SESSION_ROWS).filter(session => session.path);
	}

	/** Rows that can be opened right now. Zero once the card stops taking input. */
	get openableCount(): number {
		return this.#interactive ? this.#openable().length : 0;
	}

	get selectedIndex(): number | undefined {
		return this.#selected;
	}

	/** Stop offering the session rows (after the first prompt or a session switch). */
	endInteraction(): void {
		this.#interactive = false;
		this.#selected = undefined;
	}

	get interactive(): boolean {
		return this.#interactive;
	}

	/** Highlight a row, or clear the highlight with undefined. Returns false when there is nothing to select. */
	select(index: number | undefined): boolean {
		if (index === undefined) {
			this.#selected = undefined;
			return true;
		}
		const count = this.openableCount;
		if (count === 0) return false;
		this.#selected = Math.max(0, Math.min(count - 1, index));
		return true;
	}

	/** Move the highlight; returns false when it would leave the list upward (the caller hands focus back). */
	moveSelection(delta: number): boolean {
		if (this.#selected === undefined) return this.select(0);
		const next = this.#selected + delta;
		if (next < 0) {
			this.#selected = undefined;
			return false;
		}
		this.#selected = Math.min(this.openableCount - 1, next);
		return true;
	}

	/** Open the highlighted row. */
	openSelected(): boolean {
		const session = this.#selected === undefined ? undefined : this.#openable()[this.#selected];
		if (!session) return false;
		this.options.onOpenSession?.(session);
		return true;
	}

	handleClick(line: number): boolean {
		if (!this.#interactive) return false;
		const index = this.#lineSessions[line];
		const session = index === undefined ? undefined : this.#openable()[index];
		if (!session) return false;
		this.#selected = index;
		this.options.onOpenSession?.(session);
		return true;
	}

	// ── Layout ──────────────────────────────────────────────────────────────

	render(termWidth: number): string[] {
		this.#lineSessions = [];
		const gutterWidth = this.#rightGutterWidth(termWidth);
		const width = Math.max(0, termWidth - gutterWidth);
		if (width < 4) return [];

		const targetRows = this.#targetRows(termWidth);
		if (targetRows !== undefined && targetRows <= 0) return [];
		if (targetRows === 1) return this.#withRightGutter([this.#fit(this.#titleLine(true), width)], gutterWidth);

		const cardWidth = Math.max(1, Math.min(MAX_CARD_WIDTH, width - MARGIN));
		const sections = this.#sections(cardWidth);
		const { lines, sessionRows } = this.#fitRows(sections, targetRows);
		const margin = padding(MARGIN);
		const selectedLine = sessionRows.findIndex(index => index !== undefined && index === this.#selected);
		const out = lines.map((line, row) => {
			if (row === selectedLine) return this.#highlightRow(line, cardWidth, width);
			return this.#fit(line ? margin + line : "", width);
		});
		if (targetRows !== undefined) while (out.length < targetRows) out.push(padding(width));
		this.#lineSessions = sessionRows;
		return this.#withRightGutter(out, gutterWidth);
	}

	/** The picked row: a selection band across the card width, held after every reset inside the row. */
	#highlightRow(line: string, cardWidth: number, width: number): string {
		const bg = theme.getBgAnsi("selectedBg");
		const body = this.#fit(line, cardWidth).replace(/\x1b\[(?:0)?m|\x1b\[49m/g, match => `${match}${bg}`);
		return this.#fit(`${padding(MARGIN)}${bg}${body}\x1b[0m`, width);
	}

	/**
	 * Lay the sections out with a blank row above and between them. When the
	 * viewport is short, whole sections go by rank — keys, then the release
	 * note, then sessions — and the identity block is clipped last.
	 */
	#fitRows(
		sections: { identity: string[]; others: Section[] },
		targetRows: number | undefined,
	): { lines: string[]; sessionRows: Array<number | undefined> } {
		const colored = this.#colorReveal(1 + sections.others.length);
		const identity = this.#inkSection(sections.identity, 0, colored);
		let others = sections.others.map((section, index) => ({
			...section,
			lines: this.#inkSection(section.lines, index + 1, colored),
		}));
		const assemble = (): { lines: string[]; sessionRows: Array<number | undefined> } => {
			const lines = ["", ...identity];
			const sessionRows: Array<number | undefined> = lines.map(() => undefined);
			for (const section of others) {
				lines.push("", ...section.lines);
				sessionRows.push(undefined, ...(section.sessionRows ?? section.lines.map(() => undefined)));
			}
			return { lines, sessionRows };
		};
		let result = assemble();
		if (targetRows === undefined) return result;
		while (result.lines.length > targetRows && others.length > 0) {
			const drop = others.reduce((worst, section) => (section.dropRank > worst.dropRank ? section : worst));
			others = others.filter(section => section !== drop);
			result = assemble();
		}
		return { lines: result.lines.slice(0, targetRows), sessionRows: result.sessionRows.slice(0, targetRows) };
	}

	#sections(cardWidth: number): { identity: string[]; others: Section[] } {
		const others: Section[] = [];
		const note = this.#releaseNoteLine(cardWidth);
		if (note) others.push({ lines: [note], dropRank: 2 });
		const sessions = this.#sessionSection(cardWidth);
		others.push({ ...sessions, dropRank: 1 });
		others.push({ lines: [this.#keysLine(cardWidth)], dropRank: 3 });
		return { identity: this.#identityLines(cardWidth), others };
	}

	// ── Identity: pet + wordmark, then who and where ────────────────────────

	#identityLines(cardWidth: number): string[] {
		const mark = this.#markRows();
		const markWidth = Math.max(0, ...mark.map(row => visibleWidth(row)));
		const withMark = cardWidth >= markWidth + MARK_GAP + WORDMARK_WIDTH;
		const withWordmark = this.logoMode !== "ascii" && cardWidth >= WORDMARK_WIDTH;
		const indent = withMark ? markWidth + MARK_GAP : 0;
		const infoWidth = Math.max(1, cardWidth - indent);

		const head: string[] = withWordmark
			? WORDMARK.map(
					([word, suffix]) =>
						`${theme.bold(theme.fg("accent", word))}${padding(WORDMARK_GAP)}${theme.fg("text", suffix)}`,
				)
			: [this.#truncate(this.#titleLine(!withMark), infoWidth)];
		const versionLine = this.#spread(
			theme.fg("muted", t("welcome.tagline")),
			theme.fg("dim", this.#versionLabel()),
			infoWidth,
		);
		const info = [...head, withWordmark ? versionLine : theme.fg("muted", t("welcome.tagline"))];

		const rows: string[] = [];
		if (withMark) {
			const count = Math.max(mark.length, info.length);
			for (let row = 0; row < count; row++) {
				const art = mark[row] ?? padding(markWidth);
				const text = info[row] ?? "";
				rows.push(text ? `${art}${padding(MARK_GAP)}${text}` : art);
			}
		} else rows.push(...info);
		// Model and place sit under the wordmark, in the same column.
		for (const line of this.#statusLines(infoWidth)) rows.push(`${padding(indent)}${line}`);
		return rows;
	}

	#versionLabel(): string {
		const buildLabel = this.options.buildLabel ?? formatBuildLabel();
		return `v${this.version} · ${buildLabel}`;
	}

	/** The Sayknow pet at half size, in half blocks; the pose follows the intro. */
	#markRows(): string[] {
		const step = this.#animStart == null ? -1 : Math.floor((performance.now() - this.#animStart) / WAVE_STEP_MS);
		if (this.logoMode === "ascii") {
			const rows: string[] = [...MARK_ASCII];
			if (step >= 0 && step < INTRO_POSES.length - 1 && step % 2 === 1) rows[3] = MARK_ASCII_WAVE;
			return rows.map(row => theme.fg("accent", row));
		}
		const pose = step >= 0 && step < INTRO_POSES.length ? INTRO_POSES[step]! : "base";
		return renderPetHalfBlocks(pose, this.options.petSkin ?? "red", theme.getColorMode(), { scale: "half" });
	}

	/** One-line title for layouts without room for the wordmark. */
	#titleLine(withIcon = false): string {
		const mark = withIcon && this.logoMode !== "ascii" && theme.icon.pi ? `${theme.icon.pi} ` : "";
		return `${mark}${theme.bold(theme.fg("accent", "Sayknow-CLI"))}${theme.fg("dim", ` ${this.#versionLabel()}`)}`;
	}

	/**
	 * Model and reasoning, then project path and branch: on one row when both fit whole,
	 * otherwise the place gets its own row rather than being cut to nothing.
	 */
	#statusLines(width: number): string[] {
		const model = this.#truncate(this.#modelPart(), width);
		const sep = theme.fg("dim", "  ·  ");
		const fullWhere = this.#wherePart(Number.POSITIVE_INFINITY);
		if (!fullWhere) return [model];
		if (visibleWidth(model) + visibleWidth(sep) + visibleWidth(fullWhere) <= width)
			return [`${model}${sep}${fullWhere}`];
		return [model, this.#wherePart(width)];
	}

	#modelPart(): string {
		const sep = theme.fg("dim", " · ");
		if (this.modelName === "Unknown" || this.modelName.length === 0) {
			return `${theme.fg("accent", t("welcome.chooseModel"))}${sep}${theme.fg("dim", t("welcome.modelHint"))}`;
		}
		const parts = [theme.bold(theme.fg("statusLineModel", this.modelName))];
		const level = this.#snapshot.thinkingLevel;
		if (level) parts.push(theme.getThinkingBorderColor(String(level) as ThinkingLevel)(String(level)));
		else if (this.providerName) parts.push(theme.fg("muted", this.providerName));
		return parts.join(sep);
	}

	#wherePart(width: number): string {
		const { cwd, branch } = this.#snapshot;
		const sep = theme.fg("dim", " · ");
		const branchPart =
			typeof branch === "string"
				? `${theme.fg(this.#isDirty() ? "statusLineGitDirty" : "statusLineGitClean", branch)}${this.#changeSummary()}`
				: "";
		if (!cwd) return branchPart;
		const pathBudget = Math.max(8, width - (branchPart ? visibleWidth(branchPart) + 3 : 0));
		const path = theme.fg("statusLinePath", this.#shortenFromLeft(cwd, pathBudget));
		return branchPart ? `${path}${sep}${branchPart}` : path;
	}

	#isDirty(): boolean {
		const changes = this.#snapshot.gitChanges;
		return !!changes && changes.staged + changes.unstaged + changes.untracked > 0;
	}

	#changeSummary(): string {
		const changes = this.#snapshot.gitChanges;
		if (!changes || !this.#isDirty()) return "";
		const parts: string[] = [];
		if (changes.staged > 0) parts.push(theme.fg("statusLineStaged", `+${changes.staged}`));
		if (changes.unstaged > 0) parts.push(theme.fg("statusLineDirty", `~${changes.unstaged}`));
		if (changes.untracked > 0) parts.push(theme.fg("statusLineUntracked", `?${changes.untracked}`));
		return ` ${parts.join(" ")}`;
	}

	// ── Release note, sessions, keys ────────────────────────────────────────

	/**
	 * A section header that is also the divider: the label, a hairline rule filling the
	 * row, and hints at the right end.
	 */
	#ruleHeader(label: string, hint: string, width: number): string {
		const left = `${label} `;
		const right = hint ? ` ${hint}` : "";
		const fill = width - visibleWidth(left) - visibleWidth(right);
		if (fill < 3) return this.#truncate(`${label}${right}`, width);
		return `${left}${theme.fg("borderMuted", "─".repeat(fill))}${right}`;
	}

	/** One line, only after an update: the new version and its first note, pointing at /changelog. */
	#releaseNoteLine(width: number): string | undefined {
		const changelog = this.options.changelogMarkdown?.trim();
		if (!changelog) return undefined;
		const version = this.#latestChangelogVersion(changelog);
		const lead = theme.bold(theme.fg("accent", `v${version}`));
		const pointer = theme.fg("dim", "/changelog");
		const first = this.options.collapseChangelog ? undefined : this.#changelogItems(changelog)[0];
		const room = width - visibleWidth(lead) - visibleWidth(pointer) - 8;
		const label = first && room >= 12 ? `${lead} ${theme.fg("muted", this.#truncate(first, room))}` : lead;
		return this.#ruleHeader(label, pointer, width);
	}

	#sessionSection(width: number): Pick<Section, "lines" | "sessionRows"> {
		const heading = theme.bold(theme.fg("accent", t("welcome.sessionTrail")));
		if (this.recentSessions.length === 0) {
			return { lines: [this.#ruleHeader(heading, "", width), `  ${theme.fg("dim", t("welcome.noSessions"))}`] };
		}
		const context = this.options.keyDisplayContext ?? { platform: process.platform };
		const picking = this.#selected !== undefined;
		const hints = picking
			? [t("welcome.pickActive")]
			: [
					...(this.openableCount > 0 ? [t("welcome.pick", { key: "↓" })] : []),
					...(this.options.continueKey
						? [t("welcome.continue", { key: formatKeyHint(this.options.continueKey, context) })]
						: []),
					t("welcome.allSessions", { key: this.#resumeKey() }),
				];
		const lines = [this.#ruleHeader(heading, theme.fg("dim", hints.join(" · ")), width)];
		const sessionRows: Array<number | undefined> = [undefined];
		const openable = this.#openable();
		this.recentSessions.slice(0, SESSION_ROWS).forEach((session, index) => {
			const openIndex = openable.indexOf(session);
			const selected = picking && openIndex === this.#selected;
			// Idle: the first row is the one the continue key resumes. Picking: the highlighted row.
			const marked = picking ? selected : index === 0 && !!this.options.continueKey;
			const lead = marked ? theme.fg("accent", "› ") : "  ";
			const time = theme.fg("dim", session.timeAgo);
			const nameWidth = Math.max(1, width - visibleWidth(lead) - visibleWidth(time) - 2);
			const tone = selected ? "text" : picking ? "muted" : index === 0 ? "text" : "muted";
			const name = this.#truncate(session.name, nameWidth);
			lines.push(
				this.#spread(`${lead}${selected ? theme.bold(theme.fg(tone, name)) : theme.fg(tone, name)}`, time, width),
			);
			sessionRows.push(openIndex >= 0 ? openIndex : undefined);
		});
		return { lines, sessionRows };
	}

	#keysLine(width: number): string {
		const context = this.options.keyDisplayContext ?? { platform: process.platform };
		const items: ReadonlyArray<{ key: string; label: MsgKey }> = [
			{ key: "/", label: "welcome.commands" },
			{ key: this.#resumeKey(), label: "welcome.sessions" },
			{ key: formatKeyHint("ctrl+l", context), label: "welcome.model" },
			{ key: "?", label: "welcome.keymap" },
		];
		const text = items
			.map(item => `${theme.fg("accent", item.key)} ${theme.fg("dim", t(item.label))}`)
			.join(theme.fg("borderMuted", "  ·  "));
		return this.#truncate(text, width);
	}

	#resumeKey(): string {
		const context = this.options.keyDisplayContext ?? { platform: process.platform };
		return this.options.resumeKey ? formatKeyHint(this.options.resumeKey, context) : "/resume";
	}

	#latestChangelogVersion(markdown: string): string {
		return markdown.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/)?.[1] ?? this.version;
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
			const cleaned = line
				.replace(/^[-*]\s+/, "")
				.replace(/^\d+\.\s+/, "")
				.replace(/^>\s*/, "")
				.replace(/`([^`]+)`/g, "$1")
				.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
				.replace(/\*\*([^*]+)\*\*/g, "$1")
				.replace(/__([^_]+)__/g, "$1")
				.replace(/\*([^*]+)\*/g, "$1")
				.replace(/[_~]/g, "")
				.trim();
			if (cleaned) items.push(cleaned);
		}
		return items;
	}

	// ── Intro ───────────────────────────────────────────────────────────────

	/** Sections that have taken their colors; the rest are drawn in dim ink until the intro reaches them. */
	#colorReveal(sectionCount: number): number {
		if (this.#animStart == null) return sectionCount;
		const elapsed = performance.now() - this.#animStart;
		return Math.min(sectionCount, Math.floor((elapsed - SECTION_SETTLE_MS) / SECTION_STAGGER_MS) + 1);
	}

	#inkSection(lines: string[], order: number, colored: number): string[] {
		return order < colored ? lines : lines.map(line => theme.fg("dim", Bun.stripANSI(line)));
	}

	// ── Layout helpers ──────────────────────────────────────────────────────

	/** `left` and `right` on one row, `right` flush with the card's right edge. */
	#spread(left: string, right: string, width: number): string {
		const room = width - visibleWidth(left) - visibleWidth(right);
		return room >= 2 ? `${left}${padding(room)}${right}` : this.#truncate(left, width);
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

	/** Fit a string to exactly `width` columns (native ANSI/wide-glyph aware). */
	#fit(str: string, width: number): string {
		const visLen = visibleWidth(str);
		if (visLen > width) return truncateToWidth(str, width, null, true);
		return str + padding(width - visLen);
	}

	#rightGutterWidth(termWidth: number): number {
		const configured = this.options.rightGutterWidth ?? 0;
		if (!Number.isFinite(configured) || configured <= 0) return 0;
		return Math.min(Math.floor(configured), Math.max(0, termWidth - 4));
	}

	#withRightGutter(lines: string[], rightGutterWidth: number): string[] {
		if (rightGutterWidth <= 0) return lines;
		const gutter = padding(rightGutterWidth);
		return lines.map(line => line + gutter);
	}

	#targetRows(termWidth: number): number | undefined {
		const viewportRows = this.options.getViewportRows?.();
		if (typeof viewportRows !== "number" || !Number.isFinite(viewportRows) || viewportRows <= 0) return undefined;
		const reservedRows = Math.max(0, Math.floor(this.options.getReservedBottomRows?.(termWidth) ?? 0));
		return Math.max(0, Math.floor(viewportRows) - reservedRows);
	}
}

/** Resolve the intro cadence without making tests mutate global process state. */
export function resolveWelcomeIntroTickMs(
	platform: NodeJS.Platform = process.platform,
	tmux = process.env.TMUX,
): number {
	return platform === "win32" && tmux ? 100 : 33;
}

/** Render at 30fps directly, but cap native Windows multiplexers at 10fps to avoid ConPTY output backpressure. */
const INTRO_TICK_MS = resolveWelcomeIntroTickMs();
