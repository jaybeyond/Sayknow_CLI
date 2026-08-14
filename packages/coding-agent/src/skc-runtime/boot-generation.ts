/**
 * Boot-generation evidence for reboot-only session restore.
 *
 * Restore exists to survive a reboot, and only a reboot. The eligibility rule is
 * therefore narrow on purpose: a session may be restored only when the recorded
 * and current boot values come from the SAME source and differ. Anything else —
 * equal values, a missing or malformed record, an unreadable probe, or two
 * different sources — is inconclusive and must never spawn.
 *
 * The same-source requirement is not pedantry. Linux can report `boot-id` at
 * record time and fall back to `proc-btime` later; those two values are always
 * unequal even on one boot, so comparing across sources would read every launch
 * as a reboot and duplicate live sessions.
 */

import * as fsSync from "node:fs";

/** Where a boot value came from. Values are only ever compared within one source. */
export type BootGenerationSource = "darwin-kern-boottime" | "linux-boot-id" | "linux-proc-btime" | "unavailable";

export interface BootGeneration {
	source: BootGenerationSource;
	/** Opaque; only equality within the same source is meaningful. */
	value: string | null;
}

export type BootComparison = "changed" | "same_boot" | "boot_unknown";

const BOOT_GENERATION_SCHEMA_VERSION = 1;

export interface RecordedBootGeneration {
	schema_version: number;
	source: string;
	value: string;
}

export interface BootGenerationProbeDeps {
	platform?: NodeJS.Platform;
	readFile?: (file: string) => string;
	runCommand?: (command: string, args: string[]) => { exitCode: number | null; stdout: string };
}

function defaultReadFile(file: string): string {
	return fsSync.readFileSync(file, "utf8");
}

function defaultRunCommand(command: string, args: string[]): { exitCode: number | null; stdout: string } {
	const result = Bun.spawnSync({ cmd: [command, ...args], stdout: "pipe", stderr: "ignore" });
	return { exitCode: result.exitCode, stdout: result.stdout.toString() };
}

/** `{ sec = 1785305532, usec = 377197 } Wed Jul 29 ...` -> `1785305532.377197`. */
export function parseDarwinBootTime(raw: string): string | null {
	const match = /sec\s*=\s*(\d+)\s*,\s*usec\s*=\s*(\d+)/u.exec(raw);
	if (!match) return null;
	const sec = match[1];
	const usec = match[2];
	if (!sec || !usec) return null;
	// A microsecond field at or above 1e6 is not a time this kernel produced;
	// accepting it would let a malformed reading masquerade as a distinct boot.
	if (Number.parseInt(usec, 10) >= 1_000_000) return null;
	return `${sec}.${usec.padStart(6, "0")}`;
}

/** A boot id is a UUID that changes on every boot; anything else is not usable. */
export function parseLinuxBootId(raw: string): string | null {
	const value = raw.trim();
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value) ? value : null;
}

/** `/proc/stat` carries `btime <seconds>` once, as the kernel boot wall-clock. */
export function parseLinuxProcBtime(raw: string): string | null {
	const values: string[] = [];
	for (const line of raw.split("\n")) {
		const match = /^btime\s+(\d+)\s*$/u.exec(line);
		if (match?.[1]) values.push(match[1]);
	}
	// The kernel reports btime exactly once. More than one means the input is not
	// a `/proc/stat` we can reason about, so refuse rather than pick one.
	return values.length === 1 ? (values[0] ?? null) : null;
}

/**
 * Reads the strongest boot evidence this platform offers.
 *
 * Windows returns `unavailable`: restore is unsupported there (no immutable
 * native tmux session identity), so there is nothing to gate.
 */
export function readBootGeneration(deps: BootGenerationProbeDeps = {}): BootGeneration {
	const platform = deps.platform ?? process.platform;
	const readFile = deps.readFile ?? defaultReadFile;
	const runCommand = deps.runCommand ?? defaultRunCommand;

	if (platform === "darwin") {
		try {
			const probed = runCommand("sysctl", ["-n", "kern.boottime"]);
			if (probed.exitCode !== 0) return { source: "unavailable", value: null };
			const value = parseDarwinBootTime(probed.stdout);
			return value ? { source: "darwin-kern-boottime", value } : { source: "unavailable", value: null };
		} catch {
			return { source: "unavailable", value: null };
		}
	}

	if (platform === "linux") {
		try {
			const value = parseLinuxBootId(readFile("/proc/sys/kernel/random/boot_id"));
			if (value) return { source: "linux-boot-id", value };
		} catch {
			// Fall through: some hardened kernels hide boot_id.
		}
		try {
			const value = parseLinuxProcBtime(readFile("/proc/stat"));
			if (value) return { source: "linux-proc-btime", value };
		} catch {
			// Fall through to unavailable.
		}
		return { source: "unavailable", value: null };
	}

	return { source: "unavailable", value: null };
}

/**
 * Each source produces one exact shape. Validating it is what stops a value that
 * merely differs textually — trailing space, a zero-width character — from being
 * read as a different boot.
 */
const BOOT_VALUE_SHAPE: Record<string, RegExp> = {
	"darwin-kern-boottime": /^\d+\.\d{6}$/u,
	"linux-boot-id": /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
	"linux-proc-btime": /^\d+$/u,
};

export function isBootValueWellFormed(source: string, value: string): boolean {
	return BOOT_VALUE_SHAPE[source]?.test(value) ?? false;
}

export function isRecordedBootGeneration(value: unknown): value is RecordedBootGeneration {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		record.schema_version === BOOT_GENERATION_SCHEMA_VERSION &&
		typeof record.source === "string" &&
		record.source.length > 0 &&
		record.source !== "unavailable" &&
		typeof record.value === "string" &&
		record.value.length > 0 &&
		isBootValueWellFormed(record.source, record.value)
	);
}

export function recordBootGeneration(current: BootGeneration): RecordedBootGeneration | null {
	if (current.source === "unavailable" || !current.value) return null;
	if (!isBootValueWellFormed(current.source, current.value)) return null;
	return { schema_version: BOOT_GENERATION_SCHEMA_VERSION, source: current.source, value: current.value };
}

/**
 * Decides whether the machine rebooted since the session was recorded.
 *
 * `changed` is the ONLY executable answer. It requires a well-formed record, a
 * readable current probe, an identical source, and different values. Source
 * mismatch is deliberately `boot_unknown` rather than `changed`.
 */
export function compareBootGeneration(recorded: unknown, current: BootGeneration): BootComparison {
	if (!isRecordedBootGeneration(recorded)) return "boot_unknown";
	if (current.source === "unavailable" || !current.value) return "boot_unknown";
	if (!isBootValueWellFormed(current.source, current.value)) return "boot_unknown";
	if (recorded.source !== current.source) return "boot_unknown";
	return recorded.value === current.value ? "same_boot" : "changed";
}
