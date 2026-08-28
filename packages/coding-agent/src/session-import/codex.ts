/**
 * Codex adapter (issue #3709).
 *
 * Parses the Codex CLI rollout transcript: one JSON object per line
 * (`rollout-*.jsonl`, e.g. `~/.codex/sessions/2026/08/01/rollout-….jsonl`).
 * This is Codex's own observable transcript format; the file the user passes is
 * treated as an explicit export and is only read.
 *
 * Strictness contract: records that fail to parse or lack required fields are
 * quarantined with deterministic digests — never silently dropped. Unknown
 * record/event types are mapped when their payload shape is recognized and
 * quarantined otherwise.
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

export interface CodexParseResult {
	conversation: ImportedConversation;
	quarantine: ImportQuarantineRecord[];
	counts: SessionImportCounts;
	redactionKinds: string[];
}

const MAX_EVIDENCE_LINE_CHARS = 400;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFromContentBlocks(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block)) continue;
		// Codex rollout uses output_text/input_text; accept plain text blocks too.
		if (
			typeof block.text === "string" &&
			(block.type === "output_text" || block.type === "input_text" || block.type === "text")
		) {
			parts.push(block.text);
		}
	}
	return parts.join("\n");
}

function hasUnsupportedMessageContent(content: unknown): boolean {
	if (typeof content === "string") return content.trim().length === 0;
	if (!Array.isArray(content) || content.length === 0) return true;
	let supported = 0;
	for (const block of content) {
		if (
			isRecord(block) &&
			typeof block.text === "string" &&
			(block.type === "output_text" || block.type === "input_text" || block.type === "text")
		) {
			supported++;
		} else {
			return true;
		}
	}
	return supported === 0;
}

function messageFingerprint(role: "user" | "assistant", text: string, timestamp?: string): string {
	const parsedTimestamp = timestamp === undefined ? undefined : Date.parse(timestamp);
	const timestampKey =
		parsedTimestamp !== undefined && Number.isFinite(parsedTimestamp)
			? new Date(parsedTimestamp).toISOString()
			: (timestamp ?? "");
	return JSON.stringify([role, text, timestampKey]);
}

function canonicalResponseMessageCounts(text: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(record) || record.type !== "response_item" || !isRecord(record.payload)) continue;
		const payload = record.payload;
		if (payload.type !== "message" || (payload.role !== "user" && payload.role !== "assistant")) continue;
		const visibleText = textFromContentBlocks(payload.content).trim();
		if (!visibleText) continue;
		const timestamp = typeof record.timestamp === "string" ? record.timestamp : undefined;
		const key = messageFingerprint(payload.role, visibleText, timestamp);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return counts;
}

function summarizeArguments(args: unknown): string {
	if (typeof args !== "string" || args.length === 0) return "";
	const trimmed = args.trim();
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (isRecord(parsed)) {
			const command = parsed.command;
			if (Array.isArray(command) && command.every(part => typeof part === "string")) {
				return command.join(" ");
			}
			if (typeof command === "string") return command;
			if (typeof parsed.cmd === "string") return parsed.cmd;
			if (typeof parsed.path === "string") return parsed.path;
			if (typeof parsed.file_path === "string") return parsed.file_path;
			if (typeof parsed.input === "string") return parsed.input;
			if (typeof parsed.query === "string") return parsed.query;
		}
	} catch {
		// Fall through to the bounded raw form.
	}
	return trimmed;
}

function boundEvidence(text: string): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	if (singleLine.length <= MAX_EVIDENCE_LINE_CHARS) return singleLine;
	return `${singleLine.slice(0, MAX_EVIDENCE_LINE_CHARS - 1)}…`;
}

class EvidenceCollector {
	readonly #lines: string[] = [];
	#bytes = 0;
	omitted = 0;

	static readonly MAX_LINES = 100;
	static readonly MAX_BYTES = 8 * 1024;

	add(line: string): boolean {
		if (line.length === 0) return true;
		if (
			this.#lines.length >= EvidenceCollector.MAX_LINES ||
			this.#bytes + line.length > EvidenceCollector.MAX_BYTES
		) {
			this.omitted++;
			return false;
		}
		this.#lines.push(line);
		this.#bytes += line.length;
		return true;
	}

	get lines(): string[] {
		return this.#lines;
	}
}

/** Parse a Codex rollout JSONL transcript into the provider-neutral IR. */
export function parseCodexRollout(text: string): CodexParseResult {
	const messages: ImportedMessage[] = [];
	const quarantine: ImportQuarantineRecord[] = [];
	const counts: SessionImportCounts = { mapped: 0, quarantined: 0, redacted: 0, omitted: 0 };
	const redactionKinds = new Set<string>();
	const redact = (input: string): string => {
		const result = redactImportedText(input);
		counts.redacted += result.redacted;
		for (const kind of result.kinds) redactionKinds.add(kind);
		return result.value;
	};

	let sourceSessionId: string | undefined;
	let title: string | undefined;
	let cwd: string | undefined;
	let current: ImportedMessage | undefined;
	const unmatchedCanonicalMessages = canonicalResponseMessageCounts(text);
	const anchoredCanonicalMessages = new Map<string, number>();
	const emittedCanonicalMessages = new Map<string, number>();
	const seenEventMessages = new Set<string>();
	let evidence = new EvidenceCollector();

	const closeEvidence = (): void => {
		counts.omitted += evidence.omitted;
		if (evidence.lines.length > 0) {
			if (current?.role !== "assistant") {
				const toolOnly: ImportedMessage = { role: "assistant", text: "", toolEvidence: [...evidence.lines] };
				current = toolOnly;
				messages.push(toolOnly);
			} else {
				current.toolEvidence = [...(current.toolEvidence ?? []), ...evidence.lines];
			}
		}
		evidence = new EvidenceCollector();
	};

	/** Assemble visible text into the running conversation. `mapped` is counted by the caller per recognized record. */
	const pushMessage = (role: "user" | "assistant", rawText: string, timestamp?: string): void => {
		const sanitized = redact(rawText).trim();
		if (role === "user") {
			closeEvidence();
			if (!sanitized) {
				current = undefined;
				return;
			}
			current = { role, text: sanitized, ...(timestamp ? { timestamp } : {}) };
			messages.push(current);
			return;
		}
		if (!sanitized) {
			closeEvidence();
			return;
		}
		if (current?.role === "assistant") {
			current.text = current.text ? `${current.text}\n\n${sanitized}` : sanitized;
		} else {
			current = { role, text: sanitized, ...(timestamp ? { timestamp } : {}) };
			messages.push(current);
		}
		closeEvidence();
	};

	const quarantineRecord = (record: number, line: string, reason: ImportQuarantineRecord["reason"]): void => {
		if (quarantine.length < SESSION_IMPORT_QUARANTINE_MAX_RECORDS) {
			quarantine.push({
				record,
				byteLength: Buffer.byteLength(line, "utf8"),
				sha256: sha256Hex(line),
				reason,
			});
		}
		counts.quarantined++;
	};

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
			quarantineRecord(recordNumber, rawLine, "invalid_json");
			continue;
		}
		if (!isRecord(record) || typeof record.type !== "string") {
			quarantineRecord(recordNumber, rawLine, "invalid_json");
			continue;
		}
		const timestamp = typeof record.timestamp === "string" ? record.timestamp : undefined;

		switch (record.type) {
			case "session_meta": {
				const payload = record.payload;
				if (!isRecord(payload)) {
					quarantineRecord(recordNumber, rawLine, "missing_fields");
					break;
				}
				if (typeof payload.id === "string") sourceSessionId = redact(payload.id).trim();
				if (typeof payload.cwd === "string") cwd = redact(payload.cwd).trim();
				if (typeof payload.title === "string" && payload.title.trim().length > 0) {
					title = redact(payload.title).trim();
				}
				counts.mapped++;
				break;
			}
			case "response_item": {
				const payload = record.payload;
				if (!isRecord(payload) || typeof payload.type !== "string") {
					quarantineRecord(recordNumber, rawLine, "missing_fields");
					break;
				}
				switch (payload.type) {
					case "message": {
						const role = payload.role;
						if (role !== "user" && role !== "assistant") {
							// developer/system prompts are provider framing, not conversation.
							counts.mapped++;
							break;
						}
						counts.mapped++;
						const visibleText = textFromContentBlocks(payload.content);
						const fingerprint = messageFingerprint(role, visibleText.trim(), timestamp);
						const anchoredMatches = anchoredCanonicalMessages.get(fingerprint) ?? 0;
						if (anchoredMatches > 0) {
							anchoredCanonicalMessages.set(fingerprint, anchoredMatches - 1);
							counts.omitted++;
						} else {
							pushMessage(role, visibleText, timestamp);
							emittedCanonicalMessages.set(fingerprint, (emittedCanonicalMessages.get(fingerprint) ?? 0) + 1);
						}
						if (hasUnsupportedMessageContent(payload.content)) {
							quarantineRecord(recordNumber, rawLine, "missing_fields");
						}
						break;
					}
					case "reasoning": {
						// Model-internal reasoning is never imported (non-goal).
						counts.mapped++;
						break;
					}
					case "function_call": {
						const name = redact(boundEvidence(typeof payload.name === "string" ? payload.name : "tool"));
						if (typeof payload.arguments !== "string") {
							quarantineRecord(recordNumber, rawLine, "missing_fields");
							break;
						}
						const summary = redact(boundEvidence(summarizeArguments(payload.arguments)));
						if (!evidence.add(summary ? `$ ${name} ${summary}` : `$ ${name}`)) {
							quarantineRecord(recordNumber, rawLine, "unknown_record");
						}
						counts.mapped++;
						break;
					}
					case "function_call_output":
					case "custom_tool_call_output": {
						const output = isRecord(payload.output)
							? JSON.stringify(payload.output)
							: typeof payload.output === "string"
								? payload.output
								: undefined;
						if (output === undefined) {
							quarantineRecord(recordNumber, rawLine, "missing_fields");
							break;
						}
						const summary = redact(boundEvidence(output));
						if (!evidence.add(summary ? `→ ${summary}` : "→ [empty output]")) {
							quarantineRecord(recordNumber, rawLine, "unknown_record");
						}
						counts.mapped++;
						break;
					}
					case "custom_tool_call": {
						const name = redact(boundEvidence(typeof payload.name === "string" ? payload.name : "tool"));
						if (typeof payload.input !== "string") {
							quarantineRecord(recordNumber, rawLine, "missing_fields");
							break;
						}
						const summary = redact(boundEvidence(payload.input));
						if (!evidence.add(summary ? `$ ${name} ${summary}` : `$ ${name}`)) {
							quarantineRecord(recordNumber, rawLine, "unknown_record");
						}
						counts.mapped++;
						break;
					}
					case "local_shell_call": {
						const action = isRecord(payload.action) ? payload.action : undefined;
						if (
							!action ||
							!Array.isArray(action.command) ||
							!action.command.every(part => typeof part === "string")
						) {
							quarantineRecord(recordNumber, rawLine, "missing_fields");
							break;
						}
						const summary = redact(boundEvidence(action.command.join(" ")));
						if (!evidence.add(summary ? `$ ${summary}` : "$ shell")) {
							quarantineRecord(recordNumber, rawLine, "unknown_record");
						}
						counts.mapped++;
						break;
					}
					case "web_search_call": {
						if (!evidence.add("[web search]")) quarantineRecord(recordNumber, rawLine, "unknown_record");
						counts.mapped++;
						break;
					}
					default:
						quarantineRecord(recordNumber, rawLine, "unknown_record");
				}
				break;
			}
			case "event_msg": {
				const payload = record.payload;
				if (!isRecord(payload) || typeof payload.type !== "string") {
					quarantineRecord(recordNumber, rawLine, "missing_fields");
					break;
				}
				switch (payload.type) {
					case "user_message":
					case "agent_message": {
						if (typeof payload.message !== "string" || !payload.message.trim()) {
							quarantineRecord(recordNumber, rawLine, "missing_fields");
							break;
						}
						counts.mapped++;
						const role = payload.type === "user_message" ? "user" : "assistant";
						const fingerprint = messageFingerprint(role, payload.message.trim(), timestamp);
						if (seenEventMessages.has(fingerprint)) {
							counts.omitted++;
							break;
						}
						seenEventMessages.add(fingerprint);
						const canonicalMatches = unmatchedCanonicalMessages.get(fingerprint) ?? 0;
						const emittedMatches = emittedCanonicalMessages.get(fingerprint) ?? 0;
						if (canonicalMatches > 0 && emittedMatches > 0) {
							unmatchedCanonicalMessages.set(fingerprint, canonicalMatches - 1);
							emittedCanonicalMessages.set(fingerprint, emittedMatches - 1);
							counts.omitted++;
						} else if (canonicalMatches > 0) {
							unmatchedCanonicalMessages.set(fingerprint, canonicalMatches - 1);
							anchoredCanonicalMessages.set(fingerprint, (anchoredCanonicalMessages.get(fingerprint) ?? 0) + 1);
							pushMessage(role, payload.message, timestamp);
						} else {
							pushMessage(role, payload.message, timestamp);
						}
						break;
					}
					case "agent_reasoning":
					case "agent_reasoning_delta":
					case "agent_reasoning_raw_content":
					case "agent_reasoning_raw_content_delta":
					case "agent_reasoning_section_break":
					case "token_count":
						// Reasoning/token telemetry is model-internal or display-only.
						counts.mapped++;
						break;
					default:
						// Recognized event envelope, unmapped payload variant.
						quarantineRecord(recordNumber, rawLine, "unknown_record");
				}
				break;
			}
			case "turn_context":
			case "world_state":
				// Provider environment framing; not conversation content.
				counts.mapped++;
				break;
			default:
				quarantineRecord(recordNumber, rawLine, "unknown_record");
		}
	}
	closeEvidence();

	return {
		conversation: {
			provider: "codex",
			format: "codex-rollout-jsonl",
			...(sourceSessionId ? { sourceSessionId } : {}),
			...(title ? { title } : {}),
			...(cwd ? { cwd } : {}),
			messages,
		},
		quarantine,
		counts,
		redactionKinds: [...redactionKinds].sort(),
	};
}

function sha256Hex(text: string): string {
	// Deterministic per-record digest for quarantine evidence (content never stored).
	return createHash("sha256").update(text, "utf8").digest("hex");
}
