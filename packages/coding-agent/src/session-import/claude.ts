/**
 * Claude adapter (issue #3709).
 *
 * Parses two first-party observable Claude transcript/export shapes:
 *
 * 1. `claude-code-jsonl` — Claude Code session transcripts
 *    (`~/.claude/projects/<project-slug>/<session-uuid>.jsonl`), one JSON object
 *    per line with `type: "user" | "assistant" | "summary" | "system" | …`.
 * 2. `claude-export-json` — the claude.ai data export (`conversations.json`):
 *    a JSON array of conversations (or a single conversation object) whose
 *    `chat_messages` carry `sender: "human" | "assistant"` and `content` blocks.
 *
 * The same quarantine contract as the Codex adapter applies: unmappable
 * records/messages are counted and digested, never silently dropped.
 */

import { createHash } from "node:crypto";
import { redactImportedText } from "./redact";
import {
	type ImportedConversation,
	type ImportedMessage,
	type ImportQuarantineRecord,
	SESSION_IMPORT_QUARANTINE_MAX_RECORDS,
	type SessionImportCounts,
} from "./types";

type JsonRecord = Record<string, unknown>;

export interface ClaudeParseResult {
	conversation: ImportedConversation;
	quarantine: ImportQuarantineRecord[];
	counts: SessionImportCounts;
	redactionKinds: string[];
}

const MAX_EVIDENCE_LINE_CHARS = 400;
const MAX_EVIDENCE_LINES = 100;
const MAX_EVIDENCE_BYTES = 8 * 1024;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function boundEvidence(text: string): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	if (singleLine.length <= MAX_EVIDENCE_LINE_CHARS) return singleLine;
	return `${singleLine.slice(0, MAX_EVIDENCE_LINE_CHARS - 1)}…`;
}

class ParseSink {
	readonly messages: ImportedMessage[] = [];
	readonly quarantine: ImportQuarantineRecord[] = [];
	readonly counts: SessionImportCounts = { mapped: 0, quarantined: 0, redacted: 0, omitted: 0 };
	readonly redactionKinds = new Set<string>();
	#evidence: string[] = [];
	#evidenceBytes = 0;
	#current: ImportedMessage | undefined;

	redact(input: string): string {
		const result = redactImportedText(input);
		this.counts.redacted += result.redacted;
		for (const kind of result.kinds) this.redactionKinds.add(kind);
		return result.value;
	}

	quarantineRecord(record: number, raw: string, reason: ImportQuarantineRecord["reason"]): void {
		if (this.quarantine.length < SESSION_IMPORT_QUARANTINE_MAX_RECORDS) {
			this.quarantine.push({
				record,
				byteLength: Buffer.byteLength(raw, "utf8"),
				sha256: sha256Hex(raw),
				reason,
			});
		}
		this.counts.quarantined++;
	}

	addEvidence(line: string): boolean {
		if (line.length === 0) return true;
		if (this.#evidence.length >= MAX_EVIDENCE_LINES || this.#evidenceBytes + line.length > MAX_EVIDENCE_BYTES) {
			this.counts.omitted++;
			return false;
		}
		this.#evidence.push(line);
		this.#evidenceBytes += line.length;
		return true;
	}

	closeEvidence(): void {
		if (this.#evidence.length > 0) {
			if (this.#current?.role !== "assistant") {
				const toolOnly: ImportedMessage = { role: "assistant", text: "", toolEvidence: [...this.#evidence] };
				this.#current = toolOnly;
				this.messages.push(toolOnly);
			} else {
				this.#current.toolEvidence = [...(this.#current.toolEvidence ?? []), ...this.#evidence];
			}
		}
		this.#evidence = [];
		this.#evidenceBytes = 0;
	}

	/** Assemble visible text into the running conversation. `mapped` is counted by the caller. */
	pushMessage(role: "user" | "assistant", rawText: string, timestamp?: string): void {
		const sanitized = this.redact(rawText).trim();
		if (role === "user") {
			this.closeEvidence();
			if (!sanitized) {
				this.#current = undefined;
				return;
			}
			this.#current = { role, text: sanitized, ...(timestamp ? { timestamp } : {}) };
			this.messages.push(this.#current);
			return;
		}
		if (!sanitized) {
			this.closeEvidence();
			return;
		}
		if (this.#current?.role === "assistant") {
			this.#current.text = this.#current.text ? `${this.#current.text}\n\n${sanitized}` : sanitized;
		} else {
			this.#current = { role, text: sanitized, ...(timestamp ? { timestamp } : {}) };
			this.messages.push(this.#current);
		}
		this.closeEvidence();
	}
}

function toolUseSummary(input: unknown): string {
	if (!isRecord(input)) return "";
	if (typeof input.command === "string") return input.command;
	if (typeof input.file_path === "string") return input.file_path;
	if (typeof input.path === "string") return input.path;
	if (typeof input.pattern === "string") return input.pattern;
	if (typeof input.query === "string") return input.query;
	if (typeof input.url === "string") return input.url;
	if (typeof input.prompt === "string") return boundEvidence(input.prompt);
	if (typeof input.content === "string") return boundEvidence(input.content);
	return boundEvidence(JSON.stringify(input));
}

function toolResultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}

/** Parse a Claude Code session JSONL transcript. */
export function parseClaudeCodeTranscript(text: string): ClaudeParseResult {
	const sink = new ParseSink();
	let sourceSessionId: string | undefined;
	let title: string | undefined;
	let cwd: string | undefined;

	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const rawLine = lines[index]!;
		const line = rawLine.trim();
		if (line.length === 0) continue;
		const recordNumber = index + 1;
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			sink.quarantineRecord(recordNumber, rawLine, "invalid_json");
			continue;
		}
		if (!isRecord(record) || typeof record.type !== "string") {
			sink.quarantineRecord(recordNumber, rawLine, "invalid_json");
			continue;
		}
		if (typeof record.sessionId === "string" && !sourceSessionId)
			sourceSessionId = sink.redact(record.sessionId).trim();
		if (typeof record.cwd === "string" && !cwd) cwd = sink.redact(record.cwd).trim();
		const timestamp = typeof record.timestamp === "string" ? record.timestamp : undefined;

		switch (record.type) {
			case "summary": {
				if (typeof record.summary === "string" && record.summary.trim().length > 0) {
					title = sink.redact(record.summary).trim();
				}
				sink.counts.mapped++;
				break;
			}
			case "user":
			case "assistant": {
				const message = record.message;
				if (!isRecord(message)) {
					sink.quarantineRecord(recordNumber, rawLine, "missing_fields");
					break;
				}
				if (message.role !== record.type) {
					sink.quarantineRecord(recordNumber, rawLine, "missing_fields");
					break;
				}
				sink.counts.mapped++;
				const isMeta = record.isMeta === true || record.isSidechain === true;
				if (isMeta) break; // command/system bookkeeping rows are not conversation.
				const role: "user" | "assistant" = record.type === "user" ? "user" : "assistant";
				const content = message.content;
				if (typeof content === "string") {
					if (!content.trim()) sink.quarantineRecord(recordNumber, rawLine, "missing_fields");
					sink.pushMessage(role, content, timestamp);
					break;
				}
				if (!Array.isArray(content) || content.length === 0) {
					sink.quarantineRecord(recordNumber, rawLine, "missing_fields");
					break;
				}
				let unsupportedContent = false;
				for (const block of content) {
					if (!isRecord(block) || typeof block.type !== "string") {
						unsupportedContent = true;
						continue;
					}
					switch (block.type) {
						case "text":
							if (typeof block.text === "string") sink.pushMessage(role, block.text, timestamp);
							else unsupportedContent = true;
							break;
						case "thinking":
							// Model-internal reasoning is never imported (non-goal).
							break;
						case "tool_use": {
							if (typeof block.name !== "string" || !block.name.trim() || !isRecord(block.input)) {
								unsupportedContent = true;
								break;
							}
							const name = sink.redact(boundEvidence(block.name));
							const summary = sink.redact(boundEvidence(toolUseSummary(block.input)));
							if (!sink.addEvidence(`$ ${name} ${summary}`)) unsupportedContent = true;
							break;
						}
						case "tool_result": {
							const summary = sink.redact(boundEvidence(toolResultText(block.content)));
							if (!summary || !sink.addEvidence(`→ ${summary}`)) unsupportedContent = true;
							break;
						}
						default:
							if (block.type === "image" || block.type === "document") {
								if (!sink.addEvidence(`[${block.type}]`)) unsupportedContent = true;
							} else {
								unsupportedContent = true;
							}
					}
				}
				if (unsupportedContent) sink.quarantineRecord(recordNumber, rawLine, "unknown_record");
				sink.closeEvidence();
				break;
			}
			case "system":
			case "file-history-snapshot":
			case "queue-operation":
				// Provider hooks/bookkeeping; not conversation content.
				sink.counts.mapped++;
				break;
			default:
				sink.quarantineRecord(recordNumber, rawLine, "unknown_record");
		}
	}
	sink.closeEvidence();

	return {
		conversation: {
			provider: "claude",
			format: "claude-code-jsonl",
			...(sourceSessionId ? { sourceSessionId } : {}),
			...(title ? { title } : {}),
			...(cwd ? { cwd } : {}),
			messages: sink.messages,
		},
		quarantine: sink.quarantine,
		counts: sink.counts,
		redactionKinds: [...sink.redactionKinds].sort(),
	};
}

function claudeExportMessageText(message: JsonRecord): { text: string; unsupported: boolean } {
	let unsupported = false;
	if (Array.isArray(message.content)) {
		const parts: string[] = [];
		for (const block of message.content) {
			if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
				parts.push(block.text);
			} else if (isRecord(block) && (block.type === "image" || block.type === "document")) {
				parts.push(`[${block.type}]`);
			} else {
				unsupported = true;
			}
		}
		if (parts.length > 0) return { text: parts.join("\n"), unsupported };
	}
	if (typeof message.text === "string") return { text: message.text, unsupported };
	return { text: "", unsupported: true };
}

/** Parse a claude.ai data-export conversation (array or single object). */
export function parseClaudeExport(text: string): ClaudeParseResult {
	const sink = new ParseSink();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		sink.quarantineRecord(1, text, "invalid_json");
		return emptyResult(sink);
	}

	const conversations = Array.isArray(parsed) ? parsed : [parsed];
	if (conversations.length === 0 || !conversations.every(isRecord)) {
		sink.quarantineRecord(1, text, "missing_fields");
		return emptyResult(sink);
	}
	// The export's array and chat-message order are authoritative and stable.
	const ordered = conversations;

	let title: string | undefined;
	let sourceSessionId: string | undefined;
	let recordNumber = 0;
	for (const conversation of ordered) {
		if (typeof conversation.uuid === "string" && !sourceSessionId)
			sourceSessionId = sink.redact(conversation.uuid).trim();
		if (typeof conversation.name === "string" && conversation.name.trim().length > 0 && !title) {
			title = sink.redact(conversation.name).trim();
		}
		const chatMessages = conversation.chat_messages;
		if (!Array.isArray(chatMessages)) {
			sink.quarantineRecord(++recordNumber, JSON.stringify(conversation), "missing_fields");
			continue;
		}
		for (const message of chatMessages) {
			recordNumber++;
			if (!isRecord(message)) {
				sink.quarantineRecord(recordNumber, String(message), "invalid_json");
				continue;
			}
			const sender = message.sender;
			if (sender !== "human" && sender !== "assistant") {
				sink.quarantineRecord(recordNumber, JSON.stringify(message), "unknown_record");
				continue;
			}
			sink.counts.mapped++;
			const timestamp = typeof message.created_at === "string" ? message.created_at : undefined;
			const mapped = claudeExportMessageText(message);
			if (mapped.unsupported || !mapped.text.trim()) {
				sink.quarantineRecord(recordNumber, JSON.stringify(message), "missing_fields");
			}
			if (mapped.text) sink.pushMessage(sender === "human" ? "user" : "assistant", mapped.text, timestamp);
		}
	}
	sink.closeEvidence();

	return {
		conversation: {
			provider: "claude",
			format: "claude-export-json",
			...(sourceSessionId ? { sourceSessionId } : {}),
			...(title ? { title } : {}),
			messages: sink.messages,
		},
		quarantine: sink.quarantine,
		counts: sink.counts,
		redactionKinds: [...sink.redactionKinds].sort(),
	};
}

function emptyResult(sink: ParseSink): ClaudeParseResult {
	return {
		conversation: { provider: "claude", format: "claude-export-json", messages: [] },
		quarantine: sink.quarantine,
		counts: sink.counts,
		redactionKinds: [],
	};
}
