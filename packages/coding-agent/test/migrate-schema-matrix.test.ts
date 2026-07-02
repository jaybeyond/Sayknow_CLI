import { describe, expect, test } from "bun:test";
import { mapMcpEntry } from "../src/migrate/mcp-mapper";

describe("mapMcpEntry — Claude Code", () => {
	test("preserves stdio command/args/env", () => {
		const out = mapMcpEntry("claude-code", "a", { command: "bin", args: ["--x"], env: { K: "v" } });
		expect(out).toEqual({
			ok: true,
			config: { type: "stdio", command: "bin", args: ["--x"], env: { K: "v" } },
			warnings: [],
		});
	});

	test("preserves http url + headers", () => {
		const out = mapMcpEntry("claude-code", "a", { type: "http", url: "https://x", headers: { A: "b" } });
		expect(out).toEqual({ ok: true, config: { type: "http", url: "https://x", headers: { A: "b" } }, warnings: [] });
	});

	test("maps sse transport", () => {
		const out = mapMcpEntry("claude-code", "a", { type: "sse", url: "https://x" });
		expect(out.ok && out.config.type).toBe("sse");
	});

	test("fails on invalid args type", () => {
		const out = mapMcpEntry("claude-code", "a", { command: "bin", args: "nope" });
		expect(out).toMatchObject({ ok: false, status: "failed_invalid_source" });
	});

	test("fails on invalid env type", () => {
		const out = mapMcpEntry("claude-code", "a", { command: "bin", env: { K: 1 } });
		expect(out).toMatchObject({ ok: false, status: "failed_invalid_source" });
	});

	test("skips entry with neither command nor url", () => {
		const out = mapMcpEntry("claude-code", "a", { foo: "bar" });
		expect(out).toMatchObject({ ok: false, status: "skipped_unmappable" });
	});
});

describe("mapMcpEntry — Codex", () => {
	test("transforms tool_timeout_sec to timeout ms and preserves cwd", () => {
		const out = mapMcpEntry("codex", "a", { command: "bin", cwd: "/w", tool_timeout_sec: 5 });
		expect(out).toMatchObject({ ok: true, config: { type: "stdio", command: "bin", cwd: "/w", timeout: 5000 } });
	});

	test("omits secret-indirection fields with warning and never echoes value", () => {
		const out = mapMcpEntry("codex", "a", {
			command: "bin",
			env_vars: { SECRET: "super-secret-value" },
			bearer_token_env_var: "MY_TOKEN",
		});
		expect(out.ok).toBe(true);
		if (!out.ok) throw new Error("expected ok");
		const joined = out.warnings.join(" | ");
		expect(joined).toContain("env_vars");
		expect(joined).toContain("bearer_token_env_var");
		expect(joined).not.toContain("super-secret-value");
		expect(JSON.stringify(out.config)).not.toContain("super-secret-value");
	});

	test("omits startup_timeout_sec and enabled_tools with warning", () => {
		const out = mapMcpEntry("codex", "a", { command: "bin", startup_timeout_sec: 10, enabled_tools: ["x"] });
		expect(out.ok).toBe(true);
		if (!out.ok) throw new Error("expected ok");
		expect(out.warnings.join(" ")).toContain("startup_timeout_sec");
		expect(out.warnings.join(" ")).toContain("enabled_tools");
	});

	test("maps http with http_headers", () => {
		const out = mapMcpEntry("codex", "a", { url: "https://x", http_headers: { A: "b" } });
		expect(out).toMatchObject({ ok: true, config: { type: "http", url: "https://x", headers: { A: "b" } } });
	});

	test("fails on malformed-typed args", () => {
		const out = mapMcpEntry("codex", "a", { command: "bin", args: [1, 2] });
		expect(out).toMatchObject({ ok: false, status: "failed_invalid_source" });
	});
});

describe("mapMcpEntry — OpenCode", () => {
	test("type:local transforms to stdio", () => {
		const out = mapMcpEntry("opencode", "a", { type: "local", command: "bin", enabled: false });
		expect(out).toMatchObject({ ok: true, config: { type: "stdio", command: "bin", enabled: false } });
	});

	test("type:remote transforms to http", () => {
		const out = mapMcpEntry("opencode", "a", { type: "remote", url: "https://x" });
		expect(out).toMatchObject({ ok: true, config: { type: "http", url: "https://x" } });
	});

	test("type:local without command is skipped", () => {
		const out = mapMcpEntry("opencode", "a", { type: "local" });
		expect(out).toMatchObject({ ok: false, status: "skipped_unmappable" });
	});

	test("type:remote without url is skipped", () => {
		const out = mapMcpEntry("opencode", "a", { type: "remote" });
		expect(out).toMatchObject({ ok: false, status: "skipped_unmappable" });
	});

	test("non-object entry fails", () => {
		const out = mapMcpEntry("opencode", "a", "nope");
		expect(out).toMatchObject({ ok: false, status: "failed_invalid_source" });
	});

	test("type:sse with url is preserved as sse", () => {
		const out = mapMcpEntry("opencode", "a", { type: "sse", url: "https://x" });
		expect(out).toMatchObject({ ok: true, config: { type: "sse", url: "https://x" } });
	});

	test("unknown fields are omitted with a warning (not copied)", () => {
		const out = mapMcpEntry("opencode", "a", { type: "local", command: "bin", mystery: "drop-me" });
		expect(out.ok).toBe(true);
		if (!out.ok) throw new Error("expected ok");
		expect(out.warnings.join(" ")).toContain('omitted unknown field "mystery"');
		expect(JSON.stringify(out.config)).not.toContain("drop-me");
	});
});
