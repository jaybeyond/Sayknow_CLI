import { describe, expect, it, vi } from "bun:test";
import { DapClient } from "../src/dap/client";
import type { DapResolvedAdapter } from "../src/dap/types";
import { sendNotification } from "../src/lsp/client";
import type { LspClient } from "../src/lsp/types";
import type { OwnedProcess } from "../src/runtime/process-lifecycle";
import { writeStdioFrame } from "../src/runtime-mcp/transports/stdio";

const DAP_ADAPTER: DapResolvedAdapter = {
	name: "write-backpressure-test",
	command: process.execPath,
	args: [],
	resolvedCommand: process.execPath,
	languages: [],
	fileTypes: [],
	rootMarkers: [],
	launchDefaults: {},
	attachDefaults: {},
	connectMode: "stdio",
};

async function captureError(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Error) return error;
		throw error;
	}
	throw new Error("Expected promise to reject");
}

describe("protocol write backpressure", () => {
	it.each([
		["write", "EPIPE"],
		["flush", "ERR_STREAM_DESTROYED"],
	] as const)("DAP terminalizes and preserves a peer-closed sink %s (%s)", async (operation, code) => {
		const sinkError = Object.assign(new Error("DAP peer closed"), { code });
		const sink = {
			write: vi.fn(() => (operation === "write" ? Promise.reject(sinkError) : 1)),
			flush: vi.fn(() => (operation === "flush" ? Promise.reject(sinkError) : undefined)),
		};
		const child = {
			stdin: sink,
			stdout: new ReadableStream<Uint8Array>(),
			stderr: new ReadableStream<Uint8Array>(),
			exited: Promise.resolve(0),
			exitCode: null,
			killed: false,
			kill: () => true,
		};
		const owner = {
			child,
			dispose: async () => {},
			awaitExit: async () => ({ exited: true, code: 0 }),
		} as unknown as OwnedProcess;
		const client = new DapClient(DAP_ADAPTER, "/tmp", owner, {
			readable: child.stdout,
			writeSink: sink,
		});

		const firstError = await captureError(client.sendRequest("initialize", {}, undefined, 50));
		expect(firstError.message).toBe("DAP adapter write-backpressure-test transport closed");
		expect(firstError.cause).toBe(sinkError);
		const staleError = await captureError(client.sendRequest("stale", {}, undefined, 50));
		expect(staleError).toBe(firstError);
		expect(sink.write).toHaveBeenCalledTimes(1);
		expect(sink.flush).toHaveBeenCalledTimes(operation === "flush" ? 1 : 0);
	});

	it("DAP propagates a non-peer flush failure without terminalizing", async () => {
		const flushError = new Error("DAP flush failed");
		const sink = {
			write: vi.fn(() => 1),
			flush: vi.fn(() => Promise.reject(flushError)),
		};
		const child = {
			stdin: sink,
			stdout: new ReadableStream<Uint8Array>(),
			stderr: new ReadableStream<Uint8Array>(),
			exited: Promise.resolve(0),
			exitCode: null,
			killed: false,
			kill: () => true,
		};
		const client = new DapClient(DAP_ADAPTER, "/tmp", { child } as unknown as OwnedProcess, {
			readable: child.stdout,
			writeSink: sink,
		});

		expect(await captureError(client.sendRequest("first", {}, undefined, 50))).toBe(flushError);
		expect(await captureError(client.sendRequest("second", {}, undefined, 50))).toBe(flushError);
		expect(sink.write).toHaveBeenCalledTimes(2);
		expect(sink.flush).toHaveBeenCalledTimes(2);
	});

	it("DAP serializes complete write-and-flush transactions", async () => {
		const frames: string[] = [];
		const firstFlush = Promise.withResolvers<number>();
		let flushCalls = 0;
		const sink = {
			write: (frame: string) => {
				frames.push(frame);
				return frame.length;
			},
			flush: () => {
				flushCalls++;
				return flushCalls === 1 ? firstFlush.promise : undefined;
			},
		};
		const child = {
			stdin: sink,
			stdout: new ReadableStream<Uint8Array>(),
			stderr: new ReadableStream<Uint8Array>(),
			exited: Promise.resolve(0),
			exitCode: null,
			killed: false,
			kill: () => true,
		};
		const client = new DapClient(DAP_ADAPTER, "/tmp", { child } as unknown as OwnedProcess, {
			readable: child.stdout,
			writeSink: sink,
		});

		const first = client.sendRequest("first", {}, undefined, 50);
		const second = client.sendRequest("second", {}, undefined, 50);
		await Bun.sleep(0);
		expect(frames).toHaveLength(1);

		firstFlush.resolve(1);
		await Bun.sleep(0);
		expect(frames).toHaveLength(2);
		await Promise.allSettled([first, second]);

		const commands = frames.map(frame => {
			const [header, body] = frame.split("\r\n\r\n");
			expect(Buffer.byteLength(body, "utf8")).toBe(Number(header.replace("Content-Length: ", "")));
			return (JSON.parse(body) as { command: string }).command;
		});
		expect(commands).toEqual(["first", "second"]);
	});

	it("LSP rejects a notification at a failed sink write", async () => {
		const sinkError = new Error("LSP peer closed");
		const client = {
			lastActivity: 0,
			writeQueue: Promise.resolve(),
			proc: {
				stdin: {
					write: () => Promise.reject(sinkError),
					flush: () => undefined,
				},
			},
		} as unknown as LspClient;

		await expect(sendNotification(client, "workspace/didChangeConfiguration", {})).rejects.toThrow("LSP peer closed");
	});

	it("LSP rejects a notification at a failed sink flush", async () => {
		const flushError = new Error("LSP flush failed");
		const client = {
			lastActivity: 0,
			writeQueue: Promise.resolve(),
			proc: {
				stdin: {
					write: () => 1,
					flush: () => Promise.reject(flushError),
				},
			},
		} as unknown as LspClient;

		await expect(sendNotification(client, "workspace/didChangeConfiguration", {})).rejects.toThrow(
			"LSP flush failed",
		);
	});

	it("MCP rejects both failed writes and failed flushes", async () => {
		const writeError = new Error("MCP peer closed");
		await expect(
			writeStdioFrame(
				{
					write: () => Promise.reject(writeError),
					flush: () => undefined,
				} as unknown as Bun.FileSink,
				"{}\n",
			),
		).rejects.toThrow("MCP peer closed");

		const flushError = new Error("MCP flush failed");
		await expect(
			writeStdioFrame(
				{
					write: () => 1,
					flush: () => Promise.reject(flushError),
				} as unknown as Bun.FileSink,
				"{}\n",
			),
		).rejects.toThrow("MCP flush failed");
	});
});
