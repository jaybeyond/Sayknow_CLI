import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@sayknow-cli/tui";
import { getLanguage, setLanguage } from "../src/i18n";
import { resolveWelcomeIntroTickMs, WelcomeComponent, type WelcomeSnapshot } from "../src/modes/components/welcome";
import { getThemeByName, setThemeInstance } from "../src/modes/theme/theme";

const originalBuildChannel = process.env.SKC_BUILD_CHANNEL;
// The ledger assertions read English labels; a Korean system locale leaks in during full runs.
const originalLanguage = getLanguage();

afterEach(() => {
	if (originalBuildChannel === undefined) {
		delete process.env.SKC_BUILD_CHANNEL;
	} else {
		process.env.SKC_BUILD_CHANNEL = originalBuildChannel;
	}
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

const FULL_SNAPSHOT: WelcomeSnapshot = {
	cwd: "~/Dev/sayknow-cli",
	branch: "feature/ledger",
	gitChanges: { staged: 2, unstaged: 5, untracked: 1 },
	recentCommits: ["82c86be perf(session): reject foreign receipts early", "67c255e feat(ai): bundle GPT-6 Sol"],
	thinkingLevel: "xhigh",
	profile: "Claude Opus 5.5",
	roles: [
		{ role: "executor", model: "claude-sonnet-5" },
		{ role: "planner", model: "claude-opus-5-5:medium" },
		{ role: "critic", model: "claude-opus-5-5:high" },
		{ role: "architect", model: "claude-opus-5-5:max" },
	],
	mcp: { connected: 3, total: 4 },
	skills: 24,
	contextFiles: ["AGENTS.md", "CLAUDE.md"],
};

function ledger(snapshot: WelcomeSnapshot, width = 140, rows = 40): string {
	const welcome = new WelcomeComponent("1.2.3", "Claude Opus 5.5", "anthropic", [], [], "unicode", {
		snapshot,
		getViewportRows: () => rows,
	});
	return plain(welcome.render(width)).join("\n");
}

describe("welcome intro cadence", () => {
	it("reduces frame pressure only for native Windows multiplexers", () => {
		expect(resolveWelcomeIntroTickMs("win32", "psmux,1,0")).toBe(100);
		expect(resolveWelcomeIntroTickMs("win32", "")).toBe(33);
		expect(resolveWelcomeIntroTickMs("linux", "tmux,1,0")).toBe(33);
	});
});

describe("launch reveal", () => {
	it("renders the settled frame immediately when the reveal is skipped", () => {
		const skipped = new WelcomeComponent("1.2.3", "test-model", "test-provider", [], [], "ascii", {
			skipLogoAnimation: true,
			snapshot: FULL_SNAPSHOT,
		});
		const settled = skipped.render(120);
		skipped.playIntro(() => {});
		expect(skipped.render(120)).toEqual(settled);

		const animated = new WelcomeComponent("1.2.3", "test-model", "test-provider", [], [], "ascii", {
			snapshot: FULL_SNAPSHOT,
		});
		animated.playIntro(() => {});
		const firstFrame = animated.render(120);
		// Only color is staged: every fact is readable on the first frame, in the same place.
		expect(firstFrame).not.toEqual(settled);
		expect(firstFrame).toHaveLength(settled.length);
		expect(plain(firstFrame)).toEqual(plain(settled));

		animated.dispose();
		expect(animated.render(120)).toEqual(settled);
		skipped.dispose();
	});
});

describe("WelcomeComponent layout", () => {
	it("uses the full terminal width on wide viewports", () => {
		const lines = new WelcomeComponent("1.2.3", "test-model", "test-provider", [], [], "ascii").render(200);
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) expect(visibleWidth(line)).toBe(200);
	});

	it("reserves the composer gutter for normal and one-row layouts", () => {
		const normal = new WelcomeComponent("1.2.3", "test-model", "test-provider", [], [], "ascii", {
			rightGutterWidth: 1,
		});
		for (const line of plain(normal.render(100))) {
			expect(visibleWidth(line)).toBe(100);
			expect(line.endsWith(" ")).toBe(true);
		}

		const constrained = new WelcomeComponent("1.2.3", "test-model", "test-provider", [], [], "ascii", {
			rightGutterWidth: 1,
			getViewportRows: () => 1,
			getReservedBottomRows: () => 0,
		});
		const lines = plain(constrained.render(100));
		expect(lines).toHaveLength(1);
		expect(visibleWidth(lines[0]!)).toBe(100);
		expect(lines[0]).toContain("Sayknow-CLI");
	});

	it("renders the build label from metadata instead of defaulting to dev", () => {
		const welcome = new WelcomeComponent("1.2.3", "test-model", "test-provider", [], [], "ascii", {
			buildLabel: "release build",
		});
		const rendered = plain(welcome.render(120)).join("\n");
		expect(rendered).toContain("Sayknow-CLI v1.2.3 · release build");
		expect(rendered).not.toContain("dev build");
	});

	it("renders the production metadata resolver label when no override is provided", () => {
		process.env.SKC_BUILD_CHANNEL = "release";
		const rendered = plain(
			new WelcomeComponent("1.2.3", "test-model", "test-provider", [], [], "ascii").render(120),
		).join("\n");
		expect(rendered).toContain("Sayknow-CLI v1.2.3 · release build");
		expect(rendered).not.toContain("dev build");
	});

	it("is borderless: no enclosing box and no column divider", () => {
		const rendered = ledger(FULL_SNAPSHOT);
		for (const glyph of ["╭", "╮", "╰", "╯", "│", "┴"]) expect(rendered).not.toContain(glyph);
	});

	it("sits the ledger beside the activity column when wide, and stacks it when narrow", () => {
		const wide = ledger(FULL_SNAPSHOT, 140).split("\n");
		const sideBySide = wide.find(line => line.includes("workspace"));
		expect(sideBySide).toContain("Session trail");

		const narrow = ledger(FULL_SNAPSHOT, 80, 60).split("\n");
		const workspaceRow = narrow.findIndex(line => line.includes("workspace"));
		const sessionsRow = narrow.findIndex(line => line.includes("Session trail"));
		const whatsNewRow = narrow.findIndex(line => line.includes("What's new"));
		expect(workspaceRow).toBeGreaterThan(-1);
		// Stacked: sessions come right after the ledger, before release notes.
		expect(sessionsRow).toBeGreaterThan(workspaceRow);
		expect(whatsNewRow).toBeGreaterThan(sessionsRow);
		expect(narrow[workspaceRow]).not.toContain("What's new");
	});

	it("degrades gracefully on tiny terminal widths", () => {
		const welcome = new WelcomeComponent("1.2.3", "test-model", "test-provider", [], [], "ascii");
		expect(welcome.render(5).every(line => visibleWidth(line) <= 5)).toBe(true);
		expect(welcome.render(3)).toEqual([]);
		expect(welcome.render(24).every(line => visibleWidth(line) <= 24)).toBe(true);
	});

	it("fills available terminal rows while reserving the pinned composer and HUD", () => {
		const welcome = new WelcomeComponent("1.2.3", "test-model", "test-provider", [], [], "ascii", {
			getViewportRows: () => 24,
			getReservedBottomRows: () => 6,
		});
		const lines = welcome.render(100);
		expect(lines).toHaveLength(18);
		for (const line of lines) expect(visibleWidth(line)).toBe(100);
		const text = plain(lines).join("\n");
		expect(text).toContain("Sayknow-CLI");
		expect(text).toContain("What's new");
	});

	it("does not steal rows when the pinned composer already fills the viewport", () => {
		const hidden = new WelcomeComponent("1.2.3", "test-model", "test-provider", [], [], "ascii", {
			getViewportRows: () => 5,
			getReservedBottomRows: () => 5,
		});
		expect(hidden.render(80)).toEqual([]);

		const oneRow = new WelcomeComponent("1.2.3", "test-model", "test-provider", [], [], "ascii", {
			getViewportRows: () => 5,
			getReservedBottomRows: () => 4,
		});
		const lines = oneRow.render(80);
		expect(lines).toHaveLength(1);
		expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(80);
	});
});

describe("workspace ledger", () => {
	it("shows the workspace, branch, commits, model, reasoning, preset, roles and tooling", () => {
		const text = ledger(FULL_SNAPSHOT);

		expect(text).toContain("~/Dev/sayknow-cli");
		expect(text).toContain("feature/ledger · +2 ~5 ?1");
		expect(text).toContain("82c86be perf(session): reject foreign receipts early");
		expect(text).toContain("Claude Opus 5.5 · anthropic");
		expect(text).toContain("xhigh");
		expect(text).toContain("preset");
		expect(text).toContain("MCP 3/4");
		expect(text).toContain("skills 24");
		expect(text).toContain("rules AGENTS.md +1");

		// Role agents keep their canonical order.
		const order = ["executor", "planner", "critic", "architect"].map(role => text.indexOf(`${role} `));
		expect(order.every(index => index > -1)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		expect(text).toContain("claude-opus-5-5:max");
	});

	it("says the roles follow the default model when no role override is set", () => {
		expect(ledger({ ...FULL_SNAPSHOT, roles: [] })).toContain("roles follow the default model");
	});

	it("guides model selection instead of printing Unknown", () => {
		const welcome = new WelcomeComponent("1.2.3", "Unknown", "Unknown", [], [], "unicode");
		const text = plain(welcome.render(140)).join("\n");
		expect(text).toContain("choose a model");
		expect(text).not.toContain("Unknown");
	});

	it("fills in probed facts as they arrive", () => {
		const welcome = new WelcomeComponent("1.2.3", "m", "p", [], [], "unicode", {
			snapshot: { branch: "main" },
		});
		const before = plain(welcome.render(140)).join("\n");
		expect(before).toContain("main");
		expect(before).not.toContain("clean");

		welcome.setSnapshot({ gitChanges: { staged: 0, unstaged: 0, untracked: 0 } });
		const after = plain(welcome.render(140)).join("\n");
		expect(after).toContain("main · clean");
	});

	it("marks a directory outside git instead of hiding the row", () => {
		expect(ledger({ branch: null })).toContain("not a git repository");
	});

	it("keeps the tail of a long workspace path — the part that names the project", () => {
		const text = ledger({ cwd: `~/${"deeply/nested/".repeat(12)}my-project` }, 100);
		expect(text).toContain("…");
		expect(text).toContain("my-project");
	});
});

describe("activity column", () => {
	it("integrates changelog highlights without overflowing narrow CJK content", () => {
		const welcome = new WelcomeComponent("1.2.3", "test-model", "test-provider", [], [], "ascii", {
			getViewportRows: () => 40,
			changelogMarkdown: [
				"## [1.2.3]",
				"",
				"### Fixed",
				"",
				"- 한국어와 English가 섞인 긴 업데이트 내용을 시작 화면 안에서 안전하게 줄입니다.",
				"- Added fullscreen startup framing.",
			].join("\n"),
		});
		const lines = welcome.render(60);
		expect(plain(lines).join("\n")).toContain("한국어와 English");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
	});

	it("keeps What's new and the session trail short however tall the viewport is", () => {
		const changelogMarkdown = [
			"## [1.2.3]",
			"",
			"### Added",
			"",
			...Array.from({ length: 10 }, (_, index) => `- Dynamic changelog item ${index + 1}`),
		].join("\n");
		const recentSessions = Array.from({ length: 12 }, (_, index) => ({
			name: `trail-session-${index + 1}`,
			timeAgo: `${index + 1}m ago`,
		}));
		const make = (rows: number) =>
			plain(
				new WelcomeComponent("1.2.3", "m", "p", recentSessions, [], "ascii", {
					getViewportRows: () => rows,
					changelogMarkdown,
				}).render(140),
			).join("\n");

		for (const rows of [26, 48, 80]) {
			const text = make(rows);
			expect(text).toContain("trail-session-3");
			expect(text).not.toContain("trail-session-4");
			expect(text).toContain("Dynamic changelog item 1");
			expect(text).not.toContain("Dynamic changelog item 4");
		}
	});

	it("points the session heading at the resume picker key", () => {
		const sessions = [{ name: "previous work", timeAgo: "1m ago" }];
		const withKey = plain(
			new WelcomeComponent("1.2.3", "m", "p", sessions, [], "ascii", {
				resumeKey: "alt+r",
				keyDisplayContext: { platform: "linux" },
			}).render(140),
		).join("\n");
		expect(withKey).toMatch(/Session trail\s+Alt\+R all sessions/);

		const unbound = plain(new WelcomeComponent("1.2.3", "m", "p", sessions, [], "ascii").render(140)).join("\n");
		expect(unbound).toContain("/resume all sessions");

		const empty = plain(new WelcomeComponent("1.2.3", "m", "p", [], [], "ascii").render(140)).join("\n");
		expect(empty).not.toContain("all sessions");
	});

	it("packs Flow keys across the available section width", () => {
		const rowsWith = (width: number) =>
			plain(
				new WelcomeComponent("1.2.3", "m", "p", [], [], "ascii", {
					keyDisplayContext: { platform: "linux" },
				}).render(width),
			).filter(line => /Ctrl\+|\/ commands|Tab complete/.test(line)).length;

		expect(rowsWith(200)).toBeLessThan(rowsWith(50));
	});

	it.each([
		["darwin", ["⌃L model", "⇧⇥ reasoning", "⇥ complete", "⌃J newline", "⌃C clear"]],
		["win32", ["Ctrl+L model", "Shift+Tab reasoning", "Tab complete", "Alt+Enter newline", "Ctrl+C clear"]],
		["linux", ["Ctrl+L model", "Shift+Tab reasoning", "Tab complete", "Ctrl+J newline", "Ctrl+C clear"]],
	] as const)("renders platform-aware canonical Flow keys for %s", (platform, expected) => {
		const welcome = new WelcomeComponent("1.2.3", "m", "p", [], [], "ascii", {
			keyDisplayContext: { platform },
			getViewportRows: () => 60,
		});
		const text = plain(welcome.render(200)).join("\n");
		const flow = text.slice(text.indexOf("Flow keys"));

		let previousIndex = -1;
		for (const label of expected) {
			const index = flow.indexOf(label);
			expect(index).toBeGreaterThan(previousIndex);
			previousIndex = index;
		}
	});
});
