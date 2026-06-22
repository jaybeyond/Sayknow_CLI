import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeActiveEntry, writeActiveEntry, writeGuardedJsonAtomic } from "../src/skc-runtime/state-writer";
import {
	applyHandoffToActiveState,
	CANONICAL_SKC_WORKFLOW_SKILLS,
	getSkillActiveStatePaths,
	listActiveSkills,
	normalizeSkillActiveState,
	readVisibleSkillActiveState,
	syncSkillActiveState,
} from "../src/skill-state/active-state";

async function withTempCwd(fn: (cwd: string) => Promise<void>): Promise<void> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "skc-skill-active-"));
	try {
		await fn(cwd);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
}

describe("SKC skill-active state", () => {
	it("normalizes legacy top-level active state into active skills", () => {
		const state = normalizeSkillActiveState({ active: true, skill: "deep-interview", phase: "intent-first" });
		expect(state?.active_skills).toEqual([
			expect.objectContaining({ skill: "deep-interview", phase: "intent-first", active: true }),
		]);
	});

	it("ignores inactive and blank entries while deduping by skill and session", () => {
		const active = listActiveSkills({
			active_skills: [
				{ skill: "", active: true },
				{ skill: "team", active: false },
				{ skill: "ralplan", phase: "draft", session_id: "sess-a" },
				{ skill: "ralplan", phase: "review", session_id: "sess-a" },
				{ skill: "ralplan", phase: "root" },
			],
		});
		expect(active).toEqual([
			expect.objectContaining({ skill: "ralplan", phase: "review", session_id: "sess-a" }),
			expect.objectContaining({ skill: "ralplan", phase: "root" }),
		]);
	});

	it("writes session-scoped active state under .skc/_session-*", async () => {
		await withTempCwd(async cwd => {
			await syncSkillActiveState({
				cwd,
				skill: "team",
				phase: "running",
				active: true,
				sessionId: "sess-a",
				nowIso: "2026-05-27T00:00:00.000Z",
			});

			const paths = getSkillActiveStatePaths(cwd, "sess-a");
			expect(await fs.readFile(paths.rootPath, "utf8")).toContain("team");
			expect(paths.sessionPath).toBeDefined();
			expect(await fs.readFile(paths.sessionPath ?? "", "utf8")).toContain("running");
		});
	});

	it("encodes session ids before using them as state path segments", async () => {
		await withTempCwd(async cwd => {
			const paths = getSkillActiveStatePaths(cwd, "../escape/session");
			expect(paths.sessionPath).toBe(
				path.join(cwd, ".skc", "_session-%2E%2E%2Fescape%2Fsession", "state", "skill-active-state.json"),
			);
		});
	});

	it("filters root fallback entries to the current session", async () => {
		await withTempCwd(async cwd => {
			await syncSkillActiveState({ cwd, skill: "team", active: true, phase: "running", sessionId: "sess-a" });
			await syncSkillActiveState({
				cwd,
				skill: "deep-interview",
				active: true,
				phase: "intent",
				sessionId: "sess-b",
			});

			const visible = await readVisibleSkillActiveState(cwd, "sess-b");
			expect(visible?.active_skills?.map(entry => entry.skill)).toEqual(["deep-interview"]);
		});
	});

	it("clears only the matching session entry", async () => {
		await withTempCwd(async cwd => {
			await syncSkillActiveState({ cwd, skill: "team", active: true, sessionId: "sess-a" });
			await syncSkillActiveState({ cwd, skill: "team", active: true, sessionId: "sess-b" });
			await syncSkillActiveState({ cwd, skill: "team", active: false, sessionId: "sess-a" });

			const sessionA = await readVisibleSkillActiveState(cwd, "sess-a");
			const sessionB = await readVisibleSkillActiveState(cwd, "sess-b");
			expect(sessionA).toBeNull();
			expect(sessionB?.active_skills?.map(entry => entry.session_id)).toEqual(["sess-b"]);
		});
	});

	it("does not derive a stale flag for aged entries without explicit deactivation", async () => {
		await withTempCwd(async cwd => {
			await syncSkillActiveState({
				cwd,
				skill: "team",
				active: true,
				sessionId: "sess-old",
				nowIso: "2000-01-01T00:00:00.000Z",
			});

			const visible = await readVisibleSkillActiveState(cwd, "sess-old");
			const entry = visible?.active_skills?.[0];
			expect(entry?.skill).toBe("team");
			expect(entry?.stale).toBeUndefined();
		});
	});

	it("normalizes and preserves HUD summaries during root/session merge", async () => {
		await withTempCwd(async cwd => {
			await syncSkillActiveState({
				cwd,
				skill: "deep-interview",
				active: true,
				phase: "interviewing",
				sessionId: "sess-hud",
				nowIso: new Date().toISOString(),
				hud: {
					version: 1,
					summary: "round\tone",
					chips: [{ label: "ambiguity\n", value: "15%", priority: 10, severity: "success" }],
					details: Array.from({ length: 20 }, (_, index) => ({ label: `d${index}`, value: "x" })),
				},
			});

			const visible = await readVisibleSkillActiveState(cwd, "sess-hud");
			const entry = visible?.active_skills?.[0];
			expect(entry?.hud?.summary).toBe("round one");
			expect(entry?.hud?.chips?.[0]).toEqual({
				label: "ambiguity",
				value: "15%",
				priority: 10,
				severity: "success",
			});
			expect(entry?.hud?.details?.length).toBe(12);
		});
	});

	it("shows only the callee when a skill is seeded session-less then handed off under a session", async () => {
		await withTempCwd(async cwd => {
			// `skc deep-interview` run without --session-id seeds a global row, then
			// the in-TUI skill chain hands off under a concrete session id. The
			// demotion must supersede the global row so the HUD stops showing the
			// already-handed-off skill.
			await syncSkillActiveState({
				cwd,
				skill: "deep-interview",
				phase: "interviewing",
				active: true,
				sessionId: "sess1",
			});
			await applyHandoffToActiveState({
				cwd,
				strict: true,
				caller: {
					cwd,
					skill: "deep-interview",
					active: false,
					phase: "handoff",
					sessionId: "sess1",
					handoff_to: "ralplan",
				},
				callee: {
					cwd,
					skill: "ralplan",
					active: true,
					phase: "planner",
					sessionId: "sess1",
					handoff_from: "deep-interview",
				},
			});

			const visible = await readVisibleSkillActiveState(cwd, "sess1");
			expect(visible?.active_skills?.map(entry => entry.skill)).toEqual(["ralplan"]);
		});
	});

	it("does not demote a same-skill row owned by a different session during handoff", async () => {
		await withTempCwd(async cwd => {
			await syncSkillActiveState({ cwd, skill: "ralplan", phase: "planner", active: true, sessionId: "sessB" });
			await syncSkillActiveState({
				cwd,
				skill: "deep-interview",
				phase: "interviewing",
				active: true,
				sessionId: "sessA",
			});
			await applyHandoffToActiveState({
				cwd,
				strict: true,
				caller: {
					cwd,
					skill: "deep-interview",
					active: false,
					phase: "handoff",
					sessionId: "sessA",
					handoff_to: "ralplan",
				},
				callee: {
					cwd,
					skill: "ralplan",
					active: true,
					phase: "planner",
					sessionId: "sessA",
					handoff_from: "deep-interview",
				},
			});

			const sessionA = await readVisibleSkillActiveState(cwd, "sessA");
			const sessionB = await readVisibleSkillActiveState(cwd, "sessB");
			expect(sessionA?.active_skills?.map(entry => entry.skill)).toEqual(["ralplan"]);
			expect(sessionB?.active_skills?.map(entry => entry.skill)).toEqual(["ralplan"]);
		});
	});

	it("self-heals a stale active row left in an on-disk state file", async () => {
		await withTempCwd(async cwd => {
			const { rootPath } = getSkillActiveStatePaths(cwd, "sess1");
			await fs.mkdir(path.dirname(rootPath), { recursive: true });
			await fs.writeFile(
				rootPath,
				JSON.stringify({
					version: 1,
					active: true,
					skill: "deep-interview",
					active_skills: [
						{
							skill: "deep-interview",
							phase: "interviewing",
							active: true,
							updated_at: "2026-01-01T00:00:00.000Z",
						},
						{
							skill: "deep-interview",
							phase: "handoff",
							active: false,
							session_id: "sess1",
							updated_at: "2026-01-01T00:01:00.000Z",
							handoff_to: "ralplan",
						},
						{
							skill: "ralplan",
							phase: "handoff",
							active: false,
							session_id: "sess1",
							updated_at: "2026-01-01T00:02:00.000Z",
							handoff_to: "ultragoal",
						},
						{
							skill: "ultragoal",
							phase: "executing",
							active: true,
							session_id: "sess1",
							updated_at: "2026-01-01T00:03:00.000Z",
						},
					],
				}),
			);

			const visible = await readVisibleSkillActiveState(cwd, "sess1");
			expect(visible?.active_skills?.map(entry => entry.skill)).toEqual(["ultragoal"]);
		});
	});

	it("enforces canonical pipeline precedence when downstream stages activate", async () => {
		await withTempCwd(async cwd => {
			await syncSkillActiveState({
				cwd,
				skill: "deep-interview",
				phase: "handoff",
				active: true,
				sessionId: "sess1",
				source: "skc-deep-interview",
				nowIso: "2026-01-01T00:00:00.000Z",
			});
			await syncSkillActiveState({
				cwd,
				skill: "ralplan",
				phase: "planner",
				active: true,
				sessionId: "sess1",
				source: "skc-ralplan-native",
				nowIso: "2026-01-01T00:05:00.000Z",
			});

			let visible = await readVisibleSkillActiveState(cwd, "sess1");
			expect(visible?.skill).toBe("ralplan");
			expect(visible?.active_skills?.map(entry => entry.skill)).toEqual(["ralplan"]);

			await syncSkillActiveState({
				cwd,
				skill: "deep-interview",
				phase: "interviewing",
				active: true,
				sessionId: "sess1",
				source: "stale-upstream",
				nowIso: "2026-01-01T00:10:00.000Z",
			});
			await syncSkillActiveState({
				cwd,
				skill: "ultragoal",
				phase: "goal-planning",
				active: true,
				sessionId: "sess1",
				source: "skc-ultragoal",
				nowIso: "2026-01-01T00:15:00.000Z",
			});

			visible = await readVisibleSkillActiveState(cwd, "sess1");
			expect(visible?.skill).toBe("ultragoal");
			expect(visible?.active_skills?.map(entry => entry.skill)).toEqual(["ultragoal"]);
		});
	});

	it("keeps an active session-scoped row visible despite a newer session-less inactive same-skill row", async () => {
		await withTempCwd(async cwd => {
			// A session-less (global) deep-interview row was handed off (inactive,
			// newest), but the current session still has its own active interview.
			// Session ownership must win so the mutation guard still sees it.
			const { rootPath } = getSkillActiveStatePaths(cwd, "sess1");
			await fs.mkdir(path.dirname(rootPath), { recursive: true });
			await fs.writeFile(
				rootPath,
				JSON.stringify({
					version: 1,
					active: true,
					skill: "deep-interview",
					active_skills: [
						{
							skill: "deep-interview",
							phase: "interviewing",
							active: true,
							session_id: "sess1",
							updated_at: "2026-01-01T00:00:00.000Z",
						},
						{
							skill: "deep-interview",
							phase: "handoff",
							active: false,
							updated_at: "2026-01-01T00:09:00.000Z",
							handoff_to: "ralplan",
						},
					],
				}),
			);

			const visible = await readVisibleSkillActiveState(cwd, "sess1");
			expect(visible?.active_skills?.map(entry => entry.skill)).toEqual(["deep-interview"]);
		});
	});

	it("does not let an inactive same-skill row without a valid timestamp hide an active row", async () => {
		await withTempCwd(async cwd => {
			// Root read (no session scope) with two same-skill rows that carry no
			// trustworthy timestamp. The active row must win the tie instead of an
			// inactive row suppressing it by merge order.
			const { rootPath } = getSkillActiveStatePaths(cwd, "sess1");
			await fs.mkdir(path.dirname(rootPath), { recursive: true });
			await fs.writeFile(
				rootPath,
				JSON.stringify({
					version: 1,
					active: true,
					skill: "deep-interview",
					active_skills: [
						{ skill: "deep-interview", phase: "interviewing", active: true, session_id: "a" },
						{ skill: "deep-interview", phase: "handoff", active: false, session_id: "b" },
					],
				}),
			);

			const visible = await readVisibleSkillActiveState(cwd, "sess1");
			expect(visible?.active_skills?.map(entry => entry.skill)).toEqual(["deep-interview"]);
			expect(visible?.active_skills?.[0]?.phase).toBe("interviewing");
		});
	});

	it("surfaces legacy top-level active state through the visible read", async () => {
		await withTempCwd(async cwd => {
			// Pre-`active_skills` state files stored a single workflow at the top
			// level with no `active_skills` array. The raw visible read must still
			// surface it for the HUD, mutation guard, and caller inference.
			const { rootPath } = getSkillActiveStatePaths(cwd, "sess1");
			await fs.mkdir(path.dirname(rootPath), { recursive: true });
			await fs.writeFile(
				rootPath,
				JSON.stringify({ version: 1, active: true, skill: "deep-interview", phase: "intent-first" }),
			);

			const visible = await readVisibleSkillActiveState(cwd, "sess1");
			expect(visible?.active_skills?.map(entry => entry.skill)).toEqual(["deep-interview"]);
			expect(visible?.active_skills?.[0]?.phase).toBe("intent-first");
		});
	});

	it("chooses the most advanced active pipeline stage as snapshot primary regardless of file order", async () => {
		await withTempCwd(async cwd => {
			const activeDir = path.join(cwd, ".skc", "_session-sess1", "state", "active");
			await fs.mkdir(activeDir, { recursive: true });
			await fs.writeFile(
				path.join(activeDir, "deep-interview.json"),
				JSON.stringify({ skill: "deep-interview", phase: "interviewing", active: true }),
			);
			await fs.writeFile(
				path.join(activeDir, "ralplan.json"),
				JSON.stringify({ skill: "ralplan", phase: "planner", active: true }),
			);
			await fs.writeFile(
				path.join(activeDir, "ultragoal.json"),
				JSON.stringify({ skill: "ultragoal", phase: "goal-planning", active: true }),
			);

			await syncSkillActiveState({ cwd, skill: "team", phase: "running", active: true, sessionId: "sess1" });

			const snapshot = JSON.parse(
				await fs.readFile(path.join(cwd, ".skc", "_session-sess1", "state", "skill-active-state.json"), "utf-8"),
			);
			expect(snapshot.skill).toBe("ultragoal");
			expect(snapshot.phase).toBe("goal-planning");
		});
	});

	it("derived active-state HUD stale-skips when incoming source revision is not newer", async () => {
		await withTempCwd(async cwd => {
			const { sessionPath } = getSkillActiveStatePaths(cwd, "sess-rev");
			await writeGuardedJsonAtomic(
				sessionPath,
				{
					version: 1,
					active: true,
					skill: "deep-interview",
					phase: "newer",
					active_skills: [
						{
							skill: "deep-interview",
							phase: "newer",
							active: true,
							session_id: "sess-rev",
							hud: { version: 1, summary: "newer hud", chips: [{ label: "rev", value: "5" }] },
						},
					],
				},
				{ cwd, policy: "cache", sourceRevision: 5 },
			);

			const skipped = await writeGuardedJsonAtomic(
				sessionPath,
				{
					version: 1,
					active: true,
					skill: "deep-interview",
					phase: "older",
					active_skills: [
						{
							skill: "deep-interview",
							phase: "older",
							active: true,
							session_id: "sess-rev",
							hud: { version: 1, summary: "older hud", chips: [{ label: "rev", value: "4" }] },
						},
					],
				},
				{ cwd, policy: "cache", sourceRevision: 5 },
			);

			expect(skipped.written).toBe(false);
			const persisted = JSON.parse(await fs.readFile(sessionPath, "utf-8"));
			expect(persisted.source_state_revision).toBe(5);
			expect(persisted.active_skills[0].hud.summary).toBe("newer hud");
		});
	});

	it("derived active-state HUD overwrites when incoming source revision is newer", async () => {
		await withTempCwd(async cwd => {
			const { sessionPath } = getSkillActiveStatePaths(cwd, "sess-rev");
			await writeGuardedJsonAtomic(
				sessionPath,
				{
					version: 1,
					active: true,
					skill: "deep-interview",
					phase: "old",
					active_skills: [
						{
							skill: "deep-interview",
							phase: "old",
							active: true,
							session_id: "sess-rev",
							hud: { version: 1, summary: "old hud" },
						},
					],
				},
				{ cwd, policy: "cache", sourceRevision: 2 },
			);

			const written = await writeGuardedJsonAtomic(
				sessionPath,
				{
					version: 1,
					active: true,
					skill: "deep-interview",
					phase: "new",
					active_skills: [
						{
							skill: "deep-interview",
							phase: "new",
							active: true,
							session_id: "sess-rev",
							hud: { version: 1, summary: "new hud", chips: [{ label: "rev", value: "3" }] },
						},
					],
				},
				{ cwd, policy: "cache", sourceRevision: 3 },
			);

			expect(written.written).toBe(true);
			const persisted = JSON.parse(await fs.readFile(sessionPath, "utf-8"));
			expect(persisted.source_state_revision).toBe(3);
			expect(persisted.state_revision).toBe(2);
			expect(persisted.active_skills[0].hud.summary).toBe("new hud");
		});
	});

	it("keeps a newer active entry when a stale source-revision removal runs under the entry lock", async () => {
		await withTempCwd(async cwd => {
			await writeActiveEntry(
				cwd,
				"sess-remove-rev",
				"deep-interview",
				{
					skill: "deep-interview",
					phase: "newer",
					active: true,
					session_id: "sess-remove-rev",
					source_state_revision: 5,
					hud: { version: 1, summary: "newer hud" },
				},
				{ cwd },
			);

			const activePath = path.join(
				cwd,
				".skc",
				"_session-sess-remove-rev",
				"state",
				"active",
				"deep-interview.json",
			);
			const lockPath = `${activePath}.lock`;
			await fs.mkdir(lockPath, { recursive: true });
			await fs.writeFile(`${lockPath}/info`, JSON.stringify({ pid: process.pid, timestamp: Date.now() }));

			let staleRemovalSettled = false;
			const staleRemoval = removeActiveEntry(cwd, "sess-remove-rev", "deep-interview", {
				cwd,
				sourceRevision: 4,
				lock: { retries: 20, retryDelayMs: 10, staleMs: 10_000 },
			}).finally(() => {
				staleRemovalSettled = true;
			});

			await Bun.sleep(20);
			expect(staleRemovalSettled).toBe(false);
			await fs.rm(lockPath, { recursive: true, force: true });

			const result = await staleRemoval;
			expect(result.deleted).toBe(false);
			const persisted = JSON.parse(await fs.readFile(activePath, "utf8"));
			expect(persisted.source_state_revision).toBe(5);
			expect(persisted.phase).toBe("newer");
			expect(persisted.hud.summary).toBe("newer hud");
		});
	});
	it("exact-session HUD entry outranks newer session-less fallback and scoped reads exclude foreign sessions", async () => {
		await withTempCwd(async cwd => {
			await syncSkillActiveState({
				cwd,
				skill: "ultragoal",
				phase: "active",
				active: true,
				sessionId: "sess-exact",
				nowIso: "2026-01-01T00:00:00.000Z",
				hud: { version: 1, summary: "exact hud" },
				sourceRevision: 10,
			});
			await syncSkillActiveState({
				cwd,
				skill: "team",
				phase: "running",
				active: true,
				sessionId: "foreign-session",
				nowIso: "2026-01-01T00:05:00.000Z",
				hud: { version: 1, summary: "foreign hud" },
				sourceRevision: 11,
			});

			const activeDir = path.join(cwd, ".skc", "_session-sess-exact", "state", "active");
			await fs.writeFile(
				path.join(activeDir, "ultragoal.json"),
				JSON.stringify({
					skill: "ultragoal",
					phase: "active",
					active: true,
					updated_at: "2026-01-01T00:10:00.000Z",
					hud: { version: 1, summary: "session-less fallback hud" },
				}),
			);

			const visible = await readVisibleSkillActiveState(cwd, "sess-exact");
			expect(visible?.active_skills?.map(entry => entry.skill)).toEqual(["ultragoal"]);
			expect(visible?.active_skills?.[0]?.session_id).toBe("sess-exact");
			expect(visible?.active_skills?.[0]?.hud?.summary).toBe("exact hud");
		});
	});

	it("session-wide visible reads intentionally include same-session entries from every thread", async () => {
		await withTempCwd(async cwd => {
			await syncSkillActiveState({
				cwd,
				skill: "team",
				phase: "running",
				active: true,
				sessionId: "sess-thread",
				threadId: "thread-a",
			});
			await syncSkillActiveState({
				cwd,
				skill: "ultragoal",
				phase: "active",
				active: true,
				sessionId: "sess-thread",
				threadId: "thread-b",
			});

			const visible = await readVisibleSkillActiveState(cwd, "sess-thread");
			expect(visible?.active_skills?.map(entry => [entry.skill, entry.thread_id])).toEqual([
				["ultragoal", "thread-b"],
				["team", "thread-a"],
			]);
		});
	});

	it("planning pipeline collapse keeps downstream planning skill while preserving team alongside ultragoal", async () => {
		await withTempCwd(async cwd => {
			await syncSkillActiveState({ cwd, skill: "ralplan", phase: "planner", active: true, sessionId: "sess-pipe" });
			await syncSkillActiveState({ cwd, skill: "team", phase: "running", active: true, sessionId: "sess-pipe" });
			await syncSkillActiveState({ cwd, skill: "ultragoal", phase: "active", active: true, sessionId: "sess-pipe" });

			const visible = await readVisibleSkillActiveState(cwd, "sess-pipe");
			expect(visible?.active_skills?.map(entry => entry.skill)).toEqual(["ultragoal", "team"]);
		});
	});

	it("clear demotion removes stale HUD chips from visible state after cache rebuild", async () => {
		await withTempCwd(async cwd => {
			await syncSkillActiveState({
				cwd,
				skill: "ultragoal",
				phase: "active",
				active: true,
				sessionId: "sess-clear",
				hud: { version: 1, summary: "active hud", chips: [{ label: "goal", value: "G001" }] },
			});
			await syncSkillActiveState({
				cwd,
				skill: "ultragoal",
				phase: "complete",
				active: false,
				sessionId: "sess-clear",
				hud: { version: 1, summary: "stale clear hud", chips: [{ label: "stale", value: "yes" }] },
			});

			const visible = await readVisibleSkillActiveState(cwd, "sess-clear");
			expect(visible).toBeNull();
			const { sessionPath } = getSkillActiveStatePaths(cwd, "sess-clear");
			const snapshot = JSON.parse(await fs.readFile(sessionPath, "utf-8"));
			expect(snapshot.active).toBe(false);
			expect(snapshot.active_skills).toEqual([]);
		});
	});

	it("keeps the canonical SKC workflow skill set intentionally small", () => {
		expect(CANONICAL_SKC_WORKFLOW_SKILLS).toEqual(["deep-interview", "ralplan", "ultragoal", "team"]);
	});
});
