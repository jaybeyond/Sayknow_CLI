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
import { getThemeByName, setThemeInstance } from "../src/modes/theme/theme";

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
	it("shows who and where: version, model with reasoning, project path, branch and changes", () => {
		const text = card({ buildLabel: "release build" }).join("\n");
		expect(text).toContain("Sayknow-CLI v1.2.3 · release build");
		expect(text).toContain("Coding should feel like thinking.");
		expect(text).toContain("Claude Opus 5.5 · xhigh");
		expect(text).toMatch(/~\/Dev\/sayknow-cli · feature\/card \+2 ~5 \?1/);
	});

	it("keeps the card short: three sessions, one release line, one row of keys", () => {
		const text = card({ changelogMarkdown: CHANGELOG, getViewportRows: () => 80 }).join("\n");
		expect(text).toContain("session-3");
		expect(text).not.toContain("session-4");
		expect(text).toContain("What's new v1.2.3");
		expect(text).toContain("/fork is back");
		expect(text).not.toContain("Second note");
		expect(text).toContain("/changelog");
		for (const gone of ["workspace", "roles", "preset", "MCP", "LSP", "Workflows", "/deep-interview", "Flow keys"]) {
			expect(text).not.toContain(gone);
		}
	});

	it("names the key that opens the full session list", () => {
		const text = card({ resumeKey: "alt+r", keyDisplayContext: { platform: "linux" } }).join("\n");
		expect(text).toMatch(/Recent sessions\s+Alt\+R all sessions/);
		expect(text).toMatch(/\/ commands\s+Alt\+R sessions\s+Ctrl\+L model\s+\? keymap/);

		const unbound = card().join("\n");
		expect(unbound).toContain("/resume all sessions");

		const empty = card({}, []).join("\n");
		expect(empty).toContain("No saved sessions");
		expect(empty).not.toContain("all sessions");
	});

	it("collapses the release line to the version when asked", () => {
		const text = card({ changelogMarkdown: CHANGELOG, collapseChangelog: true }).join("\n");
		expect(text).toContain("What's new v1.2.3");
		expect(text).not.toContain("/fork is back");
		expect(card().join("\n")).not.toContain("What's new");
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
	it("draws the octopus mark beside the identity lines, with no box around anything", () => {
		const lines = card();
		const title = lines.find(line => line.includes("Sayknow-CLI"))!;
		expect(title).toContain("▄█████▄");
		expect(lines.join("\n")).toContain("▀▄▀▄▀▄▀▄▀");
		for (const glyph of ["╭", "╮", "╰", "╯", "│", "─"]) expect(lines.join("\n")).not.toContain(glyph);
	});

	it("uses an ASCII mark in ASCII mode and drops the mark when the card is narrow", () => {
		const ascii = plain(new WelcomeComponent("1.2.3", "m", "p", [], "ascii").render(100)).join("\n");
		expect(ascii).toContain("( o o )");
		expect(ascii).not.toContain("█");

		const narrow = card({}, SESSIONS, 36).join("\n");
		expect(narrow).not.toContain("█");
		expect(narrow).toContain("Sayknow-CLI");
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
		const full = rows(40);
		expect(full).toContain("commands");
		expect(full).toContain("What's new");

		const noKeys = rows(13);
		expect(noKeys).not.toContain("commands");
		expect(noKeys).toContain("What's new");
		expect(noKeys).toContain("session-1");

		const sessionsOnly = rows(11);
		expect(sessionsOnly).not.toContain("What's new");
		expect(sessionsOnly).toContain("session-1");

		const identityOnly = rows(5);
		expect(identityOnly).toContain("Sayknow-CLI");
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
	it("shows every fact on the first frame and moves only color and the tentacles", () => {
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
