import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTypeSafeKey, verifyTypeSafeKey } from "../src/setup/decision-provider";

function respond(status: number): typeof fetch {
	return (async () => new Response(status === 200 ? "{}" : "nope", { status })) as never;
}

async function tempDb(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skc-typesafe-"));
	return path.join(dir, "agent.db");
}

test("a live key verifies clean", async () => {
	expect(await verifyTypeSafeKey("sk-good", respond(200))).toBeNull();
});

test("a rejected key names the rejection rather than a generic failure", async () => {
	expect(await verifyTypeSafeKey("sk-bad", respond(401))).toMatch(/rejected/);
	expect(await verifyTypeSafeKey("sk-bad", respond(403))).toMatch(/rejected/);
});

test("a server fault is reported as a status, not as a bad key", async () => {
	expect(await verifyTypeSafeKey("sk-good", respond(503))).toMatch(/503/);
});

test("an unreachable endpoint is reported rather than thrown", async () => {
	const failing = (async () => {
		throw new Error("dns");
	}) as never;
	expect(await verifyTypeSafeKey("sk-good", failing)).toMatch(/could not reach/);
});

test("a key that fails verification is never stored", async () => {
	const dbPath = await tempDb();
	const result = await setTypeSafeKey({ apiKey: "sk-bad", fetchImpl: respond(401), dbPath });
	expect(result.verified).toBe(false);
	expect(result.error).toMatch(/rejected/);
	// Storing it would be worse than refusing: the decision service fails open, so a bad
	// key produces no error anywhere and the user believes TypeSafe is active.
	await expect(fs.stat(dbPath)).rejects.toThrow();
});

test("an empty key is refused before any network call", async () => {
	let called = false;
	await expect(
		setTypeSafeKey({
			apiKey: "   ",
			fetchImpl: (async () => {
				called = true;
				return new Response("{}");
			}) as never,
		}),
	).rejects.toThrow(/must not be empty/);
	expect(called).toBe(false);
});

test("a verified key is stored under the provider the backend reads", async () => {
	const dbPath = await tempDb();
	const result = await setTypeSafeKey({ apiKey: "sk-good", fetchImpl: respond(200), dbPath });
	expect(result).toMatchObject({ provider: "typesafe", verified: true });

	const { AuthStorage } = await import("@sayknow-cli/ai");
	const storage = await AuthStorage.create(dbPath);
	try {
		expect(await storage.getApiKey("typesafe")).toBe("sk-good");
	} finally {
		storage.close();
	}
});

test("skip-verify stores without a network call and says so", async () => {
	const dbPath = await tempDb();
	let called = false;
	const result = await setTypeSafeKey({
		apiKey: "sk-offline",
		skipVerify: true,
		dbPath,
		fetchImpl: (async () => {
			called = true;
			return new Response("{}");
		}) as never,
	});
	expect(called).toBe(false);
	expect(result).toMatchObject({ provider: "typesafe", verified: false });
	expect(result.error).toBeUndefined();
});
