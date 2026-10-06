import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { __resetVertexTokenCache } from "../src/providers/google-auth";
import { streamGoogleVertex } from "../src/providers/google-vertex";
import type { Context, FetchImpl } from "../src/types";
import { createUpstreamAdmission, type RecoveryRequestKind } from "../src/utils/recovery-budget";
import { collectEvents, createBaseModel, createSseResponse } from "./openai-tool-choice-test-helpers";

/**
 * The Vertex ADC token exchange is credential traffic. It must go through the owner's
 * `credentialFetch` ("token" admission) so the generateContent request that follows is
 * admitted as the first "inference" rather than a "resend".
 */

const ENV_KEYS = ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_API_KEY"] as const;
const savedEnv = new Map<string, string | undefined>();
let tempDir = "";

const CONTEXT: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

beforeAll(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "skc-vertex-admission-"));
	const adcPath = path.join(tempDir, "adc.json");
	fs.writeFileSync(
		adcPath,
		JSON.stringify({
			type: "authorized_user",
			client_id: "client-id",
			client_secret: "client-secret",
			refresh_token: "refresh-token",
		}),
	);
	for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
	delete process.env.GOOGLE_CLOUD_API_KEY;
	process.env.GOOGLE_APPLICATION_CREDENTIALS = adcPath;
});

afterAll(() => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	__resetVertexTokenCache();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
	__resetVertexTokenCache();
});

interface Harness {
	kinds: RecoveryRequestKind[];
	urls: string[];
	fetch: FetchImpl;
	credentialFetch: FetchImpl;
}

function createHarness(): Harness {
	const kinds: RecoveryRequestKind[] = [];
	const urls: string[] = [];
	const base = async (input: string | URL | Request): Promise<Response> => {
		const url = String(input instanceof Request ? input.url : input);
		urls.push(url);
		if (url.startsWith("https://oauth2.googleapis.com/token")) {
			return new Response(JSON.stringify({ access_token: "vertex-access-token", expires_in: 3600 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return createSseResponse([{ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }]);
	};
	const admission = createUpstreamAdmission(kind => kinds.push(kind), base as FetchImpl);
	return { kinds, urls, fetch: admission.fetch, credentialFetch: admission.credentialFetch };
}

async function runVertex(harness: Harness): Promise<void> {
	const stream = streamGoogleVertex(createBaseModel("google-vertex"), CONTEXT, {
		apiKey: "<authenticated>",
		project: "test-project",
		location: "us-central1",
		fetch: harness.fetch,
		credentialFetch: harness.credentialFetch,
	});
	await collectEvents(stream);
	const result = await stream.result();
	expect(result.stopReason).toBe("stop");
}

describe("google-vertex ADC token admission", () => {
	it("admits the ADC token exchange as token and the generateContent request as the first inference", async () => {
		const harness = createHarness();
		await runVertex(harness);
		expect(harness.kinds).toEqual(["token", "inference"]);
		expect(harness.urls).toHaveLength(2);
		expect(harness.urls[0]).toStartWith("https://oauth2.googleapis.com/token");
		expect(harness.urls[1]).toContain("us-central1-aiplatform.googleapis.com");
	});

	it("sends no token request when the ADC token is cached", async () => {
		await runVertex(createHarness());
		const harness = createHarness();
		await runVertex(harness);
		expect(harness.kinds).toEqual(["inference"]);
		expect(harness.kinds.filter(kind => kind === "token")).toHaveLength(0);
		expect(harness.urls).toHaveLength(1);
	});
});
