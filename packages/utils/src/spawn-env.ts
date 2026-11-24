/**
 * macOS libmalloc enables malloc stack logging for every environment variable
 * with this prefix — not only `MallocStackLogging` / `MallocStackLoggingNoCompact`
 * but also e.g. `MallocStackLoggingLite` and `MallocStackLoggingDirectory`.
 * A process started with any of them makes each forked child print
 * `MallocStackLogging: can't turn off malloc stack logging because it was not
 * enabled.` to the inherited stderr.
 */
const MACOS_MALLOC_STACK_LOGGING_ENV_PREFIX = "MallocStackLogging";

/** True for every env var name that turns on macOS malloc stack logging. */
export function isMacOSMallocStackLoggingEnvName(name: string): boolean {
	return name.startsWith(MACOS_MALLOC_STACK_LOGGING_ENV_PREFIX);
}

export function isSafeEnvName(name: string): boolean {
	return name.length > 0 && !name.includes("=") && !name.includes("\0");
}

export function isSafeEnvValue(value: string): boolean {
	return !value.includes("\0");
}

export function shouldForwardSpawnEnvName(name: string): boolean {
	return isSafeEnvName(name) && !isMacOSMallocStackLoggingEnvName(name);
}

export function filterProcessEnv(env: Record<string, string | undefined>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const key in env) {
		const value = env[key];
		if (!shouldForwardSpawnEnvName(key) || value === undefined || !isSafeEnvValue(value)) continue;
		result[key] = value;
	}
	return result;
}
