import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setAgentDir } from "@sayknow-cli/utils/dirs";
import {
	__setOwnerIncarnationReaderForTests,
	advanceIdentityCreatePhase,
	canonicalIdentityCreateKey,
	type IdentityCreateKey,
	identityCreatePhaseMayHaveChild,
	probeOwnerLiveness,
	reclaimIdentityCreate,
	recoverAbandonedIdentityCreate,
	releaseIdentityCreate,
	reserveIdentityCreate,
} from "../../src/skc-runtime/tmux-owner-isolation";

let root: string;
let key: IdentityCreateKey;

const OWNER_INCARNATION = "darwin:1700000000:123456";

function makeKey(stateDir: string, sessionId = "sess-a"): IdentityCreateKey {
	const stateFile = path.join(stateDir, `${sessionId}.json`);
	writeFileSync(stateFile, "{}\n");
	return { stateDir, sessionId, stateFile };
}

const originalAgentDir = process.env.SKC_CODING_AGENT_DIR;

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "skc-identity-fence-"));
	// The fence database lives under the agent dir; isolate it so tests never
	// write into the developer's real ~/.skc.
	setAgentDir(path.join(root, "agent"));
	key = makeKey(root);
	__setOwnerIncarnationReaderForTests(() => OWNER_INCARNATION);
});

afterEach(() => {
	__setOwnerIncarnationReaderForTests(null);
	if (originalAgentDir) setAgentDir(originalAgentDir);
	rmSync(root, { recursive: true, force: true });
});

describe("probeOwnerLiveness", () => {
	it("is tri-state: ESRCH proves death, EPERM proves life, anything else is unknown", () => {
		const esrch = Object.assign(new Error("no such process"), { code: "ESRCH" });
		const eperm = Object.assign(new Error("not permitted"), { code: "EPERM" });
		const weird = Object.assign(new Error("io"), { code: "EIO" });

		expect(
			probeOwnerLiveness(4242, OWNER_INCARNATION, {
				signal: () => {
					throw esrch;
				},
			}),
		).toBe("dead");
		// EPERM means the process exists under another user; the incarnation then
		// decides whether it is still the SAME process.
		expect(
			probeOwnerLiveness(4242, OWNER_INCARNATION, {
				signal: () => {
					throw eperm;
				},
				readIncarnation: () => OWNER_INCARNATION,
			}),
		).toBe("alive");
		expect(
			probeOwnerLiveness(4242, OWNER_INCARNATION, {
				signal: () => {
					throw weird;
				},
			}),
		).toBe("unknown");
	});

	it("treats an unreadable incarnation as unknown, never as death", () => {
		expect(
			probeOwnerLiveness(4242, OWNER_INCARNATION, {
				signal: () => {},
				readIncarnation: () => undefined,
			}),
		).toBe("unknown");
	});

	it("detects PID reuse: the pid is alive but is a different process", () => {
		expect(
			probeOwnerLiveness(4242, OWNER_INCARNATION, {
				signal: () => {},
				readIncarnation: () => "darwin:1700000000:999999",
			}),
		).toBe("dead");
	});

	it("rejects nonsense pids as unknown rather than dead", () => {
		expect(probeOwnerLiveness(0, OWNER_INCARNATION)).toBe("unknown");
		expect(probeOwnerLiveness(-1, OWNER_INCARNATION)).toBe("unknown");
	});
});

describe("reserveIdentityCreate", () => {
	it("claims a free identity and records the reserved phase", () => {
		const result = reserveIdentityCreate(key);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.reservation.phase).toBe("reserved");
		expect(result.reservation.sessionId).toBe("sess-a");
		expect(result.recovered).toBeNull();
	});

	it("fails closed against a live owner instead of creating a second child", () => {
		const first = reserveIdentityCreate(key, { ownerPid: 1234, ownerIncarnation: OWNER_INCARNATION });
		expect(first.ok).toBe(true);

		const second = reserveIdentityCreate(key, {
			ownerPid: 5678,
			ownerIncarnation: "darwin:1700000000:222222",
			probeLiveness: () => "alive",
		});
		expect(second.ok).toBe(false);
		if (second.ok) return;
		expect(second.code).toBe("identity_reserved_live");
	});

	it("fails closed when owner liveness cannot be proven", () => {
		reserveIdentityCreate(key, { ownerPid: 1234, ownerIncarnation: OWNER_INCARNATION });
		const contender = reserveIdentityCreate(key, {
			ownerPid: 5678,
			ownerIncarnation: "darwin:1700000000:222222",
			probeLiveness: () => "unknown",
		});
		expect(contender.ok).toBe(false);
		if (contender.ok) return;
		expect(contender.code).toBe("identity_reserved_unknown");
	});

	it("reclaims a dead owner that never reached the helper, so a crash cannot brick the identity", () => {
		const first = reserveIdentityCreate(key, { ownerPid: 1234, ownerIncarnation: OWNER_INCARNATION });
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		// phase stays "reserved": the owner died before any child could exist.
		const successor = reserveIdentityCreate(key, {
			ownerPid: 5678,
			ownerIncarnation: "darwin:1700000000:222222",
			probeLiveness: () => "dead",
		});
		expect(successor.ok).toBe(true);
		if (!successor.ok) return;
		expect(successor.recovered?.reservationId).toBe(first.reservation.reservationId);
		expect(successor.reservation.phase).toBe("reserved");
	});

	it("does NOT silently displace a dead owner; it demands recovery first", () => {
		const first = reserveIdentityCreate(key, { ownerPid: 1234, ownerIncarnation: OWNER_INCARNATION });
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		advanceIdentityCreatePhase(first.reservation, "helper_invoked", { attemptSessionName: "skc-attempt-xyz" });

		const contender = reserveIdentityCreate(key, {
			ownerPid: 5678,
			ownerIncarnation: "darwin:1700000000:222222",
			probeLiveness: () => "dead",
		});
		expect(contender.ok).toBe(false);
		if (contender.ok) return;
		// The dead owner may have left an untagged child behind, so takeover is
		// gated on the caller's authority-first census.
		expect(contender.code).toBe("identity_orphan_unresolved");
		expect(contender.existing?.attemptSessionName).toBe("skc-attempt-xyz");
		expect(contender.existing?.phase).toBe("helper_invoked");
	});

	it("an expired lease alone never authorizes takeover of a live owner", () => {
		const first = reserveIdentityCreate(key, {
			ownerPid: 1234,
			ownerIncarnation: OWNER_INCARNATION,
			ttlMs: 1,
			now: () => new Date("2020-01-01T00:00:00.000Z"),
		});
		expect(first.ok).toBe(true);

		// Long past the lease deadline, but the owner is still running: real
		// creators block in unbounded Bun.spawnSync and cannot heartbeat.
		const contender = reserveIdentityCreate(key, {
			ownerPid: 5678,
			ownerIncarnation: "darwin:1700000000:222222",
			now: () => new Date("2030-01-01T00:00:00.000Z"),
			probeLiveness: () => "alive",
		});
		expect(contender.ok).toBe(false);
		if (contender.ok) return;
		expect(contender.code).toBe("identity_reserved_live");
	});

	it("fails closed when the same session id carries a different state file", () => {
		reserveIdentityCreate(key, { ownerPid: 1234, ownerIncarnation: OWNER_INCARNATION });
		const aliased: IdentityCreateKey = { ...key, stateFile: path.join(root, "other-state.json") };
		writeFileSync(aliased.stateFile, "{}\n");

		const contender = reserveIdentityCreate(aliased, {
			ownerPid: 5678,
			ownerIncarnation: "darwin:1700000000:222222",
			probeLiveness: () => "dead",
		});
		expect(contender.ok).toBe(false);
		if (contender.ok) return;
		expect(contender.code).toBe("identity_reserved_unknown");
		expect(contender.diagnostic).toBe("state_file_mismatch");
	});

	it("canonicalizes the key so a relative path cannot dodge an existing reservation", () => {
		const canonical = canonicalIdentityCreateKey(key);
		expect(path.isAbsolute(canonical.stateDir)).toBe(true);

		reserveIdentityCreate(key, { ownerPid: 1234, ownerIncarnation: OWNER_INCARNATION });
		const viaRelative: IdentityCreateKey = {
			stateDir: path.join(root, "nested", ".."),
			sessionId: key.sessionId,
			stateFile: path.join(root, "nested", "..", "sess-a.json"),
		};
		const contender = reserveIdentityCreate(viaRelative, {
			ownerPid: 5678,
			ownerIncarnation: "darwin:1700000000:222222",
			probeLiveness: () => "alive",
		});
		expect(contender.ok).toBe(false);
		if (contender.ok) return;
		expect(contender.code).toBe("identity_reserved_live");
	});

	it("lets an unrelated session id proceed independently", () => {
		reserveIdentityCreate(key, { ownerPid: 1234, ownerIncarnation: OWNER_INCARNATION });
		const other = reserveIdentityCreate(makeKey(root, "sess-b"), {
			ownerPid: 5678,
			ownerIncarnation: "darwin:1700000000:222222",
		});
		expect(other.ok).toBe(true);
	});
});

describe("reclaimIdentityCreate", () => {
	it("takes over only the exact abandoned reservation", () => {
		const first = reserveIdentityCreate(key, { ownerPid: 1234, ownerIncarnation: OWNER_INCARNATION });
		expect(first.ok).toBe(true);
		if (!first.ok) return;

		const reclaimed = reclaimIdentityCreate(key, first.reservation.reservationId, {
			ownerPid: 5678,
			ownerIncarnation: "darwin:1700000000:222222",
			probeLiveness: () => "dead",
		});
		expect(reclaimed.ok).toBe(true);
		if (!reclaimed.ok) return;
		expect(reclaimed.recovered?.reservationId).toBe(first.reservation.reservationId);
		expect(reclaimed.reservation.reservationId).not.toBe(first.reservation.reservationId);
		expect(reclaimed.reservation.phase).toBe("reserved");
	});

	it("fails closed when another process already recovered the identity", () => {
		const first = reserveIdentityCreate(key, { ownerPid: 1234, ownerIncarnation: OWNER_INCARNATION });
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		reclaimIdentityCreate(key, first.reservation.reservationId, {
			ownerPid: 5678,
			ownerIncarnation: "darwin:1700000000:222222",
			probeLiveness: () => "dead",
		});

		const late = reclaimIdentityCreate(key, first.reservation.reservationId, {
			ownerPid: 9999,
			ownerIncarnation: "darwin:1700000000:333333",
			probeLiveness: () => "dead",
		});
		expect(late.ok).toBe(false);
		if (late.ok) return;
		expect(late.code).toBe("identity_orphan_unresolved");
		expect(late.diagnostic).toBe("reservation_changed_during_recovery");
	});

	it("refuses takeover when the owner turns out to be alive after all", () => {
		const first = reserveIdentityCreate(key, { ownerPid: 1234, ownerIncarnation: OWNER_INCARNATION });
		expect(first.ok).toBe(true);
		if (!first.ok) return;

		const resurrected = reclaimIdentityCreate(key, first.reservation.reservationId, {
			ownerPid: 5678,
			ownerIncarnation: "darwin:1700000000:222222",
			probeLiveness: () => "alive",
		});
		expect(resurrected.ok).toBe(false);
		if (resurrected.ok) return;
		expect(resurrected.code).toBe("identity_reserved_live");
	});
});

describe("recoverAbandonedIdentityCreate", () => {
	function abandoned(phase: "helper_invoked" | "spawned" | "published") {
		const first = reserveIdentityCreate(key, { ownerPid: 1234, ownerIncarnation: OWNER_INCARNATION });
		if (!first.ok) throw new Error("expected initial reservation");
		const advanced = advanceIdentityCreatePhase(first.reservation, phase, {
			attemptSessionName: "skc-attempt-abandoned",
			nativeSessionId: "$9",
		});
		if (!advanced) throw new Error("expected phase advance");
		return advanced;
	}

	const dead = { ownerPid: 5678, ownerIncarnation: "darwin:1700000000:222222", probeLiveness: () => "dead" as const };

	it("preserves an authoritative child and refuses to create a second one", () => {
		const existing = abandoned("published");
		const result = recoverAbandonedIdentityCreate(
			key,
			existing,
			{
				inspect: () => ({ kind: "authoritative", nativeSessionId: "$9" }),
				cleanupOrphan: () => {
					throw new Error("must not clean up an authoritative child");
				},
			},
			dead,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		// This is what keeps a tag-before-report crash from creating a successor.
		expect(result.code).toBe("identity_existing_owner");
	});

	it("reclaims when the child is proven absent", () => {
		const existing = abandoned("helper_invoked");
		let cleaned = false;
		const result = recoverAbandonedIdentityCreate(
			key,
			existing,
			{
				inspect: () => ({ kind: "absent" }),
				cleanupOrphan: () => {
					cleaned = true;
				},
			},
			dead,
		);
		expect(result.ok).toBe(true);
		expect(cleaned).toBe(false);
	});

	it("cleans up a non-authoritative orphan before reclaiming", () => {
		const existing = abandoned("spawned");
		const cleanups: string[] = [];
		const result = recoverAbandonedIdentityCreate(
			key,
			existing,
			{
				inspect: () => ({ kind: "orphan", nativeSessionId: "$9" }),
				cleanupOrphan: nativeSessionId => {
					cleanups.push(nativeSessionId);
				},
			},
			dead,
		);
		expect(result.ok).toBe(true);
		expect(cleanups).toEqual(["$9"]);
	});

	it("fails closed when the census cannot decide", () => {
		const existing = abandoned("spawned");
		const result = recoverAbandonedIdentityCreate(
			key,
			existing,
			{
				inspect: () => ({ kind: "unknown", reason: "generation_absent" }),
				cleanupOrphan: () => {
					throw new Error("must not clean up on an undecided census");
				},
			},
			dead,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("identity_orphan_unresolved");
		expect(result.diagnostic).toContain("generation_absent");
	});

	it("does not reclaim when orphan cleanup fails", () => {
		const existing = abandoned("spawned");
		const result = recoverAbandonedIdentityCreate(
			key,
			existing,
			{
				inspect: () => ({ kind: "orphan", nativeSessionId: "$9" }),
				cleanupOrphan: () => {
					throw new Error("kill refused");
				},
			},
			dead,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("identity_orphan_unresolved");
		expect(result.diagnostic).toContain("orphan_cleanup_failed");
	});
});

describe("advanceIdentityCreatePhase", () => {
	it("persists the attempt session name before the helper is invoked", () => {
		const claim = reserveIdentityCreate(key);
		expect(claim.ok).toBe(true);
		if (!claim.ok) return;

		const advanced = advanceIdentityCreatePhase(claim.reservation, "helper_invoked", {
			attemptSessionName: "skc-attempt-random-name",
		});
		expect(advanced?.phase).toBe("helper_invoked");
		// Creator session names are random, so a successor can only find the
		// orphan through this recorded name.
		expect(advanced?.attemptSessionName).toBe("skc-attempt-random-name");
		expect(identityCreatePhaseMayHaveChild("helper_invoked")).toBe(true);
		expect(identityCreatePhaseMayHaveChild("reserved")).toBe(false);
	});

	it("carries the native session id and server incarnation forward", () => {
		const claim = reserveIdentityCreate(key);
		expect(claim.ok).toBe(true);
		if (!claim.ok) return;

		const invoked = advanceIdentityCreatePhase(claim.reservation, "helper_invoked", {
			attemptSessionName: "attempt-1",
		});
		expect(invoked).not.toBeNull();
		if (!invoked) return;
		const spawned = advanceIdentityCreatePhase(invoked, "spawned", {
			nativeSessionId: "$7",
			serverPid: 4242,
			serverStartTime: "Mon Jan  1 00:00:00 2035",
		});
		expect(spawned?.nativeSessionId).toBe("$7");
		expect(spawned?.serverPid).toBe(4242);
		// Unpatched fields survive the transition.
		expect(spawned?.attemptSessionName).toBe("attempt-1");
	});

	it("returns null once the reservation was recovered by someone else", () => {
		const first = reserveIdentityCreate(key, { ownerPid: 1234, ownerIncarnation: OWNER_INCARNATION });
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		reclaimIdentityCreate(key, first.reservation.reservationId, {
			ownerPid: 5678,
			ownerIncarnation: "darwin:1700000000:222222",
			probeLiveness: () => "dead",
		});

		// The original owner must now perform no tmux mutation at all.
		expect(advanceIdentityCreatePhase(first.reservation, "spawned", { nativeSessionId: "$1" })).toBeNull();
	});
});

describe("crash windows", () => {
	// Every window below is a point where the owning process can die between two
	// durable writes. The successor must never conclude "no child can exist" when
	// one might, and must never kill a child that is the current authority.
	const dead = { ownerPid: 5678, ownerIncarnation: "darwin:1700000000:222222", probeLiveness: () => "dead" as const };

	function crashedAt(phase: "reserved" | "helper_invoked" | "spawned" | "tagged" | "published") {
		const first = reserveIdentityCreate(key, { ownerPid: 1234, ownerIncarnation: OWNER_INCARNATION });
		if (!first.ok) throw new Error("expected initial reservation");
		if (phase === "reserved") return first.reservation;
		const advanced = advanceIdentityCreatePhase(first.reservation, phase, {
			attemptSessionName: "skc-attempt-crash",
			nativeSessionId: phase === "helper_invoked" ? null : "$5",
		});
		if (!advanced) throw new Error("expected phase advance");
		return advanced;
	}

	it("crash between spawn and tag never auto-reclaims: a child may exist untagged", () => {
		crashedAt("spawned");
		const successor = reserveIdentityCreate(key, dead);
		expect(successor.ok).toBe(false);
		if (successor.ok) return;
		expect(successor.code).toBe("identity_orphan_unresolved");
		expect(successor.diagnostic).toContain("census_required");
		expect(successor.existing?.nativeSessionId).toBe("$5");
	});

	it("crash between tag and publication cleans the non-authoritative child, then reclaims", () => {
		const existing = crashedAt("tagged");
		const cleanups: string[] = [];
		const recovered = recoverAbandonedIdentityCreate(
			key,
			existing,
			{
				// Tagged but its generation is not the published authority yet.
				inspect: () => ({ kind: "orphan", nativeSessionId: "$5" }),
				cleanupOrphan: nativeSessionId => {
					cleanups.push(nativeSessionId);
				},
			},
			dead,
		);
		expect(recovered.ok).toBe(true);
		expect(cleanups).toEqual(["$5"]);
	});

	it("crash between publication and the phase write still preserves the child", () => {
		// The owner published and died before recording `published`, so the row
		// still says `tagged`. Phase is a hint; the census is the authority.
		const existing = crashedAt("tagged");
		expect(existing.phase).toBe("tagged");
		const recovered = recoverAbandonedIdentityCreate(
			key,
			existing,
			{
				inspect: () => ({ kind: "authoritative", nativeSessionId: "$5" }),
				cleanupOrphan: () => {
					throw new Error("must not kill the published child");
				},
			},
			dead,
		);
		expect(recovered.ok).toBe(false);
		if (recovered.ok) return;
		expect(recovered.code).toBe("identity_existing_owner");
	});

	it("crash before the helper ran is the only window that reclaims without a census", () => {
		crashedAt("reserved");
		const successor = reserveIdentityCreate(key, dead);
		expect(successor.ok).toBe(true);
	});

	it("a superseded-cleanup crash leaves the reservation reclaimable, not bricked", () => {
		const existing = crashedAt("spawned");
		// First recovery attempt dies during cleanup.
		const failed = recoverAbandonedIdentityCreate(
			key,
			existing,
			{
				inspect: () => ({ kind: "orphan", nativeSessionId: "$5" }),
				cleanupOrphan: () => {
					throw new Error("killed mid-cleanup");
				},
			},
			dead,
		);
		expect(failed.ok).toBe(false);
		// A later attempt with a completing cleanup must still succeed.
		const retried = recoverAbandonedIdentityCreate(
			key,
			existing,
			{
				inspect: () => ({ kind: "orphan", nativeSessionId: "$5" }),
				cleanupOrphan: () => {},
			},
			dead,
		);
		expect(retried.ok).toBe(true);
	});
});

describe("releaseIdentityCreate", () => {
	it("frees the identity for the next creator", () => {
		const claim = reserveIdentityCreate(key);
		expect(claim.ok).toBe(true);
		if (!claim.ok) return;
		releaseIdentityCreate(claim.reservation);

		const next = reserveIdentityCreate(key, { ownerPid: 5678, ownerIncarnation: "darwin:1700000000:222222" });
		expect(next.ok).toBe(true);
	});

	it("never deletes a successor's reservation", () => {
		const first = reserveIdentityCreate(key, { ownerPid: 1234, ownerIncarnation: OWNER_INCARNATION });
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		const second = reclaimIdentityCreate(key, first.reservation.reservationId, {
			ownerPid: 5678,
			ownerIncarnation: "darwin:1700000000:222222",
			probeLiveness: () => "dead",
		});
		expect(second.ok).toBe(true);

		// A late release from the displaced owner must not free the new owner's slot.
		releaseIdentityCreate(first.reservation);

		const contender = reserveIdentityCreate(key, {
			ownerPid: 9999,
			ownerIncarnation: "darwin:1700000000:333333",
			probeLiveness: () => "alive",
		});
		expect(contender.ok).toBe(false);
		if (contender.ok) return;
		expect(contender.code).toBe("identity_reserved_live");
	});

	it("is idempotent", () => {
		const claim = reserveIdentityCreate(key);
		expect(claim.ok).toBe(true);
		if (!claim.ok) return;
		releaseIdentityCreate(claim.reservation);
		expect(() => releaseIdentityCreate(claim.reservation)).not.toThrow();
	});
});
