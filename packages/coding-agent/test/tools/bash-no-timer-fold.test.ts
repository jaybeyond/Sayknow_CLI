import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@sayknow-cli/coding-agent/async";
import { resetSettingsForTest, Settings } from "@sayknow-cli/coding-agent/config/settings";
import * as bashExecutor from "@sayknow-cli/coding-agent/exec/bash-executor";
import { disposeAllShellSessions } from "@sayknow-cli/coding-agent/exec/bash-executor";
import { ArtifactManager } from "@sayknow-cli/coding-agent/session/artifacts";
import { BashTool, type ToolSession } from "@sayknow-cli/coding-agent/tools";

// Ported from upstream gajae 86312dfd20 (#6201). With auto-background off the
// managed foreground wait had a `timeoutMs + 1_000` timer threshold, so a command
// whose timeout kill outlived that extra second left the foreground as a running
// background job instead of reporting its timeout. The slow kill is simulated
// by an executor that settles its timeout 2.6s after the 1s timeout.

function makeToolSession(tempDir: string, settings: Settings): ToolSession {
	const artifacts = new ArtifactManager(path.join(tempDir, "artifacts"));
	return {
		cwd: tempDir,
		hasUI: false,
		settings,
		getSessionId: () => "bash-no-timer-fold-test",
		getAgentId: () => "0-Test",
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getArtifactsDir: () => artifacts.dir,
		getArtifactManager: () => artifacts,
		allocateOutputArtifact: (toolType: string) => artifacts.allocatePath(toolType),
	} as unknown as ToolSession;
}

describe.skipIf(process.platform === "win32")("bash with auto-background disabled", () => {
	let tempDir: string;
	let settings: Settings;
	let manager: AsyncJobManager;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "skc-bash-no-timer-fold-"));
		resetSettingsForTest();
		settings = await Settings.init({ inMemory: true, cwd: tempDir });
		settings.set("async.enabled", true);
		settings.set("bash.autoBackground.enabled", false);
		manager = new AsyncJobManager({ retentionMs: 20, onJobComplete: async () => {} });
		AsyncJobManager.setInstance(manager);
		await disposeAllShellSessions();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await manager.dispose({ timeoutMs: 1_000 });
		AsyncJobManager.resetForTests();
		await disposeAllShellSessions();
		resetSettingsForTest();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("reports the timeout of a slow-to-die command instead of timer-folding it", async () => {
		vi.spyOn(bashExecutor, "executeBash").mockImplementation(async () => {
			await Bun.sleep(2_600);
			throw new Error("Command timed out after 1 seconds");
		});
		const tool = new BashTool(makeToolSession(tempDir, settings));
		const startedAt = Date.now();
		let outcome: unknown;
		try {
			outcome = await tool.execute("call-no-timer-fold", { command: "sleep 30", timeout: 1 });
		} catch (error) {
			outcome = error;
		}
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2_500);
		expect(outcome).toBeInstanceOf(Error);
		expect((outcome as Error).message).toContain("Command timed out after 1 seconds");
	}, 15_000);
});
