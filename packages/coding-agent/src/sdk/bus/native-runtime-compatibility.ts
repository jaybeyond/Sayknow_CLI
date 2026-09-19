import { fileURLToPath } from "node:url";

const REQUIRED_WORKFLOW_ARBITRATION_METHODS = ["registerArbitratedAsk", "retireIfUnclaimed", "stopAndWait"] as const;

export class NativeRuntimeCompatibilityError extends Error {
	readonly code = "native_runtime_incompatible";
	readonly retryable = false;

	constructor(
		readonly runtimeVersion: string,
		readonly nativeVersion: string,
		readonly workflowArbitrationAvailable: boolean,
		readonly nativeModulePath: string | null = null,
	) {
		const loadedFrom = nativeModulePath ? ` (loaded from ${nativeModulePath})` : "";
		const causes = [
			...(runtimeVersion === nativeVersion
				? []
				: [`loaded native version is ${nativeVersion}${loadedFrom}, expected ${runtimeVersion}`]),
			...(workflowArbitrationAvailable ? [] : [`required workflow arbitration methods are missing${loadedFrom}`]),
		];
		super(
			`Incompatible @sayknow-cli/natives for @sayknow-cli/coding-agent@${runtimeVersion}: ` +
				`${causes.join("; ")}. ` +
				`Reinstall matching @sayknow-cli/coding-agent and @sayknow-cli/natives packages, ` +
				`and remove any stale nested node_modules copy of @sayknow-cli/natives that shadows it.`,
		);
		this.name = "NativeRuntimeCompatibilityError";
	}
}

function hasWorkflowArbitrationMethods(notificationServer: unknown): boolean {
	if (!notificationServer || (typeof notificationServer !== "object" && typeof notificationServer !== "function"))
		return false;
	return REQUIRED_WORKFLOW_ARBITRATION_METHODS.every(
		method => typeof (notificationServer as Record<string, unknown>)[method] === "function",
	);
}

/**
 * Where the process actually loaded `@sayknow-cli/natives` from. Diagnostic only:
 * a nested `node_modules` copy wins resolution over a workspace link, so the path
 * is the difference between "reinstall something" and a one-line fix.
 */
function resolveNativeModulePath(): string | null {
	try {
		const resolved = import.meta.resolve?.("@sayknow-cli/natives");
		if (typeof resolved !== "string") return null;
		return resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved;
	} catch {
		return null;
	}
}

export function assertNativeRuntimeCompatibility(input: {
	runtimeVersion: string;
	nativeVersion: string;
	notificationServer: unknown;
	nativeModulePath?: string | null;
}): void {
	const workflowArbitrationAvailable = hasWorkflowArbitrationMethods(input.notificationServer);
	if (input.runtimeVersion !== input.nativeVersion || !workflowArbitrationAvailable)
		throw new NativeRuntimeCompatibilityError(
			input.runtimeVersion,
			input.nativeVersion,
			workflowArbitrationAvailable,
			input.nativeModulePath ?? resolveNativeModulePath(),
		);
}
