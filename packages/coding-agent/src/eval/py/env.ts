/** Environment values consulted by the Python subprocess integration. */
export type PythonEnv = Record<string, string | undefined>;

const PYTHON_TRUTHY = new Set(["1", "true", "yes", "on", "y"]);

/** True when `value` is a non-empty string matching a truthy boolean token. */
export function isTruthyPythonFlag(value: string | undefined): boolean {
	return value !== undefined && PYTHON_TRUTHY.has(value.trim().toLowerCase());
}

/** Resolve paired SKC/legacy PI flags using OR semantics. */
export function resolvePythonFlag(env: PythonEnv, skcName: string, piName: string): boolean {
	return isTruthyPythonFlag(env[skcName]) || isTruthyPythonFlag(env[piName]);
}

export function resolvePythonSkipCheck(env: PythonEnv): boolean {
	return resolvePythonFlag(env, "SKC_PYTHON_SKIP_CHECK", "PI_PYTHON_SKIP_CHECK");
}

export function resolvePythonIpcTrace(env: PythonEnv): boolean {
	return resolvePythonFlag(env, "SKC_PYTHON_IPC_TRACE", "PI_PYTHON_IPC_TRACE");
}

export function resolvePythonIntegrationGate(env: PythonEnv): boolean {
	return resolvePythonFlag(env, "SKC_PYTHON_INTEGRATION", "PI_PYTHON_INTEGRATION");
}
