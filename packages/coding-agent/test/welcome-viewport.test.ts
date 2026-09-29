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
		// Too long to share the model's row, so the place gets its own row instead of being cut.
		expect(lines.find(line => line.includes("~/Dev/sayknow-cli"))).toMatch(
			/~\/Dev\/sayknow-cli · feature\/card \+2 ~5 \?1/,
		);
		expect(lines.find(line => line.includes("~/Dev/sayknow-cli"))).not.toContain("Claude");
	});

	it("keeps model and place on one row when both fit", () => {
		const text = card({ snapshot: { cwd: "~/x", branch: "main", thinkingLevel: "high" } }).join("\n");
		expect(text).toMatch(/Claude Opus 5\.5 · high {2}· {2}~\/x · main/);
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
	it("stands the small Sayknow pet beside the wordmark, with no box around anything", () => {
		const welcome = new WelcomeComponent("1.2.3", "m", "p", SESSIONS, "unicode", { petSkin: "blue" });
		const raw = welcome.render(120);
		// Same color mode as the live theme: CI terminals without COLORTERM get 256 colors.
		const pet = renderPetHalfBlocks("base", "blue", activeTheme.getColorMode(), { scale: "compact" });
		expect(pet).toHaveLength(5);
		// The pet's rows open the card, each followed by the wordmark and tagline.
		for (const [index, row] of pet.entries()) expect(raw[1 + index]!.startsWith(`  ${row}`)).toBe(true);
		const lines = plain(raw);
		expect(lines[1]).toMatch(/^ {2}[▀▄ ]{12} {3}╔═╗╔═╗/);
		for (const glyph of ["╭", "╮", "╰", "╯", "│"]) expect(lines.join("\n")).not.toContain(glyph);
	});

	it("divides sections with rule headers", () => {
		const lines = card({ changelogMarkdown: CHANGELOG, resumeKey: "alt+r" });
		expect(lines.find(line => line.includes("Recent sessions"))).toMatch(/Recent sessions ─{3,} /);
		expect(lines.find(line => line.includes("/changelog"))).toMatch(/v1\.2\.3 \/fork is back ─{3,} \/changelog/);
	});

	it("paints the pet in its skin's colors", () => {
		const red = new WelcomeComponent("1.2.3", "m", "p", [], "unicode", { petSkin: "red" }).render(120).join("");
		const blue = new WelcomeComponent("1.2.3", "m", "p", [], "unicode", { petSkin: "blue" }).render(120).join("");
		const mode = activeTheme.getColorMode();
		const redPet = renderPetHalfBlocks("base", "red", mode, { scale: "compact" }).join("");
		const bluePet = renderPetHalfBlocks("base", "blue", mode, { scale: "compact" }).join("");
		expect(redPet).not.toBe(bluePet);
		expect(red).toContain(redPet.slice(0, 60));
		expect(blue).toContain(bluePet.slice(0, 60));
		expect(blue).not.toContain(redPet.slice(0, 60));
	});

	it("uses an ASCII mark and a text title in ASCII mode, and drops the pet, then the wordmark, when narrow", () => {
		const ascii = plain(new WelcomeComponent("1.2.3", "m", "p", [], "ascii").render(100)).join("\n");
		expect(ascii).toContain("( oo )");
		expect(ascii).toContain("Sayknow-CLI v1.2.3");
		expect(ascii).not.toMatch(/[█▀▄╔╚]/);

		const narrow = card({}, SESSIONS, 36).join("\n");
		expect(narrow).not.toMatch(/[▀▄]/);
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
		// Blank + identity (5 pet rows beside wordmark, tagline, model; then place) + release + sessions + keys = 16.
		const full = rows(16);
		expect(full).toContain("commands");
		expect(full).toContain("/changelog");

		const noKeys = rows(15);
		expect(noKeys).not.toContain("commands");
		expect(noKeys).toContain("/changelog");
		expect(noKeys).toContain("session-1");

		const sessionsOnly = rows(13);
		expect(sessionsOnly).not.toContain("/changelog");
		expect(sessionsOnly).toContain("session-1");

		const identityOnly = rows(8);
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
	it("shows every fact on the first frame and moves only color and the pet's tentacles", () => {
		const skipped = new WelcomeComponent("1.2.3", "m", "p", SESSIONS, "unicode", { skipLogoAnimation: true });
		const settled = skipped.render(120);
		skipped.playIntro(() => {});
		expect(skipped.render(120)).toEqual(settled);

		const animated = new WelcomeComponent("1.2.3", "m", "p", SESSIONS, "unicode");
		animated.playIntro(() => {});
		const firstFrame = animated.render(120);
		expect(firstFrame).not.toEqual(settled);
		// Beside the dancing pet (margin 2 + 12 columns + gap 3), every character is already in place.
		const text = (lines: string[]) => plain(lines).map(line => line.slice(17));
		expect(text(firstFrame)).toEqual(text(settled));

		animated.dispose();
		expect(animated.render(120)).toEqual(settled);
	});
});

describe("launch pet skin", () => {
	it("uses the pet the user keeps, else the skin that matches the theme", () => {
		expect(resolveWelcomePetSkin("blue", "ink-octopus")).toBe("blue");
		expect(resolveWelcomePetSkin("red", "blue-octopus")).toBe("red");
		expect(resolveWelcomePetSkin("off", "blue-octopus")).toBe("blue");
		expect(resolveWelcomePetSkin("off", "ink-octopus")).toBe("orange");
		expect(resolveWelcomePetSkin("off", undefined)).toBe("orange");
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
});

describe("pet dance after the intro", () => {
	it("keeps dancing while the pet is on screen and stops for good once it scrolls away", async () => {
		let visible = true;
		const asked: number[] = [];
		const welcome = new WelcomeComponent("1.2.3", "m", "p", SESSIONS, "unicode", {
			isLineVisible: line => {
				asked.push(line);
				return visible;
			},
		});
		const settled = new WelcomeComponent("1.2.3", "m", "p", SESSIONS, "unicode", { skipLogoAnimation: true }).render(
			120,
		);
		welcome.render(120);
		let renders = 0;
		welcome.playIntro(() => {
			renders += 1;
			welcome.render(120);
		});
		await Bun.sleep(800); // intro (560ms) done, dance running
		expect(welcome.dancing).toBe(true);
		// The pet's top row is card line 1 (after one blank row).
		expect(asked.every(line => line === 1)).toBe(true);
		// Across one dance loop the pet shows more than one pose.
		const poses = new Set<string>();
		for (let i = 0; i < 12; i++) {
			poses.add(welcome.render(120).slice(1, 6).join("\n"));
			await Bun.sleep(140);
		}
		expect(poses.size).toBeGreaterThan(1);
		const rendersWhileDancing = renders;

		visible = false;
		await Bun.sleep(700);
		expect(welcome.dancing).toBe(false);
		expect(welcome.render(120)).toEqual(settled);
		const after = renders;
		await Bun.sleep(700);
		expect(renders).toBe(after); // no more frames once stopped
		expect(rendersWhileDancing).toBeGreaterThan(0);
		welcome.dispose();
	});

	it("does not dance without a visibility check, when skipped, or without a pet", async () => {
		const noCheck = new WelcomeComponent("1.2.3", "m", "p", [], "unicode");
		noCheck.render(120);
		noCheck.playIntro(() => noCheck.render(120));
		const skipped = new WelcomeComponent("1.2.3", "m", "p", [], "unicode", {
			skipLogoAnimation: true,
			isLineVisible: () => true,
		});
		skipped.render(120);
		skipped.playIntro(() => {});
		const narrow = new WelcomeComponent("1.2.3", "m", "p", [], "unicode", { isLineVisible: () => true });
		narrow.render(30);
		narrow.playIntro(() => narrow.render(30));
		await Bun.sleep(700);
		expect(noCheck.dancing).toBe(false);
		expect(skipped.dancing).toBe(false);
		expect(narrow.dancing).toBe(false);
		for (const card of [noCheck, skipped, narrow]) card.dispose();
	});
});

describe("launch card Sayo image", () => {
	it("draws the pet rows from the uploaded image, following the pose", async () => {
		const seen: string[] = [];
		const petImage = {
			rows: 5,
			line: (pose: string, row: number) => {
				seen.push(pose);
				return `[${pose}:${row}]`.padEnd(10, " ");
			},
		};
		const welcome = new WelcomeComponent("1.2.3", "m", "p", SESSIONS, "unicode", {
			skipLogoAnimation: true,
			petImage,
		});
		const lines = plain(welcome.render(120));
		for (let row = 0; row < 5; row++) expect(lines[1 + row]).toContain(`[base:${row}]`);
		expect(lines[1]).toContain("╔═╗╔═╗");
		expect(lines.join("\n")).not.toMatch(/[▀▄]/);

		const dancing = new WelcomeComponent("1.2.3", "m", "p", SESSIONS, "unicode", {
			petImage,
			isLineVisible: () => true,
		});
		dancing.render(120);
		dancing.playIntro(() => dancing.render(120));
		await Bun.sleep(900);
		expect(new Set(seen).size).toBeGreaterThan(1);
		dancing.dispose();
	});
});
