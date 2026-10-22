import { afterEach, describe, expect, it } from "bun:test";
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Issue #4773: `accountHomeFromSystem()`'s final fallback is
 * `os.userInfo().homedir`, which in this runtime is the environment home
 * (`HOME` on POSIX, `USERPROFILE` on Windows) returned verbatim whenever it is
 * set — the account database is consulted only when it is absent. So on an
 * identity without a usable local passwd entry (NSS/LDAP/SSSD, distroless)
 * and on non-Linux, the ambiguous branch could accept attacker-influenced
 * input as the trusted home, and the config root / agent dir it derived then
 * supplied `.env` files that `$credentialEnv` treats as trusted.
 *
 * The contract (landed with the independent-evidence rule in dirs.ts): in the
 * ambiguous branch the account home is admissible only when it does not
 * merely echo the runtime home. When no such independent evidence exists, the
 * trusted home resolves to the filesystem-root sentinel, user state is marked
 * unavailable, and every user-scope accessor refuses with
 * "User state is unavailable: no trustworthy home directory" — credentials
 * are never read from a checkout-controlled home.
 *
 * These are the discriminating regression tests for that rule on the shape
 * PR #4766's macOS repro cannot reach: a Linux identity whose uid has NO
 * entry in local /etc/passwd. An unprivileged user namespace with a
 * subordinate uid provides exactly that without root; the tests are
 * Linux-only, and when no user-namespace capability exists on the host they
 * skip with a loud warning naming the lost security coverage.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "trusted-home-failopen-probe.ts");

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-trusted-home-"));
	tempDirs.push(dir);
	return dir;
}

/** The platform-authoritative home variable, the only one that can select the trusted home. */
function homeEnvKey(): "HOME" | "USERPROFILE" {
	return process.platform === "win32" ? "USERPROFILE" : "HOME";
}

/** A checkout whose `.env` declares the platform-authoritative home key. */
function projectDir(homeValue: string): string {
	const dir = tempDir();
	fs.writeFileSync(path.join(dir, ".env"), `${homeEnvKey()}=${homeValue}\n`);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface ProbeResult {
	ok: boolean;
	trustedHome?: string;
	error?: string;
}

/** Run the probe as a subprocess; a refusal is reported as ok:false. */
function runProbe(cwd: string, envHome: string | undefined): ProbeResult {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	delete env.SKC_CODING_AGENT_DIR;
	delete env.SKC_CONFIG_DIR;
	delete env.PI_CONFIG_DIR;
	// Both platform home variables start cleared so the opposite-platform
	// variable (or a dotenv value overlaid into it) cannot redirect the
	// resolution; only the authoritative one is set when requested.
	delete env.HOME;
	delete env.USERPROFILE;
	if (envHome !== undefined) env[homeEnvKey()] = envHome;

	const result = Bun.spawnSync({
		cmd: [process.execPath, PROBE],
		cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = new TextDecoder().decode(result.stdout).trim();
	if (stdout) {
		try {
			return JSON.parse(stdout) as ProbeResult;
		} catch {}
	}
	return { ok: false, error: `probe exited ${result.exitCode}: ${new TextDecoder().decode(result.stderr).trim()}` };
}

/**
 * Run the probe under an unprivileged user namespace whose mapped uid has no
 * /etc/passwd entry — the NSS-less identity shape the fail-open needs.
 *
 * The candidate uid is chosen so the premise is verifiably true: the default
 * subordinate uid is skipped when the host's /etc/passwd already contains it,
 * and the first unused uid from the invoking user's /etc/subuid range is used
 * instead; when every candidate is taken the shape is unavailable, never
 * assumed. The exact `unshare` argument shape differs by util-linux/kernel
 * policy (group mapping sometimes needs setgroups handling, some hosts allow
 * user-mapping only), so every candidate form is probed and the first working
 * one is reused by the probe runner.
 *
 * These tests are Linux-only (the shape needs the passwd lookup to miss) and
 * require unprivileged user namespaces, which not every container permits.
 * When the capability is missing the tests skip with a loud warning naming the
 * lost coverage, so a restricted host shows it in the log instead of failing
 * for reasons unrelated to the code under test.
 */
function passwdUids(): Set<string> {
	try {
		return new Set(
			fs
				.readFileSync("/etc/passwd", "utf8")
				.split("\n")
				.map(line => line.split(":")[2]),
		);
	} catch {
		return new Set();
	}
}

/** Candidate unmapped uids: the common subordinate default, then this user's /etc/subuid range. */
function candidateUids(): number[] {
	const taken = passwdUids();
	const candidates: number[] = [];
	for (const uid of [100000, 165536]) {
		if (!taken.has(String(uid))) candidates.push(uid);
	}
	try {
		const user = os.userInfo().username;
		for (const line of fs.readFileSync("/etc/subuid", "utf8").split("\n")) {
			const fields = line.split(":");
			if (fields[0] !== user || !fields[1] || !fields[2]) continue;
			const start = Number(fields[1]);
			const count = Number(fields[2]);
			if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || count <= 0) continue;
			for (let offset = 0; offset < count && candidates.length < 8; offset++) {
				const uid = start + offset;
				if (!taken.has(String(uid))) candidates.push(uid);
			}
		}
	} catch {}
	return [...new Set(candidates)];
}

let usernsSetup: { args: string[]; uid: number } | undefined | null;
function userNamespace(): { args: string[]; uid: number } | undefined {
	if (usernsSetup !== undefined) return usernsSetup ?? undefined;
	usernsSetup = null;
	if (process.platform !== "linux") return undefined;
	for (const uid of candidateUids()) {
		for (const form of [
			["-U", "--map-user", String(uid), "--map-group", String(uid)],
			["-U", "--map-user", String(uid)],
			["-U", "--map-user", String(uid), "--setgroups=deny", "--map-group", String(uid)],
		]) {
			try {
				const result = child_process.spawnSync(
					"unshare",
					[...form, process.execPath, "-e", "console.log(process.getuid())"],
					{ encoding: "utf8", timeout: 15_000 },
				);
				if (result.status === 0 && result.stdout.trim() === String(uid)) {
					usernsSetup = { args: form, uid };
					return usernsSetup;
				}
			} catch {}
		}
	}
	return undefined;
}

/** Run the probe under a uid that has no local passwd entry. */
function runProbeWithoutPasswdEntry(cwd: string, envHome: string | undefined): ProbeResult {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	delete env.SKC_CODING_AGENT_DIR;
	delete env.SKC_CONFIG_DIR;
	delete env.PI_CONFIG_DIR;
	delete env.USERPROFILE;
	if (envHome === undefined) delete env.HOME;
	else env.HOME = envHome;

	const result = child_process.spawnSync("unshare", [...(userNamespace()?.args ?? []), process.execPath, PROBE], {
		cwd,
		env,
		encoding: "utf8",
		timeout: 30_000,
	});
	const stdout = (result.stdout ?? "").trim();
	if (stdout) {
		try {
			return JSON.parse(stdout) as ProbeResult;
		} catch {}
	}
	return { ok: false, error: `probe exited ${result.status}: ${(result.stderr ?? "").trim()}` };
}

describe("trusted-home fail-open regression (#4773)", () => {
	it("fails closed when the .env-declared home is indistinguishable and no passwd-independent source exists", () => {
		// The exact #4773 shape: an identity with no usable local passwd entry
		// plus a checkout whose .env declares HOME equal to the inherited
		// value. The vulnerable build accepted the attacker-influenced home as
		// trusted; it must refuse instead.
		if (process.platform !== "linux") return;
		if (!userNamespace()) {
			console.warn(
				"[#4773] SKIPPING the no-passwd-entry regression: no usable unprivileged user namespace on this host; the independent-evidence rule is only covered by the compat shapes here",
			);
			return;
		}
		const hostile = path.join(tempDir(), "attacker-home");
		const cwd = projectDir(hostile);
		const resolved = runProbeWithoutPasswdEntry(cwd, hostile);
		expect(resolved.ok).toBe(false);
		expect(resolved.error ?? "").toContain("User state is unavailable: no trustworthy home directory");
		expect(JSON.stringify(resolved)).not.toContain(hostile);
	});

	it("does not expose the hostile home even when resolution fails", () => {
		if (process.platform !== "linux") return;
		if (!userNamespace()) {
			console.warn(
				"[#4773] SKIPPING the no-passwd-entry regression: no usable unprivileged user namespace on this host",
			);
			return;
		}
		const hostile = "/definitely-not-a-real-home-4773";
		const cwd = projectDir(hostile);
		const resolved = runProbeWithoutPasswdEntry(cwd, hostile);
		expect(resolved.ok).toBe(false);
		expect(JSON.stringify(resolved)).not.toContain(hostile);
	});

	it("still honors the passwd home for a passwd-backed uid in the ambiguous branch", () => {
		// Compatibility: an ordinary Linux identity keeps working exactly as
		// before — the local passwd entry, not the .env declaration, selects
		// the trusted home.
		if (process.platform !== "linux") return;
		const passwdHome = (() => {
			const uid = os.userInfo().uid;
			for (const line of fs.readFileSync("/etc/passwd", "utf8").split("\n")) {
				const fields = line.split(":");
				if (fields[2] === String(uid)) return fields[5];
			}
			return undefined;
		})();
		// Mirror the resolver's own validity rule: an absolute, non-root passwd
		// home is what production accepts, and it is used verbatim.
		if (!passwdHome || !path.isAbsolute(passwdHome) || passwdHome === path.parse(passwdHome).root) return;
		const cwd = projectDir("/attacker/echo-home");
		const resolved = runProbe(cwd, "/attacker/echo-home");
		expect(resolved.ok).toBe(true);
		expect(resolved.trustedHome).toBe(passwdHome);
	});

	it("still honors the account home when the platform home variable is absent", () => {
		// Authoritative home variable absent: userInfo().homedir consults the
		// account database (or the Windows token profile), so the value is
		// independent and accepted. On Linux without a passwd entry Bun throws
		// ENOENT, which also resolves to the fail-closed refusal.
		const cwd = projectDir("/attacker/planted-home-4773");
		const resolved = runProbe(cwd, undefined);
		if (process.platform === "win32") {
			// USERPROFILE absent: libuv falls back to the access-token profile
			// directory, which the environment cannot plant.
			expect(resolved.ok).toBe(true);
			expect(resolved.trustedHome).toBeTruthy();
		} else if (resolved.ok) {
			// The real HOME is absent in the child, so os.userInfo().homedir
			// consults the account database rather than echoing an env value;
			// a planted dotenv HOME never becomes the trusted home.
			expect(resolved.trustedHome).toBe(path.resolve(resolved.trustedHome ?? ""));
			expect(resolved.trustedHome).not.toBe("/attacker/planted-home-4773");
		} else {
			expect(resolved.error ?? "").toContain("User state is unavailable: no trustworthy home directory");
		}
	});

	it("keeps the operator's distinct runtime home in the non-ambiguous branch", () => {
		// A .env declaring a DIFFERENT home than the inherited one is not
		// ambiguous: the operator's own environment wins, unchanged.
		const hostile = path.join(tempDir(), "planted-home");
		const operatorHome = tempDir();
		const cwd = projectDir(hostile);
		const resolved = runProbe(cwd, operatorHome);
		expect(resolved.ok).toBe(true);
		expect(resolved.trustedHome).toBe(operatorHome);
	});

	it("a dynamic .env home stays ambiguous and never becomes trusted", () => {
		// Dynamic dotenv declarations are ambiguous regardless of the runtime
		// value, so the account database must decide — never the env value.
		const dir = tempDir();
		fs.writeFileSync(path.join(dir, ".env"), `${homeEnvKey()}=$PLANTED/x\n`);
		const planted = path.join(tempDir(), "dynamic-home");
		const resolved = runProbe(dir, planted);
		if (resolved.ok) {
			expect(resolved.trustedHome).not.toBe(planted);
		} else {
			expect(resolved.error ?? "").toContain("User state is unavailable: no trustworthy home directory");
		}
	});
});
