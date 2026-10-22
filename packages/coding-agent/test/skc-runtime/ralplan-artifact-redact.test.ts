import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runNativeRalplanCommand as runRalplanCliCommand } from "../../src/skc-runtime/ralplan-runtime";

const SESSION = "ralplan-redact-session";
const SECRET = "sk-ant-api03-ralplanartifactsecret";
const TOKEN = "ralplan-bearer-token-value";
let previousSession: string | undefined;

beforeAll(() => {
	previousSession = process.env.SKC_SESSION_ID;
	process.env.SKC_SESSION_ID = SESSION;
});

afterAll(() => {
	if (previousSession === undefined) delete process.env.SKC_SESSION_ID;
	else process.env.SKC_SESSION_ID = previousSession;
});

async function tempDir(): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), "ralplan-redact-"));
}

describe("skc ralplan --write artifact scrub", () => {
	it("drops credential shapes from planner and pending-approval bodies", async () => {
		const root = await tempDir();
		try {
			const body = `# Plan\nUse ${SECRET} and Bearer ${TOKEN}.\nKeep src/app.ts.\n`;
			const planner = await runRalplanCliCommand(
				["--write", "--stage", "planner", "--stage_n", "1", "--artifact", body, "--run-id", "redact-run", "--json"],
				root,
			);
			expect(planner.status).toBe(0);
			const plannerPayload = JSON.parse(planner.stdout ?? "{}") as { sha256: string; path: string };
			const stored = await fs.readFile(plannerPayload.path, "utf8");
			expect(stored).not.toContain(SECRET);
			expect(stored).not.toContain(TOKEN);
			expect(stored).toContain("src/app.ts");
			expect(createHash("sha256").update(stored).digest("hex")).toBe(plannerPayload.sha256);

			const finalWrite = await runRalplanCliCommand(
				[
					"--write",
					"--stage",
					"final",
					"--stage_n",
					"2",
					"--artifact",
					`# Final\n${SECRET}\n`,
					"--run-id",
					"redact-run",
					"--json",
				],
				root,
			);
			expect(finalWrite.status).toBe(0);
			const finalPayload = JSON.parse(finalWrite.stdout ?? "{}") as {
				path: string;
				sha256: string;
				pending_approval_path: string;
			};
			const stage = await fs.readFile(finalPayload.path, "utf8");
			const pending = await fs.readFile(finalPayload.pending_approval_path, "utf8");
			expect(pending).toBe(stage);
			expect(pending).not.toContain(SECRET);
			expect(createHash("sha256").update(stage).digest("hex")).toBe(finalPayload.sha256);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("keeps an ordinary plan and dedupes an identical rewrite", async () => {
		const root = await tempDir();
		try {
			const body = "# Plan\nKeep src/app.ts and the ordinary review note.\n";
			const args = [
				"--write",
				"--stage",
				"planner",
				"--stage_n",
				"1",
				"--artifact",
				body,
				"--run-id",
				"plain-run",
				"--json",
			];
			const first = await runRalplanCliCommand(args, root);
			expect(first.status).toBe(0);
			const payload = JSON.parse(first.stdout ?? "{}") as { path: string; sha256: string };
			expect(await fs.readFile(payload.path, "utf8")).toBe(body);
			const second = await runRalplanCliCommand(args, root);
			expect(second.status).toBe(0);
			const again = JSON.parse(second.stdout ?? "{}") as { deduplicated?: boolean; sha256: string };
			expect(again.deduplicated).toBe(true);
			expect(again.sha256).toBe(payload.sha256);
			expect(await fs.readFile(payload.path, "utf8")).toBe(body);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

const PROPERTY_SEED = 5472026;

describe("scrubRalplanPersistedBody property", () => {
	it("property: scrub idempotence and safe-text agreement, seed 5472026, 64 inputs", async () => {
		const { scrubRalplanPersistedBody } = await import("../../src/skc-runtime/ralplan-runtime");
		// Seeded xorshift32 generator; fast-check is not a fork dependency.
		let state = PROPERTY_SEED;
		const next = (bound: number): number => {
			state ^= state << 13;
			state ^= state >>> 17;
			state ^= state << 5;
			return (state >>> 0) % bound;
		};
		for (let run = 0; run < 64; run++) {
			const index = next(10_000);
			const note = `note${next(10_000)}`;
			const safe = `# Plan\nKeep src/file${index}.ts ${note}.\n`;
			expect(scrubRalplanPersistedBody(safe)).toBe(safe);
			expect(scrubRalplanPersistedBody(safe)).toBe(scrubRalplanPersistedBody(scrubRalplanPersistedBody(safe)));
			const planted = `# Plan\n${SECRET} ${note}\n`;
			const redacted = scrubRalplanPersistedBody(planted);
			expect(redacted).not.toContain(SECRET);
			expect(redacted).toContain(note);
			expect(scrubRalplanPersistedBody(redacted)).toBe(redacted);
		}
	});
});

describe("ralplan OSC strip on the write path", () => {
	it("a long run of unterminated ESC prefixes stays cheap before persistence", async () => {
		const { scrubRalplanPersistedBody } = await import("../../src/skc-runtime/ralplan-runtime");
		const count = 80_000;
		const body = `${"\u001b]".repeat(count)}TAIL`;
		const started = performance.now();
		const stored = scrubRalplanPersistedBody(body);
		expect(performance.now() - started).toBeLessThan(1_000);
		expect(stored).toBe(`${"]".repeat(count)}TAIL\n`);
	}, 30_000);

	it("a file of repeated terminated OSC sequences stays cheap on write", async () => {
		const root = await tempDir();
		try {
			const count = 120_000;
			const between = "plan: keep this sentence";
			const artifactPath = path.join(root, "planner.md");
			await fs.writeFile(
				artifactPath,
				`${"\u001b]x\u0007".repeat(count)}${between}${"\u001b]y\u001b\\".repeat(count)}`,
			);
			const started = performance.now();
			const written = await runRalplanCliCommand(
				[
					"--write",
					"--stage",
					"planner",
					"--stage_n",
					"1",
					"--artifact",
					artifactPath,
					"--run-id",
					"osc-repeat",
					"--json",
				],
				root,
			);
			expect(performance.now() - started).toBeLessThan(1_000);
			expect(written.status).toBe(0);
			const payload = JSON.parse(written.stdout ?? "{}") as { path: string };
			const stored = await fs.readFile(payload.path, "utf8");
			expect(stored).toContain(between);
			expect(stored).not.toContain("\u001b]");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 30_000);
});
