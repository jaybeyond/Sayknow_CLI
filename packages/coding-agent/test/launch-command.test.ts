import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { persistCoordinatorLaunchFailure } from "@sayknow-cli/coding-agent/commands/launch";
import {
	SKC_COORDINATOR_SESSION_ID_ENV,
	SKC_COORDINATOR_SESSION_STATE_FILE_ENV,
	SKC_TMUX_OWNER_GENERATION_ENV,
} from "@sayknow-cli/coding-agent/skc-runtime/session-state-sidecar";

describe("persistCoordinatorLaunchFailure", () => {
	it("persists the exact managed owner generation without normalizing it", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "skc-launch-error-"));
		try {
			const stateFile = path.join(root, "runtime.json");
			const generation = "owner-generation-9c5542";
			await persistCoordinatorLaunchFailure(new Error("launch_failed: detail"), root, {
				[SKC_COORDINATOR_SESSION_STATE_FILE_ENV]: stateFile,
				[SKC_COORDINATOR_SESSION_ID_ENV]: "coordinator-123",
				[SKC_TMUX_OWNER_GENERATION_ENV]: generation,
			});
			const state = JSON.parse(await fs.readFile(stateFile, "utf8")) as Record<string, unknown>;
			expect(state.owner_generation).toBe(generation);
			await persistCoordinatorLaunchFailure(new Error("launch_failed"), root, {
				[SKC_COORDINATOR_SESSION_STATE_FILE_ENV]: stateFile,
				[SKC_COORDINATOR_SESSION_ID_ENV]: "coordinator-123",
			});
			const missing = JSON.parse(await fs.readFile(stateFile, "utf8")) as Record<string, unknown>;
			expect(Object.hasOwn(missing, "owner_generation")).toBe(true);
			expect(missing.owner_generation).toBeNull();
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
