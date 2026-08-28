import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..", "..");
const installScript = path.join(repoRoot, "scripts", "install.sh");

const EXISTING_BINARY = '#!/bin/sh\necho "skc 0.8.1 (existing install)"\n';
const NEW_BINARY_CONTENT = "#!/bin/sh\necho new-binary\n";
const NEW_BINARY_SHA256 = createHash("sha256").update(NEW_BINARY_CONTENT).digest("hex");
const RELEASE_BINARY_NAME = `skc-${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch}`;

interface Sandbox {
	root: string;
	shimDir: string;
	installDir: string;
}

let sandbox: Sandbox;

function writeCurlShim(
	dir: string,
	options: {
		downloadFails: boolean;
		checksum?: "valid" | "wrong" | "missing" | "duplicate";
	},
): void {
	// Emulates curl just enough for install.sh: the GitHub API call returns a
	// release tag, and the asset download either succeeds (writing to the -o
	// target) or fails like `curl -f` does on an HTTP 404 (exit 22).
	const downloadBranch = options.downloadFails
		? "exit 22"
		: 'printf \'%s\' "$NEW_BINARY_CONTENT" > "$out"\nexit 0';
	const checksum = options.checksum ?? "valid";
	const digest = checksum === "wrong" ? "0".repeat(64) : NEW_BINARY_SHA256;
	const checksumLines =
		checksum === "duplicate"
			? `${digest}  ${RELEASE_BINARY_NAME}\\n${digest}  ${RELEASE_BINARY_NAME}\\n`
			: `${digest}  ${RELEASE_BINARY_NAME}\\n`;
	const checksumBranch =
		checksum === "missing"
			? 'printf "404"\nexit 0'
			: `printf '%b' '${checksumLines}' > "$out"\nprintf "200"\nexit 0`;
	const shim = [
		"#!/bin/sh",
		'url=""',
		'for arg in "$@"; do',
		'  case "$arg" in',
		"    https://github.com/*)",
		'      url="$arg"',
		"      ;;",
		"  esac",
		"done",
		'out=""',
		'prev=""',
		'for arg in "$@"; do',
		'  if [ "$prev" = "-o" ]; then out="$arg"; fi',
		'  prev="$arg"',
		"done",
		'if [ -z "$out" ]; then exit 22; fi',
		'case "$url" in',
		'  */releases/latest)',
		'    printf "https://github.com/jaybeyond/Sayknow_CLI/releases/tag/sayknow-v0.9.0"',
		"    exit 0",
		"    ;;",
		'  *sayknow-release-binaries.sha256)',
		...checksumBranch.split("\n").map(line => `    ${line}`),
		"    ;;",
		"esac",
		downloadBranch,
		"",
	].join("\n");
	const shimPath = path.join(dir, "curl");
	fs.writeFileSync(shimPath, shim);
	fs.chmodSync(shimPath, 0o755);
}

async function runInstaller(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(["sh", installScript, "--binary"], {
		env: {
			...process.env,
			PATH: `${sandbox.shimDir}:/usr/bin:/bin`,
			SKC_INSTALL_DIR: sandbox.installDir,
			NEW_BINARY_CONTENT,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

beforeEach(() => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "skc-install-sh-"));
	const shimDir = path.join(root, "shim-bin");
	const installDir = path.join(root, "install");
	fs.mkdirSync(shimDir, { recursive: true });
	fs.mkdirSync(installDir, { recursive: true });
	sandbox = { root, shimDir, installDir };
});

afterEach(() => {
	fs.rmSync(sandbox.root, { recursive: true, force: true });
});

describe("install.sh binary upgrades", () => {
	test("a failed download leaves the existing skc binary untouched", async () => {
		const existingPath = path.join(sandbox.installDir, "skc");
		fs.writeFileSync(existingPath, EXISTING_BINARY);
		fs.chmodSync(existingPath, 0o755);
		writeCurlShim(sandbox.shimDir, { downloadFails: true });

		const result = await runInstaller();

		expect(result.exitCode).not.toBe(0);
		expect(fs.existsSync(existingPath)).toBe(true);
		expect(fs.readFileSync(existingPath, "utf8")).toBe(EXISTING_BINARY);
	});

	test("wrong or missing integrity metadata preserves the existing binary", async () => {
		for (const checksum of ["wrong", "missing"] as const) {
			const existingPath = path.join(sandbox.installDir, "skc");
			fs.writeFileSync(existingPath, EXISTING_BINARY);
			fs.chmodSync(existingPath, 0o755);
			writeCurlShim(sandbox.shimDir, { downloadFails: false, checksum });

			const result = await runInstaller();

			expect(result.exitCode).not.toBe(0);
			expect(fs.readFileSync(existingPath, "utf8")).toBe(EXISTING_BINARY);
			expect(fs.readdirSync(sandbox.installDir)).toEqual(["skc"]);
		}
	});

	test("duplicate checksum entries fail closed without changing the binary", async () => {
		const existingPath = path.join(sandbox.installDir, "skc");
		fs.writeFileSync(existingPath, EXISTING_BINARY);
		writeCurlShim(sandbox.shimDir, { downloadFails: false, checksum: "duplicate" });
		const result = await runInstaller();
		expect(result.exitCode).not.toBe(0);
		expect(fs.readFileSync(existingPath, "utf8")).toBe(EXISTING_BINARY);
		expect(result.stderr).toContain("exactly one SHA-256");
	});


	test("an existing installer lock fails closed without changing the binary", async () => {
		const existingPath = path.join(sandbox.installDir, "skc");
		fs.writeFileSync(existingPath, EXISTING_BINARY);
		fs.mkdirSync(path.join(sandbox.installDir, ".skc-install.lock"));
		writeCurlShim(sandbox.shimDir, { downloadFails: false });

		const result = await runInstaller();

		expect(result.exitCode).not.toBe(0);
		expect(fs.readFileSync(existingPath, "utf8")).toBe(EXISTING_BINARY);
		expect(result.stderr).toContain("Another SKC installer is already running");
		expect(fs.statSync(path.join(sandbox.installDir, ".skc-install.lock")).isDirectory()).toBe(true);
	});

	test("a successful download replaces the binary and leaves no temp files", async () => {
		const existingPath = path.join(sandbox.installDir, "skc");
		fs.writeFileSync(existingPath, EXISTING_BINARY);
		fs.chmodSync(existingPath, 0o755);
		writeCurlShim(sandbox.shimDir, { downloadFails: false });

		const result = await runInstaller();

		expect(result.exitCode).toBe(0);
		expect(fs.readFileSync(existingPath, "utf8")).toBe(NEW_BINARY_CONTENT);
		// The install must be executable and must not leave partial download
		// artifacts next to the binary.
		expect(fs.statSync(existingPath).mode & 0o100).toBe(0o100);
		expect(fs.readdirSync(sandbox.installDir)).toEqual(["skc"]);
	});
});
