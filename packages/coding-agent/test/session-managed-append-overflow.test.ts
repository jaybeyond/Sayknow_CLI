import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@sayknow-cli/utils";
import { ManagedSessionDescendantStore } from "../src/session/internal/managed-session-storage";
import { SessionManager } from "../src/session/session-manager";

const tempDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(import.meta.dirname, ".tmp-managed-append-overflow-"));
	tempDirs.push(dir);
	return dir;
}

describe("SessionManager managed append overflow recovery", () => {
	it("recovers from content_too_large via full rewrite", async () => {
		const root = makeTempDir();
		const cwd = path.join(root, "workspace");
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		const destination = SessionManager.managedDestination(cwd, agentDir);
		if (destination.kind !== "managed") throw new Error("Expected managed destination");

		const manager = SessionManager.create(cwd, destination);
		try {
			const firstId = manager.appendMessage({ role: "user", content: "duplicate", timestamp: 1 });
			await manager.ensureOnDisk();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected managed session file");
			const modelId = manager.appendModelChange("model-a");
			const duplicateId = manager.appendMessage({ role: "user", content: "duplicate", timestamp: 2 });

			const appendSpy = vi.spyOn(ManagedSessionDescendantStore.prototype, "appendSync").mockImplementation(() => {
				throw new Error("content_too_large");
			});
			let recoveredId = "";
			expect(() => {
				recoveredId = manager.appendCustomEntry("after-overflow", { recovered: true });
			}).not.toThrow();
			appendSpy.mockRestore();

			const thirdId = manager.appendMessage({ role: "user", content: "third", timestamp: 3 });
			await manager.flush();
			const entries = fs
				.readFileSync(sessionFile, "utf8")
				.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line) as { type?: unknown; id?: unknown; message?: { content?: unknown } });
			const liveEntries = entries.filter(entry => entry.type !== "session");
			expect(liveEntries).toEqual(JSON.parse(JSON.stringify(manager.getEntries())));
			expect(liveEntries.map(entry => entry.type)).toEqual([
				"message",
				"model_change",
				"message",
				"custom",
				"message",
			]);
			expect(liveEntries.map(entry => entry.id)).toEqual([firstId, modelId, duplicateId, recoveredId, thirdId]);
			expect(
				liveEntries
					.filter(
						(entry): entry is { type: "message"; id: string; message: { content: string } } =>
							entry.type === "message" &&
							typeof entry.id === "string" &&
							typeof entry.message?.content === "string",
					)
					.map(entry => entry.message.content),
			).toEqual(["duplicate", "duplicate", "third"]);
		} finally {
			await manager.close();
		}
	});

	it.skipIf(process.platform !== "linux")("reports the authority-bound on-disk transcript size", async () => {
		const root = makeTempDir();
		const cwd = path.join(root, "workspace");
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		const destination = SessionManager.managedDestination(cwd, agentDir);
		if (destination.kind !== "managed") throw new Error("Expected managed destination");

		const manager = SessionManager.create(cwd, destination);
		try {
			expect(manager.getTranscriptFileBytes()).toBeUndefined();
			manager.appendMessage({ role: "user", content: "hello world", timestamp: 1 });
			await manager.ensureOnDisk();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected managed session file");
			expect(manager.getTranscriptFileBytes()).toBe(fs.statSync(sessionFile).size);
		} finally {
			await manager.close();
		}
	});

	it.skipIf(process.platform === "linux")(
		"reports transcript size as unknown without retained authority",
		async () => {
			const root = makeTempDir();
			const cwd = path.join(root, "workspace");
			const agentDir = path.join(root, "agent");
			fs.mkdirSync(cwd, { recursive: true });
			const destination = SessionManager.managedDestination(cwd, agentDir);
			if (destination.kind !== "managed") throw new Error("Expected managed destination");

			const manager = SessionManager.create(cwd, destination);
			try {
				manager.appendMessage({ role: "user", content: "hello world", timestamp: 1 });
				await manager.ensureOnDisk();
				expect(manager.getTranscriptFileBytes()).toBeUndefined();
			} finally {
				await manager.close();
			}
		},
	);

	it("does not sample explicit transcripts", async () => {
		const root = makeTempDir();
		const cwd = path.join(root, "workspace");
		const sessionDir = path.join(root, "explicit-sessions");
		fs.mkdirSync(cwd, { recursive: true });
		const manager = SessionManager.create(cwd, SessionManager.explicitDestination(sessionDir));
		try {
			manager.appendMessage({ role: "user", content: "plain", timestamp: 1 });
			await manager.ensureOnDisk();
			expect(manager.getTranscriptFileBytes()).toBeUndefined();
		} finally {
			await manager.close();
		}
	});

	it("reports managed stat failures once per failure streak", async () => {
		const root = makeTempDir();
		const cwd = path.join(root, "workspace");
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		const destination = SessionManager.managedDestination(cwd, agentDir);
		if (destination.kind !== "managed") throw new Error("Expected managed destination");

		const manager = SessionManager.create(cwd, destination);
		try {
			manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
			await manager.ensureOnDisk();
			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
			const sizeSpy = vi.spyOn(ManagedSessionDescendantStore.prototype, "sizeSync").mockImplementation(() => {
				throw new Error("stat_failed");
			});
			expect(manager.getTranscriptFileBytes()).toBeUndefined();
			expect(manager.getTranscriptFileBytes()).toBeUndefined();
			expect(sizeSpy).toHaveBeenCalledTimes(2);
			expect(warnSpy).toHaveBeenCalledTimes(1);

			sizeSpy.mockReturnValueOnce(123);
			expect(manager.getTranscriptFileBytes()).toBe(123);
			expect(manager.getTranscriptFileBytes()).toBeUndefined();
			expect(warnSpy).toHaveBeenCalledTimes(2);
		} finally {
			await manager.close();
		}
	});

	it("latches a failed capacity rewrite before later appends", async () => {
		const root = makeTempDir();
		const cwd = path.join(root, "workspace");
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		const destination = SessionManager.managedDestination(cwd, agentDir);
		if (destination.kind !== "managed") throw new Error("Expected managed destination");

		const manager = SessionManager.create(cwd, destination);
		try {
			manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
			await manager.ensureOnDisk();
			const entriesBeforeFailure = manager.getEntries();
			const appendSpy = vi.spyOn(ManagedSessionDescendantStore.prototype, "appendSync").mockImplementation(() => {
				throw new Error("content_too_large");
			});
			const replaceSpy = vi.spyOn(ManagedSessionDescendantStore.prototype, "replaceSync").mockImplementation(() => {
				throw new Error("rewrite_failed");
			});

			expect(() => manager.appendMessage({ role: "user", content: "overflow", timestamp: 2 })).toThrow(
				"rewrite_failed",
			);
			expect(manager.getEntries()).toEqual(entriesBeforeFailure);
			expect(() => manager.appendMessage({ role: "user", content: "follow-up", timestamp: 3 })).toThrow(
				"rewrite_failed",
			);
			expect(manager.getEntries()).toEqual(entriesBeforeFailure);
			expect(appendSpy).toHaveBeenCalledTimes(1);
			expect(replaceSpy).toHaveBeenCalledTimes(1);
		} finally {
			try {
				await manager.close();
			} catch {}
		}
	});

	it("does not recover unrelated append errors", async () => {
		const root = makeTempDir();
		const cwd = path.join(root, "workspace");
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		const destination = SessionManager.managedDestination(cwd, agentDir);
		if (destination.kind !== "managed") throw new Error("Expected managed destination");

		const manager = SessionManager.create(cwd, destination);
		try {
			manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
			await manager.ensureOnDisk();
			vi.spyOn(ManagedSessionDescendantStore.prototype, "appendSync").mockImplementation(() => {
				throw new Error("some_other_error");
			});
			expect(() => manager.appendMessage({ role: "user", content: "fail", timestamp: 2 })).toThrow();
		} finally {
			try {
				await manager.close();
			} catch {}
		}
	});
});
