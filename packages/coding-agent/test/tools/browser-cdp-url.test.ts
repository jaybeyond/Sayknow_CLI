import { describe, expect, it } from "bun:test";
import type { ToolSession } from "../../src/sdk";
import { resolveBrowserKindForTest } from "../../src/tools/browser";
import { assertLoopbackCdpUrl } from "../../src/tools/browser/cdp-url";
import { ToolError } from "../../src/tools/tool-errors";

describe("assertLoopbackCdpUrl", () => {
	it("allows loopback CDP URLs and rejects other hosts", () => {
		expect(assertLoopbackCdpUrl("http://127.0.0.1:9222")).toBe("http://127.0.0.1:9222");
		expect(assertLoopbackCdpUrl("http://localhost:9222/")).toBe("http://localhost:9222/");
		expect(assertLoopbackCdpUrl("http://[::1]:9222")).toBe("http://[::1]:9222");
		expect(() => assertLoopbackCdpUrl("http://169.254.169.254/latest/meta-data")).toThrow(/non-loopback/);
		expect(() => assertLoopbackCdpUrl("http://10.255.255.1:9222")).toThrow(/non-loopback/);
		expect(() => assertLoopbackCdpUrl("file:///tmp/browser")).toThrow(/non-loopback/);
	});
});

describe("browser app.cdp_url", () => {
	const session = { cwd: process.cwd() } as unknown as ToolSession;

	it("refuses a non-loopback endpoint before connecting", () => {
		expect(() =>
			resolveBrowserKindForTest({ action: "open", app: { cdp_url: "http://169.254.169.254:9222/" } }, session),
		).toThrow(ToolError);
	});

	it("still connects to a loopback endpoint", () => {
		expect(
			resolveBrowserKindForTest({ action: "open", app: { cdp_url: "http://127.0.0.1:9222/" } }, session),
		).toEqual({
			kind: "connected",
			cdpUrl: "http://127.0.0.1:9222",
		});
	});
});
