import { describe, expect, test } from "bun:test";
import { AsyncJobManager } from "@sayknow-cli/coding-agent/async/job-manager";

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("waitFor timed out");
}

// Upstream e130edd302 (#6521): the in-flight delivery future was assigned only
// after the delivery callback had started, so a drain reentered from inside
// `onJobComplete` found no future and treated the delivery as settled.
describe("AsyncJobManager delivery future enrollment", () => {
	test("a drain reentered from the delivery callback waits on the enrolled future", async () => {
		const release = Promise.withResolvers<void>();
		const outcomes: { bounded?: boolean; unbounded?: boolean } = {};
		let unbounded: Promise<boolean> | undefined;
		let bounded: Promise<boolean> | undefined;
		const manager = new AsyncJobManager({
			onJobComplete: async () => {
				if (!unbounded) {
					unbounded = manager.drainDeliveries();
					void unbounded.then(value => {
						outcomes.unbounded = value;
					});
					bounded = manager.drainDeliveries({ timeoutMs: 0 });
					void bounded.then(value => {
						outcomes.bounded = value;
					});
				}
				await release.promise;
			},
		});
		try {
			manager.register("bash", "held delivery", async () => "payload");
			await waitFor(() => bounded !== undefined);
			expect(await bounded).toBe(false);
			await Bun.sleep(20);
			expect(outcomes.unbounded).toBeUndefined();
			release.resolve();
			expect(await unbounded).toBe(true);
		} finally {
			release.resolve();
			await manager.waitForAll();
			await manager.dispose({ timeoutMs: 250 });
		}
	});

	test("an owner in-flight wait reentered from the delivery callback does not report settlement early", async () => {
		const release = Promise.withResolvers<void>();
		let ownerWait: Promise<boolean> | undefined;
		const manager = new AsyncJobManager({
			onJobComplete: async () => {
				ownerWait ??= manager.waitForOwnerInFlightDeliveries("owner-held", { timeoutMs: 50 });
				await release.promise;
			},
		});
		try {
			manager.register("bash", "held owner delivery", async () => "payload", { ownerId: "owner-held" });
			await waitFor(() => ownerWait !== undefined);
			expect(await ownerWait).toBe(false);
		} finally {
			release.resolve();
			await manager.waitForAll();
			await manager.dispose({ timeoutMs: 250 });
		}
	});
});
