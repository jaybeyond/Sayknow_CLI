import { type Component, padding, truncateToWidth, visibleWidth } from "@sayknow-cli/tui";
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
	/** Key bound to the resume picker (`app.session.resume`); the card names it. */
	resumeKey?: string;
	/** Key bound to `app.session.continue`, which resumes the first session on the card. */
	continueKey?: string;
	/** Called when a session row is opened by click or Enter. */
	onOpenSession?: (session: RecentSession) => void;
	/**
	 * Opens the full session list. When set, the card ends its session rows with an
	 * "all sessions" row reached with ↓/Enter or a click: no modifier chord, so it works in
	 * every terminal and keyboard layout (Option+R types a plain `r` on Korean layouts).
	 */
	onShowAllSessions?: () => void;
}

/** Left margin of the card, and the widest the card grows on wide terminals. */
const MARGIN = 2;
const MAX_CARD_WIDTH = 76;
/** Recent sessions on the card; the resume picker has the rest. */
const SESSION_ROWS = 3;

const SECTION_STAGGER_MS = 55;
const SECTION_SETTLE_MS = 90;
const INTRO_MS = SECTION_SETTLE_MS + 4 * SECTION_STAGGER_MS;

/** A block of rows that takes its colors together during the intro. */
interface Section {
	lines: string[];
	/** When the viewport is short, the section with the highest rank is dropped first. */
	dropRank: number;
	/** Session index per line, for rows that open a session. */
	sessionRows?: Array<number | undefined>;
}

/**
 * Sayknow-CLI launch card: the wordmark, build, release note, recent sessions and
 * shortcuts. Model, place and version belong to the status line. The composer pet does not appear on this card.
 */
export class WelcomeComponent implements Component {
	#animStart: number | null = null;
	#animTimer: NodeJS.Timeout | null = null;
	/** Highlighted session row while picking with the keyboard; undefined when not picking. */
	#selected: number | undefined;
	/** Session index per rendered line, from the last frame. */
	#lineSessions: Array<number | undefined> = [];
	#interactive = true;

	constructor(
		private readonly version: string,
		private modelName: string,
		_providerName: string,
		private recentSessions: RecentSession[] = [],
		private readonly logoMode: WelcomeLogoMode = "unicode",
		private readonly options: WelcomeComponentOptions = {},
	) {}

	invalidate(): void {}

	/** Briefly reveal section colors without moving the card's content. */
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

	/** The provider is shown on the status line; the card only needs to know a model is set. */
	setModel(modelName: string, _providerName: string): void {
		this.modelName = modelName;
	}

	setRecentSessions(sessions: RecentSession[]): void {
		this.recentSessions = sessions;
		if (this.#selected !== undefined && this.#selected >= this.#openable().length) this.#selected = undefined;
	}

	// ── Picking a session ───────────────────────────────────────────────────

	/** Sessions on the card that can be opened (they have a file). */
	#openable(): RecentSession[] {
		return this.recentSessions.slice(0, SESSION_ROWS).filter(session => session.path);
	}

	/** Whether the card ends with the "all sessions" row. */
	#hasAllSessionsRow(): boolean {
		return !!this.options.onShowAllSessions && this.recentSessions.length > 0;
	}

	/** Rows that can be picked right now (sessions, then "all sessions"). Zero once the card stops taking input. */
	get openableCount(): number {
		if (!this.#interactive) return 0;
		return this.#openable().length + (this.#hasAllSessionsRow() ? 1 : 0);
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
		return this.#open(this.#selected);
	}

	handleClick(line: number): boolean {
		if (!this.#interactive) return false;
		const index = this.#lineSessions[line];
		if (index === undefined) return false;
		this.#selected = index;
		if (this.#open(index)) return true;
		this.#selected = undefined;
		return false;
	}

	/** Open a picked row: a session, or the full list for the trailing "all sessions" row. */
	#open(index: number | undefined): boolean {
		if (index === undefined) return false;
		const openable = this.#openable();
		const session = openable[index];
		if (session) {
			this.options.onOpenSession?.(session);
			return true;
		}
		if (index === openable.length && this.#hasAllSessionsRow()) {
			// The picker takes over; leave the card un-highlighted for when it closes.
			this.#selected = undefined;
			this.options.onShowAllSessions?.();
			return true;
		}
		return false;
	}

	// ── Layout ──────────────────────────────────────────────────────────────

	render(termWidth: number): string[] {
		this.#lineSessions = [];
		const gutterWidth = this.#rightGutterWidth(termWidth);
		const width = Math.max(0, termWidth - gutterWidth);
		if (width < 4) return [];

		const targetRows = this.#targetRows(termWidth);
		if (targetRows !== undefined && targetRows <= 0) return [];
		if (targetRows === 1) return this.#withRightGutter([this.#fit(this.#titleLine(width), width)], gutterWidth);

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
		const sessions = this.#sessionSection(cardWidth);
		others.push({ ...sessions, dropRank: 1 });
		const note = this.#releaseNoteLine(cardWidth);
		if (note) others.push({ lines: [note], dropRank: 2 });
		others.push({ lines: [this.#keysLine(cardWidth)], dropRank: 3 });
		return { identity: this.#identityLines(cardWidth), others };
	}

	// ── Identity ────────────────────────────────────────────────────────────

	#identityLines(cardWidth: number): string[] {
		const title = this.#titleLine(cardWidth);
		return this.#hasModel() ? [title] : [title, this.#chooseModelPart(cardWidth)];
	}

	/** Release or source build: the one launch fact the status line does not carry. */
	#buildLabel(): string {
		return this.options.buildLabel ?? formatBuildLabel();
	}

	/** A single wordmark in every preset; omit the metadata before clipping the name. */
	#titleLine(width: number): string {
		const name = theme.bold(theme.fg("accent", "Sayknow-CLI"));
		const build = `${name}${theme.fg("dim", ` · ${this.#buildLabel()}`)}`;
		return visibleWidth(build) <= width ? build : this.#truncate(name, width);
	}

	#hasModel(): boolean {
		return this.modelName !== "Unknown" && this.modelName.length > 0;
	}

	#chooseModelPart(width: number): string {
		const label = theme.fg("accent", t("welcome.chooseModel"));
		const context = this.options.keyDisplayContext ?? { platform: process.platform };
		const hint = `${label}${theme.fg("dim", ` · ${formatKeyHint("ctrl+l", context)}`)}`;
		return visibleWidth(hint) <= width ? hint : this.#truncate(label, width);
	}

	// ── Release note, sessions, keys ────────────────────────────────────────

	/** Primary section divider. Drop complete hints as space gets tighter. */
	#sessionHeading(label: string, hints: string[], width: number): string {
		const left = `${label} `;
		while (hints.length > 0 && visibleWidth(`${left}    ${hints.join(" · ")}`) > width) hints.pop();
		const right = hints.length ? ` ${theme.fg("dim", hints.join(" · "))}` : "";
		const fill = width - visibleWidth(left) - visibleWidth(right);
		if (fill < 3) return this.#truncate(label, width);
		const rule = this.logoMode === "ascii" ? "-" : "─";
		return `${left}${theme.fg("borderMuted", rule.repeat(fill))}${right}`;
	}

	/** One line, only after an update: the new version and its first note, pointing at /changelog. */
	#releaseNoteLine(width: number): string | undefined {
		const changelog = this.options.changelogMarkdown?.trim();
		if (!changelog) return undefined;
		const version = this.#latestChangelogVersion(changelog);
		const lead = theme.fg("muted", `v${version}`);
		const pointer = theme.fg("dim", "/changelog");
		const gap = theme.fg("dim", " · ");
		const first = this.options.collapseChangelog ? undefined : this.#changelogItems(changelog)[0];
		const room = width - visibleWidth(`${lead}${gap}${gap}${pointer}`);
		const suffix = `${gap}${pointer}`;
		if (first && room >= 12) return `${lead}${gap}${theme.fg("dim", truncateAtWord(first, room))}${suffix}`;
		return visibleWidth(`${lead}${suffix}`) <= width ? `${lead}${suffix}` : this.#truncate(lead, width);
	}

	#sessionSection(width: number): Pick<Section, "lines" | "sessionRows"> {
		const heading = theme.bold(theme.fg("accent", t("welcome.sessionTrail")));
		if (this.recentSessions.length === 0) {
			return { lines: [this.#sessionHeading(heading, [], width), `  ${theme.fg("dim", t("welcome.noSessions"))}`] };
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
		const lines = [this.#sessionHeading(heading, hints, width)];
		const sessionRows: Array<number | undefined> = [undefined];
		const openable = this.#openable();
		this.recentSessions.slice(0, SESSION_ROWS).forEach((session, index) => {
			const openIndex = openable.indexOf(session);
			const selected = picking && openIndex === this.#selected;
			// Idle: the first row is the one the continue key resumes. Picking: the highlighted row.
			const marked = picking ? selected : index === 0 && !!this.options.continueKey;
			const lead = marked ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const time = theme.fg("dim", session.timeAgo);
			const nameWidth = Math.max(1, width - visibleWidth(lead) - visibleWidth(time) - 2);
			const tone = selected ? "text" : picking ? "muted" : index === 0 ? "text" : "muted";
			const name = this.#truncate(session.name, nameWidth);
			lines.push(
				this.#spread(
					`${lead}${selected || (!picking && index === 0) ? theme.bold(theme.fg(tone, name)) : theme.fg(tone, name)}`,
					time,
					width,
				),
			);
			sessionRows.push(openIndex >= 0 ? openIndex : undefined);
		});
		if (this.#hasAllSessionsRow()) {
			const allIndex = openable.length;
			const selected = picking && this.#selected === allIndex;
			const label = t("welcome.allSessionsRow");
			lines.push(
				selected
					? `${theme.fg("accent", `${theme.nav.cursor} `)}${theme.bold(theme.fg("text", label))}`
					: `  ${theme.fg("dim", label)}`,
			);
			sessionRows.push(allIndex);
		}
		return { lines, sessionRows };
	}

	#keysLine(width: number): string {
		const context = this.options.keyDisplayContext ?? { platform: process.platform };
		const items: ReadonlyArray<{ key: string; label: MsgKey }> = [
			{ key: "/", label: "welcome.commands" },
			{ key: formatKeyHint("ctrl+l", context), label: "welcome.model" },
			{ key: "?", label: "welcome.keymap" },
		];
		const labels = items.map(item => `${theme.fg("accent", item.key)} ${theme.fg("dim", t(item.label))}`);
		const separator = theme.fg("borderMuted", "  ·  ");
		while (labels.length > 0 && visibleWidth(labels.join(separator)) > width) labels.pop();
		return labels.join(separator);
	}

	/**
	 * How the card names the full session list. `/resume` works everywhere; a bound chord is
	 * shown only off macOS, where Option often types a character instead of sending Alt.
	 */
	#resumeKey(): string {
		const context = this.options.keyDisplayContext ?? { platform: process.platform };
		const key = this.options.resumeKey;
		if (!key || (context.platform === "darwin" && /(^|\+)alt\+/.test(key))) return "/resume";
		return formatKeyHint(key, context);
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

/** Cut prose at the last whole word that fits, so a note never ends mid-word. */
export function truncateAtWord(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	const cut = truncateToWidth(text, width);
	const body = cut.endsWith("…") ? cut.slice(0, -1) : cut;
	// The cut landed after a whole word (next is a space or punctuation): keep it, minus
	// trailing punctuation so the ellipsis does not read as `world.…`.
	if (text.startsWith(body) && /^[^\p{L}\p{N}]/u.test(text.slice(body.length))) {
		const whole = body.replace(/[\s,.;:!?]+$/, "");
		if (whole.length > 0) return `${whole}…`;
	}
	const boundary = body.search(/\s+\S*$/);
	if (boundary <= 0) return cut;
	return `${body.slice(0, boundary).replace(/[\s,.;:!?]+$/, "")}…`;
}
