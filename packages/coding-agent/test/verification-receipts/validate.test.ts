import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	executeRun,
	isSelectableTestPath,
	validateFileList,
} from "../../bundles/verification-receipts/tools/verification-run";
import { cleanupTemps, mkEnv, mkPi, mkRepo, write } from "./helpers";

afterEach(cleanupTemps);

describe("validateFileList", () => {
	it("accepts explicit relative test files", () => {
		expect(validateFileList(["a.test.ts", "nested/b.spec.tsx", "c_test.js"], "bun-test")).toBeNull();
		expect(validateFileList(["a.test.mjs"], "node-test")).toBeNull();
	});
	it("rejects every malformed list with its closed code", () => {
		const cases: Array<[unknown, string]> = [
			[[], "invalid_file_count"],
			[Array.from({ length: 33 }, (_, i) => `f${i}.test.ts`), "invalid_file_count"],
			["a.test.ts", "invalid_file_count"],
			[[42], "invalid_test_path"],
			[[""], "invalid_test_path"],
			[["/abs/a.test.ts"], "invalid_test_path"],
			[["../a.test.ts"], "invalid_test_path"],
			[["a/../b.test.ts"], "invalid_test_path"],
			[["./a.test.ts"], "invalid_test_path"],
			[["-x.test.ts"], "invalid_test_path"],
			[["dir/*.test.ts"], "invalid_test_path"],
			[["a[1].test.ts"], "invalid_test_path"],
			[["a\\b.test.ts"], "invalid_test_path"],
			[["a\nb.test.ts"], "invalid_test_path"],
			[["a.ts"], "not_a_test_file"],
			[["src"], "not_a_test_file"],
			[["x.test.ts.bak"], "not_a_test_file"],
			[["node_modules/p/a.test.ts"], "excluded_path"],
			[[".skc/a.test.ts"], "excluded_path"],
			[[".git/a.test.ts"], "excluded_path"],
			[["a.test.ts", "a.test.ts"], "duplicate_test_file"],
		];
		for (const [input, code] of cases) expect(validateFileList(input, "bun-test")).toBe(code as never);
	});
	it("applies the narrower node pattern", () => {
		expect(validateFileList(["a.test.ts"], "node-test")).toBe("not_a_test_file");
		expect(isSelectableTestPath("deep/a.spec.cjs", "node-test")).toBe(true);
	});
});

describe("executeRun disk validation", () => {
	it("returns not_run for missing, symlinked and escaping inputs without running anything", async () => {
		const env = await mkEnv();
		const repo = await mkRepo();
		const outside = await mkRepo();
		await fs.symlink(path.join(outside, "a.test.ts"), path.join(repo, "link.test.ts"));
		await fs.symlink(outside, path.join(repo, "linkdir"));
		await write(repo, "dir.test.ts/placeholder", "x");
		const pi = mkPi(repo, env);
		const run = (files: string[]) =>
			executeRun(
				pi,
				{ sessionManager: { getSessionId: () => "s" } },
				"call-1",
				{ files },
				undefined,
				{ env: env.env },
				env.toolsDir,
			);
		expect((await run(["missing.test.ts"])).execution.reason).toBe("missing_test_file");
		expect((await run(["link.test.ts"])).execution.reason).toBe("symlink_test_path");
		expect((await run(["linkdir/a.test.ts"])).execution.reason).toBe("symlink_test_path");
		expect((await run(["dir.test.ts"])).execution.reason).toBe("invalid_test_file");
		const bad = await run(["missing.test.ts"]);
		expect(bad.execution.status).toBe("not_run");
		expect(bad.receiptId).toBeNull();
		await expect(fs.stat(env.storeRoot)).rejects.toThrow();
	});
});
