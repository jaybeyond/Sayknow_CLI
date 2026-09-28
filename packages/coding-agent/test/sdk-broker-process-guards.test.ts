import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Broker } from "../src/sdk/broker/broker";
import { brokerDiscoveryPath, readBrokerDiscovery } from "../src/sdk/broker/discovery";
import {
	checkSessionHostAuthority,
	exitIfSourceGone,
	type SessionHostAuthority,
	type SessionHostAuthorityState,
	sourceEntryAvailable,
	sourceEntryPath,
	startSessionHostGuard,
} from "../src/sdk/broker/process-guard";

const roots: string[] = [];
const brokers: Broker[] = [];

afterEach(async () => {
	for (const broker of brokers.splice(0)) await broker.stop().catch(() => {});
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

/** Resolves true if the broker completes within `ms`, false if it is still running. */
async function stopsWithin(broker: Broker, ms: number): Promise<boolean> {
	return Promise.race([broker.completion.then(() => true), Bun.sleep(ms).then(() => false)]);
}

async function exists(file: string): Promise<boolean> {
	return fs
		.stat(file)
		.then(() => true)
		.catch(() => false);
}

function errno(code: string): Error {
	return Object.assign(new Error(code), { code });
}

describe("broker idle shutdown", () => {
	// heartbeatTtlMs 60 → a publication tick every 20ms, so idle checks run often.
	const fast = { heartbeatTtlMs: 60, idleShutdownMs: 150 };

	it("stops on its own once nothing uses it, releasing discovery and the lock", async () => {
		const agentDir = await tempDir("skc-broker-idle-");
		const broker = new Broker({ agentDir, ...fast });
		brokers.push(broker);
		await broker.start();
		expect(await readBrokerDiscovery(agentDir)).not.toBeNull();

		expect(await stopsWithin(broker, 3_000)).toBe(true);
		expect(await exists(brokerDiscoveryPath(agentDir))).toBe(false);
		expect(await exists(path.join(agentDir, "sdk", "broker.lock"))).toBe(false);
	});

	it("stays up while a client is connected, and stops after it disconnects", async () => {
		const agentDir = await tempDir("skc-broker-idle-conn-");
		const broker = new Broker({ agentDir, ...fast });
		brokers.push(broker);
		const discovery = await broker.start();
		const socket = new WebSocket(`${discovery.url}?token=${discovery.token}`);
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("message", () => resolve(), { once: true });
			socket.addEventListener("error", () => reject(new Error("socket error")), { once: true });
		});

		expect(await stopsWithin(broker, 800)).toBe(false);
		socket.close();
		expect(await stopsWithin(broker, 3_000)).toBe(true);
	});

	it("stays up while a session host is live, and stops once it unregisters", async () => {
		const agentDir = await tempDir("skc-broker-idle-live-");
		const broker = new Broker({ agentDir, ...fast });
		brokers.push(broker);
		await broker.start();
		const registration = {
			sessionId: "live",
			locator: { repo: agentDir, stateRoot: path.join(agentDir, "state") },
			endpointGeneration: 1,
			pid: process.pid,
		};
		await broker.index.append({ type: "host_registered", ...registration, endpointMtimeMs: Date.now() });

		expect(await stopsWithin(broker, 800)).toBe(false);
		await broker.index.append({ type: "host_unregistered", ...registration });
		expect(await stopsWithin(broker, 3_000)).toBe(true);
	});

	it("never idles out when idleShutdownMs is 0", async () => {
		const agentDir = await tempDir("skc-broker-idle-off-");
		const broker = new Broker({ agentDir, heartbeatTtlMs: 60, idleShutdownMs: 0 });
		brokers.push(broker);
		await broker.start();
		expect(await stopsWithin(broker, 600)).toBe(false);
	});

	it("runs the process guard before each publication tick and skips the tick when it fires", async () => {
		const agentDir = await tempDir("skc-broker-guard-");
		let guardCalls = 0;
		const broker = new Broker({
			agentDir,
			heartbeatTtlMs: 60,
			idleShutdownMs: 0,
			beforePublicationTick: () => {
				guardCalls += 1;
				return true;
			},
		});
		brokers.push(broker);
		const started = await broker.start();
		await Bun.sleep(200);
		expect(guardCalls).toBeGreaterThan(2);
		// Every tick was skipped, so the published heartbeat never advanced.
		const onDisk = JSON.parse(await fs.readFile(brokerDiscoveryPath(agentDir), "utf8")) as { heartbeatAt: number };
		expect(onDisk.heartbeatAt).toBe(started.heartbeatAt);
	});
});

describe("source guard", () => {
	it("treats compiled-binary entries as always available", () => {
		expect(sourceEntryPath("/$bunfs/root/skc")).toBeUndefined();
		expect(sourceEntryPath("B:/~BUN/root/skc.exe")).toBeUndefined();
		expect(sourceEntryPath("/Volumes/drive/repo/src/cli.ts")).toBe("/Volumes/drive/repo/src/cli.ts");
		expect(sourceEntryAvailable(undefined)).toBe(true);
	});

	it("reports the source gone only for missing-file and dead-volume errors", () => {
		const failing = (code: string) => () => {
			throw errno(code);
		};
		for (const code of ["ENOENT", "ENOTDIR", "EIO", "ENXIO", "ENODEV"]) {
			expect(sourceEntryAvailable("/x/cli.ts", failing(code))).toBe(false);
		}
		// A permission problem is not a vanished checkout.
		expect(sourceEntryAvailable("/x/cli.ts", failing("EACCES"))).toBe(true);
		expect(sourceEntryAvailable("/x/cli.ts", () => ({}))).toBe(true);
	});

	it("kills the process only when the source is gone", () => {
		let kills = 0;
		const kill = () => {
			kills += 1;
		};
		expect(exitIfSourceGone("/x/cli.ts", { stat: () => ({}), kill })).toBe(false);
		expect(kills).toBe(0);
		expect(
			exitIfSourceGone("/x/cli.ts", {
				stat: () => {
					throw errno("ENOENT");
				},
				kill,
			}),
		).toBe(true);
		expect(kills).toBe(1);
		expect(exitIfSourceGone(undefined, { stat: () => ({}), kill })).toBe(false);
	});
});

describe("session host guard", () => {
	const authority = (dir: string): SessionHostAuthority => ({
		markerPath: path.join(dir, "sdk", "s.lifecycle.json"),
		pid: 4242,
		effectMarker: "effect-1",
		incarnation: "darwin:1:2",
		cwd: dir,
	});

	it("holds while the marker names this host and the worktree exists", async () => {
		const dir = await tempDir("skc-host-guard-");
		const held = authority(dir);
		await fs.mkdir(path.dirname(held.markerPath), { recursive: true });
		await fs.writeFile(
			held.markerPath,
			JSON.stringify({ pid: 4242, effectMarker: "effect-1", incarnation: "darwin:1:2" }),
		);
		expect(checkSessionHostAuthority(held)).toBe("held");

		// Taken over by another spawn of the same session.
		await fs.writeFile(
			held.markerPath,
			JSON.stringify({ pid: 4243, effectMarker: "effect-2", incarnation: "darwin:1:3" }),
		);
		expect(checkSessionHostAuthority(held)).toBe("lost");

		// Session deleted: marker gone.
		await fs.rm(held.markerPath);
		expect(checkSessionHostAuthority(held)).toBe("lost");

		// Whole state root removed (a finished test).
		await fs.rm(dir, { recursive: true, force: true });
		expect(checkSessionHostAuthority(held)).toBe("lost");
	});

	it("does not count unreadable state as lost", () => {
		const held = authority("/nowhere");
		expect(
			checkSessionHostAuthority(held, {
				stat: () => {
					throw errno("EACCES");
				},
			}),
		).toBe("unknown");
		expect(checkSessionHostAuthority(held, { stat: () => ({}), readFile: () => "{torn" })).toBe("unknown");
		expect(
			checkSessionHostAuthority(held, {
				stat: () => ({}),
				readFile: () => {
					throw errno("EIO");
				},
			}),
		).toBe("unknown");
	});

	function manualGuard(states: SessionHostAuthorityState[], sourceGone = false) {
		let tick: (() => void) | undefined;
		let lost = 0;
		let cleared = false;
		const stop = startSessionHostGuard({
			...authority("/unused"),
			onLost: () => {
				lost += 1;
			},
			check: () => states.shift() ?? "held",
			sourceGuard: () => sourceGone,
			setInterval: ((callback: () => void) => {
				tick = callback;
				return 1;
			}) as unknown as typeof setInterval,
			clearInterval: (() => {
				cleared = true;
			}) as typeof clearInterval,
		});
		return {
			tick: (times = 1) => {
				for (let i = 0; i < times; i++) tick?.();
			},
			lost: () => lost,
			cleared: () => cleared,
			stop,
		};
	}

	it("gives up the session only after three lost checks in a row", () => {
		const guard = manualGuard(["lost", "lost", "held", "lost", "unknown", "lost", "lost", "lost"]);
		guard.tick(7);
		expect(guard.lost()).toBe(0);
		guard.tick();
		expect(guard.lost()).toBe(1);
		expect(guard.cleared()).toBe(true);
		guard.tick(5);
		expect(guard.lost()).toBe(1);
	});

	it("checks nothing once the source guard fires (it already ended the process)", () => {
		const guard = manualGuard(["lost", "lost", "lost"], true);
		guard.tick(3);
		expect(guard.lost()).toBe(0);
	});
});
