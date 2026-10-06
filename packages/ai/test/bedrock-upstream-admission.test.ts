import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $inheritedEnv } from "@sayknow-cli/utils";
import { type BedrockOptions, streamBedrock } from "../src/providers/amazon-bedrock";
import { clearAwsCredentialCache } from "../src/providers/aws-credentials";
import type { Context, FetchImpl, Model } from "../src/types";
import {
	createUpstreamAdmission,
	RecoveryAdmissionError,
	type RecoveryRequestKind,
} from "../src/utils/recovery-budget";

const model: Model<"bedrock-converse-stream"> = {
	id: "anthropic.claude-test",
	name: "Claude Test",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};

const context: Context = {
	systemPrompt: ["Test"],
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

const ENV_KEYS = [
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_PROFILE",
	"AWS_SHARED_CREDENTIALS_FILE",
	"AWS_CONFIG_FILE",
	"AWS_EC2_METADATA_DISABLED",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_BEDROCK_SKIP_AUTH",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
] as const;

const UNOBSERVED_REASON = "AWS credential source has unobserved remote requests";

interface Harness {
	kinds: RecoveryRequestKind[];
	urls: string[];
	uncertain: string[];
	options: BedrockOptions;
}

/** Owner-shaped admission: every outbound request is recorded with the kind the owner saw. */
function harness(respond: (url: string) => Response, extra: Partial<BedrockOptions> = {}): Harness {
	const kinds: RecoveryRequestKind[] = [];
	const urls: string[] = [];
	const uncertain: string[] = [];
	const base: FetchImpl = async input => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		urls.push(url);
		return respond(url);
	};
	const admission = createUpstreamAdmission(kind => kinds.push(kind), base);
	return {
		kinds,
		urls,
		uncertain,
		options: {
			region: "us-east-1",
			fetch: admission.fetch,
			credentialFetch: admission.credentialFetch,
			onUncertainUpstream: reason => uncertain.push(reason),
			...extra,
		},
	};
}

function isInference(url: string): boolean {
	return url.startsWith("https://bedrock-runtime.us-east-1.amazonaws.com/");
}

const rejectInference = () => new Response("validationException: nope", { status: 400 });

describe("Bedrock upstream admission", () => {
	const saved = new Map<string, string | undefined>();
	let root: string;

	beforeEach(async () => {
		for (const key of ENV_KEYS) {
			saved.set(key, Bun.env[key]);
			delete Bun.env[key];
		}
		Bun.env.AWS_EC2_METADATA_DISABLED = "true";
		root = await fs.mkdtemp(path.join(os.tmpdir(), "bedrock-admission-"));
		// Point profile resolution at empty files so the developer's ~/.aws never participates.
		Bun.env.AWS_SHARED_CREDENTIALS_FILE = path.join(root, "credentials");
		Bun.env.AWS_CONFIG_FILE = path.join(root, "config");
		Bun.env.AWS_PROFILE = "admission-test";
		clearAwsCredentialCache();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const [key, value] of saved) {
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
		saved.clear();
		clearAwsCredentialCache();
		await fs.rm(root, { recursive: true, force: true });
	});

	// Startup-inherited AWS variables take precedence over live overrides and would mask the paths under test.
	const inheritedAws = ENV_KEYS.some(key => $inheritedEnv(key) !== undefined);

	it.skipIf(inheritedAws)(
		"sends inference only through options.fetch and spends no token request for static keys",
		async () => {
			Bun.env.AWS_ACCESS_KEY_ID = "AKIDSTATIC";
			Bun.env.AWS_SECRET_ACCESS_KEY = "static-secret";
			const globalFetch = vi.spyOn(globalThis, "fetch");
			const h = harness(rejectInference);

			const result = await streamBedrock(model, context, h.options).result();

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("Bedrock HTTP 400");
			expect(h.kinds).toEqual(["inference"]);
			expect(h.urls.every(isInference)).toBe(true);
			expect(h.uncertain).toEqual([]);
			expect(globalFetch).not.toHaveBeenCalled();
		},
	);

	it.skipIf(inheritedAws)("makes exactly one request on 503 when fallback is owner-managed", async () => {
		Bun.env.AWS_ACCESS_KEY_ID = "AKIDSTATIC";
		Bun.env.AWS_SECRET_ACCESS_KEY = "static-secret";
		const unavailable = () => new Response("busy", { status: 503, headers: { "retry-after": "0" } });

		const managed = harness(unavailable, { fallbackManaged: true });
		const managedResult = await streamBedrock(model, context, managed.options).result();
		expect(managedResult.errorMessage).toContain("Bedrock HTTP 503");
		expect(managed.kinds).toEqual(["inference"]);

		// Control: the same 503 is retried by the provider when fallback is not owner-managed.
		const unmanaged = harness(unavailable, { requestMaxRetries: 1 });
		await streamBedrock(model, context, unmanaged.options).result();
		expect(unmanaged.kinds).toEqual(["inference", "resend"]);
	});

	it.skipIf(inheritedAws)("routes the forced tool-choice retry through options.fetch", async () => {
		Bun.env.AWS_ACCESS_KEY_ID = "AKIDSTATIC";
		Bun.env.AWS_SECRET_ACCESS_KEY = "static-secret";
		const globalFetch = vi.spyOn(globalThis, "fetch");
		const h = harness(() => new Response("validationException: toolChoice is not supported", { status: 400 }), {
			toolChoice: "required",
		});
		const forcedContext: Context = {
			...context,
			tools: [
				{
					name: "read",
					description: "Read",
					parameters: { type: "object", properties: {}, additionalProperties: false },
				},
			],
		};

		await streamBedrock({ ...model, id: "anthropic.claude-forced-admission" }, forcedContext, h.options).result();

		expect(h.kinds).toEqual(["inference", "resend"]);
		expect(globalFetch).not.toHaveBeenCalled();
	});

	it.skipIf(inheritedAws)("exchanges SSO role credentials through credentialFetch before inference", async () => {
		const home = path.join(root, "home");
		const cacheDir = path.join(home, ".aws", "sso", "cache");
		await fs.mkdir(cacheDir, { recursive: true });
		await fs.writeFile(
			path.join(cacheDir, "token.json"),
			JSON.stringify({
				accessToken: "sso-access-token",
				expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
				startUrl: "https://example.awsapps.com/start",
				region: "us-west-2",
			}),
		);
		await fs.writeFile(
			path.join(root, "config"),
			[
				"[profile admission-test]",
				"sso_start_url = https://example.awsapps.com/start",
				"sso_region = us-west-2",
				"sso_account_id = 123456789012",
				"sso_role_name = Dev",
				"",
			].join("\n"),
		);
		vi.spyOn(os, "homedir").mockReturnValue(home);
		const globalFetch = vi.spyOn(globalThis, "fetch");
		const h = harness(url => {
			if (url.startsWith("https://portal.sso.us-west-2.amazonaws.com/federation/credentials")) {
				return Response.json({
					roleCredentials: {
						accessKeyId: "AKIDSSO",
						secretAccessKey: "sso-secret",
						sessionToken: "sso-session",
						expiration: Date.now() + 3_600_000,
					},
				});
			}
			return rejectInference();
		});

		const first = await streamBedrock(model, context, h.options).result();
		expect(first.errorMessage).toContain("Bedrock HTTP 400");
		expect(h.kinds).toEqual(["token", "inference"]);
		expect(h.urls[0]).toContain("account_id=123456789012");
		expect(isInference(h.urls[1] ?? "")).toBe(true);

		// Cached role credentials are reused without another token request.
		const second = harness(rejectInference);
		await streamBedrock(model, context, second.options).result();
		expect(second.kinds).toEqual(["inference"]);
		expect(h.uncertain).toEqual([]);
		expect(globalFetch).not.toHaveBeenCalled();
	});

	it.skipIf(inheritedAws)("reads IMDSv2 credentials through credentialFetch", async () => {
		delete Bun.env.AWS_EC2_METADATA_DISABLED;
		const globalFetch = vi.spyOn(globalThis, "fetch");
		const h = harness(url => {
			if (url.endsWith("/latest/api/token")) return new Response("imds-token");
			if (url.endsWith("/latest/meta-data/iam/security-credentials/")) return new Response("ec2-role\n");
			if (url.endsWith("/latest/meta-data/iam/security-credentials/ec2-role")) {
				return Response.json({ AccessKeyId: "AKIDIMDS", SecretAccessKey: "imds-secret", Token: "imds-session" });
			}
			return rejectInference();
		});

		await streamBedrock(model, context, h.options).result();

		expect(h.kinds).toEqual(["token", "token", "token", "inference"]);
		expect(h.urls.slice(0, 3).every(url => url.startsWith("http://169.254.169.254/"))).toBe(true);
		expect(globalFetch).not.toHaveBeenCalled();
	});

	it.skipIf(inheritedAws)(
		"surfaces an owner refusal of the IMDS token request instead of a missing-credentials error",
		async () => {
			delete Bun.env.AWS_EC2_METADATA_DISABLED;
			const urls: string[] = [];
			const admission = createUpstreamAdmission(
				kind => {
					if (kind === "token") throw new RecoveryAdmissionError("request_limit");
				},
				async input => {
					urls.push(String(input));
					return rejectInference();
				},
			);

			const result = await streamBedrock(model, context, {
				region: "us-east-1",
				fetch: admission.fetch,
				credentialFetch: admission.credentialFetch,
			}).result();

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toBe("Recovery request limit reached");
			expect(urls).toEqual([]);
		},
	);

	it.skipIf(inheritedAws)("marks credential_process as unobserved upstream once and not on cache hits", async () => {
		const script = path.join(root, "creds.ts");
		await fs.writeFile(
			script,
			`console.log(JSON.stringify({ Version: 1, AccessKeyId: "AKIDPROC", SecretAccessKey: "proc-secret", Expiration: new Date(Date.now() + 3600000).toISOString() }));\n`,
		);
		await fs.writeFile(
			path.join(root, "config"),
			`[profile admission-test]\ncredential_process = ${process.execPath} ${script}\n`,
		);
		const h = harness(rejectInference);

		await streamBedrock(model, context, h.options).result();
		expect(h.uncertain).toEqual([UNOBSERVED_REASON]);
		expect(h.kinds).toEqual(["inference"]);

		const cached = harness(rejectInference);
		await streamBedrock(model, context, cached.options).result();
		expect(cached.uncertain).toEqual([]);
		expect(cached.kinds).toEqual(["inference"]);
	});
});
