import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@sayknow-cli/tui";
import { getLanguage, setLanguage } from "../src/i18n";
import {
	type RecentSession,
	resolveWelcomeIntroTickMs,
	WelcomeComponent,
	type WelcomeComponentOptions,
	type WelcomeSnapshot,
} from "../src/modes/components/welcome";
import { theme as activeTheme, getThemeByName, setThemeInstance } from "../src/modes/theme/theme";

const originalBuildChannel = process.env.SKC_BUILD_CHANNEL;
// Assertions read English labels; a Korean system locale leaks in during full runs.
const originalLanguage = getLanguage();

afterEach(() => {
	if (originalBuildChannel === undefined) delete process.env.SKC_BUILD_CHANNEL;
	else process.env.SKC_BUILD_CHANNEL = originalBuildChannel;
});
beforeAll(async () => {
	setLanguage("en");
	const theme = await getThemeByName("ink-octopus");
	if (!theme) throw new Error("Failed to load ink-octopus theme");
	setThemeInstance(theme);
});
afterAll(() => {
	setLanguage(originalLanguage);
});

const plain = (lines: string[]): string[] => lines.map(line => stripVTControlCharacters(line));

const SNAPSHOT: WelcomeSnapshot = {
	cwd: "~/Dev/sayknow-cli",
	branch: "feature/card",
	gitChanges: { staged: 2, unstaged: 5, untracked: 1 },
	thinkingLevel: "xhigh",
};

const SESSIONS: RecentSession[] = Array.from({ length: 8 }, (_, index) => ({
	name: `session-${index + 1}`,
	timeAgo: `${index + 1}m ago`,
}));

const CHANGELOG = ["## [1.2.3]", "", "### Added", "", "- `/fork` is back", "- Second note", "- Third note"].join("\n");

function card(options: WelcomeComponentOptions = {}, sessions: RecentSession[] = SESSIONS, width = 120): string[] {
	const welcome = new WelcomeComponent("1.2.3", "Claude Opus 5.5", "anthropic", sessions, "unicode", {
		snapshot: SNAPSHOT,
		...options,
	});
	return plain(welcome.render(width));
}

describe("welcome intro cadence", () => {
	it("reduces frame pressure only for native Windows multiplexers", () => {
		expect(resolveWelcomeIntroTickMs("win32", "psmux,1,0")).toBe(100);
		expect(resolveWelcomeIntroTickMs("win32", "")).toBe(33);
		expect(resolveWelcomeIntroTickMs("linux", "tmux,1,0")).toBe(33);
	});
});

describe("launch card content", () => {
	it("shows the wordmark, then who and where: version, model with reasoning, path, branch and changes", () => {
		const lines = card({ buildLabel: "release build" });
		const text = lines.join("\n");
		expect(text).toContain("╔═╗╔═╗╦ ╦╦╔═╔╗╔╔═╗╦ ╦  ╔═╗╦  ╦");
		expect(text).toContain("╚═╝╩ ╩ ╩ ╩ ╩╝╚╝╚═╝╚╩╝  ╚═╝╩═╝╩");
		expect(text).toMatch(/Coding should feel like thinking\.\s+v1\.2\.3 · release build/);
		expect(text).toContain("Claude Opus 5.5 · xhigh");
		// Reclaiming the mascot's columns lets model and place share a row.
		expect(lines.find(line => line.includes("~/Dev/sayknow-cli"))).toMatch(
			/Claude Opus 5\.5 · xhigh {2}· {2}~\/Dev\/sayknow-cli · feature\/card \+2 ~5 \?1/,
		);
	});

	it("keeps model and place on one row when both fit", () => {
		const text = card({ snapshot: { cwd: "~/x", branch: "main", thinkingLevel: "high" } }).join("\n");
		expect(text).toMatch(/Claude Opus 5\.5 · high {2}· {2}~\/x · main/);
	});

	it("moves the workspace below the model when the card is narrow", () => {
		const lines = card({ snapshot: SNAPSHOT }, [], 52);
		const modelLine = lines.findIndex(line => line.includes("Claude Opus 5.5"));
		const projectLine = lines.findIndex(line => line.includes("~/Dev/sayknow-cli"));
		expect(projectLine).toBe(modelLine + 1);
		expect(lines[projectLine]).toContain("feature/card");
	});

	it("keeps the card short: three sessions, one release line, one row of keys", () => {
		const text = card({ changelogMarkdown: CHANGELOG, getViewportRows: () => 80 }).join("\n");
		expect(text).toContain("session-3");
		expect(text).not.toContain("session-4");
		expect(text).toMatch(/v1\.2\.3 +\/fork is back|v1\.2\.3 +\/changelog/);
		expect(text).toContain("/fork is back");
		expect(text).not.toContain("Second note");
		expect(text).toContain("/changelog");
		for (const gone of ["workspace", "roles", "preset", "MCP", "LSP", "Workflows", "/deep-interview", "Flow keys"]) {
			expect(text).not.toContain(gone);
		}
	});

	it("names the key that opens the full session list", () => {
		const text = card({ resumeKey: "alt+r", keyDisplayContext: { platform: "linux" } }).join("\n");
		expect(text).toMatch(/Recent sessions ─+ Alt\+R all sessions/);
		expect(text).toMatch(/\/ commands {2}· {2}Alt\+R sessions {2}· {2}Ctrl\+L model {2}· {2}\? keymap/);

		const unbound = card().join("\n");
		expect(unbound).toContain("/resume all sessions");

		const empty = card({}, []).join("\n");
		expect(empty).toContain("No saved sessions");
		expect(empty).not.toContain("all sessions");
	});

	it("names /resume instead of an Option chord on macOS, where Option may type a letter", () => {
		const mac = card({ resumeKey: "alt+r", continueKey: "ctrl+q", keyDisplayContext: { platform: "darwin" } }).join(
			"\n",
		);
		expect(mac).toContain("/resume all sessions");
		expect(mac).toContain("/resume sessions");
		expect(mac).not.toMatch(/⌥|Option|Alt\+R/);
		// Control chords stay: they never compose into text.
		expect(mac).toContain("continue");
	});

	it("marks the session the continue key resumes and names both keys", () => {
		const lines = card({ resumeKey: "alt+r", continueKey: "ctrl+q", keyDisplayContext: { platform: "linux" } });
		const text = lines.join("\n");
		expect(text).toMatch(/Recent sessions ─+ Ctrl\+Q continue · Alt\+R all sessions/);
		expect(lines.find(line => line.includes("session-1"))).toMatch(/^ {2}› session-1/);
		expect(lines.find(line => line.includes("session-2"))).toMatch(/^ {4}session-2/);

		// Without a continue key nothing is marked.
		expect(card().find(line => line.includes("session-1"))).not.toContain("›");
	});

	it("collapses the release line to the version when asked", () => {
		const text = card({ changelogMarkdown: CHANGELOG, collapseChangelog: true }).join("\n");
		expect(text).toMatch(/v1\.2\.3 ─+ \/changelog/);
		expect(text).not.toContain("/fork is back");
		expect(text).toContain("/changelog");
		expect(card().join("\n")).not.toContain("/changelog");
	});

	it("guides model selection instead of printing Unknown", () => {
		const welcome = new WelcomeComponent("1.2.3", "Unknown", "", [], "unicode");
		const text = plain(welcome.render(120)).join("\n");
		expect(text).toContain("choose a model");
		expect(text).not.toContain("Unknown");
	});

	it("fills in probed git counts as they arrive", () => {
		const welcome = new WelcomeComponent("1.2.3", "m", "p", [], "unicode", {
			snapshot: { cwd: "~/x", branch: "main" },
		});
		expect(plain(welcome.render(120)).join("\n")).not.toContain("~5");
		welcome.setSnapshot({ gitChanges: { staged: 0, unstaged: 5, untracked: 0 } });
		expect(plain(welcome.render(120)).join("\n")).toContain("main ~5");
	});

	it("keeps the tail of a long project path, the part that names the project", () => {
		const text = card({ snapshot: { cwd: `~/${"deep/".repeat(30)}my-project`, branch: "main" } }).join("\n");
		expect(text).toContain("my-project");
		expect(text).toContain("…");
	});
});

describe("launch card layout", () => {
	it("starts the wordmark at the card margin without a mascot or placeholder cells", () => {
		for (const mode of ["unicode", "square", "ascii"] as const) {
			const lines = plain(new WelcomeComponent("1.2.3", "m", "p", SESSIONS, mode).render(120));
			const text = lines.join("\n");
			expect(lines[1]).toStartWith(mode === "ascii" ? "  Sayknow-CLI" : "  ╔═╗╔═╗");
			expect(text).not.toMatch(/[▀▄\u{10eeee}]/u);
			expect(text).not.toContain("( oo )");
		}
	});

	it("divides sections with rule headers", () => {
		const lines = card({ changelogMarkdown: CHANGELOG, resumeKey: "alt+r" });
		expect(lines.find(line => line.includes("Recent sessions"))).toMatch(/Recent sessions ─{3,} /);
		expect(lines.find(line => line.includes("/changelog"))).toMatch(/v1\.2\.3 \/fork is back ─{3,} \/changelog/);
	});

	it("shows only the title in ASCII mode and drops the wordmark when narrow", () => {
		const ascii = plain(new WelcomeComponent("1.2.3", "m", "p", [], "ascii").render(100)).join("\n");
		expect(ascii).toContain("Sayknow-CLI v1.2.3");
		expect(ascii).not.toMatch(/[█▀▄╔╚]/);

		const narrow = card({}, SESSIONS, 36).join("\n");
		expect(narrow).toContain("╔═╗╔═╗");
		const tiny = card({}, SESSIONS, 26).join("\n");
		expect(tiny).not.toContain("╔═╗");
		expect(tiny).toContain("Sayknow-CLI");
	});

	it("does not stretch across wide terminals", () => {
		const lines = card({ resumeKey: "alt+r" }, SESSIONS, 220);
		for (const line of lines) expect(visibleWidth(line)).toBe(220);
		const longest = Math.max(...lines.map(line => line.trimEnd().length));
		expect(longest).toBeLessThanOrEqual(2 + 76);
	});

	it("fills the rows above the pinned composer and HUD", () => {
		const lines = card({ getViewportRows: () => 30, getReservedBottomRows: () => 6 });
		expect(lines).toHaveLength(24);
		expect(lines.join("\n")).toContain("session-1");
	});

	it("drops keys, then the release line, then sessions when rows run short", () => {
		const rows = (count: number) =>
			card({ changelogMarkdown: CHANGELOG, getViewportRows: () => count, resumeKey: "alt+r" }).join("\n");
		// Blank + wordmark/tagline/model and place + release + sessions + keys = 15.
		const full = rows(15);
		expect(full).toContain("commands");
		expect(full).toContain("/changelog");

		const noKeys = rows(14);
		expect(noKeys).not.toContain("commands");
		expect(noKeys).toContain("/changelog");
		expect(noKeys).toContain("session-1");

		const sessionsOnly = rows(12);
		expect(sessionsOnly).not.toContain("/changelog");
		expect(sessionsOnly).toContain("session-1");

		const identityOnly = rows(7);
		expect(identityOnly).toContain("╔═╗╔═╗");
		expect(identityOnly).not.toContain("session-1");
	});

	it("reserves the composer gutter, including the one-row layout", () => {
		for (const line of card({ rightGutterWidth: 1 }, SESSIONS, 100)) {
			expect(visibleWidth(line)).toBe(100);
			expect(line.endsWith(" ")).toBe(true);
		}
		const oneRow = card({ rightGutterWidth: 1, getViewportRows: () => 1 }, SESSIONS, 100);
		expect(oneRow).toHaveLength(1);
		expect(oneRow[0]).toContain("Sayknow-CLI");
	});

	it("gives up rows it does not have and degrades on tiny widths", () => {
		expect(card({ getViewportRows: () => 5, getReservedBottomRows: () => 5 })).toEqual([]);
		const welcome = new WelcomeComponent("1.2.3", "m", "p", [], "ascii");
		expect(welcome.render(3)).toEqual([]);
		expect(welcome.render(5).every(line => visibleWidth(line) <= 5)).toBe(true);
		expect(welcome.render(24).every(line => visibleWidth(line) <= 24)).toBe(true);
	});

	it("renders the build label from metadata when no override is provided", () => {
		process.env.SKC_BUILD_CHANNEL = "release";
		const text = plain(new WelcomeComponent("1.2.3", "m", "p", [], "ascii").render(120)).join("\n");
		expect(text).toContain("Sayknow-CLI v1.2.3 · release build");
		expect(text).not.toContain("dev build");
	});
});

describe("launch intro", () => {
	it("shows every fact on the first frame; the intro changes only color", () => {
		const skipped = new WelcomeComponent("1.2.3", "m", "p", SESSIONS, "unicode", { skipLogoAnimation: true });
		const settled = skipped.render(120);
		skipped.playIntro(() => {});
		expect(skipped.render(120)).toEqual(settled);

		const animated = new WelcomeComponent("1.2.3", "m", "p", SESSIONS, "unicode");
		animated.playIntro(() => {});
		const firstFrame = animated.render(120);
		expect(firstFrame).not.toEqual(settled);
		expect(plain(firstFrame)).toEqual(plain(settled));

		animated.dispose();
		expect(animated.render(120)).toEqual(settled);
	});
});

describe("opening a session from the card", () => {
	const OPENABLE: RecentSession[] = [
		{ name: "first", timeAgo: "1m", path: "/s/1.jsonl" },
		{ name: "second", timeAgo: "2m", path: "/s/2.jsonl" },
		{ name: "third", timeAgo: "3m", path: "/s/3.jsonl" },
	];
	const make = (opened: RecentSession[], sessions = OPENABLE) =>
		new WelcomeComponent("1.2.3", "m", "p", sessions, "unicode", {
			resumeKey: "alt+r",
			continueKey: "ctrl+q",
			keyDisplayContext: { platform: "linux" },
			onOpenSession: session => opened.push(session),
		});

	it("moves a highlight with the keyboard and opens the highlighted session", () => {
		const opened: RecentSession[] = [];
		const welcome = make(opened);
		expect(plain(welcome.render(120)).join("\n")).toMatch(/↓ pick · Ctrl\+Q continue · Alt\+R all sessions/);

		expect(welcome.select(0)).toBe(true);
		expect(welcome.moveSelection(1)).toBe(true);
		expect(welcome.moveSelection(5)).toBe(true);
		expect(welcome.selectedIndex).toBe(2);
		const raw = welcome.render(120);
		const text = plain(raw);
		expect(text.join("\n")).toContain("↑↓ move · ⏎ open · esc back");
		const row = raw.findIndex(line => Bun.stripANSI(line).includes("third"));
		expect(text[row]).toMatch(/^ {2}› third/);
		expect(raw[row]).toContain(activeTheme.getBgAnsi("selectedBg"));
		expect(text.find(line => line.includes("first"))).not.toContain("›");

		expect(welcome.openSelected()).toBe(true);
		expect(opened.map(session => session.path)).toEqual(["/s/3.jsonl"]);

		// ↑ past the first row hands focus back.
		welcome.select(0);
		expect(welcome.moveSelection(-1)).toBe(false);
		expect(welcome.selectedIndex).toBeUndefined();
	});

	it("opens the session under a click, and ignores clicks elsewhere", () => {
		const opened: RecentSession[] = [];
		const welcome = make(opened);
		const lines = plain(welcome.render(120));
		const secondRow = lines.findIndex(line => line.includes("second"));
		expect(welcome.handleClick(lines.findIndex(line => line.includes("Recent sessions")))).toBe(false);
		expect(welcome.handleClick(1)).toBe(false);
		expect(welcome.handleClick(secondRow)).toBe(true);
		expect(opened.map(session => session.path)).toEqual(["/s/2.jsonl"]);
	});

	it("stops offering rows once interaction ends, and never offers rows without a file", () => {
		const opened: RecentSession[] = [];
		const welcome = make(opened);
		const lines = plain(welcome.render(120));
		welcome.endInteraction();
		expect(welcome.openableCount).toBe(0);
		expect(welcome.select(0)).toBe(false);
		expect(welcome.handleClick(lines.findIndex(line => line.includes("first")))).toBe(false);
		expect(plain(welcome.render(120)).join("\n")).not.toContain("↓ pick");
		expect(opened).toEqual([]);

		const noFiles = make(opened, [{ name: "legacy", timeAgo: "1d" }]);
		expect(noFiles.openableCount).toBe(0);
		expect(noFiles.select(0)).toBe(false);
	});

	it("ends the rows with an 'all sessions' row reached by ↓ and Enter or a click", () => {
		const opened: RecentSession[] = [];
		let showAll = 0;
		const welcome = new WelcomeComponent("1.2.3", "m", "p", OPENABLE, "unicode", {
			continueKey: "ctrl+q",
			keyDisplayContext: { platform: "darwin" },
			onOpenSession: session => opened.push(session),
			onShowAllSessions: () => showAll++,
		});
		const lines = plain(welcome.render(120));
		const allRow = lines.findIndex(line => line.includes("All sessions…"));
		expect(allRow).toBe(lines.findIndex(line => line.includes("third")) + 1);
		expect(welcome.openableCount).toBe(4);

		welcome.select(0);
		welcome.moveSelection(10);
		expect(welcome.selectedIndex).toBe(3);
		expect(plain(welcome.render(120))[allRow]).toMatch(/^ {2}› All sessions…/);
		expect(welcome.openSelected()).toBe(true);
		expect(showAll).toBe(1);
		expect(opened).toEqual([]);
		// Cancelling the picker comes back to an un-highlighted card.
		expect(welcome.selectedIndex).toBeUndefined();

		expect(welcome.handleClick(allRow)).toBe(true);
		expect(showAll).toBe(2);
	});

	it("offers no 'all sessions' row without a handler, sessions, or interaction", () => {
		expect(make([]).openableCount).toBe(3);
		const handler = { onShowAllSessions: () => {} };
		const empty = new WelcomeComponent("1.2.3", "m", "p", [], "unicode", handler);
		expect(plain(empty.render(120)).join("\n")).not.toContain("All sessions…");
		const ended = new WelcomeComponent("1.2.3", "m", "p", OPENABLE, "unicode", handler);
		ended.endInteraction();
		expect(ended.openableCount).toBe(0);
	});
});
