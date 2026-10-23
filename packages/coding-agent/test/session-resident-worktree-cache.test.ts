import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@sayknow-cli/ai";
import { residentTextCacheRootAllowsDisk, SessionManager } from "@sayknow-cli/coding-agent/session/session-manager";
import * as git from "@sayknow-cli/coding-agent/utils/git";

// Ported from upstream gajae 5c77a6586c (#6974). The fork keeps the resident
// text cache next to an explicit session file (<session>/resident-cache), so the
// worktree case is a session directory inside a Git worktree rather than an XDG
// cache root.

const PROPERTY_SEED = 5180518;
const PROPERTY_INPUTS = 64;
const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true });
});

function makeTemp(prefix: string): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	tempDirs.push(dir);
	return dir;
}

function ensurePrivate(dir: string): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.chmodSync(dir, 0o700);
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		stopReason: "stop",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

function toolResult(text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-resident-worktree",
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function residentCacheRoot(sm: SessionManager): string {
	const artifactsDir = sm.getArtifactsDir();
	if (!artifactsDir) throw new Error("Expected artifacts dir");
	return path.join(artifactsDir, "resident-cache");
}

function treeHas(root: string, needle: string): boolean {
	if (!fs.existsSync(root)) return false;
	const target = Buffer.from(needle);
	const stack = [root];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) continue;
		const stat = fs.lstatSync(current);
		if (stat.isSymbolicLink()) continue;
		if (stat.isDirectory()) {
			for (const name of fs.readdirSync(current)) stack.push(path.join(current, name));
			continue;
		}
		if (!stat.isFile() || stat.size > 2_000_000) continue;
		if (fs.readFileSync(current).includes(target)) return true;
	}
	return false;
}

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

const ASSISTANT_CANARY = `sk-live-CANARY518-assistant-${"A".repeat(1200)}`;
const TOOL_CANARY = `sk-live-CANARY518-tool-${"T".repeat(1200)}`;

async function persistLargeOutput(cwd: string, sessionDir: string): Promise<SessionManager> {
	ensurePrivate(cwd);
	ensurePrivate(sessionDir);
	const manager = SessionManager.create(cwd, sessionDir);
	manager.appendMessage(assistantMessage(ASSISTANT_CANARY));
	manager.appendMessage(toolResult(TOOL_CANARY));
	await manager.ensureOnDisk();
	await manager.flush();
	return manager;
}

describe.skipIf(process.platform === "win32")("resident text cache inside a git worktree", () => {
	it("still writes long assistant and tool text when the session directory is outside a worktree", async () => {
		const root = makeTemp("skc-resident-allowed-");
		const manager = await persistLargeOutput(path.join(root, "project"), path.join(root, "sessions"));
		try {
			const cacheRoot = residentCacheRoot(manager);
			expect(git.repo.resolveSync(cacheRoot)).toBeNull();
			expect(treeHas(cacheRoot, ASSISTANT_CANARY)).toBe(true);
			expect(treeHas(cacheRoot, TOOL_CANARY)).toBe(true);
			expect(JSON.stringify(manager.getEntries())).toContain(ASSISTANT_CANARY);
		} finally {
			await manager.close().catch(() => {});
		}
	});

	it("keeps assistant and tool text in memory when the session directory is inside a worktree", async () => {
		const root = makeTemp("skc-resident-worktree-");
		const repo = path.join(root, "repo");
		ensurePrivate(path.join(repo, ".git"));
		const sessionDir = path.join(repo, ".sessions");
		const manager = await persistLargeOutput(path.join(root, "project"), sessionDir);
		try {
			expect(git.repo.resolveSync(sessionDir)?.repoRoot).toBe(repo);
			// Only the session file itself (which the user chose to place there) may
			// carry the text; the resident cache must not add a second plaintext copy.
			expect(fs.existsSync(residentCacheRoot(manager))).toBe(false);
			expect(JSON.stringify(manager.getEntries())).toContain(ASSISTANT_CANARY);
			expect(JSON.stringify(manager.getEntries())).toContain(TOOL_CANARY);
		} finally {
			await manager.close().catch(() => {});
		}
	});

	it("keeps resident text in memory when a symlinked session directory resolves into a worktree", async () => {
		const root = makeTemp("skc-resident-alias-");
		const repo = path.join(root, "repo");
		ensurePrivate(path.join(repo, ".git"));
		const realSessions = path.join(repo, "sessions");
		ensurePrivate(realSessions);
		const alias = path.join(root, "sessions-alias");
		fs.symlinkSync(realSessions, alias);
		expect(git.repo.resolveSync(root)).toBeNull();
		const manager = await persistLargeOutput(path.join(root, "project"), alias);
		try {
			expect(fs.existsSync(residentCacheRoot(manager))).toBe(false);
			expect(JSON.stringify(manager.getEntries())).toContain(ASSISTANT_CANARY);
		} finally {
			await manager.close().catch(() => {});
		}
	});
});

describe("residentTextCacheRootAllowsDisk", () => {
	it(`property: residentTextCacheRootAllowsDisk, seed ${PROPERTY_SEED}, ${PROPERTY_INPUTS} inputs`, () => {
		const parent = makeTemp("skc-resident-property-");
		expect(git.repo.resolveSync(parent)).toBeNull();
		const repo = path.join(parent, "repo");
		const plain = path.join(parent, "plain");
		fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
		fs.mkdirSync(plain);
		const random = mulberry32(PROPERTY_SEED);
		const alphabet = ["aa", "bb", "cc", "dd", "ee", "ff"];
		for (let index = 0; index < PROPERTY_INPUTS; index++) {
			const depth = 1 + Math.floor(random() * 4);
			const parts: string[] = [];
			for (let level = 0; level < depth; level++) {
				parts.push(`${alphabet[Math.floor(random() * alphabet.length)]}${index.toString(36)}`);
			}
			const relative = path.join(...parts);
			const inside = path.join(repo, relative);
			const outside = path.join(plain, relative);
			expect(residentTextCacheRootAllowsDisk(inside)).toBe(false);
			expect(residentTextCacheRootAllowsDisk(inside)).toBe(
				residentTextCacheRootAllowsDisk(path.join(inside, "child")),
			);
			expect(residentTextCacheRootAllowsDisk(outside)).toBe(true);
		}
		const linked = path.join(parent, "linked");
		const gitdir = path.join(parent, "real-gitdir");
		fs.mkdirSync(linked);
		fs.mkdirSync(gitdir);
		fs.writeFileSync(path.join(linked, ".git"), `gitdir: ${gitdir}\n`);
		expect(residentTextCacheRootAllowsDisk(path.join(linked, "resident-cache"))).toBe(false);
		const bogus = path.join(parent, "bogus");
		fs.mkdirSync(bogus);
		fs.writeFileSync(path.join(bogus, ".git"), "not-a-gitdir\n");
		expect(residentTextCacheRootAllowsDisk(path.join(bogus, "resident-cache"))).toBe(true);
		const occupied = path.join(plain, "occupied-root");
		fs.mkdirSync(occupied);
		fs.writeFileSync(path.join(occupied, "resident-cache"), "not-a-directory");
		expect(residentTextCacheRootAllowsDisk(path.join(occupied, "resident-cache"))).toBe(true);
		fs.writeFileSync(path.join(repo, "occupied-root"), "not-a-directory");
		expect(residentTextCacheRootAllowsDisk(path.join(repo, "occupied-root"))).toBe(false);
		const aliasIn = path.join(parent, "alias-in");
		fs.symlinkSync(repo, aliasIn);
		expect(residentTextCacheRootAllowsDisk(path.join(aliasIn, "resident-cache"))).toBe(false);
		expect(residentTextCacheRootAllowsDisk(path.join(aliasIn, "missing", "resident-cache"))).toBe(false);
		const outsideTarget = path.join(parent, "outside-target");
		fs.mkdirSync(outsideTarget);
		const aliasOut = path.join(parent, "alias-out");
		fs.symlinkSync(outsideTarget, aliasOut);
		expect(residentTextCacheRootAllowsDisk(path.join(aliasOut, "resident-cache"))).toBe(true);
		const trailed = path.join(plain, "trailed");
		expect(residentTextCacheRootAllowsDisk(trailed + path.sep)).toBe(residentTextCacheRootAllowsDisk(trailed));
		expect(residentTextCacheRootAllowsDisk(path.parse(parent).root)).toBe(true);
		const deep = path.join(parent, ...Array.from({ length: 70 }, () => "q"));
		expect(residentTextCacheRootAllowsDisk(deep)).toBe(false);
	});
});
