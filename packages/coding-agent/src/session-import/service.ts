/** Provider-neutral, explicit-file session import service. */
import { createHash } from "node:crypto";
import type * as fs from "node:fs";
import * as nodeFs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { canContinuePersistedHistory } from "@sayknow-cli/agent-core";
import { getAgentDir } from "@sayknow-cli/utils";
import { withFileLock } from "../config/file-lock";
import { type SessionDestinationInput, SessionManager } from "../session/session-manager";
import { FileSessionStorage, type SessionStorageSnapshot } from "../session/session-storage";
import { parseClaudeCodeTranscript, parseClaudeExport } from "./claude";
import { parseCodexRollout } from "./codex";
import { detectSessionImportFormat } from "./detect";
import { IMPORT_SANITIZER_VERSION, redactImportedText } from "./redact";
import {
	type ImportedConversation,
	type ImportQuarantineRecord,
	type PreparedSessionImport,
	SESSION_IMPORT_QUARANTINE_MAX_RECORDS,
	type SessionImportCompleted,
	type SessionImportCounts,
	SessionImportError,
	type SessionImportProvenance,
	type SessionImportProviderId,
} from "./types";

export const IMPORT_CONVERTER_VERSION = 1;
/** Durable metadata only; it is not added to model context. */
export const SESSION_IMPORT_PROVENANCE_CUSTOM_TYPE = "session-import";
export const SESSION_IMPORT_QUARANTINE_CUSTOM_TYPE = "session-import-quarantine";
export const SESSION_IMPORT_COMPLETION_CUSTOM_TYPE = "session-import-complete";
/** Displayed custom-message context reconstructed from the imported transcript. */
export const SESSION_IMPORT_CONTEXT_CUSTOM_TYPE = "session-import";
export const SESSION_IMPORT_SOURCE_MAX_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_MESSAGES = 5000;
const MAX_CONTEXT_CHARS = 120_000;
const HEAD_CONTEXT_CHARS = 20_000;
const MAX_MESSAGE_CHARS = 16_000;
const MAX_TITLE_CHARS = 200;
const MAX_SOURCE_SESSION_ID_CHARS = 512;
const MAX_SOURCE_CWD_CHARS = 4096;
const SOURCE_READ_CHUNK_BYTES = 1024 * 1024;
const MAX_NATIVE_IMPORT_CANDIDATES = 512;
const MAX_NATIVE_IMPORT_SCAN_BYTES = 128 * 1024 * 1024;

export interface SessionImportRequest {
	sourcePath: string;
	provider?: SessionImportProviderId;
	cwd: string;
	destination?: SessionDestinationInput;
	now?: () => Date;
}

/** Invocation-scoped mutation seam used only by TOCTOU regression tests. */
export interface SessionImportTestProbe {
	afterSourceOpen?: (resolvedSourcePath: string) => void | Promise<void>;
	afterSourceIdentityCheck?: (resolvedSourcePath: string) => void | Promise<void>;
}

interface ParsedSource {
	conversation: ImportedConversation;
	quarantine: { present: boolean; truncated: boolean };
	quarantineRecords: ImportQuarantineRecord[];
	counts: SessionImportCounts;
	redactionKinds: string[];
}

/** Reads only the selected regular file, with a stable identity check. */
async function readImportSource(
	sourcePath: string,
	testProbe?: SessionImportTestProbe,
): Promise<{ text: string; bytes: number; sha256: string }> {
	const resolved = path.resolve(sourcePath);
	const sourceLabel = redactImportedText(path.basename(resolved)).value || "selected transcript";
	let before: fs.Stats;
	try {
		before = await fsp.lstat(resolved);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT")
			throw new SessionImportError("source_not_found", "read", `Transcript file does not exist: ${sourceLabel}`);
		throw new SessionImportError(
			"source_unreadable",
			"read",
			`Transcript file cannot be read (${code ?? "unknown error"}): ${sourceLabel}`,
			{ retryable: true },
		);
	}
	if (!before.isFile() || before.isSymbolicLink())
		throw new SessionImportError("invalid_request", "read", `Import source must be a regular file: ${sourceLabel}`);
	if (before.size === 0)
		throw new SessionImportError("malformed_input", "parse", `Transcript file is empty: ${sourceLabel}`);
	if (before.size > SESSION_IMPORT_SOURCE_MAX_BYTES)
		throw new SessionImportError(
			"content_too_large",
			"read",
			`Transcript exceeds the ${SESSION_IMPORT_SOURCE_MAX_BYTES}-byte import limit.`,
			{ limitBytes: SESSION_IMPORT_SOURCE_MAX_BYTES, observedBytes: before.size },
		);
	let handle: fsp.FileHandle;
	try {
		handle = await fsp.open(resolved, nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		throw new SessionImportError(
			"source_unreadable",
			"read",
			`Transcript file cannot be read (${code ?? "unknown error"}): ${sourceLabel}`,
			{ retryable: true },
		);
	}
	let sourceBytes: Buffer;
	try {
		await testProbe?.afterSourceOpen?.(resolved);
		const opened = await handle.stat();
		if (
			!opened.isFile() ||
			opened.size !== before.size ||
			opened.mtimeMs !== before.mtimeMs ||
			opened.ctimeMs !== before.ctimeMs ||
			opened.nlink !== before.nlink ||
			opened.dev !== before.dev ||
			opened.ino !== before.ino
		) {
			throw new SessionImportError(
				"source_changed",
				"read",
				"The transcript file changed while it was being read.",
				{
					retryable: true,
				},
			);
		}
		await testProbe?.afterSourceIdentityCheck?.(resolved);
		const chunks: Buffer[] = [];
		let bytes = 0;
		for (;;) {
			const capacity = Math.min(SOURCE_READ_CHUNK_BYTES, SESSION_IMPORT_SOURCE_MAX_BYTES + 1 - bytes);
			const chunk = Buffer.allocUnsafe(capacity);
			const { bytesRead } = await handle.read(chunk, 0, capacity, bytes);
			if (bytesRead === 0) break;
			chunks.push(chunk.subarray(0, bytesRead));
			bytes += bytesRead;
			if (bytes > SESSION_IMPORT_SOURCE_MAX_BYTES) {
				throw new SessionImportError(
					"content_too_large",
					"read",
					`Transcript exceeds the ${SESSION_IMPORT_SOURCE_MAX_BYTES}-byte import limit.`,
					{ limitBytes: SESSION_IMPORT_SOURCE_MAX_BYTES, observedBytes: bytes },
				);
			}
		}
		const terminal = await handle.stat();
		if (
			terminal.size !== opened.size ||
			terminal.mtimeMs !== opened.mtimeMs ||
			terminal.ctimeMs !== opened.ctimeMs ||
			terminal.nlink !== opened.nlink ||
			terminal.dev !== opened.dev ||
			terminal.ino !== opened.ino ||
			terminal.size !== bytes
		) {
			throw new SessionImportError(
				"source_changed",
				"read",
				"The transcript file changed while it was being read.",
				{ retryable: true },
			);
		}
		sourceBytes = Buffer.concat(chunks, bytes);
	} finally {
		await handle.close();
	}
	const bytes = sourceBytes.byteLength;
	const after = await fsp.lstat(resolved).catch(() => undefined);
	if (
		!after ||
		after.size !== before.size ||
		after.mtimeMs !== before.mtimeMs ||
		after.ctimeMs !== before.ctimeMs ||
		after.nlink !== before.nlink ||
		after.dev !== before.dev ||
		after.ino !== before.ino
	) {
		throw new SessionImportError("source_changed", "read", "The transcript file changed while it was being read.", {
			retryable: true,
		});
	}
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
	} catch {
		throw new SessionImportError("malformed_input", "parse", "Transcript is not valid UTF-8.");
	}
	return { text, bytes, sha256: createHash("sha256").update(sourceBytes).digest("hex") };
}

function normalizeAdapterResult(result: {
	conversation: ImportedConversation;
	quarantine: ImportQuarantineRecord[];
	counts: SessionImportCounts;
	redactionKinds: string[];
}): ParsedSource {
	return {
		conversation: result.conversation,
		quarantine: {
			present: result.counts.quarantined > 0,
			truncated:
				result.counts.quarantined > result.quarantine.length ||
				result.quarantine.length > SESSION_IMPORT_QUARANTINE_MAX_RECORDS,
		},
		quarantineRecords: result.quarantine.slice(0, SESSION_IMPORT_QUARANTINE_MAX_RECORDS),
		counts: result.counts,
		redactionKinds: result.redactionKinds,
	};
}
function parseDetectedFormat(detection: ReturnType<typeof detectSessionImportFormat>, text: string): ParsedSource {
	switch (detection.format) {
		case "codex-rollout-jsonl":
			return normalizeAdapterResult(parseCodexRollout(text));
		case "claude-code-jsonl":
			return normalizeAdapterResult(parseClaudeCodeTranscript(text));
		case "claude-export-json":
			return normalizeAdapterResult(parseClaudeExport(text));
	}
}
function truncateText(text: string, maxChars: number): string {
	return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}
function sanitizeConversationAtBoundary(
	conversation: ImportedConversation,
	counts: SessionImportCounts,
	redactionKinds: string[],
): void {
	const kinds = new Set(redactionKinds);
	const sanitize = (value: string): string => {
		const result = redactImportedText(value);
		counts.redacted += result.redacted;
		for (const kind of result.kinds) kinds.add(kind);
		return result.value;
	};
	if (conversation.sourceSessionId !== undefined)
		conversation.sourceSessionId = sanitize(conversation.sourceSessionId);
	if (conversation.title !== undefined) conversation.title = sanitize(conversation.title);
	if (conversation.cwd !== undefined) conversation.cwd = sanitize(conversation.cwd);
	for (const message of conversation.messages) {
		if (message.text !== undefined) message.text = sanitize(message.text);
		if (message.toolEvidence !== undefined) message.toolEvidence = message.toolEvidence.map(sanitize);
	}
	redactionKinds.splice(0, redactionKinds.length, ...[...kinds].sort());
}

function canonicalizeTimestamps(conversation: ImportedConversation): void {
	for (const message of conversation.messages) {
		if (message.timestamp === undefined) continue;
		const timestamp = Date.parse(message.timestamp);
		if (!Number.isFinite(timestamp))
			throw new SessionImportError(
				"malformed_input",
				"normalize",
				"A message carries an unparseable timestamp; the transcript is not a clean export.",
			);
		message.timestamp = new Date(timestamp).toISOString();
	}
}

/** Deterministic bounded head/tail continuation context. */
function renderImportContext(conversation: ImportedConversation): {
	text: string;
	omitted: number;
	truncated: boolean;
} {
	const title = conversation.title ? ` titled "${truncateText(conversation.title, MAX_TITLE_CHARS)}"` : "";
	const prefix = [
		`<imported-session provider="${conversation.provider}" format="${conversation.format}">`,
		"",
		`The conversation below was imported from an external ${conversation.provider === "codex" ? "Codex" : "Claude"} session transcript${title}.`,
		"It is reconstructed context only: roles and text are preserved, but tool/internal provider state was not cloned, and secrets were redacted.",
		"Continue this conversation naturally as its current participant.",
		"",
	];
	const rendered = conversation.messages.flatMap(message => {
		const blocks: string[] = [];
		if (message.text) blocks.push(truncateText(message.text, MAX_MESSAGE_CHARS));
		if (message.toolEvidence?.length)
			blocks.push(["Tool/file evidence:", ...message.toolEvidence.map(line => `  ${line}`)].join("\n"));
		return blocks.length ? [`### ${message.role === "user" ? "User" : "Assistant"}\n\n${blocks.join("\n\n")}`] : [];
	});
	const buildText = (body: readonly string[]): string => [...prefix, ...body, "", "</imported-session>"].join("\n");
	const fullText = buildText(rendered);
	if (fullText.length <= MAX_CONTEXT_CHARS) {
		return { text: fullText, omitted: 0, truncated: false };
	}

	const head: string[] = [];
	const tail: string[] = [];
	let headChars = 0;
	const marker = (omitted: number): string =>
		`[… ${omitted} earlier message${omitted === 1 ? "" : "s"} from the imported ${conversation.provider} session were elided to bound context; the continuation tail is preserved below. …]`;

	while (head.length + tail.length < rendered.length - 1) {
		const next = rendered[head.length]!;
		if (headChars + next.length + 2 > HEAD_CONTEXT_CHARS) break;
		const candidate = [...head, next];
		const omitted = rendered.length - candidate.length - tail.length;
		if (buildText([...candidate, marker(omitted), ...tail]).length > MAX_CONTEXT_CHARS) break;
		head.push(next);
		headChars += next.length + 2;
	}
	for (let index = rendered.length - 1; index >= head.length + 1; index--) {
		const candidateTail = [rendered[index]!, ...tail];
		const omitted = rendered.length - head.length - candidateTail.length;
		if (buildText([...head, marker(omitted), ...candidateTail]).length > MAX_CONTEXT_CHARS) break;
		tail.unshift(rendered[index]!);
	}
	const omitted = rendered.length - head.length - tail.length;
	const text = buildText([...head, marker(omitted), ...tail]);
	return { text, omitted, truncated: true };
}

/** Read, detect, parse, normalize, redact, and bound without session mutation. */
export async function prepareSessionImport(
	request: Pick<SessionImportRequest, "sourcePath" | "provider">,
	testProbe?: SessionImportTestProbe,
): Promise<PreparedSessionImport> {
	if (typeof request.sourcePath !== "string" || request.sourcePath.trim().length === 0)
		throw new SessionImportError(
			"invalid_request",
			"request",
			"A transcript file path is required: /import-session <file> [--provider codex|claude]",
		);
	if (request.provider !== undefined && request.provider !== "codex" && request.provider !== "claude")
		throw new SessionImportError("invalid_request", "request", "Unsupported provider; expected codex or claude.");
	const source = await readImportSource(request.sourcePath, testProbe);
	const detection = detectSessionImportFormat(source.text, request.provider);
	const parsed = parseDetectedFormat(detection, source.text);
	sanitizeConversationAtBoundary(parsed.conversation, parsed.counts, parsed.redactionKinds);
	canonicalizeTimestamps(parsed.conversation);
	if (parsed.conversation.messages.length === 0)
		throw new SessionImportError(
			"malformed_input",
			"parse",
			`No importable user/assistant messages were found in the ${detection.format} transcript.`,
		);
	if (parsed.conversation.messages.length > MAX_SOURCE_MESSAGES)
		throw new SessionImportError(
			"content_too_large",
			"normalize",
			`The transcript has ${parsed.conversation.messages.length} messages, exceeding the ${MAX_SOURCE_MESSAGES}-message import limit.`,
			{ limitBytes: MAX_SOURCE_MESSAGES, observedBytes: parsed.conversation.messages.length },
		);
	let metadataTruncated = false;
	if (
		parsed.conversation.sourceSessionId?.length &&
		parsed.conversation.sourceSessionId.length > MAX_SOURCE_SESSION_ID_CHARS
	) {
		parsed.conversation.sourceSessionId = truncateText(
			parsed.conversation.sourceSessionId,
			MAX_SOURCE_SESSION_ID_CHARS,
		);
		metadataTruncated = true;
	}
	if (parsed.conversation.title?.length && parsed.conversation.title.length > MAX_TITLE_CHARS) {
		parsed.conversation.title = truncateText(parsed.conversation.title, MAX_TITLE_CHARS);
		metadataTruncated = true;
	}
	if (parsed.conversation.cwd?.length && parsed.conversation.cwd.length > MAX_SOURCE_CWD_CHARS) {
		parsed.conversation.cwd = truncateText(parsed.conversation.cwd, MAX_SOURCE_CWD_CHARS);
		metadataTruncated = true;
	}
	const rendered = renderImportContext(parsed.conversation);
	const sourceFileNameRedaction = redactImportedText(path.basename(path.resolve(request.sourcePath)));
	const counts: SessionImportCounts = {
		...parsed.counts,
		redacted: parsed.counts.redacted + sourceFileNameRedaction.redacted,
		omitted: parsed.counts.omitted + rendered.omitted,
	};
	const redactionKinds = [...new Set([...parsed.redactionKinds, ...sourceFileNameRedaction.kinds])].sort();
	const provenance: PreparedSessionImport["provenance"] = {
		schemaVersion: 1,
		customType: SESSION_IMPORT_PROVENANCE_CUSTOM_TYPE,
		provider: parsed.conversation.provider,
		format: parsed.conversation.format,
		sourceFileName: sourceFileNameRedaction.value,
		...(parsed.conversation.sourceSessionId ? { sourceSessionId: parsed.conversation.sourceSessionId } : {}),
		...(parsed.conversation.title ? { sourceTitle: truncateText(parsed.conversation.title, MAX_TITLE_CHARS) } : {}),
		sourceSha256: source.sha256,
		sourceBytes: source.bytes,
		converterVersion: IMPORT_CONVERTER_VERSION,
		sanitizerVersion: IMPORT_SANITIZER_VERSION,
		counts,
		truncated: rendered.truncated || metadataTruncated || parsed.counts.omitted > 0,
		quarantine: parsed.quarantine,
	};
	return {
		conversation: parsed.conversation,
		contextText: rendered.text,
		provenance,
		counts,
		redactionKinds,
		quarantineRecords: parsed.quarantineRecords,
		sourceSha256: source.sha256,
		sourceBytes: source.bytes,
	};
}

function canonicalPublicationPath(value: string): string {
	const resolved = path.resolve(value);
	const suffix: string[] = [];
	let cursor = resolved;
	for (;;) {
		try {
			return path.join(nodeFs.realpathSync.native(cursor), ...suffix);
		} catch {
			const parent = path.dirname(cursor);
			if (parent === cursor) return resolved;
			suffix.unshift(path.basename(cursor));
			cursor = parent;
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findExistingWorkspaceImport(
	prepared: PreparedSessionImport,
	options: Pick<SessionImportRequest, "cwd" | "destination">,
): SessionImportCompleted | undefined {
	const destination = options.destination;
	const storage = new FileSessionStorage();
	const inventory = SessionManager.inventorySessionsStrict(options.cwd, {
		...(typeof destination === "string"
			? { sessionDir: path.resolve(destination) }
			: destination
				? { sessionDir: destination.directory, destination }
				: {}),
		storage,
		maxCandidates: MAX_NATIVE_IMPORT_CANDIDATES,
		maxTotalBytes: MAX_NATIVE_IMPORT_SCAN_BYTES,
		filterOtherWorkspaces: true,
	});
	if (inventory.kind === "failure") {
		throw new SessionImportError(
			"io_failed",
			"persist",
			"Existing imports could not be verified for this workspace.",
			{ retryable: true },
		);
	}
	if (inventory.candidates.length > MAX_NATIVE_IMPORT_CANDIDATES) {
		throw new SessionImportError(
			"content_too_large",
			"persist",
			"Existing imports exceed the bounded workspace scan limit.",
			{ limitBytes: MAX_NATIVE_IMPORT_CANDIDATES, observedBytes: inventory.candidates.length },
		);
	}

	let scannedBytes = 0;
	for (const candidate of [...inventory.candidates].sort((left, right) => left.path.localeCompare(right.path))) {
		let snapshot: SessionStorageSnapshot;
		try {
			snapshot = storage.readSnapshotBoundedSync(candidate.path, MAX_NATIVE_IMPORT_SCAN_BYTES - scannedBytes);
		} catch {
			throw new SessionImportError(
				"io_failed",
				"persist",
				"An existing workspace session changed during import verification.",
				{ retryable: true },
			);
		}
		scannedBytes += snapshot.bytes.byteLength;

		let header: Record<string, unknown> | undefined;
		let provenance: Record<string, unknown> | undefined;
		let contextMatches = false;
		let completionMatches = false;
		try {
			const text = new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes);
			for (const line of text.split("\n")) {
				if (!line.trim()) continue;
				const entry: unknown = JSON.parse(line);
				if (!isRecord(entry)) continue;
				if (!header && entry.type === "session") header = entry;
				if (
					entry.type === "custom" &&
					entry.customType === SESSION_IMPORT_PROVENANCE_CUSTOM_TYPE &&
					isRecord(entry.data)
				) {
					provenance = entry.data;
				}
				if (
					entry.type === "custom_message" &&
					entry.customType === SESSION_IMPORT_CONTEXT_CUSTOM_TYPE &&
					entry.display === true &&
					typeof entry.content === "string" &&
					entry.content === prepared.contextText &&
					isRecord(entry.details) &&
					entry.details.sourceSha256 === prepared.sourceSha256 &&
					entry.details.provider === prepared.conversation.provider &&
					entry.details.format === prepared.conversation.format
				) {
					contextMatches = true;
				}
				if (
					entry.type === "custom" &&
					entry.customType === SESSION_IMPORT_COMPLETION_CUSTOM_TYPE &&
					isRecord(entry.data) &&
					entry.data.schemaVersion === 1 &&
					entry.data.targetSessionId === candidate.id &&
					entry.data.sourceSha256 === prepared.sourceSha256 &&
					entry.data.converterVersion === IMPORT_CONVERTER_VERSION &&
					entry.data.sanitizerVersion === IMPORT_SANITIZER_VERSION
				) {
					completionMatches = true;
				}
			}
		} catch {
			throw new SessionImportError("io_failed", "persist", "An existing workspace session could not be verified.", {
				retryable: true,
			});
		}
		if (
			!header ||
			!provenance ||
			header.id !== candidate.id ||
			header.cwd !== candidate.cwd ||
			!contextMatches ||
			!completionMatches ||
			provenance.schemaVersion !== 1 ||
			provenance.customType !== SESSION_IMPORT_PROVENANCE_CUSTOM_TYPE ||
			provenance.targetSessionId !== candidate.id ||
			provenance.sourceSha256 !== prepared.sourceSha256 ||
			provenance.sourceBytes !== prepared.sourceBytes ||
			provenance.provider !== prepared.conversation.provider ||
			provenance.format !== prepared.conversation.format ||
			provenance.converterVersion !== IMPORT_CONVERTER_VERSION ||
			provenance.sanitizerVersion !== IMPORT_SANITIZER_VERSION
		) {
			continue;
		}
		return {
			targetSessionId: candidate.id,
			targetPath: candidate.path,
			title:
				typeof header.title === "string" && header.title.trim()
					? truncateText(header.title, MAX_TITLE_CHARS)
					: (prepared.conversation.title ??
						`Imported ${prepared.conversation.provider === "codex" ? "Codex" : "Claude"} session ${(
							prepared.conversation.sourceSessionId ?? prepared.sourceSha256
						).slice(0, 8)}`),
			prepared,
			reused: true,
		};
	}
	return undefined;
}
/** Reuse the same workspace import key or materialize one new independent session. */
async function materializeSessionImportLocked(
	prepared: PreparedSessionImport,
	options: Pick<SessionImportRequest, "cwd" | "destination" | "now">,
): Promise<SessionImportCompleted> {
	if (typeof options.cwd !== "string" || !options.cwd)
		throw new SessionImportError("invalid_request", "request", "A workspace cwd is required to host the import.");
	const existing = findExistingWorkspaceImport(prepared, options);
	if (existing) return existing;
	const manager = SessionManager.create(options.cwd, options.destination);
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) {
		const closeFailure = await manager.close().then(
			() => undefined,
			closeError => closeError,
		);
		if (closeFailure)
			throw new SessionImportError(
				"io_failed",
				"cleanup",
				"Session persistence is unavailable and manager cleanup could not be verified.",
				{ retryable: false },
			);
		throw new SessionImportError(
			"io_failed",
			"persist",
			"Session persistence is unavailable for this workspace; the import has nowhere to live.",
		);
	}
	const targetSessionId = manager.getSessionId();
	try {
		const importedAt = (options.now?.() ?? new Date()).toISOString();
		const provenance: SessionImportProvenance = { ...prepared.provenance, targetSessionId, importedAt };
		manager.appendCustomEntry(SESSION_IMPORT_PROVENANCE_CUSTOM_TYPE, provenance);
		if (prepared.quarantineRecords.length > 0) {
			manager.appendCustomEntry(SESSION_IMPORT_QUARANTINE_CUSTOM_TYPE, {
				schemaVersion: 1,
				total: prepared.counts.quarantined,
				truncated: prepared.provenance.quarantine.truncated,
				records: prepared.quarantineRecords,
			});
		}
		manager.appendCustomMessageEntry(
			SESSION_IMPORT_CONTEXT_CUSTOM_TYPE,
			prepared.contextText,
			true,
			{
				provider: prepared.conversation.provider,
				format: prepared.conversation.format,
				sourceSha256: prepared.sourceSha256,
				sourceBytes: prepared.sourceBytes,
				counts: prepared.counts,
				truncated: prepared.provenance.truncated,
				importedAt,
			},
			"agent",
		);
		const title =
			prepared.conversation.title ??
			`Imported ${prepared.conversation.provider === "codex" ? "Codex" : "Claude"} session ${(prepared.conversation.sourceSessionId ?? prepared.sourceSha256).slice(0, 8)}`;
		await manager.setSessionName(truncateText(title, MAX_TITLE_CHARS), "user");
		await manager.ensureOnDisk();
		await manager.flush();
		await manager.close();
		const reopened = await SessionManager.open(sessionFile, options.destination);
		try {
			if (!canContinuePersistedHistory(reopened.buildSessionContext().messages))
				throw new SessionImportError(
					"malformed_input",
					"persist",
					"The imported session did not reconstruct a continuable conversation.",
				);
			reopened.appendCustomEntry(SESSION_IMPORT_COMPLETION_CUSTOM_TYPE, {
				schemaVersion: 1,
				targetSessionId,
				sourceSha256: prepared.sourceSha256,
				converterVersion: IMPORT_CONVERTER_VERSION,
				sanitizerVersion: IMPORT_SANITIZER_VERSION,
			});
			await reopened.flush();
		} finally {
			await reopened.close();
		}
		return {
			targetSessionId,
			targetPath: sessionFile,
			title: truncateText(title, MAX_TITLE_CHARS),
			prepared,
			reused: false,
		};
	} catch (error) {
		const closeFailure = await manager.close().then(
			() => undefined,
			closeError => closeError,
		);
		const deleteFailure = await new FileSessionStorage().deleteSessionWithArtifacts(sessionFile).then(
			() => undefined,
			deleteError => deleteError,
		);
		const remaining = await fsp.lstat(sessionFile).then(
			() => true,
			statError => (statError as NodeJS.ErrnoException).code !== "ENOENT",
		);
		if (closeFailure || deleteFailure || remaining) {
			throw new SessionImportError(
				"io_failed",
				"cleanup",
				"Import failed and cleanup of the unpublished session could not be verified.",
				{ retryable: false },
			);
		}
		if (error instanceof SessionImportError) throw error;
		throw new SessionImportError(
			"io_failed",
			"persist",
			"Failed to persist the imported session before publication.",
			{ retryable: true },
		);
	}
}
export async function importExternalSession(request: SessionImportRequest): Promise<SessionImportCompleted> {
	return materializeSessionImport(await prepareSessionImport(request), request);
}
export async function materializeSessionImport(
	prepared: PreparedSessionImport,
	options: Pick<SessionImportRequest, "cwd" | "destination" | "now">,
): Promise<SessionImportCompleted> {
	if (typeof options.cwd !== "string" || !options.cwd)
		throw new SessionImportError("invalid_request", "request", "A workspace cwd is required to host the import.");
	const destination = options.destination;
	const destinationKey =
		typeof destination === "string" ? destination : (destination?.directory ?? "<managed-workspace>");
	const publicationKey = createHash("sha256")
		.update(
			JSON.stringify([
				canonicalPublicationPath(options.cwd),
				destinationKey === "<managed-workspace>" ? destinationKey : canonicalPublicationPath(destinationKey),
				prepared.sourceSha256,
				prepared.conversation.provider,
				prepared.conversation.format,
				IMPORT_CONVERTER_VERSION,
				IMPORT_SANITIZER_VERSION,
			]),
		)
		.digest("hex");
	const lockRoot =
		typeof destination === "string" || destination?.kind === "explicit"
			? canonicalPublicationPath(destinationKey)
			: path.join(getAgentDir(), "locks", "session-import");
	const lockTarget = path.join(lockRoot, `publication-${publicationKey}`);
	try {
		return await withFileLock(lockTarget, () => materializeSessionImportLocked(prepared, options), {
			staleMs: 60_000,
			retries: 600,
			retryDelayMs: 50,
		});
	} catch (error) {
		if (error instanceof SessionImportError) throw error;
		throw new SessionImportError("io_failed", "persist", "Import publication serialization could not be completed.", {
			retryable: true,
		});
	}
}
export function formatSessionImportSummary(result: SessionImportCompleted): string {
	const { prepared } = result,
		provider = prepared.conversation.provider === "codex" ? "Codex" : "Claude";
	const lines = [
		`${result.reused ? "Reused existing imported" : "Imported"} ${provider} session (${prepared.conversation.format}) ${result.reused ? "in" : "into"} the current SKC workspace.`,
		`Session: ${result.targetSessionId}`,
		`Title: ${result.title}`,
		`Messages: ${prepared.conversation.messages.length} reconstructed (${prepared.counts.mapped} records mapped, ${prepared.counts.quarantined} quarantined)`,
		`Source: ${prepared.provenance.sourceFileName} (${prepared.sourceBytes} bytes, sha256 ${prepared.sourceSha256.slice(0, 12)}…)`,
	];
	if (prepared.counts.omitted > 0)
		lines.push(
			`Bounded: ${prepared.counts.omitted} message/evidence item${prepared.counts.omitted === 1 ? "" : "s"} omitted by fixed import limits.`,
		);
	if (prepared.counts.redacted > 0)
		lines.push(
			`Redacted: ${prepared.counts.redacted} secret/credential value${prepared.counts.redacted === 1 ? "" : "s"} (${prepared.redactionKinds.join(", ")}).`,
		);
	lines.push("The original transcript file was not modified.");
	return lines.join("\n");
}
export function formatSessionImportError(error: unknown): string {
	if (error instanceof SessionImportError)
		return `Import failed: ${error.code} [${error.phase}]${error.retryable ? " (retryable)" : ""} — ${error.message}`;
	return "Import failed: unexpected_error — An unexpected session import error occurred.";
}
