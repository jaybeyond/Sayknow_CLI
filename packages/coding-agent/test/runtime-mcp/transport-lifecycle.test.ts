import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { logger } from "@sayknow-cli/utils";
import { disposeAllOwnedProcesses, liveOwnedProcessCount } from "../../src/runtime/process-lifecycle";
import { HttpTransport } from "../../src/runtime-mcp/transports/http";
import { StdioTransport } from "../../src/runtime-mcp/transports/stdio";

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("waitFor timed out");
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

const servers: Bun.Server<unknown>[] = [];

afterEach(async () => {
	try {
		await Promise.all(servers.splice(0).map(server => server.stop(true)));
	} finally {
		await disposeAllOwnedProcesses();
	}
});

describe("MCP stdio transport lifecycle", () => {
	test("close and reconnect dispose the old owned child tree", async () => {
		const before = liveOwnedProcessCount();
		const pidFile = `/tmp/skc-mcp-stdio-${Date.now()}-${Math.random().toString(36).slice(2)}.pid`;
		const command = [
			"node",
			"-e",
			`const fs=require('fs'); const cp=require('child_process'); const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:false,stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); setInterval(()=>{},1000);`,
		];
		const transport = new StdioTransport({ command: command[0], args: command.slice(1), timeout: 500 });
		await transport.connect();
		await waitFor(() => Bun.file(pidFile).exists());
		const oldChildPid = Number(await Bun.file(pidFile).text());
		expect(isAlive(oldChildPid)).toBe(true);

		await transport.close();
		await waitFor(() => !isAlive(oldChildPid));
		expect(liveOwnedProcessCount()).toBeLessThanOrEqual(before);

		await Bun.write(pidFile, "");
		await transport.connect();
		await waitFor(async () => {
			const text = await Bun.file(pidFile)
				.text()
				.catch(() => "");
			return Number(text) > 0;
		});
		const newChildPid = Number(await Bun.file(pidFile).text());
		expect(newChildPid).not.toBe(oldChildPid);
		expect(isAlive(oldChildPid)).toBe(false);
		await transport.close();
		await waitFor(() => !isAlive(newChildPid));
	});

	test.each([
		"notify",
		"request",
	] as const)("peer-closed %s terminalizes the transport and reports the write failure once", async operation => {
		const command = [
			"node",
			"-e",
			`const fs=require('fs'); fs.closeSync(0); process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'ready'})+'\\n'); setInterval(()=>{},1000);`,
		];
		const transport = new StdioTransport({ command: command[0], args: command.slice(1), timeout: 500 });
		const ready = Promise.withResolvers<void>();
		const onError = vi.fn();
		const onClose = vi.fn();
		transport.onNotification = method => {
			if (method === "ready") ready.resolve();
		};
		transport.onError = onError;
		transport.onClose = onClose;
		await transport.connect();
		await Promise.race([
			ready.promise,
			Bun.sleep(1_000).then(() => {
				throw new Error("ready notification timed out");
			}),
		]);

		const params = { payload: "x".repeat(1024 * 1024) };
		const writes = [1, 2].map(sequence =>
			operation === "notify"
				? transport.notify("test/after-close", { ...params, sequence })
				: transport.request("test/after-close", { ...params, sequence }),
		);
		const outcomes = await Promise.allSettled(writes);
		expect(outcomes.every(outcome => outcome.status === "rejected")).toBe(true);
		await waitFor(() => onClose.mock.calls.length === 1);
		expect(transport.connected).toBe(false);
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onClose).toHaveBeenCalledTimes(1);
		await expect(transport.notify("test/stale", {})).rejects.toThrow();
		await expect(transport.request("test/stale", {})).rejects.toThrow();
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	test("server response write failure reports and closes once", async () => {
		const command = [
			"node",
			"-e",
			`const fs=require('fs'); fs.closeSync(0); process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'server/test',params:{}})+'\\n'); setInterval(()=>{},1000);`,
		];
		const transport = new StdioTransport({ command: command[0], args: command.slice(1), timeout: 500 });
		const onRequest = vi.fn(async () => ({ ok: true }));
		const onError = vi.fn();
		const onClose = vi.fn();
		transport.onRequest = onRequest;
		transport.onError = onError;
		transport.onClose = onClose;
		await transport.connect();

		await waitFor(() => onError.mock.calls.length === 1);
		await waitFor(() => onClose.mock.calls.length === 1);
		expect(transport.connected).toBe(false);
		expect(onRequest).toHaveBeenCalledTimes(1);
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	test("deferred server responses cannot write to or close a reconnected epoch", async () => {
		const marker = `/tmp/skc-mcp-stdio-epoch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const command = [
			"node",
			"-e",
			`const fs=require('fs'); const marker=${JSON.stringify(marker)}; if (!fs.existsSync(marker)) { fs.writeFileSync(marker,'1'); process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'server/deferred',params:{}})+'\\n'); } else { process.stdin.on('data',()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'unexpected-write'})+'\\n')); process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'ready'})+'\\n'); } setInterval(()=>{},1000);`,
		];
		const transport = new StdioTransport({ command: command[0], args: command.slice(1), timeout: 500 });
		const handlerGate = Promise.withResolvers<void>();
		const handlerReturned = Promise.withResolvers<void>();
		const ready = Promise.withResolvers<void>();
		let unexpectedWrite = false;
		const onRequest = vi.fn(async () => {
			await handlerGate.promise;
			handlerReturned.resolve();
			return { ok: true };
		});
		const onError = vi.fn();
		const onClose = vi.fn();
		transport.onRequest = onRequest;
		transport.onNotification = method => {
			if (method === "ready") ready.resolve();
			if (method === "unexpected-write") unexpectedWrite = true;
		};
		transport.onError = onError;
		transport.onClose = onClose;

		try {
			await transport.connect();
			await waitFor(() => onRequest.mock.calls.length === 1);
			await transport.close();
			expect(onClose).toHaveBeenCalledTimes(1);

			await transport.connect();
			await Promise.race([
				ready.promise,
				Bun.sleep(1_000).then(() => {
					throw new Error("reconnected server ready notification timed out");
				}),
			]);

			handlerGate.resolve();
			await handlerReturned.promise;
			await Bun.sleep(50);
			expect(transport.connected).toBe(true);
			expect(unexpectedWrite).toBe(false);
			expect(onRequest).toHaveBeenCalledTimes(1);
			expect(onError).not.toHaveBeenCalled();
			expect(onClose).toHaveBeenCalledTimes(1);
		} finally {
			await transport.close();
			await fs.rm(marker, { force: true });
		}
	});
});

describe("MCP HTTP transport lifecycle", () => {
	test("request timeout covers hanging response bodies after headers", async () => {
		const server = Bun.serve({
			port: 0,
			idleTimeout: 255,
			fetch() {
				return new Response(new ReadableStream({ start() {} }), {
					headers: { "Content-Type": "application/json" },
				});
			},
		});
		servers.push(server);
		const transport = new HttpTransport({ type: "http", url: server.url.href, timeout: 100 });
		await transport.connect();
		await expect(transport.request("tools/list")).rejects.toThrow("Request timeout after 100ms");
		await transport.close();
	});

	test("per-request SSE closes after matching response", async () => {
		let nextId: string | number = "1";
		const server = Bun.serve({
			port: 0,
			idleTimeout: 255,
			async fetch(req) {
				const request = (await req.json()) as { id?: string | number };
				nextId = request.id ?? nextId;
				const stream = new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								`data: {"jsonrpc":"2.0","id":${JSON.stringify(nextId)},"result":{"ok":true}}\n\n`,
							),
						);
						controller.close();
					},
				});
				return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
			},
		});
		servers.push(server);
		const transport = new HttpTransport({ type: "http", url: server.url.href, timeout: 1_000 });
		await transport.connect();
		await expect(transport.request("tools/list")).resolves.toEqual({ ok: true });

		await transport.close();
	});

	test("failed GET SSE listener cancels the response body", async () => {
		const server = Bun.serve({
			port: 0,
			idleTimeout: 255,
			fetch() {
				const stream = new ReadableStream({
					start(controller) {
						controller.close();
					},
				});
				return new Response(stream, { status: 500 });
			},
		});
		servers.push(server);
		const transport = new HttpTransport({ type: "http", url: server.url.href, timeout: 1_000 });
		await transport.connect();
		await transport.startSSEListener();

		await transport.close();
	});
	test("redacts background SSE parser diagnostics without changing error or close handling", async () => {
		const credential = "sse-query-credential";
		const rawSseMarker = "MALICIOUS_SSE_PAYLOAD_MARKER";
		const server = Bun.serve({
			port: 0,
			idleTimeout: 255,
			fetch() {
				const stream = new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(`data: ${rawSseMarker}\n\n`));
						controller.close();
					},
				});
				return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
			},
		});
		servers.push(server);
		const url = `${server.url.href}?access_token=${credential}`;
		const transport = new HttpTransport({ type: "http", url, timeout: 1_000 });
		const errors: Error[] = [];
		let closeCount = 0;
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});
		const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
		let closed = false;

		try {
			transport.onError = error => errors.push(error);
			transport.onClose = () => {
				closeCount += 1;
			};

			await transport.connect();
			await transport.startSSEListener();
			await waitFor(() => errors.length === 1 && closeCount === 1);

			expect(errors[0]).toBeInstanceOf(SyntaxError);
			expect(debugSpy).toHaveBeenCalledTimes(1);
			expect(debugSpy).toHaveBeenCalledWith("HTTP SSE stream error");
			expect(infoSpy).not.toHaveBeenCalled();
			expect(warnSpy).not.toHaveBeenCalled();
			expect(errorSpy).not.toHaveBeenCalled();

			await transport.close();
			closed = true;
			expect(closeCount).toBe(2);
		} finally {
			try {
				if (!closed) await transport.close();
			} finally {
				vi.restoreAllMocks();
			}
		}
	});
});
