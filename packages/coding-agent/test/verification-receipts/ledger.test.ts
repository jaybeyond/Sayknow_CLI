import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as bl from "../../bundles/verification-receipts/hooks/verification-baseline";
import { d16, gateIdOf } from "../../bundles/verification-receipts/hooks/verification-gate";
import { cleanupTemps, mkTemp } from "./helpers";

afterEach(cleanupTemps);

const hex = (n: number) => n.toString(16).padStart(16, "0");
const key = (n: number) => `job:${hex(n)}`;
function openGate(n: number, jobs = 1): bl.OpenGate {
	return {
		id: gateIdOf(key(n)),
		key: key(n),
		trigger: "discovered",
		origin: "hook",
		openedAt: 1_700_000_000_000 + n,
		toolCallAt: 1_700_000_000_000 + n,
		baselineHead: "a".repeat(40),
		baselineSource: "prior_observation",
		baselineAt: 1_700_000_000_000,
		subagentDigest: hex(7),
		priorJobDigest: hex(8),
		expectedJobs: null,
		jobSetComplete: false,
		quiescentAt: null,
		isolated: false,
		lastGapMask: 0,
		loopRuns: 0,
		jobs: Array.from(
			{ length: jobs },
			(_, i) => [hex(n * 1000 + i), hex(9), "running", 0, null, "subagent"] as bl.JobTuple,
		),
		subState: "queued",
		subStateAt: 1_700_000_000_000,
	};
}
function resolved(n: number, at: number): bl.ResolvedGate {
	const { jobs, subState, subStateAt, ...base } = openGate(n);
	void subState;
	void subStateAt;
	return {
		...base,
		jobCount: jobs.length,
		resolvedAt: at,
		resolution: "receipts",
		resolvedReceiptIds: Array.from({ length: 8 }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`),
	};
}
const ledger = () => bl.newLedger(hex(1).repeat(4), hex(2).repeat(4), 1_700_000_000_000);

describe("ledger admission", () => {
	it("stores up to 64 open gates, then records the key as pending instead of dropping silently", () => {
		const L = ledger();
		for (let i = 0; i < 64; i++) expect(bl.admit(L, openGate(i), 5)).toBe("stored");
		expect(bl.admit(L, openGate(64), 6)).toBe("failed");
		expect(L.overflow).toMatchObject({ firstAt: 6, lastAt: 6, pendingKeys: [key(64)], keysTruncated: false });
		expect(bl.admit(L, openGate(3), 7)).toBe("existing");
	});
	it("pendingKeys is capped at 256 and then flags keysTruncated", () => {
		const L = ledger();
		for (let i = 0; i < 64; i++) bl.admit(L, openGate(i), 5);
		for (let i = 100; i < 100 + 257; i++) bl.admit(L, openGate(i), 6);
		expect(L.overflow?.pendingKeys).toHaveLength(256);
		expect(L.overflow?.keysTruncated).toBe(true);
	});
	it("at 128 gates the oldest resolved gate is retired into retiredKeys; a retired key is not re-admitted", () => {
		const L = ledger();
		for (let i = 0; i < 100; i++) L.gates.push(resolved(i, 1000 + i));
		for (let i = 100; i < 128; i++) L.gates.push(openGate(i));
		expect(bl.admit(L, openGate(500), 5)).toBe("stored");
		expect(L.gates).toHaveLength(128);
		expect(L.retiredKeys).toEqual([key(0)]);
		expect(L.gates.some(g => g.key === key(0))).toBe(false);
		expect(bl.admit(L, openGate(0), 6)).toBe("existing");
		expect(L.gates).toHaveLength(128);
	});
	it("with 128 open-or-nothing-to-evict the admission fails", () => {
		const L = ledger();
		for (let i = 0; i < 64; i++) L.gates.push(openGate(i));
		for (let i = 64; i < 128; i++) L.gates.push(openGate(i));
		expect(bl.admit(L, openGate(999), 5)).toBe("failed");
	});
	it("refuses a gate whose projected size would exceed the 512 KiB cap", () => {
		const L = ledger();
		expect(bl.admit(L, openGate(1), 1)).toBe("stored");
		L.headObservations = [{ at: 1, head: "x".repeat(bl.LEDGER_MAX), source: "tool_git" }];
		expect(bl.admit(L, openGate(2), 2)).toBe("failed");
		expect(L.gates).toHaveLength(1);
		expect(L.overflow?.pendingKeys).toEqual([key(2)]);
	});
	it("the worst-case ledger stays under 421 KiB (and validates)", () => {
		const L = ledger();
		for (let i = 0; i < 64; i++) L.gates.push(openGate(i, 64));
		for (let i = 64; i < 128; i++) L.gates.push(resolved(i, 2000 + i));
		L.retiredKeys = Array.from({ length: 512 }, (_, i) => key(10_000 + i));
		L.overflow = {
			firstAt: 1_700_000_000_000,
			lastAt: 1_700_000_000_001,
			pendingKeys: Array.from({ length: 256 }, (_, i) => key(20_000 + i)),
			keysTruncated: true,
		};
		L.headObservations = Array.from({ length: 32 }, (_, i) => ({
			at: 1_700_000_000_000 + i,
			head: "b".repeat(64),
			source: "tool_git" as const,
		}));
		L.sourceSnapshots = Array.from({ length: 32 }, (_, i) => ({
			at: 1_700_000_000_000 + i,
			sourceDigest: "c".repeat(64),
			head: "b".repeat(64),
			by: "loop" as const,
		}));
		L.baselines = Array.from(
			{ length: 64 },
			(_, i) => [hex(i), "d".repeat(64), 1_700_000_000_000] as [string, string, number],
		);
		L.scan.cursor = { entryId: "e".repeat(32), entryTimestamp: 1_700_000_000_000 };
		L.scan.pending = { topId: "f".repeat(32), bottomId: "g".repeat(32) };
		const size = bl.sizeOf(L);
		expect(size).toBeLessThanOrEqual(421 * 1024);
		expect(size).toBeLessThan(bl.LEDGER_MAX);
		expect(bl.validateLedger(JSON.parse(JSON.stringify(L)), L.repoDigest, L.sessionDigest)).not.toBeNull();
	});
});

describe("validateLedger", () => {
	it("rejects foreign digests, bad shapes and out-of-range values", () => {
		const L = ledger();
		const round = (mutate: (x: Record<string, any>) => void) => {
			const copy = JSON.parse(JSON.stringify(L));
			mutate(copy);
			return bl.validateLedger(copy, L.repoDigest, L.sessionDigest);
		};
		expect(round(() => {})).not.toBeNull();
		expect(bl.validateLedger(JSON.parse(JSON.stringify(L)), "other", L.sessionDigest)).toBeNull();
		expect(round(x => (x.schemaVersion = 2))).toBeNull();
		expect(round(x => (x.scan.floor = -1))).toBeNull();
		expect(round(x => (x.gates = [{ id: "zz" }]))).toBeNull();
		expect(round(x => (x.retiredKeys = ["../../etc"]))).toBeNull();
		expect(round(x => (x.baselines = [["nothex", null, 1]]))).toBeNull();
		expect(
			round(
				x => (x.overflow = { firstAt: 1, lastAt: 1, pendingKeys: Array(257).fill(key(1)), keysTruncated: false }),
			),
		).toBeNull();
		expect(bl.validateLedger(null, L.repoDigest, L.sessionDigest)).toBeNull();
		expect(bl.validateLedger("x", L.repoDigest, L.sessionDigest)).toBeNull();
	});
	it("gate ids must be the digest of their keys", () => {
		const L = ledger();
		const g = openGate(1);
		g.id = hex(99);
		L.gates.push(g);
		expect(bl.validateLedger(JSON.parse(JSON.stringify(L)), L.repoDigest, L.sessionDigest)).toBeNull();
		expect(d16(key(1))).toBe(gateIdOf(key(1)));
	});
});

describe("withLock", () => {
	const alive = () => true;
	it("serializes holders and reports busy after the wait", async () => {
		const dir = await mkTemp();
		const file = path.join(dir, "x.lock");
		let inner: unknown;
		await bl.withLock(fs, file, { pidAlive: alive, waitMs: 50 }, async () => {
			inner = await bl.withLock(fs, file, { pidAlive: alive, waitMs: 80 }, async () => "never").catch(e => e);
		});
		expect(inner).toBeInstanceOf(bl.StoreBusyError);
		expect(await fs.readdir(dir)).toEqual([]);
	});
	it("breaks a lock whose pid is dead and one older than the stale threshold", async () => {
		const dir = await mkTemp();
		const file = path.join(dir, "x.lock");
		await fs.writeFile(file, JSON.stringify({ v: 1, pid: 99, createdAt: Date.now(), nonce: "a" }), { mode: 0o600 });
		expect(await bl.withLock(fs, file, { pidAlive: () => false, waitMs: 200 }, async () => "ok")).toBe("ok");
		await fs.writeFile(file, JSON.stringify({ v: 1, pid: 99, createdAt: Date.now() - 120_000, nonce: "b" }), {
			mode: 0o600,
		});
		expect(await bl.withLock(fs, file, { pidAlive: alive, waitMs: 200 }, async () => "ok2")).toBe("ok2");
	});
	it("an unparseable lock is only broken once its mtime is stale", async () => {
		const dir = await mkTemp();
		const file = path.join(dir, "x.lock");
		await fs.writeFile(file, "garbage", { mode: 0o600 });
		const busy = await bl.withLock(fs, file, { pidAlive: alive, waitMs: 60 }, async () => "x").catch(e => e);
		expect(busy).toBeInstanceOf(bl.StoreBusyError);
		const old = new Date(Date.now() - 120_000);
		await fs.utimes(file, old, old);
		expect(await bl.withLock(fs, file, { pidAlive: alive, waitMs: 200 }, async () => "ok")).toBe("ok");
	});
	it("a break is aborted when the nonce changed between read and unlink", async () => {
		const dir = await mkTemp();
		const file = path.join(dir, "x.lock");
		await fs.writeFile(file, JSON.stringify({ v: 1, pid: 99, createdAt: 1, nonce: "old" }), { mode: 0o600 });
		let swapped = false;
		const res = await bl
			.withLock(
				fs,
				file,
				{
					pidAlive: pid => pid !== 99,
					waitMs: 60,
					beforeBreak: async () => {
						if (swapped) return;
						swapped = true;
						await fs.writeFile(
							file,
							JSON.stringify({ v: 1, pid: process.pid, createdAt: Date.now(), nonce: "new-holder" }),
							{ mode: 0o600 },
						);
					},
				},
				async () => "stolen",
			)
			.catch(e => e);
		expect(res).toBeInstanceOf(bl.StoreBusyError);
		expect(JSON.parse(await fs.readFile(file, "utf8")).nonce).toBe("new-holder");
	});
	it("a stale break whose unlink fails surfaces the error instead of spinning past the deadline", async () => {
		const dir = await mkTemp();
		const file = path.join(dir, "x.lock");
		await fs.writeFile(file, JSON.stringify({ v: 1, pid: 99, createdAt: 1, nonce: "old" }), { mode: 0o600 });
		let unlinks = 0;
		const rejecting = {
			...fs,
			unlink: async () => {
				unlinks++;
				throw Object.assign(new Error("EPERM"), { code: "EPERM" });
			},
		} as unknown as Parameters<typeof bl.withLock>[0];
		const outcome = await Promise.race([
			bl.withLock(rejecting, file, { pidAlive: () => false, waitMs: 100 }, async () => "never").catch(e => e),
			Bun.sleep(3000).then(() => "hung"),
		]);
		expect(outcome).not.toBe("hung");
		expect((outcome as NodeJS.ErrnoException).code).toBe("EPERM");
		expect(unlinks).toBe(1);
	});
	it("an ENOENT on the stale unlink is tolerated, and the wait deadline bounds a lock that keeps vanishing", async () => {
		const dir = await mkTemp();
		const file = path.join(dir, "x.lock");
		await fs.writeFile(file, JSON.stringify({ v: 1, pid: 99, createdAt: 1, nonce: "old" }), { mode: 0o600 });
		const raced = {
			...fs,
			unlink: async (target: string) => {
				await fs.unlink(target);
				throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			},
		} as unknown as Parameters<typeof bl.withLock>[0];
		expect(await bl.withLock(raced, file, { pidAlive: () => false, waitMs: 200 }, async () => "ok")).toBe("ok");
		// open(O_EXCL) says EEXIST while every read says ENOENT: the loop must still end at the deadline.
		const phantom = {
			...fs,
			open: async (target: string, flags: number, ...rest: unknown[]) => {
				const code = flags & fs.constants.O_EXCL ? "EEXIST" : "ENOENT";
				void target;
				void rest;
				throw Object.assign(new Error(code), { code });
			},
		} as unknown as Parameters<typeof bl.withLock>[0];
		const outcome = await Promise.race([
			bl.withLock(phantom, file, { pidAlive: alive, waitMs: 60 }, async () => "never").catch(e => e),
			Bun.sleep(3000).then(() => "hung"),
		]);
		expect(outcome).toBeInstanceOf(bl.StoreBusyError);
	});
	it("release only removes the lock it still owns", async () => {
		const dir = await mkTemp();
		const file = path.join(dir, "x.lock");
		await bl.withLock(fs, file, { pidAlive: alive }, async () => {
			await fs.writeFile(
				file,
				JSON.stringify({ v: 1, pid: process.pid, createdAt: Date.now(), nonce: "someone-else" }),
				{ mode: 0o600 },
			);
		});
		expect(JSON.parse(await fs.readFile(file, "utf8")).nonce).toBe("someone-else");
	});
	it("releases the lock when the callback throws", async () => {
		const dir = await mkTemp();
		const file = path.join(dir, "x.lock");
		await expect(
			bl.withLock(fs, file, { pidAlive: alive }, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(await fs.readdir(dir)).toEqual([]);
	});
});
