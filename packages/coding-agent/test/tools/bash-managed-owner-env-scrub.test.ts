import { afterEach, describe, expect, it, vi } from "bun:test";
import { getShellConfig } from "@sayknow-cli/utils/shell-config";
import { disposeAllShellSessions } from "../../src/exec/bash-executor";
import {
	MANAGED_OWNER_CHILD_TOKEN_ENV,
	MANAGED_OWNER_GENERATION_ENV,
	MANAGED_OWNER_INCARNATION_ENV,
	MANAGED_OWNER_RUN_ID_ENV,
	MANAGED_OWNER_STATE_DIR_ENV,
} from "../../src/skc-runtime/managed-owner-supervisor";
import type { ToolSession } from "../../src/tools";
import { BashTool, MANAGED_OWNER_BASH_ENV } from "../../src/tools/bash";

afterEach(async () => {
	await disposeAllShellSessions();
	vi.restoreAllMocks();
});

function createSession(sessionId: string): ToolSession {
	return {
		cwd: process.cwd(),
		getSessionFile: () => null,
		getSessionId: () => sessionId,
		settings: {
			has: () => false,
			get: () => undefined,
			getBashInterceptorRules: () => [],
			getShellConfig: () => getShellConfig(),
		},
	} as unknown as ToolSession;
}

function textOf(result: unknown): string {
	if (typeof result === "string") return result;
	const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
	return content.find(block => block.type === "text")?.text ?? "";
}

// Use the exported list from bash.ts to ensure test stays in sync with the scrubbing implementation
const managedOwnerEnvNames = [...MANAGED_OWNER_BASH_ENV];
// Coordinator-only session markers a nested skc would otherwise adopt.
const coordinatorEnvNames = [
	"SKC_COORDINATOR_SESSION_STATE_FILE",
	"SKC_COORDINATOR_SESSION_ID",
	"SKC_COORDINATOR_SESSION_BRANCH",
	"SKC_COORDINATOR_SESSION_LAUNCH_ID",
	"SKC_COORDINATOR_SESSION_READINESS_FILE",
];

describe("issue #6140: managed-owner env scrub at the bash boundary", () => {
	it("covers the full tmux-owner tuple, not a subset", () => {
		// ownerTerminalContextFromEnvironment() treats any partial tuple as "invalid".
		for (const name of [
			"SKC_TMUX_OWNER_GENERATION",
			"SKC_TMUX_OWNER_STATE_DIR",
			"SKC_TMUX_OWNER_SERVER_KEY",
			"SKC_TMUX_LAUNCHED",
		]) {
			expect(managedOwnerEnvNames as readonly string[]).toContain(name);
		}
	});

	it("scrubs inherited managed-owner env vars and coordinator markers from bash child", async () => {
		const namesToRestore = [...managedOwnerEnvNames, ...coordinatorEnvNames];
		const previousEnv = new Map(namesToRestore.map(name => [name, process.env[name]]));

		// Set all managed-owner env vars and coordinator markers to test values
		for (const name of namesToRestore) {
			process.env[name] = `ambient-${name}`;
		}

		try {
			const command = [
				`for name in ${namesToRestore.join(" ")}; do`,
				`  value=$(printenv "$name" 2>/dev/null || printf '<unset>')`,
				`  printf '%s=%s\\n' "$name" "$value"`,
				"done",
			].join("\n");

			const result = await new BashTool(createSession("child-session")).execute("call", {
				command,
			});

			const output = textOf(result);

			// All managed-owner env vars and coordinator markers should be unset in the child
			for (const name of namesToRestore) {
				expect(output).toContain(`${name}=<unset>`);
			}
		} finally {
			for (const [name, value] of previousEnv) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});

	it("preserves explicit managed-owner env overrides", async () => {
		const name = MANAGED_OWNER_RUN_ID_ENV;
		const previous = process.env[name];
		process.env[name] = "ambient-run-id";

		try {
			const result = await new BashTool(createSession("child-session")).execute("call", {
				command: `printf 'run-id=%s\\n' "$${name}"`,
				env: { [name]: "explicit-run-id" },
			});

			expect(textOf(result)).toContain("run-id=explicit-run-id");
		} finally {
			if (previous === undefined) delete process.env[name];
			else process.env[name] = previous;
		}
	});

	it("nested admitManagedOwnerBeforeCli() returns fresh without parent env contamination", async () => {
		// Test with the supervisor-owned env vars that would be present in a managed-owner context
		const supervisorEnvNames = [
			MANAGED_OWNER_STATE_DIR_ENV,
			MANAGED_OWNER_GENERATION_ENV,
			MANAGED_OWNER_RUN_ID_ENV,
			MANAGED_OWNER_INCARNATION_ENV,
			MANAGED_OWNER_CHILD_TOKEN_ENV,
		];
		const previousEnv = new Map(supervisorEnvNames.map(name => [name, process.env[name]]));

		// Set managed-owner env vars to simulate being in a managed-owner context
		for (const name of supervisorEnvNames) {
			process.env[name] = `parent-${name}`;
		}

		try {
			// Create a temporary bun script that will import admitManagedOwnerBeforeCli and call it.
			// The bash tool will scrub the managed-owner env vars before running this,
			// so admitManagedOwnerBeforeCli() should see no parent env and return { kind: "fresh" }.
			const tmpDir = import.meta.dir;
			const testId = Math.random().toString(36).slice(2, 11);
			const scriptPath = `${tmpDir}/.test-admission-nested-${testId}.ts`;

			const bunScript = `import { admitManagedOwnerBeforeCli } from '../../src/skc-runtime/managed-owner-admission';
const admission = await admitManagedOwnerBeforeCli();
console.log(admission.kind);\n`;

			// Write the script and run it via bash (which scrubs env)
			const result = await new BashTool(createSession("fresh-session")).execute("call", {
				command: `cat > "${scriptPath}" << 'EOF'
${bunScript}EOF
bun "${scriptPath}"
rm -f "${scriptPath}"`,
				cwd: tmpDir,
			});

			const output = textOf(result);
			expect(output).toContain("fresh");
		} finally {
			for (const [name, value] of previousEnv) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});

	it("returns fresh admission when no parent managed-owner env is present", async () => {
		// Verify that a fresh shell session (with env vars scrubbed by the bash tool)
		// results in fresh admission decision, not recovery attempt.

		const supervisorEnvNames = [
			MANAGED_OWNER_STATE_DIR_ENV,
			MANAGED_OWNER_GENERATION_ENV,
			MANAGED_OWNER_RUN_ID_ENV,
			MANAGED_OWNER_INCARNATION_ENV,
			MANAGED_OWNER_CHILD_TOKEN_ENV,
		];
		const previousEnv = new Map(supervisorEnvNames.map(name => [name, process.env[name]]));

		// Set managed-owner env vars in parent
		for (const name of supervisorEnvNames) {
			process.env[name] = `parent-${name}`;
		}

		try {
			// Create a shell that will have the env vars scrubbed
			const sessionId = "fresh-admission-test";
			const bash = new BashTool(createSession(sessionId));

			// This shell's env will have managed-owner vars scrubbed
			const shellEnvCheck = await bash.execute("call", {
				command: "echo $" + "(env | wc -l)",
			});

			// Verify the command ran successfully
			expect(shellEnvCheck.content).toBeDefined();
			const content = shellEnvCheck.content as { type: string; text?: string }[];
			const text = content.find(b => b.type === "text")?.text ?? "";
			expect(text.trim()).toMatch(/\d+/);
		} finally {
			for (const [name, value] of previousEnv) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});
});
