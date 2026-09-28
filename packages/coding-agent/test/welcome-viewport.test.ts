import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { renderPetHalfBlocks, visibleWidth } from "@sayknow-cli/tui";
import { getLanguage, setLanguage } from "../src/i18n";
import {
	type RecentSession,
	resolveWelcomeIntroTickMs,
	WelcomeComponent,
	type WelcomeComponentOptions,
	type WelcomeSnapshot,
} from "../src/modes/components/welcome";
import { resolveWelcomePetSkin } from "../src/modes/interactive-mode";
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
		expect(text).toMatch(/Recent sessions\s+Alt\+R all sessions/);
		expect(text).toMatch(/\/ commands\s+Alt\+R sessions\s+Ctrl\+L model\s+\? keymap/);

		const unbound = card().join("\n");
		expect(unbound).toContain("/resume all sessions");

		const empty = card({}, []).join("\n");
		expect(empty).toContain("No saved sessions");
		expect(empty).not.toContain("all sessions");
	});

	it("marks the session the continue key resumes and names both keys", () => {
		const lines = card({ resumeKey: "alt+r", continueKey: "ctrl+q", keyDisplayContext: { platform: "linux" } });
		const text = lines.join("\n");
		expect(text).toMatch(/Recent sessions\s+Ctrl\+Q continue · Alt\+R all sessions/);
		expect(lines.find(line => line.includes("session-1"))).toMatch(/^ {2}› session-1/);
		expect(lines.find(line => line.includes("session-2"))).toMatch(/^ {4}session-2/);

		// Without a continue key nothing is marked.
		expect(card().find(line => line.includes("session-1"))).not.toContain("›");
	});

	it("collapses the release line to the version when asked", () => {
		const text = card({ changelogMarkdown: CHANGELOG, collapseChangelog: true }).join("\n");
		expect(text).toMatch(/v1\.2\.3 +\/fork is back|v1\.2\.3 +\/changelog/);
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
	it("stands the Sayknow pet beside the identity lines, with no box around anything", () => {
		const welcome = new WelcomeComponent("1.2.3", "m", "p", SESSIONS, "unicode", { petSkin: "blue" });
		const raw = welcome.render(120);
		const pet = renderPetHalfBlocks("base", "blue", "truecolor");
		// The pet's rows open the card, each followed by the identity text.
		for (const [index, row] of pet.entries()) expect(raw[1 + index]!.startsWith(`  ${row}`)).toBe(true);
		const lines = plain(raw);
		expect(lines.find(line => line.includes("Sayknow-CLI"))).toMatch(/^ {2}[▀▄ ]{16} {3}Sayknow-CLI/);
		for (const glyph of ["╭", "╮", "╰", "╯", "│", "─"]) expect(lines.join("\n")).not.toContain(glyph);
	});

	it("paints the pet in its skin's colors", () => {
		const red = new WelcomeComponent("1.2.3", "m", "p", [], "unicode", { petSkin: "red" }).render(120).join("");
		const blue = new WelcomeComponent("1.2.3", "m", "p", [], "unicode", { petSkin: "blue" }).render(120).join("");
		expect(red).toContain("229;72;46");
		expect(blue).toContain("47;155;255");
		expect(blue).not.toContain("229;72;46");
	});

	it("uses an ASCII mark in ASCII mode and drops the mark when the card is narrow", () => {
		const ascii = plain(new WelcomeComponent("1.2.3", "m", "p", [], "ascii").render(100)).join("\n");
		expect(ascii).toContain("( o o )");
		expect(ascii).not.toMatch(/[█▀▄]/);

		const narrow = card({}, SESSIONS, 36).join("\n");
		expect(narrow).not.toMatch(/[▀▄]/);
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
		expect(full).toContain("/changelog");

		const noKeys = rows(16);
		expect(noKeys).not.toContain("commands");
		expect(noKeys).toContain("/changelog");
		expect(noKeys).toContain("session-1");

		const sessionsOnly = rows(14);
		expect(sessionsOnly).not.toContain("/changelog");
		expect(sessionsOnly).toContain("session-1");

		const identityOnly = rows(8);
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
	it("shows every fact on the first frame and moves only color and the pet's tentacles", () => {
		const skipped = new WelcomeComponent("1.2.3", "m", "p", SESSIONS, "unicode", { skipLogoAnimation: true });
		const settled = skipped.render(120);
		skipped.playIntro(() => {});
		expect(skipped.render(120)).toEqual(settled);

		const animated = new WelcomeComponent("1.2.3", "m", "p", SESSIONS, "unicode");
		animated.playIntro(() => {});
		const firstFrame = animated.render(120);
		expect(firstFrame).not.toEqual(settled);
		// Beside the dancing pet (margin 2 + 16 columns + gap 3), every character is already in place.
		const text = (lines: string[]) => plain(lines).map(line => line.slice(21));
		expect(text(firstFrame)).toEqual(text(settled));
		expect(plain(firstFrame).join("\n")).not.toEqual(plain(settled).join("\n"));

		animated.dispose();
		expect(animated.render(120)).toEqual(settled);
	});
});

describe("launch pet skin", () => {
	it("uses the pet the user keeps, else the skin that matches the theme", () => {
		expect(resolveWelcomePetSkin("blue", "ink-octopus")).toBe("blue");
		expect(resolveWelcomePetSkin("red", "blue-octopus")).toBe("red");
		expect(resolveWelcomePetSkin("off", "blue-octopus")).toBe("blue");
		expect(resolveWelcomePetSkin("off", "ink-octopus")).toBe("red");
		expect(resolveWelcomePetSkin("off", undefined)).toBe("red");
	});
});
