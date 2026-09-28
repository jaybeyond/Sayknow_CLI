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
}

/** Left margin of the card, and the widest the card grows on wide terminals. */
const MARGIN = 2;
const MAX_CARD_WIDTH = 76;
/** Gap between the mark and the identity lines. */
const MARK_GAP = 3;
/** Below this card width the mark is dropped and only the identity lines remain. */
const MIN_WIDTH_FOR_MARK = 44;
/** Recent sessions on the card; the resume picker has the rest. */
const SESSION_ROWS = 3;

/** ASCII-safe stand-in for the pet when the banner must avoid block glyphs. */
const MARK_ASCII = ["  .---.  ", " ( o o ) ", "  )   (  ", " /\\/\\/\\/ "] as const;
const MARK_ASCII_WAVE = " \\/\\/\\/\\ ";

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
}

/**
 * Sayknow-CLI launch card: the octopus mark beside who and where you are
 * (version, model and reasoning, project and branch), then the three most recent
 * sessions and a single row of keys. Everything else — the full session list,
 * workflows, the keymap, release notes — is one key away, not on the card.
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
	}

	/** Merge newly probed workspace facts into the card. */
	setSnapshot(patch: WelcomeSnapshot): void {
		this.#snapshot = { ...this.#snapshot, ...patch };
	}

	render(termWidth: number): string[] {
		const gutterWidth = this.#rightGutterWidth(termWidth);
		const width = Math.max(0, termWidth - gutterWidth);
		if (width < 4) return [];

		const targetRows = this.#targetRows(termWidth);
		if (targetRows !== undefined && targetRows <= 0) return [];
		if (targetRows === 1) return this.#withRightGutter([this.#fit(this.#titleLine(true), width)], gutterWidth);

		const cardWidth = Math.max(1, Math.min(MAX_CARD_WIDTH, width - MARGIN));
		const sections = this.#sections(cardWidth);
		const lines = this.#fitRows(sections, targetRows);
		const margin = padding(MARGIN);
		const out = lines.map(line => this.#fit(line ? margin + line : "", width));
		if (targetRows !== undefined) while (out.length < targetRows) out.push(padding(width));
		return this.#withRightGutter(out, gutterWidth);
	}

	/**
	 * Lay the sections out with a blank row above and between them. When the
	 * viewport is short, whole sections go by rank — keys, then the release
	 * note, then sessions — and the identity block is clipped last.
	 */
	#fitRows(sections: { identity: string[]; others: Section[] }, targetRows: number | undefined): string[] {
		const colored = this.#colorReveal(1 + sections.others.length);
		const identity = this.#inkSection(sections.identity, 0, colored);
		let others = sections.others.map((section, index) => ({
			...section,
			lines: this.#inkSection(section.lines, index + 1, colored),
		}));
		const assemble = (): string[] => {
			const out = ["", ...identity];
			for (const section of others) out.push("", ...section.lines);
			return out;
		};
		let lines = assemble();
		if (targetRows === undefined) return lines;
		while (lines.length > targetRows && others.length > 0) {
			const drop = others.reduce((worst, section) => (section.dropRank > worst.dropRank ? section : worst));
			others = others.filter(section => section !== drop);
			lines = assemble();
		}
		return lines.slice(0, targetRows);
	}

	#sections(cardWidth: number): { identity: string[]; others: Section[] } {
		const others: Section[] = [];
		const note = this.#releaseNoteLine(cardWidth);
		if (note) others.push({ lines: [note], dropRank: 2 });
		others.push({ lines: this.#sessionLines(cardWidth), dropRank: 1 });
		others.push({ lines: [this.#keysLine(cardWidth)], dropRank: 3 });
		return { identity: this.#identityLines(cardWidth), others };
	}

	// ── Identity: mark + who and where ──────────────────────────────────────

	#identityLines(cardWidth: number): string[] {
		const withMark = cardWidth >= MIN_WIDTH_FOR_MARK;
		const mark = withMark ? this.#markRows() : [];
		const markWidth = Math.max(0, ...mark.map(row => visibleWidth(row)));
		const infoWidth = Math.max(1, withMark ? cardWidth - markWidth - MARK_GAP : cardWidth);
		const info = [
			this.#truncate(this.#titleLine(!withMark), infoWidth),
			this.#truncate(theme.fg("muted", t("welcome.tagline")), infoWidth),
			this.#truncate(this.#modelLine(), infoWidth),
			this.#truncate(this.#whereLine(infoWidth), infoWidth),
		];
		if (!withMark) return info;
		// Center the four identity lines against the pet's height.
		const offset = Math.max(0, Math.floor((mark.length - info.length) / 2));
		const rows = Math.max(mark.length, info.length + offset);
		const out: string[] = [];
		for (let row = 0; row < rows; row++) {
			const art = mark[row] ?? padding(markWidth);
			const text = info[row - offset] ?? "";
			out.push(text ? `${art}${padding(MARK_GAP)}${text}` : art);
		}
		return out;
	}

	/** The Sayknow pet itself, in half blocks; the pose follows the intro. */
	#markRows(): string[] {
		const step = this.#animStart == null ? -1 : Math.floor((performance.now() - this.#animStart) / WAVE_STEP_MS);
		if (this.logoMode === "ascii") {
			const rows: string[] = [...MARK_ASCII];
			if (step >= 0 && step < INTRO_POSES.length - 1 && step % 2 === 1) rows[3] = MARK_ASCII_WAVE;
			return rows.map(row => theme.fg("accent", row));
		}
		const pose = step >= 0 && step < INTRO_POSES.length ? INTRO_POSES[step]! : "base";
		return renderPetHalfBlocks(pose, this.options.petSkin ?? "red", theme.getColorMode());
	}

	/** `withIcon` adds the 🐙 glyph for layouts that have no room for the drawn mark. */
	#titleLine(withIcon = false): string {
		const buildLabel = this.options.buildLabel ?? formatBuildLabel();
		const mark = withIcon && this.logoMode !== "ascii" && theme.icon.pi ? `${theme.icon.pi} ` : "";
		return `${mark}${theme.bold(theme.fg("text", "Sayknow-CLI"))}${theme.fg("dim", ` v${this.version} · ${buildLabel}`)}`;
	}

	#modelLine(): string {
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

	#whereLine(width: number): string {
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

	/** One line, only after an update: the new version, its first note, and a pointer to /changelog. */
	#releaseNoteLine(width: number): string | undefined {
		const changelog = this.options.changelogMarkdown?.trim();
		if (!changelog) return undefined;
		const version = this.#latestChangelogVersion(changelog);
		const lead = theme.bold(theme.fg("accent", `v${version}`));
		const pointer = theme.fg("dim", "/changelog");
		const first = this.options.collapseChangelog ? undefined : this.#changelogItems(changelog)[0];
		if (!first) return this.#spread(lead, pointer, width);
		const room = width - visibleWidth(lead) - visibleWidth(pointer) - 4;
		const body = room >= 12 ? `  ${theme.fg("muted", this.#truncate(first, room))}` : "";
		return this.#spread(`${lead}${body}`, pointer, width);
	}

	#sessionLines(width: number): string[] {
		const heading = theme.bold(theme.fg("accent", t("welcome.sessionTrail")));
		if (this.recentSessions.length === 0) return [heading, theme.fg("dim", t("welcome.noSessions"))];
		const context = this.options.keyDisplayContext ?? { platform: process.platform };
		const hints = [t("welcome.allSessions", { key: this.#resumeKey() })];
		if (this.options.continueKey)
			hints.unshift(t("welcome.continue", { key: formatKeyHint(this.options.continueKey, context) }));
		const lines = [this.#spread(heading, theme.fg("dim", hints.join(" · ")), width)];
		this.recentSessions.slice(0, SESSION_ROWS).forEach((session, index) => {
			// The first row is the one the continue key resumes; mark it.
			const lead = index === 0 && this.options.continueKey ? theme.fg("accent", "› ") : "  ";
			const time = theme.fg("dim", session.timeAgo);
			const nameWidth = Math.max(1, width - visibleWidth(lead) - visibleWidth(time) - 2);
			const name = theme.fg(index === 0 ? "text" : "muted", this.#truncate(session.name, nameWidth));
			lines.push(this.#spread(`${lead}${name}`, time, width));
		});
		return lines;
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
			.map(item => `${theme.fg("text", item.key)} ${theme.fg("dim", t(item.label))}`)
			.join(theme.fg("dim", "   "));
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
