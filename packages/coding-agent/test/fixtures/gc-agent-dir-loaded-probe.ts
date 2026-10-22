/**
 * Child entry for the load-time agent-dir trust regression.
 *
 * The parent writes cwd/.env, then starts this process so Bun and the utils
 * snapshot see that declaration. This file then changes the declaration and
 * calls `runSkcGcCommand` with the already-loaded process environment.
 *
 * The fork has no `gc --disk` surface, so the observable agent dir is the one
 * `--repair-session-index` initializes (`<agentDir>/sdk/sessions`).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@sayknow-cli/utils";
import { type GcStoreAdapter, runSkcGcCommand } from "../../src/skc-runtime/gc-runtime";

const root = process.cwd();
const mode = process.argv[2];
const key = process.argv[3];
const loaded = key ? process.env[key] : undefined;

if (mode === "drop") {
	await Bun.write(path.join(root, ".env"), "UNRELATED=1\n");
} else if (mode === "rewrite") {
	const rewritten = process.argv[4];
	await Bun.write(path.join(root, ".env"), `${key}=${rewritten}\n`);
}

const duringCollect: GcStoreAdapter[] | undefined =
	mode === "during"
		? [
				{
					store: "file_locks",
					async collect() {
						await Bun.write(path.join(root, ".env"), `${key}=${process.argv[4]}\n`);
						return { records: [], errors: [] };
					},
					async prune() {
						return { removed: false };
					},
				},
			]
		: undefined;

const fallback = getAgentDir();
const candidates = [...new Set([...(JSON.parse(process.env.SKC_GC_PROBE_CANDIDATES ?? "[]") as string[]), fallback])];
const result = await runSkcGcCommand(["--repair-session-index", "--json"], root, process.env, duringCollect);
const used = candidates.filter(dir => fs.existsSync(path.join(dir, "sdk", "sessions")));
const sessions = used.length === 1 ? used[0] : undefined;
process.stdout.write(
	`${JSON.stringify({
		status: result.status,
		stderr: result.stderr,
		loaded: loaded ?? null,
		sessions: sessions ?? null,
		fallback,
	})}\n`,
);
