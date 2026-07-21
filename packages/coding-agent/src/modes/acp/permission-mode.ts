import type { ClientCapabilities } from "@agentclientprotocol/sdk";

export type AcpPermissionMode = "auto" | "prompt" | "always-allow";

const ACP_PERMISSION_MODE_ENV = "SKC_ACP_PERMISSION_MODE";

function parseAcpPermissionMode(value: unknown): AcpPermissionMode {
	if (value === "auto" || value === "prompt" || value === "always-allow") return value;
	return "prompt";
}

/** Client metadata is authoritative; the process environment is only a fallback when that field is absent. */
export function resolveAcpPermissionMode(
	clientCapabilities: ClientCapabilities | undefined,
	env: NodeJS.ProcessEnv = process.env,
): AcpPermissionMode {
	const meta = clientCapabilities?._meta;
	if (typeof meta === "object" && meta !== null) {
		const skc = (meta as { skc?: unknown }).skc;
		if (typeof skc === "object" && skc !== null && "permissionHandling" in skc) {
			return parseAcpPermissionMode((skc as { permissionHandling?: unknown }).permissionHandling);
		}
	}
	return parseAcpPermissionMode(env[ACP_PERMISSION_MODE_ENV]);
}
