import { afterEach, describe, expect, it, vi } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@sayknow-cli/agent-core";
import * as ai from "@sayknow-cli/ai";
import { type Api, getBundledModel, type Model } from "@sayknow-cli/ai";
import * as titleGenerator from "../src/utils/title-generator";

const { generateSessionTitle } = titleGenerator;

const EMPTY_DIR = join(tmpdir(), "title-secrets-empty");

const TOKEN_NAME = "TITLE_OBFUSCATION_TOKEN";
const TOKEN = "skc-title-secret-378-alpha";
const PLACEHOLDER = "#SKC1_bbbbbbbbbbbbbbbbbbbbbb#";
const CAP = 2000;

function model(): Model<Api> {
	const found = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!found) throw new Error("missing title model");
	return found;
}

function settings(enabled: boolean) {
	const selected = model();
	return {
		get(key: string) {
			return key === "secrets.enabled" ? enabled : undefined;
		},
		getModelRole(role: string) {
			return role === "default" ? `${selected.provider}/${selected.id}` : undefined;
		},
		getStorage() {
			return undefined;
		},
		getCwd() {
			return EMPTY_DIR;
		},
		getAgentDir() {
			return join(EMPTY_DIR, "agent");
		},
	} as never;
}

function registry(selected: Model<Api>) {
	return { getAvailable: () => [selected], getApiKey: async () => "test-key" } as never;
}

function outbound(call: unknown, index = 0): string {
	const context = (call as { mock: { calls: unknown[][] } }).mock.calls[index]?.[1] as
		| { messages?: Array<{ content?: string }> }
		| undefined;
	const content = context?.messages?.[0]?.content;
	if (typeof content !== "string") throw new Error("title request had no user text");
	return content;
}

afterEach(() => {
	vi.restoreAllMocks();
	delete process.env[TOKEN_NAME];
});

describe("session title secret outbound", () => {
	it("still allows the first message when secret obfuscation is off", async () => {
		process.env[TOKEN_NAME] = TOKEN;
		const selected = model();
		const completeSimple = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "toolCall", id: "call", name: "set_title", arguments: { title: "Plain Title" } }],
		} as never);
		const message = `${"a".repeat(1990)}${TOKEN}bbbb`;
		const title = await generateSessionTitle(message, registry(selected), settings(false), undefined, selected);
		const body = message.slice(0, CAP);
		expect(title).toBe("Plain Title");
		expect(outbound(completeSimple)).toBe(`<user-message>\n${body}…\n</user-message>`);
		expect(outbound(completeSimple)).toContain(TOKEN.slice(0, 10));
	});

	it("obfuscates a secret that crosses the title cap before the prompt is sent", async () => {
		process.env[TOKEN_NAME] = TOKEN;
		const selected = model();
		const completeSimple = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "toolCall", id: "call", name: "set_title", arguments: { title: "Hidden Title" } }],
		} as never);
		const message = `rotate ${TOKEN} today`;
		const title = await generateSessionTitle(message, registry(selected), settings(true), undefined, selected);
		const sent = outbound(completeSimple);
		expect(title).toBe("Hidden Title");
		expect(sent).not.toContain(TOKEN);
		expect(sent.startsWith("<user-message>\n")).toBe(true);
		expect(sent.endsWith("\n</user-message>")).toBe(true);
		const straddling = `${"a".repeat(1990)}${TOKEN}bbbb`;
		await generateSessionTitle(straddling, registry(selected), settings(true), undefined, selected);
		const straddled = outbound(completeSimple, 1);
		expect(straddled).not.toContain(TOKEN);
		expect(straddled).not.toContain(TOKEN.slice(0, 10));
	});

	it("obfuscates a rename secret before the 400-character digest cut", async () => {
		process.env[TOKEN_NAME] = TOKEN;
		const selected = model();
		const completeSimple = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "toolCall", id: "call", name: "set_title", arguments: { title: "Redacted Title" } }],
		} as never);
		const message = `${"a".repeat(393)}${TOKEN}`;
		const obfuscateText = await titleGenerator.titleInputObfuscator(settings(true));
		if (!obfuscateText) throw new Error("expected secret obfuscator");
		const digest = titleGenerator.buildConversationTitleInput(
			[{ role: "user", content: message, timestamp: 0 } as AgentMessage],
			obfuscateText,
		);
		if (!digest) throw new Error("expected rename digest");
		expect(digest).not.toContain(TOKEN);
		expect(digest).not.toContain(TOKEN.slice(0, 7));

		const title = await generateSessionTitle(digest, registry(selected), settings(true), undefined, selected);
		const sent = outbound(completeSimple);
		expect(title).toBe("Redacted Title");
		expect(sent).not.toContain(TOKEN);
		expect(sent).not.toContain(TOKEN.slice(0, 7));
	});

	it("frames tail-only and head-plus-tail slices after truncation", () => {
		const prepare = titleGenerator.prepareTitleOutboundText;
		expect(typeof prepare).toBe("function");
		const full = `${"H".repeat(400)}${"M".repeat(4000)}SECRET378TAIL${"T".repeat(400)}`;
		const tailOnly = full.slice(-1800);
		const headAndTail = `${full.slice(0, 900)}${full.slice(-900)}`;
		for (const slice of [tailOnly, headAndTail]) {
			const framed = prepare(slice);
			expect(framed.startsWith("<user-message>\n")).toBe(true);
			expect(framed.endsWith("\n</user-message>")).toBe(true);
			expect(framed).toContain(slice);
		}
		const framedFull = prepare(full);
		expect(framedFull.startsWith("<user-message>\n")).toBe(true);
		expect(framedFull.endsWith("\n</user-message>")).toBe(true);
		const inner = framedFull.slice("<user-message>\n".length, -"\n</user-message>".length);
		expect(inner.length).toBeLessThanOrEqual(CAP + 1);
		// Tail-only slice longer than the cap: the function truncates, then fences.
		const tailOnlyOverlong = full.slice(-2500);
		const framedTail = prepare(tailOnlyOverlong);
		expect(tailOnlyOverlong.length).toBeGreaterThan(CAP);
		expect(framedTail.startsWith("<user-message>\n")).toBe(true);
		expect(framedTail.endsWith("\n</user-message>")).toBe(true);
		const headAndTailOverlong = `${full.slice(0, 1500)}${full.slice(-1500)}`;
		const framedHeadTail = prepare(headAndTailOverlong);
		expect(headAndTailOverlong.length).toBeGreaterThan(CAP);
		expect(framedHeadTail.startsWith("<user-message>\n")).toBe(true);
		expect(framedHeadTail.endsWith("\n</user-message>")).toBe(true);
	});

	// Seeded xorshift32 generator; fast-check is not a fork dependency.
	function xorshift(seed: number): (bound: number) => number {
		let state = seed;
		return bound => {
			state ^= state << 13;
			state ^= state >>> 17;
			state ^= state << 5;
			return (state >>> 0) % bound;
		};
	}

	it("property: title outbound keeps the fence and drops a configured secret", () => {
		const next = xorshift(378202610);
		const printable = (length: number): string =>
			Array.from({ length }, () => String.fromCharCode(32 + next(95))).join("");
		const prepare = titleGenerator.prepareTitleOutboundText;
		expect(typeof prepare).toBe("function");
		let runs = 0;
		while (runs < 80) {
			const pad = next(2101);
			const tail = printable(next(41));
			const secret = printable(8 + next(17));
			if (secret.trim().length < 8 || secret.includes("<") || secret.includes(">") || PLACEHOLDER.includes(secret))
				continue;
			runs++;
			const base = `${"a".repeat(pad)}${tail}`;
			const plain = prepare(base);
			const manual = base.length > CAP ? `${base.slice(0, CAP)}…` : base;
			expect(plain).toBe(`<user-message>\n${manual}\n</user-message>`);
			const at = Math.min(1996, base.length);
			const withSecret = `${base.slice(0, at)}${secret}${base.slice(at)}`;
			const sent = prepare(withSecret, text => text.split(secret).join(PLACEHOLDER));
			expect(sent.startsWith("<user-message>\n")).toBe(true);
			expect(sent.endsWith("\n</user-message>")).toBe(true);
			expect(sent).not.toContain(secret);
			const inner = sent.slice("<user-message>\n".length, -"\n</user-message>".length);
			expect(inner.length).toBeLessThanOrEqual(CAP + 1);
		}
	});

	it("property: rename digest obfuscates before the 400-character cut", () => {
		const build = titleGenerator.buildConversationTitleInput;
		const placeholder = "#SKC1_qqqqqqqqqqqqqqqqqqqqqq#";
		const user = (content: string): AgentMessage => ({ role: "user", content, timestamp: 0 }) as AgentMessage;
		const next = xorshift(378400201);
		for (let run = 0; run < 64; run++) {
			const pad = next(451);
			const core = Array.from({ length: 8 + next(9) }, () => "abcdefghij"[next(10)]).join("");
			const lead = next(3);
			const trail = next(3);
			const secret = `${" ".repeat(lead)}${core}${" ".repeat(trail)}`;
			const message = `${"x".repeat(pad)}${secret}`;
			const visible = message.trim();
			const raw = build([user(message)]);
			const historical = visible.length > 400 ? `${visible.slice(0, 400)}…` : visible;
			expect(raw).toBe(historical);
			const redacted = build([user(message)], text => text.split(secret).join(placeholder));
			expect(redacted).toBeDefined();
			expect(redacted!.startsWith("<user-message>")).toBe(false);
			expect(redacted).not.toContain(core);
			expect(redacted!.length).toBeLessThanOrEqual(401);
			if (pad < 400 && pad + core.length > 400) {
				const prefix = core.slice(0, 400 - pad);
				expect(redacted).not.toContain(prefix);
			}
		}
	});
});
