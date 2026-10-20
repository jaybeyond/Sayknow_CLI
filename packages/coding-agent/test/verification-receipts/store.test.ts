import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	envelopeOf,
	RECEIPT_MAX_BYTES,
	RECEIPTS_PER_REPO,
	type Receipt,
	type SourceFingerprint,
	sha256Hex,
	validateEnvelope,
} from "../../bundles/verification-receipts/hooks/verification-gate";
import { loadRepoReceipts, storeReceipt } from "../../bundles/verification-receipts/tools/verification-status";
import { cleanupTemps, git, loadInstalled, mkEnv, mkPi, mkRepo, mkTemp, sess, write } from "./helpers";

afterEach(cleanupTemps);

async function runOnce(env: Awaited<ReturnType<typeof mkEnv>>, repo: string, files = ["a.test.ts"]) {
	const m = await loadInstalled(env);
	const d = await m.run.executeRun(
		mkPi(repo, env),
		sess(),
		"c1",
		{ files },
		undefined,
		{ env: env.env },
		env.toolsDir,
	);
	return { m, d };
}

describe("verification_status", () => {
	it("recomputes freshness: fresh, stale after an edit, fresh again after restoring", async () => {
		const env = await mkEnv();
		const repo = await mkRepo();
		const { m, d } = await runOnce(env, repo);
		const pi = mkPi(repo, env);
		const status = async () => m.status.runStatus(pi, sess(), { receiptId: d.receiptId as string });
		expect((await status()).freshness).toBe("fresh");
		await write(repo, "a.ts", "export const a = 99;\n");
		const stale = await status();
		expect(stale).toMatchObject({ status: "ok", freshness: "stale", storedFreshness: "fresh" });
		expect(stale.execution?.status).toBe("passed");
		await write(repo, "a.ts", "export const a = 1;\n");
		// R4-3: the restored file may still be stat-dirty (hashed raw -> stale) or not, depending on mtime
		// granularity; both are safe because the content equals the index. Refresh makes the outcome deterministic.
		await git(repo, "update-index", "--refresh");
		expect((await status()).freshness).toBe("fresh");
	});

	it("is stale when the selected test file itself changes", async () => {
		const env = await mkEnv();
		const repo = await mkRepo();
		const { m, d } = await runOnce(env, repo);
		await write(repo, "a.test.ts", `${await Bun.file(path.join(repo, "a.test.ts")).text()}// tweak\n`);
		expect((await m.status.runStatus(mkPi(repo, env), sess(), { receiptId: d.receiptId as string })).freshness).toBe(
			"stale",
		);
	});

	it("rejects a non-uuid receiptId before any path join and reports not_found for unknown ids", async () => {
		const env = await mkEnv();
		const repo = await mkRepo();
		const m = await loadInstalled(env);
		const pi = mkPi(repo, env);
		for (const bad of ["../../etc/passwd", "ABCDEF00-0000-0000-0000-000000000000", "x"]) {
			expect(await m.status.runStatus(pi, sess(), { receiptId: bad })).toMatchObject({
				status: "blocked",
				reason: "invalid_receipt_id",
			});
		}
		const unknown = await m.status.runStatus(pi, sess(), { receiptId: "11111111-1111-4111-8111-111111111111" });
		expect(unknown.status).toBe("not_found");
		// The tool schema is strict and enforces the same pattern before execute runs.
		const tool = m.status.default(pi);
		expect(tool.parameters.safeParse({ receiptId: "nope" }).success).toBe(false);
		expect(tool.parameters.safeParse({ receiptId: "11111111-1111-4111-8111-111111111111", extra: 1 }).success).toBe(
			false,
		);
	});

	it("does not trust a tampered receipt file", async () => {
		const env = await mkEnv();
		const repo = await mkRepo();
		const { m, d } = await runOnce(env, repo);
		const dir = path.join(env.storeRoot, "receipts", "v1");
		const [repoDir] = await fs.readdir(dir);
		const file = path.join(dir, repoDir as string, `${d.receiptId}.json`);
		const body = JSON.parse(await fs.readFile(file, "utf8"));
		body.receipt.execution.status = "failed";
		await fs.chmod(file, 0o600);
		await fs.writeFile(file, JSON.stringify(body));
		const res = await m.status.runStatus(mkPi(repo, env), sess(), { receiptId: d.receiptId as string });
		expect(res).toMatchObject({ status: "not_found", storage: "receipt_unavailable" });
	});
});

describe("store safety", () => {
	it("a symlinked skc-plugin-data fails closed with unsafe_permissions", async () => {
		const env = await mkEnv();
		const repo = await mkRepo();
		const elsewhere = await mkTemp("skc-vr-elsewhere-");
		await fs.symlink(elsewhere, path.join(env.agentDir, "skc-plugin-data"));
		const { d } = await runOnce(env, repo);
		expect(d.execution).toMatchObject({ status: "unavailable", reason: "store_unavailable" });
		expect(d.warnings).toContain("unsafe_permissions");
		expect(await fs.readdir(elsewhere)).toEqual([]);
	});

	it("a group/other-writable data root is refused", async () => {
		const env = await mkEnv();
		const repo = await mkRepo();
		await fs.mkdir(path.join(env.agentDir, "skc-plugin-data"), { mode: 0o700 });
		await fs.chmod(path.join(env.agentDir, "skc-plugin-data"), 0o777);
		const { d } = await runOnce(env, repo);
		expect(d.warnings).toContain("unsafe_permissions");
		await fs.chmod(path.join(env.agentDir, "skc-plugin-data"), 0o700);
	});

	it("a project-scope layout (<proj>/.skc) returns project_scope_unsupported and creates nothing", async () => {
		const env = await mkEnv();
		const repo = await mkRepo();
		const projAgent = path.join(repo, ".skc");
		const tools = path.join(projAgent, "skc-plugins", "verification-receipts", "tools");
		await fs.mkdir(tools, { recursive: true });
		const m = await loadInstalled(env);
		const d = await m.run.executeRun(
			mkPi(repo, env),
			sess(),
			"c",
			{ files: ["a.test.ts"] },
			undefined,
			{ env: env.env },
			tools,
		);
		expect(d.warnings).toContain("project_scope_unsupported");
		expect(await fs.readdir(projAgent)).toEqual(["skc-plugins"]);
		const loop = await m.loop.executeLoop(
			mkPi(repo, env),
			{ sessionManager: { ...sess().sessionManager, getLeafId: () => null, getEntry: () => undefined } },
			{ env: env.env },
			tools,
		);
		expect(loop).toMatchObject({ status: "blocked", reason: "store_unavailable:project_scope_unsupported" });
	});

	it("an uninstalled layout (running from the checkout) is inert", async () => {
		const env = await mkEnv();
		const repo = await mkRepo();
		const run = await import("../../bundles/verification-receipts/tools/verification-run");
		const d = await run.executeRun(mkPi(repo, env), sess(), "c", { files: ["a.test.ts"] }, undefined, {
			env: env.env,
		});
		expect(d.warnings).toContain("uninstalled_layout");
	});

	it("a layout that disagrees with the live agent dir is refused", async () => {
		const env = await mkEnv();
		const repo = await mkRepo();
		const other = await mkEnv();
		const m = await loadInstalled(env);
		const d = await m.run.executeRun(
			mkPi(repo, other),
			sess(),
			"c",
			{ files: ["a.test.ts"] },
			undefined,
			{ env: env.env },
			env.toolsDir,
		);
		expect(d.warnings).toContain("layout_mismatch");
	});
});

const H = (c: string): string => c.repeat(64);
const COUNTS = { tests: 2, passed: 2, failed: 0, errors: 0, skipped: 0 };
const fpOf = (): SourceFingerprint => ({
	status: "available",
	reason: "observed_source",
	subreason: null,
	head: null,
	sourceDigest: H("a"),
	selectedDigest: H("b"),
	digest: H("c"),
	counts: { indexEntries: 1, dirtyPaths: 0, hashedBytes: 0 },
});
function mkReceipt(startedAt = 1_700_000_000_000, over: Partial<Receipt> = {}): Receipt {
	return {
		schemaVersion: 1,
		plugin: "verification-receipts",
		pluginVersion: "0.1.0",
		id: crypto.randomUUID(),
		runner: "bun-test",
		runnerVersion: "1.3.14",
		repositoryDigest: H("d"),
		toolCallDigest: H("e"),
		sessionDigest: H("f"),
		startedAt,
		finishedAt: startedAt + 5,
		durationMs: 5,
		specDigest: H("1"),
		selectedInputs: ["a.test.ts"],
		before: fpOf(),
		after: fpOf(),
		freshness: "fresh",
		execution: {
			status: "passed",
			reason: "native_success",
			exitCode: 0,
			signal: null,
			counts: { ...COUNTS },
			perInput: [{ ...COUNTS }],
			outputBytes: 10,
		},
		advisoryOnly: true,
		limitations: [],
		...over,
	};
}
const withExec = (patch: Record<string, unknown>): Receipt => {
	const r = mkReceipt();
	return { ...r, execution: { ...r.execution, ...patch } as Receipt["execution"] };
};

describe("validateEnvelope (load validation guards the passed rule)", () => {
	it("accepts a well-formed passed receipt", () => {
		const r = mkReceipt();
		expect(validateEnvelope(envelopeOf(r), r.id)).toEqual(r);
	});

	it("rejects forged `passed` receipts even when inputDigest is recomputed over the forgery", () => {
		const one = { tests: 1, passed: 1, failed: 0, errors: 0, skipped: 0 };
		const cases: Array<[string, Receipt]> = [
			["nonzero exit code", withExec({ exitCode: 1 })],
			["null exit code", withExec({ exitCode: null })],
			["signal present", withExec({ signal: "SIGSEGV" })],
			[
				"zero tests",
				withExec({ counts: { ...COUNTS, tests: 0, passed: 0 }, perInput: [{ ...COUNTS, tests: 0, passed: 0 }] }),
			],
			["zero passed", withExec({ counts: { ...COUNTS, passed: 0 }, perInput: [{ ...COUNTS, passed: 0 }] })],
			["failures present", withExec({ counts: { ...COUNTS, failed: 1 }, perInput: [{ ...COUNTS, failed: 1 }] })],
			["errors present", withExec({ counts: { ...COUNTS, errors: 1 }, perInput: [{ ...COUNTS, errors: 1 }] })],
			[
				"a selected input that executed nothing (tests - skipped < 1)",
				withExec({ counts: { ...COUNTS, skipped: 2 }, perInput: [{ ...COUNTS, skipped: 2 }] }),
			],
			["perInput sums disagree with counts", withExec({ counts: { ...COUNTS, tests: 3, passed: 3 } })],
			["perInput is null", withExec({ perInput: null })],
			[
				"perInput length differs from selectedInputs",
				withExec({ perInput: [{ ...one }, { ...one }], counts: { ...COUNTS } }),
			],
			[
				"counts out of range",
				withExec({ counts: { ...COUNTS, tests: 100_001 }, perInput: [{ ...COUNTS, tests: 100_001 }] }),
			],
		];
		for (const [name, forged] of cases) {
			expect([name, validateEnvelope(envelopeOf(forged), forged.id)]).toEqual([name, null]);
		}
	});

	it("rejects structural violations: keys, ids, schema, digests, fingerprints, bounds", () => {
		const base = mkReceipt();
		const mutations: Array<[string, (r: Record<string, unknown>) => void]> = [
			[
				"extra receipt key",
				r => {
					r.extra = 1;
				},
			],
			["missing receipt key", r => Reflect.deleteProperty(r, "limitations")],
			[
				"schemaVersion",
				r => {
					r.schemaVersion = 2;
				},
			],
			[
				"plugin",
				r => {
					r.plugin = "other";
				},
			],
			[
				"advisoryOnly",
				r => {
					r.advisoryOnly = false;
				},
			],
			[
				"runner",
				r => {
					r.runner = "jest";
				},
			],
			[
				"non-hex digest",
				r => {
					r.specDigest = "xyz";
				},
			],
			[
				"short digest",
				r => {
					r.sessionDigest = "ab";
				},
			],
			[
				"empty selectedInputs",
				r => {
					r.selectedInputs = [];
				},
			],
			[
				"33 selectedInputs",
				r => {
					r.selectedInputs = Array.from({ length: 33 }, (_, i) => `f${i}.test.ts`);
				},
			],
			[
				"21 limitations",
				r => {
					r.limitations = Array.from({ length: 21 }, () => "x");
				},
			],
			[
				"available fingerprint without digest",
				r => {
					(r.after as SourceFingerprint).digest = null;
				},
			],
			[
				"unavailable fingerprint with digest",
				r => Object.assign(r.before as SourceFingerprint, { status: "unavailable" }),
			],
			[
				"fingerprint extra key",
				r => {
					(r.before as unknown as Record<string, unknown>).extra = 1;
				},
			],
			[
				"fingerprint counts key",
				r => {
					(r.before as SourceFingerprint).counts = { indexEntries: 1 } as never;
				},
			],
			[
				"execution extra key",
				r => {
					(r.execution as unknown as Record<string, unknown>).extra = 1;
				},
			],
		];
		for (const [name, mutate] of mutations) {
			const clone = structuredClone(base) as unknown as Record<string, unknown>;
			mutate(clone);
			const forged = clone as unknown as Receipt;
			expect([name, validateEnvelope(envelopeOf(forged), forged.id)]).toEqual([name, null]);
		}
		expect(validateEnvelope(envelopeOf(base), crypto.randomUUID())).toBeNull(); // uuid != file name
		expect(validateEnvelope(envelopeOf({ ...base, id: "not-a-uuid" }), "not-a-uuid")).toBeNull();
		const env = envelopeOf(base);
		expect(validateEnvelope({ ...env, inputDigest: H("0") }, base.id)).toBeNull(); // digest not recomputed
		expect(validateEnvelope({ ...env, extra: 1 }, base.id)).toBeNull();
		expect(validateEnvelope({ ...env, storageSchemaVersion: 2 }, base.id)).toBeNull();
		expect(validateEnvelope(null, base.id)).toBeNull();
		expect(validateEnvelope([], base.id)).toBeNull();
	});
});

describe("storeReceipt admission and eviction", () => {
	async function mkStore() {
		const tmp = await mkTemp("skc-vr-receipts-");
		const storeRoot = path.join(tmp, "verification-receipts");
		const dir = path.join(storeRoot, "receipts", "v1", H("d"));
		return { storeRoot, dir };
	}
	const seed = async (dir: string, r: Receipt, mtime: number): Promise<void> => {
		const file = path.join(dir, `${r.id}.json`);
		await fs.writeFile(file, JSON.stringify(envelopeOf(r)), { mode: 0o600 });
		await fs.utimes(file, mtime / 1000, mtime / 1000);
	};

	it("stores, loads newest first, and never replaces an existing receipt", async () => {
		const { storeRoot, dir } = await mkStore();
		const older = mkReceipt(1_700_000_000_000);
		const newer = mkReceipt(1_700_000_100_000);
		expect(await storeReceipt(fs, storeRoot, older)).toBe("stored");
		expect(await storeReceipt(fs, storeRoot, newer)).toBe("stored");
		expect((await loadRepoReceipts(fs, storeRoot, H("d"))).map(r => r.id)).toEqual([newer.id, older.id]);
		const before = await fs.readFile(path.join(dir, `${older.id}.json`), "utf8");
		expect(await storeReceipt(fs, storeRoot, { ...older, durationMs: 99 })).toBe("store_unavailable");
		expect(await fs.readFile(path.join(dir, `${older.id}.json`), "utf8")).toBe(before);
		expect((await fs.readdir(dir)).filter(n => n.startsWith(".tmp-"))).toEqual([]);
	});

	it("evicts FIFO by age at the per-repo count limit and keeps the newest", async () => {
		const { storeRoot, dir } = await mkStore();
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		const seeded: Receipt[] = [];
		for (let i = 0; i < RECEIPTS_PER_REPO; i++) {
			const r = mkReceipt(1_700_000_000_000 + i);
			seeded.push(r);
			await seed(dir, r, 1_700_000_000_000 + i * 1000);
		}
		const fresh = mkReceipt(1_800_000_000_000);
		expect(await storeReceipt(fs, storeRoot, fresh)).toBe("stored");
		const names = await fs.readdir(dir);
		expect(names.filter(n => n.endsWith(".json"))).toHaveLength(RECEIPTS_PER_REPO);
		expect(names).toContain(`${fresh.id}.json`);
		expect(names).not.toContain(`${seeded[0]?.id}.json`);
		expect(names).toContain(`${seeded[1]?.id}.json`);
	}, 30_000);

	it("a foreign file, a non-uuid name or a directory makes admission store_corrupt without evicting anything", async () => {
		for (const plant of [
			(dir: string) => fs.writeFile(path.join(dir, "foreign.txt"), "x"),
			(dir: string) => fs.writeFile(path.join(dir, "ABCDEF00-0000-0000-0000-000000000000.json"), "x"),
			(dir: string) => fs.mkdir(path.join(dir, `${crypto.randomUUID()}.json`)),
		]) {
			const { storeRoot, dir } = await mkStore();
			const kept = mkReceipt();
			expect(await storeReceipt(fs, storeRoot, kept)).toBe("stored");
			await plant(dir);
			const before = (await fs.readdir(dir)).sort();
			expect(await storeReceipt(fs, storeRoot, mkReceipt())).toBe("store_corrupt");
			expect((await fs.readdir(dir)).sort()).toEqual(before);
		}
	});

	it("an invalid oldest receipt blocks eviction (store_corrupt) and is left in place", async () => {
		const { storeRoot, dir } = await mkStore();
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		const forged = withExec({ exitCode: 7 });
		await seed(dir, forged, 1_600_000_000_000); // passed with exit 7: fails load validation
		for (let i = 1; i < RECEIPTS_PER_REPO; i++)
			await seed(dir, mkReceipt(1_700_000_000_000 + i), 1_700_000_000_000 + i * 1000);
		expect(await storeReceipt(fs, storeRoot, mkReceipt())).toBe("store_corrupt");
		expect((await fs.readdir(dir)).filter(n => n.endsWith(".json"))).toHaveLength(RECEIPTS_PER_REPO);
		expect(await fs.readdir(dir)).toContain(`${forged.id}.json`);
	}, 30_000);

	it("oversized receipts are refused, and invalid files are invisible to loadRepoReceipts", async () => {
		const { storeRoot, dir } = await mkStore();
		const huge = mkReceipt(1_700_000_000_000, { limitations: ["x".repeat(RECEIPT_MAX_BYTES)] });
		expect(await storeReceipt(fs, storeRoot, huge)).toBe("receipt_unavailable");
		const good = mkReceipt();
		expect(await storeReceipt(fs, storeRoot, good)).toBe("stored");
		const forged = withExec({ signal: "SIGKILL" });
		await seed(dir, forged, Date.now());
		await fs.writeFile(path.join(dir, `${crypto.randomUUID()}.json`), "{not json");
		const loaded = await loadRepoReceipts(fs, storeRoot, H("d"));
		expect(loaded.map(r => r.id)).toEqual([good.id]);
		expect(sha256Hex(JSON.stringify(loaded[0]))).toBe(sha256Hex(JSON.stringify(good)));
	});

	it("a failing lock break surfaces as store_unavailable instead of hanging admission", async () => {
		const { storeRoot, dir } = await mkStore();
		expect(await storeReceipt(fs, storeRoot, mkReceipt())).toBe("stored");
		await fs.writeFile(
			path.join(dir, ".admission.lock"),
			JSON.stringify({ v: 1, pid: 99999999, createdAt: 1, nonce: "dead" }),
			{
				mode: 0o600,
			},
		);
		const rejecting = {
			...fs,
			unlink: async (target: string) => {
				if (path.basename(String(target)) === ".admission.lock")
					throw Object.assign(new Error("EPERM"), { code: "EPERM" });
				return fs.unlink(target);
			},
		} as unknown as typeof fs;
		const outcome = await Promise.race([
			storeReceipt(rejecting, storeRoot, mkReceipt()),
			Bun.sleep(4000).then(() => "hung"),
		]);
		expect(outcome).toBe("store_unavailable");
	});
});
