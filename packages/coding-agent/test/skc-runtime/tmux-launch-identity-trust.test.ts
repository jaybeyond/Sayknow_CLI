import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Args } from "@sayknow-cli/coding-agent/cli/args";
import { buildDefaultTmuxLaunchPlan } from "@sayknow-cli/coding-agent/skc-runtime/launch-tmux";
import {
	__setCreateOwnerIsolationForTests,
	createSkcTmuxSession,
	resolvedChildSkcSessionId,
} from "@sayknow-cli/coding-agent/skc-runtime/tmux-sessions";

// Fork-native port of upstream 51ad81e759 tmux-launch-identity-trust. The fork
// launch plan is a pure function, so the plan's sessionName/innerCommand are
// inspected directly instead of through the owner-isolated launcher.

const PLANTED_SESSION = "victim-tmux-493";
const PLANTED_COORDINATOR = "victim-coordinator-493";
const PLANTED_SKC_SESSION = "victim-session-493";
const OPERATOR_SESSION = "operator-tmux-493";
const OPERATOR_COORDINATOR = "operator-coordinator-493";
const OPERATOR_SKC_SESSION = "operator-session-493";

function args(): Args {
	return { messages: [], fileArgs: [], unknownFlags: new Map(), tmux: true } as Args;
}

function childSessionAssignment(inner: string): string | undefined {
	return inner.match(/SKC_SESSION_ID='([^']*)'/)?.[1];
}

function launchPins(cwd: string, env: NodeJS.ProcessEnv): { sessionName: string; inner: string; stateFile: string } {
	const plan = buildDefaultTmuxLaunchPlan({
		parsed: args(),
		rawArgs: ["--tmux"],
		cwd,
		env: { SKC_PSMUX_DETECTION: "off", SKC_TMUX_COMMAND: "tmux", ...env },
		argv: ["bun", "packages/coding-agent/src/cli.ts"],
		execPath: process.execPath,
		platform: "darwin",
		tty: { stdin: true, stdout: true },
		tmuxAvailable: true,
		existingBranchSessionName: null,
		currentBranch: "main",
	});
	if (!plan) throw new Error("expected a tmux launch plan");
	return { sessionName: plan.sessionName, inner: plan.innerCommand, stateFile: plan.sessionStateFile ?? "" };
}

async function withRepo(
	body: string | undefined,
	run: (cwd: string, victimState: string) => Promise<void> | void,
): Promise<void> {
	const root = await mkdtemp(path.join(tmpdir(), "tmux-identity-"));
	const cwd = path.join(root, "repo");
	const victimState = path.join(root, "victim", "coordinator-state.json");
	await mkdir(cwd, { recursive: true });
	if (body !== undefined) await writeFile(path.join(cwd, ".env"), body);
	try {
		await run(cwd, victimState);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("tmux launch identity provenance", () => {
	it("does not adopt project dotenv session, root, or state-file pins", async () => {
		await withRepo(undefined, async (cwd, victimState) => {
			await writeFile(
				path.join(cwd, ".env"),
				[
					`SKC_TMUX_SESSION=${PLANTED_SESSION}`,
					`SKC_COORDINATOR_SESSION_ID=${PLANTED_COORDINATOR}`,
					`SKC_SESSION_ID=${PLANTED_SKC_SESSION}`,
					`SKC_COORDINATOR_SESSION_STATE_FILE=${victimState}`,
					"",
				].join("\n"),
			);
			const launched = launchPins(cwd, {
				SKC_TMUX_SESSION: PLANTED_SESSION,
				SKC_COORDINATOR_SESSION_ID: PLANTED_COORDINATOR,
				SKC_SESSION_ID: PLANTED_SKC_SESSION,
				SKC_COORDINATOR_SESSION_STATE_FILE: victimState,
			});
			expect(launched.sessionName).not.toBe(PLANTED_SESSION);
			expect(launched.inner).not.toContain(victimState);
			expect(launched.stateFile).not.toBe(victimState);
			expect(launched.inner).not.toContain(PLANTED_SKC_SESSION);
			expect(launched.inner).not.toContain(PLANTED_COORDINATOR);
			expect(childSessionAssignment(launched.inner)).toBe(launched.sessionName);
		});
	});

	it("masks a project dotenv session id the parent environment does not carry", async () => {
		await withRepo(`SKC_SESSION_ID=${PLANTED_SKC_SESSION}\n`, async cwd => {
			const launched = launchPins(cwd, {});
			expect(launched.inner).not.toContain(PLANTED_SKC_SESSION);
			expect(childSessionAssignment(launched.inner)).toBe(launched.sessionName);
		});
	});

	it("leaves the child session id unset when the operator and the project omit it", async () => {
		await withRepo(undefined, async cwd => {
			const launched = launchPins(cwd, {});
			expect(launched.inner).not.toContain("SKC_SESSION_ID=");
		});
	});

	it("still uses operator tmux identity pins the project does not declare", async () => {
		await withRepo(undefined, async cwd => {
			const stateFile = path.join(cwd, "operator-state.json");
			const launched = launchPins(cwd, {
				SKC_TMUX_SESSION: OPERATOR_SESSION,
				SKC_COORDINATOR_SESSION_ID: OPERATOR_COORDINATOR,
				SKC_SESSION_ID: OPERATOR_SKC_SESSION,
				SKC_COORDINATOR_SESSION_STATE_FILE: stateFile,
			});
			expect(launched.sessionName).toBe(OPERATOR_SESSION);
			expect(launched.inner).toContain(OPERATOR_COORDINATOR);
			expect(launched.inner).toContain(stateFile);
			expect(childSessionAssignment(launched.inner)).toBe(OPERATOR_SKC_SESSION);
		});
	});

	it("still uses an operator session id the project does not declare for the session root", async () => {
		await withRepo(undefined, async cwd => {
			const launched = launchPins(cwd, { SKC_SESSION_ID: OPERATOR_SKC_SESSION });
			expect(launched.stateFile).toContain(`_session-${OPERATOR_SKC_SESSION}`);
			expect(childSessionAssignment(launched.inner)).toBe(OPERATOR_SKC_SESSION);
		});
	});

	it("still uses an operator pin that differs from the project dotenv value", async () => {
		await withRepo(
			[`SKC_TMUX_SESSION=${PLANTED_SESSION}`, `SKC_COORDINATOR_SESSION_ID=${PLANTED_COORDINATOR}`, ""].join("\n"),
			async cwd => {
				const launched = launchPins(cwd, {
					SKC_TMUX_SESSION: OPERATOR_SESSION,
					SKC_COORDINATOR_SESSION_ID: OPERATOR_COORDINATOR,
				});
				expect(launched.sessionName).toBe(OPERATOR_SESSION);
				expect(launched.inner).toContain(OPERATOR_COORDINATOR);
				expect(launched.inner).not.toContain(PLANTED_COORDINATOR);
			},
		);
	});
});

describe("tmux session create identity provenance", () => {
	afterEach(() => {
		__setCreateOwnerIsolationForTests(null);
	});

	function plannedCreate(cwd: string, env: NodeJS.ProcessEnv): string[] {
		let plannedArgv: string[] | undefined;
		__setCreateOwnerIsolationForTests({
			execute: plan => {
				if (!plan.ok) throw new Error("expected owner-isolation plan");
				plannedArgv = plan.execution.argv;
				return { ok: false, code: "scope_bootstrap_failed", diagnostic: "test-stop" };
			},
		});
		expect(() =>
			createSkcTmuxSession(
				{ SKC_PSMUX_DETECTION: "off", SKC_TMUX_COMMAND: "tmux", ...env },
				{ cwd, platform: "darwin" },
			),
		).toThrow("skc_tmux_owner_isolation_scope_bootstrap_failed:test-stop");
		if (!plannedArgv) throw new Error("expected a planned new-session argv");
		return plannedArgv;
	}

	it("session create ignores a project dotenv session and state-file pin", async () => {
		await withRepo(undefined, async (cwd, victimState) => {
			await writeFile(
				path.join(cwd, ".env"),
				[
					`SKC_TMUX_SESSION=${PLANTED_SESSION}`,
					`SKC_COORDINATOR_SESSION_ID=${PLANTED_COORDINATOR}`,
					`SKC_SESSION_ID=${PLANTED_SKC_SESSION}`,
					`SKC_COORDINATOR_SESSION_STATE_FILE=${victimState}`,
					"",
				].join("\n"),
			);
			const argv = plannedCreate(cwd, {
				SKC_TMUX_SESSION: PLANTED_SESSION,
				SKC_COORDINATOR_SESSION_ID: PLANTED_COORDINATOR,
				SKC_SESSION_ID: PLANTED_SKC_SESSION,
				SKC_COORDINATOR_SESSION_STATE_FILE: victimState,
			});
			const sessionName = argv[argv.indexOf("-s") + 1];
			const inner = argv.at(-1) ?? "";
			expect(sessionName).not.toBe(PLANTED_SESSION);
			expect(inner).not.toContain(victimState);
			expect(inner).not.toContain(PLANTED_COORDINATOR);
			expect(inner).not.toContain(PLANTED_SKC_SESSION);
		});
	});

	it("session create still passes an operator session id the project does not declare", async () => {
		await withRepo(undefined, async cwd => {
			const argv = plannedCreate(cwd, {
				SKC_TMUX_SESSION: OPERATOR_SESSION,
				SKC_SESSION_ID: OPERATOR_SKC_SESSION,
			});
			expect(argv[argv.indexOf("-s") + 1]).toBe(OPERATOR_SESSION);
			expect(childSessionAssignment(argv.at(-1) ?? "")).toBe(OPERATOR_SKC_SESSION);
		});
	});
});

describe("resolved child session id", () => {
	it("property: filtered child id agrees with the launch fallback, seed 493, 64 inputs", () => {
		let seed = 493;
		const next = (): number => {
			seed = (seed + 0x6d2b79f5) | 0;
			let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
			value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
			return (value ^ (value >>> 14)) >>> 0;
		};
		const alphabet = ["", " ", "operator-session-493", " victim-session-493 ", "generated-493"];
		for (let index = 0; index < 64; index += 1) {
			const trusted = alphabet[next() % alphabet.length];
			const inherited = alphabet[next() % alphabet.length];
			const fallback = alphabet[next() % alphabet.length] ?? "";
			const projectDeclared = next() % 2 === 0;
			const result = resolvedChildSkcSessionId({ trusted, inherited, projectDeclared, fallback });
			const trustedTrim = trusted?.trim() ?? "";
			if (trustedTrim) {
				expect(result).toBe(trustedTrim);
				continue;
			}
			if (!inherited?.trim() && !projectDeclared) {
				expect(result).toBeUndefined();
				continue;
			}
			expect(result).toBe(fallback.trim() || undefined);
		}
	});
});
