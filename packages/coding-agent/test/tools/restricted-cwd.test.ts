import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getShellConfig } from "@sayknow-cli/utils/shell-config";
import { disposeAllShellSessions } from "../../src/exec/bash-executor";
import type { ToolSession } from "../../src/tools";
import { BashTool } from "../../src/tools/bash";
import { assertCwdInsideWorkspace } from "../../src/tools/restricted-cwd";

afterEach(async () => {
	await disposeAllShellSessions();
});

describe("assertCwdInsideWorkspace", () => {
	it("allows the workspace and rejects a directory outside it", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "restricted-cwd-"));
		const workspace = path.join(root, "repo");
		const outside = path.join(root, "outside");
		await mkdir(workspace);
		await mkdir(outside);
		await expect(assertCwdInsideWorkspace(workspace, workspace)).resolves.toBeUndefined();
		await expect(assertCwdInsideWorkspace(workspace, outside)).rejects.toThrow(/inside the workspace/);
		await symlink(outside, path.join(workspace, "link"));
		await expect(assertCwdInsideWorkspace(workspace, path.join(workspace, "link"))).rejects.toThrow(
			/inside the workspace/,
		);
	});
});

function createRestrictedBashTool(cwd: string, restriction: { profile?: "read-only"; prefixes: string[] }): BashTool {
	const session = {
		cwd,
		getSessionFile: () => null,
		getSessionId: () => "restricted-cwd-test",
		bashAllowedPrefixes: restriction.prefixes,
		...(restriction.profile ? { bashRestrictionProfile: restriction.profile } : {}),
		settings: {
			has(key: string) {
				return this.get(key) !== undefined;
			},
			get(key: string) {
				if (key === "bashInterceptor.enabled") return false;
				if (key === "async.enabled") return false;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				if (key === "bash.stripTrailingHeadTail") return false;
				return undefined;
			},
			getBashInterceptorRules() {
				return [];
			},
			getShellConfig: () => getShellConfig(),
		},
	} as unknown as ToolSession;
	return new BashTool(session);
}

// Port of upstream 3ad318acde (#6396): a restricted (read-only or role-agent
// prefix-allowlisted) bash may not move its working directory out of the workspace.
describe.skipIf(process.platform === "win32")("restricted bash cwd", () => {
	for (const restriction of [{ profile: "read-only" as const, prefixes: ["pwd"] }, { prefixes: ["pwd"] }]) {
		const label = restriction.profile ?? "role-agent prefixes";
		it(`refuses a cwd outside the workspace under ${label}`, async () => {
			const root = await mkdtemp(path.join(tmpdir(), "restricted-cwd-tool-"));
			try {
				const workspace = path.join(root, "repo");
				const outside = path.join(root, "outside");
				await mkdir(workspace);
				await mkdir(outside);
				await symlink(outside, path.join(workspace, "link"));
				const tool = createRestrictedBashTool(workspace, restriction);
				await expect(tool.execute("call-outside", { command: "pwd", cwd: outside })).rejects.toThrow(
					/inside the workspace/,
				);
				await expect(tool.execute("call-link", { command: "pwd", cwd: "link" })).rejects.toThrow(
					/inside the workspace/,
				);
				const inside = await tool.execute("call-inside", { command: "pwd" });
				expect(inside.content.find(part => part.type === "text")?.text).toContain("repo");
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});
	}
});
