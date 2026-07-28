export const ACP_MCP_REQUEST_TIMEOUT_MS = 30_000;
export const ACP_MCP_LIFECYCLE_TIMEOUT_MS = ACP_MCP_REQUEST_TIMEOUT_MS + 500;
/**
 * Slice of the readiness budget reserved for the work that follows MCP startup
 * (session wiring, marker publication). The ACP MCP startup ceiling is the
 * remaining time to `semanticReadyDeadlineAt` minus this headroom, so a slow
 * MCP handshake cannot consume the whole readiness window.
 */
export const ACP_MCP_STARTUP_HEADROOM_MS = 250;

export interface SessionLifecycleMcpStdioServer {
	type?: "stdio";
	name: string;
	command: string;
	args: string[];
	env?: Record<string, string>;
}

export interface SessionLifecycleMcpRemoteServer {
	type: "http" | "sse";
	name: string;
	url: string;
	headers?: Record<string, string>;
}

export type SessionLifecycleMcpServer = SessionLifecycleMcpStdioServer | SessionLifecycleMcpRemoteServer;
