import * as fs from "node:fs";

/**
 * Guards for the SDK's long-lived background processes (`sdk broker-internal`,
 * `sdk session-host-internal`). They are spawned detached and outlive whoever
 * started them, so each one has to notice on its own when it has no reason, or no
 * way, to keep running.
 */

/** How often the guards run. Cheap: one `stat`, plus a small JSON read for hosts. */
export const PROCESS_GUARD_INTERVAL_MS = 5_000;

/**
 * The entry script of a process run from source (`bun …/src/cli.ts sdk …`), or
 * undefined for a compiled binary, whose entry lives in Bun's virtual filesystem
 * and cannot disappear from under it.
 */
export function sourceEntryPath(main: string | undefined = Bun.main): string | undefined {
	if (!main) return undefined;
	if (main.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(main)) return undefined;
	return main;
}

/** Errors that mean the file is gone, or the volume holding it is: unmounted, ejected, or failing. */
const SOURCE_GONE_CODES = new Set(["ENOENT", "ENOTDIR", "EIO", "ENXIO", "ENODEV"]);

/** Whether the source entry is still reachable. A compiled binary (no entry) always is. */
export function sourceEntryAvailable(
	entry: string | undefined,
	stat: (file: string) => unknown = file => fs.statSync(file),
): boolean {
	if (!entry) return true;
	try {
		stat(entry);
		return true;
	} catch (error) {
		return !SOURCE_GONE_CODES.has((error as NodeJS.ErrnoException).code ?? "");
	}
}

/**
 * End this process at once when the source it runs from has vanished — typically
 * an external drive with the checkout was unplugged. The native addon is mapped
 * from that checkout and paged in lazily, so the next call into it faults on a
 * page that can no longer be read, and Bun's fault handler then spins on the same
 * unreadable mapping at 100% CPU forever. No cleanup is safe at that point (it
 * would call into the same addon), so the process kills itself; readers already
 * treat its discovery and markers as stale once the pid is gone.
 *
 * Call this before any native call in a periodic task. Returns true if it fired.
 */
export function exitIfSourceGone(
	entry: string | undefined = sourceEntryPath(),
	options: { stat?: (file: string) => unknown; kill?: () => void } = {},
): boolean {
	if (sourceEntryAvailable(entry, options.stat)) return false;
	(options.kill ?? (() => process.kill(process.pid, "SIGKILL")))();
	return true;
}

/** What a session host needs to recognise that its session is still its own. */
export interface SessionHostAuthority {
	/** `<stateRoot>/sdk/<sessionId>.lifecycle.json`, written once by the broker when it spawned this host. */
	markerPath: string;
	pid: number;
	effectMarker: string;
	incarnation: string;
	/** The host's worktree. */
	cwd: string;
}

/**
 * `held`: the marker still names this process and the worktree exists. `lost`: the
 * marker or worktree is gone, or the marker names another process — the session was
 * deleted, taken over, or its whole state root was removed (a finished test). `unknown`:
 * something could not be read for another reason; that is not evidence either way.
 */
export type SessionHostAuthorityState = "held" | "lost" | "unknown";

const GONE_CODES = new Set(["ENOENT", "ENOTDIR"]);

export function checkSessionHostAuthority(
	authority: SessionHostAuthority,
	io: { readFile?: (file: string) => string; stat?: (file: string) => unknown } = {},
): SessionHostAuthorityState {
	const readFile = io.readFile ?? (file => fs.readFileSync(file, "utf8"));
	const stat = io.stat ?? (file => fs.statSync(file));
	const code = (error: unknown) => (error as NodeJS.ErrnoException).code ?? "";
	try {
		stat(authority.cwd);
	} catch (error) {
		return GONE_CODES.has(code(error)) ? "lost" : "unknown";
	}
	let raw: string;
	try {
		raw = readFile(authority.markerPath);
	} catch (error) {
		return GONE_CODES.has(code(error)) ? "lost" : "unknown";
	}
	let marker: { pid?: unknown; effectMarker?: unknown; incarnation?: unknown };
	try {
		marker = JSON.parse(raw) as typeof marker;
	} catch {
		// The broker publishes the marker by atomic rename, so a torn read is not
		// expected; still, one unparsable read alone does not end a live session.
		return "unknown";
	}
	return marker.pid === authority.pid &&
		marker.effectMarker === authority.effectMarker &&
		marker.incarnation === authority.incarnation
		? "held"
		: "lost";
}

/** Consecutive `lost` checks before a host gives up its session (≈15s at the default interval). */
export const SESSION_HOST_LOST_CHECKS = 3;

/**
 * Watch a running session host. It stops (through `onLost`, the host's normal
 * shutdown) once its ownership marker or worktree has been gone for
 * {@link SESSION_HOST_LOST_CHECKS} checks in a row, and kills itself at once if the
 * source checkout it runs from disappears. Before this, a host whose session state
 * had been deleted kept running until someone killed it — for days, after tests.
 * Returns a function that stops the watch.
 */
export function startSessionHostGuard(
	options: SessionHostAuthority & {
		onLost: () => void;
		intervalMs?: number;
		lostChecks?: number;
		check?: (authority: SessionHostAuthority) => SessionHostAuthorityState;
		sourceGuard?: () => boolean;
		setInterval?: typeof setInterval;
		clearInterval?: typeof clearInterval;
	},
): () => void {
	const testInterval = Number(process.env.SKC_SDK_TEST_HOST_GUARD_MS);
	const intervalMs =
		options.intervalMs ??
		(Number.isFinite(testInterval) && testInterval > 0 ? testInterval : PROCESS_GUARD_INTERVAL_MS);
	const lostChecks = options.lostChecks ?? SESSION_HOST_LOST_CHECKS;
	const check = options.check ?? checkSessionHostAuthority;
	const sourceGuard = options.sourceGuard ?? (() => exitIfSourceGone());
	const set = options.setInterval ?? setInterval;
	const clear = options.clearInterval ?? clearInterval;
	let misses = 0;
	let stopped = false;
	const timer = set(() => {
		if (stopped || sourceGuard()) return;
		misses = check(options) === "lost" ? misses + 1 : 0;
		if (misses < lostChecks) return;
		stopped = true;
		clear(timer);
		options.onLost();
	}, intervalMs);
	return () => {
		stopped = true;
		clear(timer);
	};
}
