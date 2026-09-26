import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@sayknow-cli/utils";
import { SessionSelectorComponent } from "../src/modes/components/session-selector";
import { initTheme } from "../src/modes/theme/theme";
import { prioritizeStarredSessions, type SessionInfo, SessionManager } from "../src/session/session-manager";
import {
	getSessionStarIndexPath,
	isSessionIdStarred,
	readStarredSessionIds,
	setSessionIdStarred,
} from "../src/session/session-stars";

let originalAgentDir: string;
let agentDir: string;

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(() => {
	originalAgentDir = getAgentDir();
	agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "skc-stars-"));
	setAgentDir(agentDir);
});

afterEach(() => {
	setAgentDir(originalAgentDir);
	fs.rmSync(agentDir, { recursive: true, force: true });
});

function info(id: string, starred = false): SessionInfo {
	return {
		path: `/sessions/${id}.jsonl`,
		id,
		cwd: "/tmp/project",
		title: id,
		starred,
		created: new Date(0),
		modified: new Date(0),
		messageCount: 1,
		size: 10,
		firstMessage: id,
		allMessagesText: id,
	};
}

describe("session star index", () => {
	it("treats a missing index as nothing starred and creates it on first star", async () => {
		expect(readStarredSessionIds().size).toBe(0);
		expect(await setSessionIdStarred("a", true)).toBe(true);
		expect(fs.existsSync(getSessionStarIndexPath())).toBe(true);
		expect(isSessionIdStarred("a")).toBe(true);
		expect(isSessionIdStarred("b")).toBe(false);
	});

	it("reports no change when the session is already in the requested state", async () => {
		expect(await setSessionIdStarred("a", false)).toBe(false);
		expect(await setSessionIdStarred("a", true)).toBe(true);
		expect(await setSessionIdStarred("a", true)).toBe(false);
		expect(await setSessionIdStarred("a", false)).toBe(true);
		expect(isSessionIdStarred("a")).toBe(false);
	});

	it("keeps concurrent stars on different sessions", async () => {
		const ids = Array.from({ length: 12 }, (_, index) => `s${index}`);
		await Promise.all(ids.map(id => setSessionIdStarred(id, true)));
		expect([...readStarredSessionIds()].sort()).toEqual([...ids].sort());
	});

	it("sees a star written by another process after the cached read", async () => {
		expect(isSessionIdStarred("external")).toBe(false);
		fs.writeFileSync(
			getSessionStarIndexPath(),
			JSON.stringify({ version: 1, starred: { external: "2026-01-01T00:00:00.000Z" } }),
		);
		expect(isSessionIdStarred("external")).toBe(true);
	});

	it("never overwrites an unreadable index, and listing treats it as empty", async () => {
		fs.writeFileSync(getSessionStarIndexPath(), "{ not json");
		expect(readStarredSessionIds().size).toBe(0);
		await expect(setSessionIdStarred("a", true)).rejects.toThrow("unreadable");
		expect(fs.readFileSync(getSessionStarIndexPath(), "utf8")).toBe("{ not json");
	});

	it("puts starred sessions first and keeps recency order inside each group", () => {
		const ordered = prioritizeStarredSessions([
			info("new"),
			info("pinned-new", true),
			info("old"),
			info("pinned-old", true),
		]);
		expect(ordered.map(session => session.id)).toEqual(["pinned-new", "pinned-old", "new", "old"]);
	});
});

describe("session listing and manager", () => {
	it("marks listed sessions from the index and stars the live session", async () => {
		const sessionDir = path.join(agentDir, "explicit-sessions");
		const manager = SessionManager.create("/tmp/project", sessionDir);
		manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		// A transcript reaches disk once the first assistant reply lands.
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		await manager.flush();
		expect(fs.existsSync(manager.getSessionFile()!)).toBe(true);

		expect(manager.isSessionStarred()).toBe(false);
		expect(await manager.setSessionStarred(true)).toBe(true);
		expect(manager.isSessionStarred()).toBe(true);

		const listed = await SessionManager.list("/tmp/project", sessionDir);
		expect(listed.find(session => session.id === manager.getSessionId())?.starred).toBe(true);

		// Stars live outside the transcript: the file carries no star metadata.
		const transcript = fs.readFileSync(manager.getSessionFile()!, "utf8");
		expect(transcript).not.toContain("starred");
	});
});

describe("resume picker star toggle", () => {
	it("toggles the selected session with ctrl+s and moves it to the top", async () => {
		const calls: Array<[string, boolean]> = [];
		const selector = new SessionSelectorComponent(
			[info("recent"), info("older")],
			() => {},
			() => {},
			() => {},
			undefined,
			undefined,
			undefined,
			async (session, starred) => {
				calls.push([session.id, starred]);
			},
		);
		const plain = () => Bun.stripANSI(selector.render(100).join("\n"));
		expect(plain()).toContain("Ctrl+S to star/unstar");

		selector.handleInput("\x1b[B"); // down to "older"
		selector.handleInput("\x13"); // ctrl+s
		await Bun.sleep(0);

		expect(calls).toEqual([["older", true]]);
		const text = plain();
		expect(text.indexOf("★ older")).toBeGreaterThanOrEqual(0);
		expect(text.indexOf("★ older")).toBeLessThan(text.indexOf("recent"));
	});

	it("shows the error and keeps the list unchanged when persisting fails", async () => {
		const selector = new SessionSelectorComponent(
			[info("only")],
			() => {},
			() => {},
			() => {},
			undefined,
			undefined,
			undefined,
			async () => {
				throw new Error("disk full");
			},
		);
		selector.handleInput("\x13");
		await Bun.sleep(0);
		const text = Bun.stripANSI(selector.render(100).join("\n"));
		expect(text).toContain("disk full");
		expect(text).not.toContain("★");
	});

	it("hides the hint and ignores ctrl+s when the host cannot persist stars", () => {
		const selector = new SessionSelectorComponent(
			[info("only")],
			() => {},
			() => {},
			() => {},
		);
		selector.handleInput("\x13");
		const text = Bun.stripANSI(selector.render(100).join("\n"));
		expect(text).not.toContain("Ctrl+S");
		expect(text).not.toContain("★");
	});
});
