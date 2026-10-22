/**
 * Append-only crash event journal.
 *
 * The fatal path is the most hostile place in the process: it runs while the
 * program is already broken, possibly out of disk, possibly re-entered by a
 * crash inside the crash handler. So the fatal path does exactly one thing
 * here — append a single bounded line with `O_APPEND` — and never parses,
 * locks, renames or reads. Aggregation into `skc-crash-index.json` happens at
 * the next startup, under a cross-process lock, far away from the fatal path.
 *
 * The journal, not the index, is the source of increments: a lost index can be
 * rebuilt from journal events, and concurrent compactors cannot drop counts.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { CRASH_FINGERPRINT_PATTERN } from "./crash-fingerprint";

/** Hard cap for one journal line, including its newline. */
export const CRASH_EVENT_MAX_BYTES = 512;
/** Journal line format tag. */
export const CRASH_EVENT_KIND = "skc-crash-event.v1";
/** Preview cap for the message class carried by an event. */
export const CRASH_EVENT_MESSAGE_MAX_BYTES = 256;

/** Bounded execution provenance carried only on newly written occurrences. */
export type CrashProvenance = "product" | "eval" | "bun_test";

/**
 * Classify only process-level harness modes that are explicit and stable.
 * Everything else is product provenance, including source checkouts, CLI
 * invocations, SDK/ACP hosts, and native-loader failures.
 */
export function detectCrashProvenance(
	argv: readonly string[] = process.argv,
	env: NodeJS.ProcessEnv = process.env,
	execArgv: readonly string[] = process.execArgv,
): CrashProvenance {
	if (env.BUN_TEST !== undefined) return "bun_test";
	if (execArgv[0] === "-e" || execArgv[0] === "--eval" || argv[0] === "-e" || argv[0] === "--eval") return "eval";
	return "product";
}

export type CrashEvent =
	| CrashOccurrenceEvent
	| CrashRefusedEvent
	| CrashReportedEvent
	| CrashRelayedEvent
	| CrashAcknowledgedEvent
	| CrashNudgedEvent;

export interface CrashOccurrenceEvent {
	readonly kind: "occurrence";
	readonly fingerprint: string;
	readonly fpv: number;
	readonly recordId: string;
	readonly at: number;
	readonly errorName: string;
	readonly messageClass: string;
	/** Legacy events omit this and are treated as product crashes. */
	readonly provenance?: CrashProvenance;
}

export interface CrashRefusedEvent {
	readonly kind: "refused";
	readonly fingerprint: string;
	readonly fpv: number;
	readonly recordId: string;
	readonly contractVersion: string;
	readonly at: number;
}

export interface CrashReportedEvent {
	readonly kind: "reported";
	readonly fingerprint: string;
	readonly at: number;
	readonly issueUrl: string;
	/** Set when the submission was a "+1" comment rather than a new issue. */
	readonly commented?: boolean;
}

export interface CrashRelayedEvent {
	readonly kind: "relayed";
	readonly fingerprint: string;
	readonly at: number;
	/** Sentry event id accepted upstream: 32 lowercase hex. */
	readonly eventId: string;
	/** Exact occurrence record represented by the accepted envelope. Absent on legacy pre-record-id relay lines. */
	readonly recordId?: string;
}

export interface CrashAcknowledgedEvent {
	readonly kind: "acknowledged";
	readonly fingerprint: string;
	readonly at: number;
}

export interface CrashNudgedEvent {
	readonly kind: "nudged";
	readonly at: number;
}

function truncateUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const bytes = Buffer.from(text, "utf8");
	let end = maxBytes;
	while (end > 0 && (bytes[end - 1] & 0xc0) === 0x80) end--;
	if (end > 0 && bytes[end - 1] >= 0xc0) end--;
	return bytes.subarray(0, end).toString("utf8");
}

/** Strip control characters so one event line can never contain a newline. */
function sanitizeEventText(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

/**
 * Serialize one event to a single journal line (newline included), bounded to
 * `CRASH_EVENT_MAX_BYTES`. Oversized message previews are shortened, and if the
 * line still does not fit the preview is dropped entirely rather than the event.
 */
export function formatCrashEventLine(event: CrashEvent): string {
	const build = (messageClass?: string): string => {
		const body: Record<string, unknown> =
			event.kind === "occurrence"
				? {
						k: "occurrence",
						fp: event.fingerprint,
						fpv: event.fpv,
						id: event.recordId,
						at: event.at,
						n: sanitizeEventText(truncateUtf8(event.errorName, 64)),
						...(event.provenance && event.provenance !== "product" ? { p: event.provenance } : {}),
						...(messageClass === undefined ? {} : { m: messageClass }),
					}
				: event.kind === "reported"
					? {
							k: "reported",
							fp: event.fingerprint,
							at: event.at,
							u: sanitizeEventText(truncateUtf8(event.issueUrl, 256)),
							...(event.commented ? { c: 1 } : {}),
						}
					: event.kind === "refused"
						? {
								k: "refused",
								fp: event.fingerprint,
								v: event.fpv,
								r: event.recordId,
								c: sanitizeEventText(truncateUtf8(event.contractVersion, 64)),
								at: event.at,
							}
						: event.kind === "relayed"
							? { k: "relayed", fp: event.fingerprint, at: event.at, e: event.eventId, r: event.recordId }
							: event.kind === "acknowledged"
								? { k: "acknowledged", fp: event.fingerprint, at: event.at }
								: { k: "nudged", at: event.at };
		return `${CRASH_EVENT_KIND} ${JSON.stringify(body)}\n`;
	};

	if (event.kind !== "occurrence") return truncateLine(build());
	let preview = sanitizeEventText(truncateUtf8(event.messageClass, CRASH_EVENT_MESSAGE_MAX_BYTES));
	let line = build(preview);
	while (Buffer.byteLength(line, "utf8") > CRASH_EVENT_MAX_BYTES && preview.length > 0) {
		preview = preview.slice(0, Math.floor(preview.length / 2));
		line = build(preview);
	}
	if (Buffer.byteLength(line, "utf8") > CRASH_EVENT_MAX_BYTES) line = build();
	return truncateLine(line);
}

/** Final safety net: an event line never exceeds the cap, even if malformed. */
function truncateLine(line: string): string {
	if (Buffer.byteLength(line, "utf8") <= CRASH_EVENT_MAX_BYTES) return line;
	return `${truncateUtf8(line.trimEnd(), CRASH_EVENT_MAX_BYTES - 1)}\n`;
}

function isSafeTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Parse one journal line. Anything unexpected yields `undefined`, never a throw. */
export function parseCrashEventLine(line: string): CrashEvent | undefined {
	const trimmed = line.trim();
	if (!trimmed.startsWith(`${CRASH_EVENT_KIND} `)) return undefined;
	if (Buffer.byteLength(trimmed, "utf8") > CRASH_EVENT_MAX_BYTES) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed.slice(CRASH_EVENT_KIND.length + 1)) as unknown;
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const body = parsed as Record<string, unknown>;
	if (!isSafeTimestamp(body.at)) return undefined;
	const at = body.at;
	const fingerprint = typeof body.fp === "string" && CRASH_FINGERPRINT_PATTERN.test(body.fp) ? body.fp : undefined;

	switch (body.k) {
		case "occurrence": {
			if (!fingerprint) return undefined;
			if (typeof body.id !== "string" || !/^[0-9a-f]{8,32}$/.test(body.id)) return undefined;
			if (typeof body.fpv !== "number" || !Number.isSafeInteger(body.fpv) || body.fpv < 1) return undefined;
			const errorName = typeof body.n === "string" ? sanitizeEventText(body.n) : "Error";
			const messageClass = typeof body.m === "string" ? sanitizeEventText(body.m) : "";
			const provenance = body.p === undefined ? undefined : body.p;
			if (provenance !== undefined && provenance !== "product" && provenance !== "eval" && provenance !== "bun_test")
				return undefined;
			return {
				kind: "occurrence",
				fingerprint,
				fpv: body.fpv,
				recordId: body.id,
				at,
				errorName,
				messageClass,
				...(provenance === undefined ? {} : { provenance }),
			};
		}
		case "reported": {
			if (!fingerprint) return undefined;
			if (typeof body.u !== "string" || body.u.length === 0) return undefined;
			return { kind: "reported", fingerprint, at, issueUrl: sanitizeEventText(body.u), commented: body.c === 1 };
		}
		case "refused": {
			if (!fingerprint) return undefined;
			if (typeof body.r !== "string" || !/^[0-9a-f]{8,32}$/.test(body.r)) return undefined;
			if (typeof body.v !== "number" || !Number.isSafeInteger(body.v) || body.v < 1) return undefined;
			if (typeof body.c !== "string" || body.c.length === 0 || /[\u0000-\u001f\u007f-\u009f]/.test(body.c))
				return undefined;
			return { kind: "refused", fingerprint, fpv: body.v, recordId: body.r, contractVersion: body.c, at };
		}
		case "relayed": {
			if (!fingerprint) return undefined;
			if (typeof body.e !== "string" || !/^[0-9a-f]{32}$/.test(body.e)) return undefined;
			if (body.r !== undefined && (typeof body.r !== "string" || !/^[0-9a-f]{8,32}$/.test(body.r))) return undefined;
			return {
				kind: "relayed",
				fingerprint,
				at,
				eventId: body.e,
				...(typeof body.r === "string" ? { recordId: body.r } : {}),
			};
		}
		case "acknowledged": {
			if (!fingerprint) return undefined;
			return { kind: "acknowledged", fingerprint, at };
		}
		case "nudged":
			return { kind: "nudged", at };
		default:
			return undefined;
	}
}

/**
 * Append one event synchronously with `O_APPEND`. Never throws.
 *
 * No parse, no lock, no rename, no read: the only I/O is one bounded write to
 * an append-only file, so concurrent writers interleave whole lines instead of
 * corrupting each other's records.
 */
export function appendCrashEvent(event: CrashEvent, journalPath: string): boolean {
	try {
		const line = formatCrashEventLine(event);
		fs.mkdirSync(path.dirname(journalPath), { recursive: true });
		const fd = fs.openSync(journalPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND, 0o600);
		try {
			fs.writeSync(fd, line);
		} finally {
			fs.closeSync(fd);
		}
		return true;
	} catch {
		// A failing journal write must never mask or delay the original fatal.
		return false;
	}
}

let fatalJournalLatched = false;

/**
 * Fatal-path entry point: at most one journal append per process lifetime.
 *
 * A crash raised while handling a crash must not spend the process's remaining
 * moments on journal bookkeeping, so the latch is never cleared — the process
 * is exiting anyway. Returns whether this call wrote a line.
 */
export function appendFatalCrashEvent(event: CrashEvent, journalPath: string): boolean {
	if (fatalJournalLatched) return false;
	fatalJournalLatched = true;
	return appendCrashEvent(event, journalPath);
}
