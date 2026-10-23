import { resetAgentDirFromEnvironment } from "@sayknow-cli/utils";

/** Exact agent-dir override env, captured before a test calls `setAgentDir`. */
export interface AgentDirEnvSnapshot {
	skc: string | undefined;
	pi: string | undefined;
}

export function captureAgentDirEnv(): AgentDirEnvSnapshot {
	return { skc: process.env.SKC_CODING_AGENT_DIR, pi: process.env.PI_CODING_AGENT_DIR };
}

function restoreEnv(name: "SKC_CODING_AGENT_DIR" | "PI_CODING_AGENT_DIR", value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

/**
 * Undo `setAgentDir`: restore the exact override env, then rebuild the resolver.
 * `setAgentDir` pins `SKC_CODING_AGENT_DIR`, so re-pinning a remembered path (or
 * skipping the restore when no override was set) leaves later tests in the same
 * process on a deleted temp dir or on the real user agent dir.
 */
export function restoreAgentDirEnv(snapshot: AgentDirEnvSnapshot): void {
	restoreEnv("SKC_CODING_AGENT_DIR", snapshot.skc);
	restoreEnv("PI_CODING_AGENT_DIR", snapshot.pi);
	resetAgentDirFromEnvironment();
}
