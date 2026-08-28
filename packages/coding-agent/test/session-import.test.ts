import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { canContinuePersistedHistory } from "@sayknow-cli/agent-core";
import { SessionManager } from "../src/session/session-manager";
import { parseClaudeCodeTranscript, parseClaudeExport } from "../src/session-import/claude";
import { parseCodexRollout } from "../src/session-import/codex";
import { parseImportSessionArgs, runSessionImportCommand } from "../src/session-import/command";
import { detectSessionImportFormat } from "../src/session-import/detect";
import { redactImportedText } from "../src/session-import/redact";
import {
	formatSessionImportError,
	formatSessionImportSummary,
	importExternalSession,
	materializeSessionImport,
	prepareSessionImport,
	SESSION_IMPORT_COMPLETION_CUSTOM_TYPE,
	SESSION_IMPORT_CONTEXT_CUSTOM_TYPE,
	SESSION_IMPORT_PROVENANCE_CUSTOM_TYPE,
	SESSION_IMPORT_QUARANTINE_CUSTOM_TYPE,
	SESSION_IMPORT_SOURCE_MAX_BYTES,
} from "../src/session-import/service";
import { SessionImportError, type SessionImportProvenance } from "../src/session-import/types";
import { ACP_BUILTIN_SLASH_COMMANDS, executeAcpBuiltinSlashCommand } from "../src/slash-commands/acp-builtins";
import {
	handleImportSessionCommand,
	handleImportSessionTuiCommand,
	lookupBuiltinSlashCommand,
} from "../src/slash-commands/builtin-registry";
import { parseSlashCommand } from "../src/slash-commands/helpers/parse";

const CODEX_ID = "019cabcd-1111-7222-8333-444455556666";
const CLAUDE_ID = "c4d4e5f6-1111-4222-8333-444455556666";

const CODEX_ROLLOUT = [
	{
		timestamp: "2026-07-30T10:00:00.000Z",
		type: "session_meta",
		payload: { id: CODEX_ID, cwd: "/work/project", title: "Fix login redirect" },
	},
	{
		timestamp: "2026-07-30T10:01:00.000Z",
		type: "response_item",
		payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the redirect." }] },
	},
	{
		timestamp: "2026-07-30T10:01:30.000Z",
		type: "response_item",
		payload: {
			type: "message",
			role: "assistant",
			content: [{ type: "output_text", text: "The callback drops the query." }],
		},
	},
	{
		timestamp: "2026-07-30T10:01:40.000Z",
		type: "response_item",
		payload: {
			type: "function_call",
			name: "exec_command",
			arguments: '{"command":["cat","src/auth.ts"]}',
			call_id: "c1",
		},
	},
	{
		timestamp: "2026-07-30T10:01:41.000Z",
		type: "response_item",
		payload: { type: "function_call_output", call_id: "c1", output: "export function callback() {}" },
	},
	{
		timestamp: "2026-07-30T10:02:00.000Z",
		type: "response_item",
		payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Preserved the query." }] },
	},
	{ timestamp: "2026-07-30T10:03:00.000Z", type: "future_record", payload: { secret: "not persisted" } },
]
	.map(record => JSON.stringify(record))
	.join("\n");

const CLAUDE_CODE = [
	{ type: "summary", summary: "Fix login redirect", leafUuid: "leaf" },
	{
		parentUuid: null,
		isSidechain: false,
		cwd: "/work/project",
		sessionId: CLAUDE_ID,
		type: "user",
		message: { role: "user", content: "Fix the redirect." },
		uuid: "u1",
		timestamp: "2026-07-30T10:01:00.000Z",
	},
	{
		parentUuid: "u1",
		isSidechain: false,
		cwd: "/work/project",
		sessionId: CLAUDE_ID,
		type: "assistant",
		message: {
			role: "assistant",
			model: "claude-sonnet-4.6",
			content: [
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "text", text: "The callback drops the query." },
				{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/work/project/src/auth.ts" } },
			],
		},
		uuid: "a1",
		timestamp: "2026-07-30T10:01:30.000Z",
	},
	{
		parentUuid: "a1",
		isSidechain: false,
		sessionId: CLAUDE_ID,
		type: "user",
		message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "callback source" }] },
		uuid: "u2",
		timestamp: "2026-07-30T10:01:31.000Z",
	},
	{ type: "unknown_future_record", data: {} },
]
	.map(record => JSON.stringify(record))
	.join("\n");

const CLAUDE_EXPORT = JSON.stringify([
	{
		uuid: CLAUDE_ID,
		name: "Fix login redirect",
		created_at: "2026-07-30T10:00:00.000Z",
		chat_messages: [
			{
				uuid: "m1",
				sender: "human",
				created_at: "2026-07-30T10:01:00.000Z",
				content: [{ type: "text", text: "Fix the redirect." }],
			},
			{
				uuid: "m2",
				sender: "assistant",
				created_at: "2026-07-30T10:02:00.000Z",
				content: [{ type: "text", text: "Preserved the query." }],
			},
		],
	},
]);

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skc-session-import-"));
	tempDirs.push(dir);
	return dir;
}
function sourceFile(dir: string, name: string, content: string | Buffer): string {
	const target = path.join(dir, name);
	fs.writeFileSync(target, content);
	return target;
}
function expectImportError(error: unknown, code: SessionImportError["code"]): void {
	expect(error).toBeInstanceOf(SessionImportError);
	expect((error as SessionImportError).code).toBe(code);
}
afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("session import detection and adapters", () => {
	it("detects all supported formats and fails closed on mismatches", () => {
		expect(detectSessionImportFormat(CODEX_ROLLOUT)).toEqual({ provider: "codex", format: "codex-rollout-jsonl" });
		expect(detectSessionImportFormat(CLAUDE_CODE)).toEqual({ provider: "claude", format: "claude-code-jsonl" });
		expect(detectSessionImportFormat(CLAUDE_EXPORT)).toEqual({ provider: "claude", format: "claude-export-json" });
		expect(() => detectSessionImportFormat(CLAUDE_CODE, "codex")).toThrow(SessionImportError);
		expect(() => detectSessionImportFormat("not a transcript")).toThrow(SessionImportError);
		expect(() => detectSessionImportFormat(JSON.stringify({ type: "session", version: 5, id: "native" }))).toThrow(
			SessionImportError,
		);
	});

	it("maps Codex messages and tool evidence while quarantining unknown records", async () => {
		const dir = tempDir();
		const prepared = await prepareSessionImport({ sourcePath: sourceFile(dir, "rollout.jsonl", CODEX_ROLLOUT) });
		expect(prepared.conversation.provider).toBe("codex");
		expect(prepared.conversation.sourceSessionId).toBe(CODEX_ID);
		expect(prepared.conversation.messages).toHaveLength(2);
		expect(prepared.conversation.messages[1]?.text).toContain("Preserved the query");
		expect(prepared.conversation.messages[1]?.toolEvidence).toEqual([
			"$ exec_command cat src/auth.ts",
			"→ export function callback() {}",
		]);
		expect(prepared.counts.quarantined).toBe(1);
		expect(prepared.provenance.quarantine.present).toBe(true);
	});

	it("uses response items canonically and event messages only as a fallback", () => {
		const meta = JSON.stringify({
			type: "session_meta",
			timestamp: "2026-01-01T00:00:00Z",
			payload: { id: CODEX_ID },
		});
		const events = [
			{
				type: "event_msg",
				timestamp: "2026-01-01T00:00:01Z",
				payload: { type: "user_message", message: "same user" },
			},
			{
				type: "event_msg",
				timestamp: "2026-01-01T00:00:02Z",
				payload: { type: "agent_message", message: "same assistant" },
			},
		];
		const responses = [
			{
				type: "response_item",
				timestamp: "2026-01-01T00:00:01Z",
				payload: { type: "message", role: "user", content: [{ type: "input_text", text: "same user" }] },
			},
			{
				type: "response_item",
				timestamp: "2026-01-01T00:00:02Z",
				payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "same assistant" }] },
			},
		];
		const combined = parseCodexRollout(
			[meta, ...events.map(value => JSON.stringify(value)), ...responses.map(value => JSON.stringify(value))].join(
				"\n",
			),
		);
		expect(combined.conversation.messages.map(message => message.text)).toEqual(["same user", "same assistant"]);
		expect(combined.counts.omitted).toBe(2);
		const mixed = parseCodexRollout(
			[meta, ...events.map(value => JSON.stringify(value)), JSON.stringify(responses[1])].join("\n"),
		);
		expect(mixed.conversation.messages.map(message => message.text)).toEqual(["same user", "same assistant"]);
		expect(mixed.counts.omitted).toBe(1);
		const symmetricMixed = parseCodexRollout(
			[meta, ...events.map(value => JSON.stringify(value)), JSON.stringify(responses[0])].join("\n"),
		);
		expect(symmetricMixed.conversation.messages.map(message => message.text)).toEqual([
			"same user",
			"same assistant",
		]);
		expect(symmetricMixed.counts.omitted).toBe(1);
		const duplicateEvent = parseCodexRollout(
			[meta, JSON.stringify(events[0]), JSON.stringify(events[0]), JSON.stringify(responses[0])].join("\n"),
		);
		expect(duplicateEvent.conversation.messages.map(message => message.text)).toEqual(["same user"]);
		expect(duplicateEvent.counts.omitted).toBe(2);

		const fallback = parseCodexRollout([meta, ...events.map(value => JSON.stringify(value))].join("\n"));
		expect(fallback.conversation.messages.map(message => message.text)).toEqual(["same user", "same assistant"]);

		const fallbackWithTools = parseCodexRollout(
			[
				meta,
				JSON.stringify(events[0]),
				JSON.stringify({
					type: "response_item",
					timestamp: "2026-01-01T00:00:01.500Z",
					payload: { type: "function_call", name: "read_file", arguments: "{}" },
				}),
				JSON.stringify({
					type: "response_item",
					timestamp: "2026-01-01T00:00:01.600Z",
					payload: { type: "function_call_output", output: "file body" },
				}),
				JSON.stringify(events[1]),
			].join("\n"),
		);
		expect(fallbackWithTools.conversation.messages.map(message => message.role)).toEqual(["user", "assistant"]);
		expect(fallbackWithTools.conversation.messages[1]).toMatchObject({
			text: "same assistant",
			toolEvidence: ["$ read_file {}", "→ file body"],
		});
	});

	it("quarantines malformed records by digest without persisting raw bytes", () => {
		const rawSecret = "raw-quarantine-value";
		const parsed = parseCodexRollout(`${CODEX_ROLLOUT}\n{${rawSecret}`);
		expect(parsed.quarantine).toHaveLength(2);
		const invalid = parsed.quarantine.at(-1);
		expect(invalid).toMatchObject({ reason: "invalid_json" });
		expect(invalid?.sha256).toBe(createHash("sha256").update(`{${rawSecret}`).digest("hex"));
		expect(JSON.stringify(invalid)).not.toContain(rawSecret);
	});

	it("bounds digest-only quarantine metadata while retaining total counts", async () => {
		const dir = tempDir();
		const unknown = Array.from({ length: 600 }, (_, index) =>
			JSON.stringify({ type: `future-${index}`, payload: { raw: `not-persisted-${index}` } }),
		);
		const prepared = await prepareSessionImport({
			sourcePath: sourceFile(dir, "many-unknown.jsonl", `${CODEX_ROLLOUT}\n${unknown.join("\n")}`),
		});
		expect(prepared.counts.quarantined).toBe(601);
		expect(prepared.quarantineRecords).toHaveLength(512);
		expect(prepared.provenance.quarantine).toEqual({ present: true, truncated: true });
		expect(JSON.stringify(prepared.quarantineRecords)).not.toContain("not-persisted");
	});

	it("quarantines unsupported content blocks instead of silently dropping them", async () => {
		const codexSecret = "codex-unsupported-raw";
		const codex = parseCodexRollout(
			`${CODEX_ROLLOUT}\n${JSON.stringify({
				timestamp: "2026-07-30T10:05:00.000Z",
				type: "response_item",
				payload: {
					type: "message",
					role: "assistant",
					content: [{ type: "future_content", raw: codexSecret }],
				},
			})}`,
		);
		expect(codex.counts.quarantined).toBe(2);
		expect(JSON.stringify(codex.quarantine)).not.toContain(codexSecret);

		const dir = tempDir();
		const claudeSecret = "claude-unsupported-raw";
		const unsupportedClaudeRecord = JSON.stringify({
			parentUuid: "a1",
			isSidechain: false,
			sessionId: CLAUDE_ID,
			type: "assistant",
			message: { role: "assistant", content: [{ type: "future_content", raw: claudeSecret }] },
			uuid: "a2",
			timestamp: "2026-07-30T10:05:00.000Z",
		});
		const claude = await prepareSessionImport({
			sourcePath: sourceFile(dir, "unsupported.jsonl", `${CLAUDE_CODE}\n${unsupportedClaudeRecord}`),
		});
		expect(claude.counts.quarantined).toBe(2);
		expect(JSON.stringify(claude.quarantineRecords)).not.toContain(claudeSecret);
	});

	it("maps Claude Code and claude.ai without importing thinking", async () => {
		const dir = tempDir();
		const code = await prepareSessionImport({ sourcePath: sourceFile(dir, `${CLAUDE_ID}.jsonl`, CLAUDE_CODE) });
		expect(code.conversation.provider).toBe("claude");
		expect(code.conversation.messages).toHaveLength(2);
		expect(code.contextText).not.toContain("private reasoning");
		expect(code.conversation.messages[1]?.toolEvidence).toEqual([
			"$ Read /work/project/src/auth.ts",
			"→ callback source",
		]);
		expect(code.counts.quarantined).toBe(1);

		const exported = await prepareSessionImport({ sourcePath: sourceFile(dir, "conversations.json", CLAUDE_EXPORT) });
		expect(exported.conversation.format).toBe("claude-export-json");
		expect(exported.conversation.messages.map(message => message.role)).toEqual(["user", "assistant"]);
	});

	it("excludes provider framing and reasoning sentinels from reconstructed context", () => {
		const codex = parseCodexRollout(
			[
				{ type: "session_meta", payload: { id: CODEX_ID }, timestamp: "2026-01-01T00:00:00Z" },
				{
					type: "response_item",
					payload: {
						type: "message",
						role: "developer",
						content: [{ type: "input_text", text: "CODEX_DEVELOPER" }],
					},
					timestamp: "2026-01-01T00:00:01Z",
				},
				{
					type: "response_item",
					payload: { type: "reasoning", summary: "CODEX_REASONING" },
					timestamp: "2026-01-01T00:00:02Z",
				},
				{
					type: "event_msg",
					payload: { type: "agent_reasoning", text: "CODEX_EVENT_REASONING" },
					timestamp: "2026-01-01T00:00:03Z",
				},
				{
					type: "response_item",
					payload: { type: "message", role: "user", content: [{ type: "input_text", text: "visible user" }] },
					timestamp: "2026-01-01T00:00:04Z",
				},
				{
					type: "response_item",
					payload: {
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: "visible assistant" }],
					},
					timestamp: "2026-01-01T00:00:05Z",
				},
			]
				.map(value => JSON.stringify(value))
				.join("\n"),
		);
		expect(codex.counts.mapped).toBe(6);
		expect(JSON.stringify(codex.conversation.messages)).not.toMatch(/CODEX_(?:DEVELOPER|REASONING|EVENT_REASONING)/);

		const claude = parseClaudeCodeTranscript(
			[
				{
					type: "system",
					sessionId: CLAUDE_ID,
					message: { role: "system", content: "CLAUDE_SYSTEM" },
					timestamp: "2026-01-01T00:00:01Z",
				},
				{
					type: "user",
					sessionId: CLAUDE_ID,
					message: { role: "system", content: "CLAUDE_SPOOFED_SYSTEM" },
					timestamp: "2026-01-01T00:00:01.500Z",
				},
				{
					type: "user",
					sessionId: CLAUDE_ID,
					message: { role: "user", content: "visible user" },
					timestamp: "2026-01-01T00:00:02Z",
				},
				{
					type: "assistant",
					sessionId: CLAUDE_ID,
					message: {
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "CLAUDE_THINKING" },
							{ type: "text", text: "visible assistant" },
						],
					},
					timestamp: "2026-01-01T00:00:03Z",
				},
			]
				.map(value => JSON.stringify(value))
				.join("\n"),
		);
		expect(claude.counts.mapped).toBe(3);
		expect(claude.counts.quarantined).toBe(1);
		expect(JSON.stringify(claude.conversation.messages)).not.toMatch(/CLAUDE_(?:SYSTEM|SPOOFED_SYSTEM|THINKING)/);
	});
	it("attaches tool-first and tool-only Claude evidence only to assistant turns", () => {
		const records = [
			{
				type: "user",
				sessionId: CLAUDE_ID,
				message: { role: "user", content: "inspect it" },
				timestamp: "2026-01-01T00:00:01Z",
			},
			{
				type: "assistant",
				sessionId: CLAUDE_ID,
				message: {
					role: "assistant",
					content: [
						{ type: "tool_use", name: "Read", input: { file_path: "/tmp/a.ts" } },
						{ type: "text", text: "found it" },
					],
				},
				timestamp: "2026-01-01T00:00:02Z",
			},
			{
				type: "user",
				sessionId: CLAUDE_ID,
				message: { role: "user", content: "continue" },
				timestamp: "2026-01-01T00:00:03Z",
			},
			{
				type: "assistant",
				sessionId: CLAUDE_ID,
				message: { role: "assistant", content: [{ type: "tool_use", name: "Glob", input: { pattern: "*.ts" } }] },
				timestamp: "2026-01-01T00:00:04Z",
			},
		];
		const parsed = parseClaudeCodeTranscript(records.map(value => JSON.stringify(value)).join("\n"));
		expect(parsed.conversation.messages.map(message => message.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
		]);
		expect(parsed.conversation.messages[0]?.toolEvidence).toBeUndefined();
		expect(parsed.conversation.messages[1]?.toolEvidence).toEqual(["$ Read /tmp/a.ts"]);
		expect(parsed.conversation.messages[3]).toMatchObject({ text: "", toolEvidence: ["$ Glob *.ts"] });
	});

	it("quarantines malformed tools and records bounded evidence omissions", () => {
		const meta = JSON.stringify({
			type: "session_meta",
			timestamp: "2026-01-01T00:00:00Z",
			payload: { id: CODEX_ID },
		});
		const conversation = [
			meta,
			JSON.stringify({
				type: "response_item",
				timestamp: "2026-01-01T00:00:01Z",
				payload: { type: "message", role: "user", content: [{ type: "input_text", text: "run tools" }] },
			}),
			JSON.stringify({
				type: "response_item",
				timestamp: "2026-01-01T00:00:02Z",
				payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "working" }] },
			}),
		];
		const malformed = [
			{ type: "function_call", name: "a", arguments: { bad: true } },
			{ type: "function_call_output", output: 123 },
			{ type: "custom_tool_call", name: "b", input: 123 },
			{ type: "local_shell_call", action: { command: ["echo", 123] } },
		].map((payload, index) =>
			JSON.stringify({ type: "response_item", timestamp: `2026-01-01T00:00:${index + 3}Z`, payload }),
		);
		const malformedParsed = parseCodexRollout([...conversation, ...malformed].join("\n"));
		expect(malformedParsed.counts.quarantined).toBe(4);

		const evidence = Array.from({ length: 110 }, (_, index) =>
			JSON.stringify({
				type: "response_item",
				timestamp: "2026-01-01T00:01:00Z",
				payload: { type: "function_call", name: `tool-${index}`, arguments: "{}" },
			}),
		);
		const bounded = parseCodexRollout([...conversation, ...evidence].join("\n"));
		expect(bounded.counts.omitted).toBe(10);
		expect(bounded.counts.quarantined).toBe(10);
		expect(bounded.conversation.messages[1]?.toolEvidence).toHaveLength(100);

		const claudeBlocks = Array.from({ length: 110 }, (_, index) => ({
			type: "tool_use",
			name: `tool-${index}`,
			input: { path: `/tmp/${index}` },
		}));
		const claude = parseClaudeCodeTranscript(
			JSON.stringify({
				type: "assistant",
				sessionId: CLAUDE_ID,
				message: { role: "assistant", content: claudeBlocks },
				timestamp: "2026-01-01T00:00:00Z",
			}),
		);
		expect(claude.counts.omitted).toBe(10);
		expect(claude.counts.quarantined).toBe(1);
		expect(claude.conversation.messages[0]?.toolEvidence).toHaveLength(100);
	});

	it("preserves authoritative claude.ai export array and message order", () => {
		const parsed = parseClaudeExport(
			JSON.stringify([
				{
					uuid: "later-created",
					created_at: "2026-02-01T00:00:00Z",
					chat_messages: [{ sender: "human", created_at: "2026-02-01T00:00:00Z", text: "first in export" }],
				},
				{
					uuid: "earlier-created",
					created_at: "2026-01-01T00:00:00Z",
					chat_messages: [{ sender: "assistant", created_at: "2026-01-01T00:00:00Z", text: "second in export" }],
				},
			]),
		);
		expect(parsed.conversation.messages.map(message => message.text)).toEqual([
			"first in export",
			"second in export",
		]);
	});
});

describe("session import safety", () => {
	it("redacts assignment, URL, bearer, and arbitrary Authorization values", () => {
		const input = [
			"OPENAI_API_KEY=sk-AAAAAAAAAAAAAAAAAAAAAAAA",
			"https://user:passw0rd@example.com/path",
			"Bearer abcdef1234567890abcdef",
			"Authorization: Basic dXNlcjpwYXNzd29yZA==",
			'"Authorization":"AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/2026"',
			"glpat-0123456789abcdefghijkl",
			"npm_0123456789abcdefghijkl",
			"ya29.0123456789abcdefghijkl",
			"sk_live_0123456789abcdefghijkl",
			"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
			"+JalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
			"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKE/",
		].join("\n");
		const result = redactImportedText(input);
		expect(result.redacted).toBeGreaterThanOrEqual(12);
		expect(result.value).not.toContain("passw0rd");
		expect(result.value).not.toContain("dXNlcj");
		expect(result.value).not.toContain("AKIAEXAMPLE");
		expect(result.value).not.toContain("glpat-");
		expect(result.value).not.toContain("npm_");
		expect(result.value).not.toContain("ya29.");
		expect(result.value).not.toContain("sk_live_");
		expect(result.value).not.toContain("wJalrXUtnFEMI/");
		expect(result.value).not.toContain("+JalrXUtnFEMI/");
		expect(result.value).not.toContain("EXAMPLEKE/");
		expect(result.value).toContain("[REDACTED]");
	});

	it("does not expose unexpected host paths through formatted errors", () => {
		const formatted = formatSessionImportError(new Error("EACCES: /private/host/secret/session.jsonl"));
		expect(formatted).toContain("unexpected_error");
		expect(formatted).not.toContain("/private/host/secret");
	});

	it("does not reflect an invalid provider value in request errors", async () => {
		const error = await prepareSessionImport({
			sourcePath: "unused.jsonl",
			provider: "/private/host/provider" as never,
		}).catch(cause => cause);
		const message = formatSessionImportError(error);
		expect(message).toContain("Unsupported provider; expected codex or claude.");
		expect(message).not.toContain("/private/host/provider");
	});
	it("redacts imported secrets before any session persistence", async () => {
		const dir = tempDir();
		const secrets = [
			"Basic dXNlcjpwYXNzd29yZA==",
			"glpat-0123456789abcdefghijkl",
			"npm_0123456789abcdefghijkl",
			"ya29.0123456789abcdefghijkl",
			"sk_live_0123456789abcdefghijkl",
			"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
		];
		const transcript = `${CODEX_ROLLOUT}\n${JSON.stringify({
			timestamp: "2026-07-30T10:04:00.000Z",
			type: "response_item",
			payload: {
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: `Authorization: ${secrets[0]}\n${secrets.slice(1).join("\n")}` }],
			},
		})}`;
		const result = await importExternalSession({
			sourcePath: sourceFile(dir, "secret.jsonl", transcript),
			cwd: dir,
			destination: path.join(dir, "sessions"),
		});
		expect(result.prepared.counts.redacted).toBeGreaterThanOrEqual(secrets.length);
		expect(result.prepared.provenance.sanitizerVersion).toBe(3);
		const persisted = fs.readFileSync(result.targetPath, "utf8");
		for (const secret of secrets) {
			expect(result.prepared.contextText).not.toContain(secret);
			expect(persisted).not.toContain(secret);
		}
	});

	it("rejects directories, symlinks, invalid UTF-8, missing files, and empty files", async () => {
		const dir = tempDir();
		for (const [target, code] of [
			[path.join(dir, "missing.jsonl"), "source_not_found"],
			[dir, "invalid_request"],
			[sourceFile(dir, "empty.jsonl", ""), "malformed_input"],
			[sourceFile(dir, "invalid.jsonl", Buffer.from([0xc3, 0x28])), "malformed_input"],
		] as const) {
			try {
				await prepareSessionImport({ sourcePath: target });
				expect.unreachable();
			} catch (error) {
				expectImportError(error, code);
			}
		}
		const real = sourceFile(dir, "real.jsonl", CODEX_ROLLOUT);
		const link = path.join(dir, "link.jsonl");
		fs.symlinkSync(real, link);
		await expect(prepareSessionImport({ sourcePath: link })).rejects.toMatchObject({ code: "invalid_request" });
	});

	it("accepts an explicitly selected hard link without modifying either name", async () => {
		const dir = tempDir();
		const original = sourceFile(dir, "original.jsonl", CODEX_ROLLOUT);
		const linked = path.join(dir, "linked.jsonl");
		fs.linkSync(original, linked);
		const before = createHash("sha256").update(fs.readFileSync(original)).digest("hex");
		await prepareSessionImport({ sourcePath: linked });
		expect(createHash("sha256").update(fs.readFileSync(original)).digest("hex")).toBe(before);
		expect(createHash("sha256").update(fs.readFileSync(linked)).digest("hex")).toBe(before);
	});

	it("rejects selected-path replacement after the source descriptor opens", async () => {
		const dir = tempDir();
		const source = sourceFile(dir, "race.jsonl", CODEX_ROLLOUT);
		await expect(
			prepareSessionImport(
				{ sourcePath: source },
				{
					afterSourceOpen(resolvedSourcePath) {
						fs.renameSync(resolvedSourcePath, path.join(dir, "opened-original.jsonl"));
						fs.writeFileSync(resolvedSourcePath, CLAUDE_CODE);
					},
				},
			),
		).rejects.toMatchObject({ code: "source_changed", phase: "read", retryable: true });
	});

	it("caps descriptor growth before allocating beyond the source limit", async () => {
		const dir = tempDir();
		const source = sourceFile(dir, "grow.jsonl", CODEX_ROLLOUT);
		await expect(
			prepareSessionImport(
				{ sourcePath: source },
				{
					afterSourceIdentityCheck(resolvedSourcePath) {
						fs.truncateSync(resolvedSourcePath, SESSION_IMPORT_SOURCE_MAX_BYTES + 1);
					},
				},
			),
		).rejects.toMatchObject({
			code: "content_too_large",
			phase: "read",
			limitBytes: SESSION_IMPORT_SOURCE_MAX_BYTES,
			observedBytes: SESSION_IMPORT_SOURCE_MAX_BYTES + 1,
		});
	});
	it("bounds large conversations with deterministic head and tail", async () => {
		const dir = tempDir();
		const lines = [
			JSON.stringify({ type: "session_meta", timestamp: "2026-01-01T00:00:00Z", payload: { id: CODEX_ID } }),
		];
		for (let index = 0; index < 12; index++) {
			lines.push(
				JSON.stringify({
					type: "response_item",
					timestamp: `2026-01-01T00:${String(index + 1).padStart(2, "0")}:00Z`,
					payload: {
						type: "message",
						role: index % 2 === 0 ? "user" : "assistant",
						content: [
							{
								type: index % 2 === 0 ? "input_text" : "output_text",
								text: `turn-${index} ${"x".repeat(20_000)}`,
							},
						],
					},
				}),
			);
		}
		const prepared = await prepareSessionImport({ sourcePath: sourceFile(dir, "large.jsonl", lines.join("\n")) });
		expect(prepared.provenance.truncated).toBe(true);
		expect(prepared.contextText).toContain("turn-0");
		expect(prepared.contextText).toContain("turn-11");
		expect(prepared.contextText).toContain("elided");
		expect(prepared.contextText.length).toBeLessThanOrEqual(120_000);
	});

	it("bounds imported metadata before context and provenance persistence", async () => {
		const dir = tempDir();
		const transcript = [
			JSON.stringify({
				type: "session_meta",
				timestamp: "2026-01-01T00:00:00Z",
				payload: {
					id: "i".repeat(600),
					title: "t".repeat(300),
					cwd: `/${Array.from({ length: 500 }, (_, index) => `segment-${index.toString().padStart(4, "0")}`).join("/")}`,
				},
			}),
			JSON.stringify({
				type: "response_item",
				timestamp: "2026-01-01T00:00:01Z",
				payload: { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
			}),
			JSON.stringify({
				type: "response_item",
				timestamp: "2026-01-01T00:00:02Z",
				payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
			}),
		].join("\n");
		const prepared = await prepareSessionImport({
			sourcePath: sourceFile(dir, "metadata.jsonl", transcript),
		});
		expect(prepared.conversation.sourceSessionId?.length).toBe(512);
		expect(prepared.conversation.title?.length).toBe(200);
		expect(prepared.conversation.cwd?.length).toBe(4096);
		expect(prepared.contextText).not.toContain("segment-0000");
		expect(prepared.contextText.length).toBeLessThanOrEqual(120_000);
		expect(prepared.provenance.truncated).toBe(true);
	});

	it("rejects source and message counts beyond fixed limits", async () => {
		const dir = tempDir();
		const huge = sourceFile(dir, "huge.jsonl", "");
		fs.truncateSync(huge, SESSION_IMPORT_SOURCE_MAX_BYTES + 1);
		await expect(prepareSessionImport({ sourcePath: huge })).rejects.toMatchObject({
			code: "content_too_large",
			limitBytes: SESSION_IMPORT_SOURCE_MAX_BYTES,
		});

		const lines = [
			JSON.stringify({ type: "session_meta", timestamp: "2026-01-01T00:00:00Z", payload: { id: CODEX_ID } }),
		];
		for (let index = 0; index < 5001; index++) {
			lines.push(
				JSON.stringify({
					type: "response_item",
					timestamp: "2026-01-01T00:00:01Z",
					payload: {
						type: "message",
						role: index % 2 === 0 ? "user" : "assistant",
						content: [
							{
								type: index % 2 === 0 ? "input_text" : "output_text",
								text: `message-${index}`,
							},
						],
					},
				}),
			);
		}
		await expect(
			prepareSessionImport({ sourcePath: sourceFile(dir, "too-many.jsonl", lines.join("\n")) }),
		).rejects.toMatchObject({ code: "content_too_large", observedBytes: 5001 });
	});

	it("canonicalizes valid timestamps and rejects secret-bearing timestamp metadata", async () => {
		const dir = tempDir();
		const valid = [
			JSON.stringify({ type: "session_meta", timestamp: "2026-01-01T00:00:00Z", payload: { id: CODEX_ID } }),
			JSON.stringify({
				type: "response_item",
				timestamp: "2026-01-01T01:00:00+01:00",
				payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
			}),
		].join("\n");
		const prepared = await prepareSessionImport({ sourcePath: sourceFile(dir, "valid-time.jsonl", valid) });
		expect(prepared.conversation.messages[0]?.timestamp).toBe("2026-01-01T00:00:00.000Z");

		const invalid = valid.replace("2026-01-01T01:00:00+01:00", "Authorization: Bearer timestamp-secret-value");
		await expect(
			prepareSessionImport({ sourcePath: sourceFile(dir, "invalid-time.jsonl", invalid) }),
		).rejects.toMatchObject({ code: "malformed_input", phase: "normalize" });
	});
});

describe("session import materialization and command", () => {
	it("creates a continuable new session with provenance and leaves source unchanged", async () => {
		const dir = tempDir();
		const destination = path.join(dir, "sessions");
		const source = sourceFile(dir, "rollout.jsonl", CODEX_ROLLOUT);
		const sourceDigest = createHash("sha256").update(fs.readFileSync(source)).digest("hex");
		const result = await importExternalSession({
			sourcePath: source,
			cwd: dir,
			destination,
			now: () => new Date("2026-08-01T09:00:00.000Z"),
		});
		expect(result.targetSessionId).not.toBe(CODEX_ID);
		expect(fs.existsSync(result.targetPath)).toBe(true);
		expect(createHash("sha256").update(fs.readFileSync(source)).digest("hex")).toBe(sourceDigest);

		const entries = fs
			.readFileSync(result.targetPath, "utf8")
			.trim()
			.split("\n")
			.map(line => JSON.parse(line));
		const provenanceEntry = entries.find(
			entry => entry.type === "custom" && entry.customType === SESSION_IMPORT_PROVENANCE_CUSTOM_TYPE,
		);
		const provenance = provenanceEntry?.data as SessionImportProvenance;
		expect(provenance.sourceSha256).toBe(sourceDigest);
		expect(provenance.targetSessionId).toBe(result.targetSessionId);
		expect(provenance.importedAt).toBe("2026-08-01T09:00:00.000Z");
		expect(
			entries.find(entry => entry.type === "custom" && entry.customType === SESSION_IMPORT_COMPLETION_CUSTOM_TYPE)
				?.data,
		).toMatchObject({
			schemaVersion: 1,
			targetSessionId: result.targetSessionId,
			sourceSha256: sourceDigest,
		});
		expect(
			entries.find(
				entry => entry.type === "custom_message" && entry.customType === SESSION_IMPORT_CONTEXT_CUSTOM_TYPE,
			)?.display,
		).toBe(true);

		const quarantineEntry = entries.find(
			entry => entry.type === "custom" && entry.customType === SESSION_IMPORT_QUARANTINE_CUSTOM_TYPE,
		);
		expect(quarantineEntry?.data).toMatchObject({
			schemaVersion: 1,
			total: 1,
			truncated: false,
			records: [{ record: 7, reason: "unknown_record" }],
		});
		expect(JSON.stringify(quarantineEntry)).not.toContain("not persisted");
		const reopened = await SessionManager.open(result.targetPath, destination);
		try {
			expect(canContinuePersistedHistory(reopened.buildSessionContext().messages)).toBe(true);
		} finally {
			await reopened.close();
		}
		expect(formatSessionImportSummary(result)).toContain("original transcript file was not modified");
	});

	it("reuses the same native import only within its workspace scope", async () => {
		const dir = tempDir();
		const source = sourceFile(dir, "rollout.jsonl", CODEX_ROLLOUT);
		const destination = path.join(dir, "sessions");
		const first = await importExternalSession({ sourcePath: source, cwd: dir, destination });
		const second = await importExternalSession({ sourcePath: source, cwd: dir, destination });
		expect(first.reused).toBe(false);
		expect(second.reused).toBe(true);
		expect(second.targetSessionId).toBe(first.targetSessionId);
		expect(second.targetPath).toBe(first.targetPath);
		expect(fs.readdirSync(destination).filter(name => name.endsWith(".jsonl"))).toHaveLength(1);

		const otherWorkspace = path.join(dir, "other-workspace");
		fs.mkdirSync(otherWorkspace);
		const other = await importExternalSession({
			sourcePath: source,
			cwd: otherWorkspace,
			destination,
		});
		expect(other.reused).toBe(false);
		expect(other.targetSessionId).not.toBe(first.targetSessionId);
		expect(other.targetPath).not.toBe(first.targetPath);
		const firstAgain = await importExternalSession({ sourcePath: source, cwd: dir, destination });
		const otherAgain = await importExternalSession({
			sourcePath: source,
			cwd: otherWorkspace,
			destination,
		});
		expect(firstAgain.targetSessionId).toBe(first.targetSessionId);
		expect(otherAgain.targetSessionId).toBe(other.targetSessionId);
		expect(firstAgain.reused).toBe(true);
		expect(otherAgain.reused).toBe(true);
		expect(fs.readdirSync(destination).filter(name => name.endsWith(".jsonl"))).toHaveLength(2);

		const concurrentWorkspace = path.join(dir, "concurrent-workspace");
		const concurrentDestination = path.join(concurrentWorkspace, "sessions");
		fs.mkdirSync(concurrentWorkspace);
		const [concurrentA, concurrentB] = await Promise.all([
			importExternalSession({
				sourcePath: source,
				cwd: concurrentWorkspace,
				destination: concurrentDestination,
			}),
			importExternalSession({
				sourcePath: source,
				cwd: concurrentWorkspace,
				destination: concurrentDestination,
			}),
		]);
		expect(concurrentB.targetSessionId).toBe(concurrentA.targetSessionId);
		expect([concurrentA.reused, concurrentB.reused].sort()).toEqual([false, true]);
		expect(fs.readdirSync(concurrentDestination).filter(name => name.endsWith(".jsonl"))).toHaveLength(1);

		const tamperedWorkspace = path.join(dir, "tampered-workspace");
		const tamperedDestination = path.join(tamperedWorkspace, "sessions");
		fs.mkdirSync(tamperedWorkspace);
		const tampered = await importExternalSession({
			sourcePath: source,
			cwd: tamperedWorkspace,
			destination: tamperedDestination,
		});
		const tamperedEntries = fs
			.readFileSync(tampered.targetPath, "utf8")
			.trim()
			.split("\n")
			.map(line => JSON.parse(line));
		const importedContext = tamperedEntries.find(
			entry => entry.type === "custom_message" && entry.customType === SESSION_IMPORT_CONTEXT_CUSTOM_TYPE,
		);
		importedContext.details.sourceSha256 = "0".repeat(64);
		fs.writeFileSync(tampered.targetPath, `${tamperedEntries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
		const afterTamper = await importExternalSession({
			sourcePath: source,
			cwd: tamperedWorkspace,
			destination: tamperedDestination,
		});
		expect(afterTamper.reused).toBe(false);
		expect(afterTamper.targetSessionId).not.toBe(tampered.targetSessionId);
	});

	it("serializes idempotent publication across CLI processes", async () => {
		const dir = tempDir();
		const source = sourceFile(dir, "rollout.jsonl", CODEX_ROLLOUT);
		const workspace = path.join(dir, "workspace");
		const destination = path.join(workspace, "sessions");
		fs.mkdirSync(workspace);
		const serviceUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/session-import/service.ts")).href;
		const childCode = `
			import { importExternalSession } from ${JSON.stringify(serviceUrl)};
			const result = await importExternalSession({
				sourcePath: process.env.IMPORT_SOURCE,
				cwd: process.env.IMPORT_WORKSPACE,
				destination: process.env.IMPORT_DESTINATION,
			});
			console.log(JSON.stringify({
				targetSessionId: result.targetSessionId,
				targetPath: result.targetPath,
				reused: result.reused,
			}));
		`;
		const runChild = async (childDestination = destination) => {
			const child = Bun.spawn([process.execPath, "-e", childCode], {
				cwd: path.resolve(import.meta.dir, "../../.."),
				env: {
					...process.env,
					IMPORT_SOURCE: source,
					IMPORT_WORKSPACE: workspace,
					IMPORT_DESTINATION: childDestination,
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			if (exitCode !== 0) throw new Error(stderr);
			return JSON.parse(stdout.trim()) as {
				targetSessionId: string;
				targetPath: string;
				reused: boolean;
			};
		};

		const [first, second] = await Promise.all([runChild(), runChild()]);
		expect(second.targetSessionId).toBe(first.targetSessionId);
		expect(second.targetPath).toBe(first.targetPath);
		expect([first.reused, second.reused].sort()).toEqual([false, true]);
		expect(fs.readdirSync(destination).filter(name => name.endsWith(".jsonl"))).toHaveLength(1);

		const aliasDestination = path.join(workspace, "alias-sessions");
		const realDestination = path.join(workspace, "real-sessions");
		fs.mkdirSync(realDestination);
		fs.symlinkSync(realDestination, aliasDestination, process.platform === "win32" ? "junction" : "dir");
		const [realResult, aliasResult] = await Promise.all([runChild(realDestination), runChild(aliasDestination)]);
		expect(aliasResult.targetSessionId).toBe(realResult.targetSessionId);
		expect(fs.realpathSync(aliasResult.targetPath)).toBe(fs.realpathSync(realResult.targetPath));
		expect(fs.readdirSync(realDestination).filter(name => name.endsWith(".jsonl"))).toHaveLength(1);

		const realRoot = path.join(workspace, "real-root");
		const aliasRoot = path.join(workspace, "alias-root");
		fs.mkdirSync(realRoot);
		fs.symlinkSync(realRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
		const deepRealDestination = path.join(realRoot, "missing", "nested", "sessions");
		const deepAliasDestination = path.join(aliasRoot, "missing", "nested", "sessions");
		const [deepRealResult, deepAliasResult] = await Promise.all([
			runChild(deepRealDestination),
			runChild(deepAliasDestination),
		]);
		expect(deepAliasResult.targetSessionId).toBe(deepRealResult.targetSessionId);
		expect(fs.realpathSync(deepAliasResult.targetPath)).toBe(fs.realpathSync(deepRealResult.targetPath));
		expect(fs.readdirSync(deepRealDestination).filter(name => name.endsWith(".jsonl"))).toHaveLength(1);
	});
	it("fails closed before publication when native workspace inventory exceeds its bounds", async () => {
		const dir = tempDir();
		const prepared = await prepareSessionImport({
			sourcePath: sourceFile(dir, "rollout.jsonl", CODEX_ROLLOUT),
		});
		const candidateDestination = path.join(dir, "candidate-heavy");
		fs.mkdirSync(candidateDestination);
		for (let index = 0; index < 513; index++) {
			fs.writeFileSync(path.join(candidateDestination, `${index}.jsonl`), "");
		}
		await expect(
			materializeSessionImport(prepared, { cwd: dir, destination: candidateDestination }),
		).rejects.toMatchObject({ code: "io_failed", phase: "persist" });

		const byteDestination = path.join(dir, "byte-heavy");
		fs.mkdirSync(byteDestination);
		const oversized = path.join(byteDestination, "oversized.jsonl");
		fs.writeFileSync(oversized, "");
		fs.truncateSync(oversized, 128 * 1024 * 1024 + 1);
		await expect(
			materializeSessionImport(prepared, { cwd: dir, destination: byteDestination }),
		).rejects.toMatchObject({ code: "io_failed", phase: "persist" });
	});
	it("removes an unpublished partial session when materialization fails", async () => {
		const dir = tempDir();
		const destination = path.join(dir, "sessions");
		const prepared = await prepareSessionImport({
			sourcePath: sourceFile(dir, "rollout.jsonl", CODEX_ROLLOUT),
		});
		await expect(
			materializeSessionImport(prepared, {
				cwd: dir,
				destination,
				now: () => new Date(Number.NaN),
			}),
		).rejects.toMatchObject({ code: "io_failed", phase: "persist" });
		expect(fs.existsSync(destination) ? fs.readdirSync(destination) : []).toEqual([]);
	});

	it("parses the public command and keeps host-path import unavailable over ACP", async () => {
		expect(parseImportSessionArgs('"/tmp/my exports/rollout.jsonl" --provider codex')).toEqual({
			kind: "ok",
			sourcePath: "/tmp/my exports/rollout.jsonl",
			provider: "codex",
		});
		expect(parseImportSessionArgs("--provider=claude /tmp/c.jsonl")).toMatchObject({
			kind: "ok",
			provider: "claude",
		});
		expect(parseImportSessionArgs("--provider openai /tmp/x").kind).toBe("error");
		expect(parseImportSessionArgs("/tmp/a /tmp/b").kind).toBe("error");
		const commandCwd = tempDir();
		const missingRelative = await runSessionImportCommand("missing.jsonl", commandCwd);
		expect(missingRelative).toMatchObject({ kind: "error" });
		const missingMessage = missingRelative.kind === "error" ? missingRelative.message : "";
		expect(missingMessage).toContain("missing.jsonl");
		expect(missingMessage).not.toContain(commandCwd);
		const spec = lookupBuiltinSlashCommand("import-session");
		expect(spec?.handle).toBeDefined();
		expect(spec?.handleTui).toBeDefined();
		expect(spec?.allowArgs).toBe(true);
		expect(spec?.acp).toBe(false);
		expect(ACP_BUILTIN_SLASH_COMMANDS.some(command => command.name === "import-session")).toBe(false);
		const parsedCommand = parseSlashCommand("/import-session /tmp/source.jsonl");
		expect(parsedCommand).toBeDefined();
		const textOutput: string[] = [];
		const textResult = await spec?.handle?.(parsedCommand!, {
			session: { isStreaming: true },
			output(message: string) {
				textOutput.push(message);
			},
		} as never);
		expect(textResult).toEqual({ consumed: true });
		expect(textOutput.join("\n")).toContain("while a response is streaming");

		const tuiErrors: string[] = [];
		const editorValues: string[] = [];
		await spec?.handleTui?.(parsedCommand!, {
			ctx: {
				session: { isStreaming: true },
				editor: {
					setText(value: string) {
						editorValues.push(value);
					},
				},
				showError(message: string) {
					tuiErrors.push(message);
				},
			},
		} as never);
		expect(editorValues).toEqual([""]);
		expect(tuiErrors.join("\n")).toContain("while a response is streaming");

		let switchCalled = false;
		let switchOptions: { requireIdle?: boolean } | undefined;
		const raceOutput: string[] = [];
		const raceResult = await handleImportSessionCommand(
			parsedCommand!,
			{
				session: {
					isStreaming: false,
					async switchSession(_path: string, options: { requireIdle?: boolean }) {
						switchCalled = true;
						switchOptions = options;
						throw Object.assign(new Error("turn began"), { code: "busy" });
					},
				},
				cwd: commandCwd,
				output(message: string) {
					raceOutput.push(message);
				},
			} as never,
			(async () => ({ kind: "imported", result: { targetPath: "/private/new-session.jsonl" } })) as never,
		);
		expect(raceResult).toEqual({ consumed: true });
		expect(switchCalled).toBe(true);
		expect(switchOptions).toEqual({ requireIdle: true });
		expect(raceOutput.join("\n")).toContain("response or turn started");
		expect(raceOutput.join("\n")).not.toContain("/private/new-session.jsonl");

		let resumed = false;
		let resumeOptions: { requireIdle?: boolean } | undefined;
		const raceErrors: string[] = [];
		await handleImportSessionTuiCommand(
			parsedCommand!,
			{
				ctx: {
					session: { isStreaming: false },
					sessionManager: { getCwd: () => commandCwd },
					editor: { setText() {} },
					showError(message: string) {
						raceErrors.push(message);
					},
					async handleResumeSession(_path: string, options: { requireIdle?: boolean }) {
						resumed = true;
						resumeOptions = options;
						throw Object.assign(new Error("turn began"), { code: "busy" });
					},
				},
			} as never,
			(async () => ({ kind: "imported", result: { targetPath: "/private/new-session.jsonl" } })) as never,
		);
		expect(resumed).toBe(true);
		expect(resumeOptions).toEqual({ requireIdle: true });
		expect(raceErrors.join("\n")).toContain("response or turn started");
		expect(raceErrors.join("\n")).not.toContain("/private/new-session.jsonl");
		const acpOutput: string[] = [];
		expect(
			await executeAcpBuiltinSlashCommand("/import-session /etc/passwd", {
				output(message) {
					acpOutput.push(message);
					return Promise.resolve();
				},
			} as Parameters<typeof executeAcpBuiltinSlashCommand>[1]),
		).toEqual({ consumed: true });
		expect(acpOutput).toEqual(["/import-session is not available over ACP."]);
		expect(acpOutput.join("\n")).not.toContain("/etc/passwd");
		for (const commandName of ["export", "move"]) {
			expect(ACP_BUILTIN_SLASH_COMMANDS.some(command => command.name === commandName)).toBe(false);
			const output: string[] = [];
			expect(
				await executeAcpBuiltinSlashCommand(`/${commandName} /private/host/path`, {
					output(message) {
						output.push(message);
					},
				} as Parameters<typeof executeAcpBuiltinSlashCommand>[1]),
			).toEqual({ consumed: true });
			expect(output).toEqual([`/${commandName} is not available over ACP.`]);
			expect(output.join("\n")).not.toContain("/private/host/path");
		}
	});
});
