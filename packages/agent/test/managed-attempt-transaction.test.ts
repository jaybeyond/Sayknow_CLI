import { describe, expect, it, spyOn } from "bun:test";
import type { ManagedAttemptOutcome } from "@sayknow-cli/agent-core";
import { Agent } from "@sayknow-cli/agent-core";
import {
	agentLoopContinue,
	MANAGED_ATTEMPT_MAX_STAGED_BYTES,
	MANAGED_ATTEMPT_MAX_STAGED_EVENTS,
	MANAGED_ATTEMPT_MAX_VISIBLE_HOLD_MS,
	ManagedAttemptTransaction,
	sanitizedDetachedClone,
} from "@sayknow-cli/agent-core/agent-loop";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage } from "@sayknow-cli/agent-core/types";
import type { AssistantMessage, AssistantMessageEvent, Message } from "@sayknow-cli/ai";
import { EventStream } from "@sayknow-cli/ai";

import { createMockModel } from "@sayknow-cli/ai/providers/mock";
import { AssistantMessageEventStream } from "@sayknow-cli/ai/utils/event-stream";

function assistantMessage(model: AgentLoopConfig["model"]): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function expectManagedRunStart(events: string[]): void {
	expect(events.filter(type => type === "agent_start")).toHaveLength(1);
	const start = events.indexOf("agent_start");
	for (const lifecycleType of ["message_start", "turn_start", "agent_end"]) {
		const lifecycleIndex = events.indexOf(lifecycleType);
		if (lifecycleIndex >= 0) expect(start).toBeLessThan(lifecycleIndex);
	}
}

// This is an internal transaction seam, not a config/telemetry API. Observe the
// actual queue boundary synchronously; consumer-owned output is deliberately
// excluded from the provisional inventory.
function ledgerFixture(
	observed = true,
	effect?: (message: AssistantMessage, event: AssistantMessageEvent, count: number) => void,
) {
	const mock = createMockModel();
	const order: string[] = [];
	const events: AgentEvent[] = [];
	const callbacks: Array<{ message: AssistantMessage; event: AssistantMessageEvent }> = [];
	class CaptureStream extends EventStream<AgentEvent, AgentMessage[]> {
		override push(event: AgentEvent): void {
			events.push(event);
			order.push(event.type === "message_update" ? "update" : event.type);
			super.push(event);
		}
	}
	const stream = new CaptureStream(
		event => event.type === "agent_end",
		() => [],
	);
	const observer = observed
		? (message: AssistantMessage, event: AssistantMessageEvent) => {
				callbacks.push({ message, event });
				order.push("callback");
				effect?.(message, event, callbacks.length);
			}
		: undefined;
	const transaction = new ManagedAttemptTransaction(stream, observer, mock.model);
	const message = assistantMessage(mock.model);
	message.timestamp = 0;
	message.content = [{ type: "text", text: "" }];
	const update = (text: string, delta = text) => {
		(message.content[0] as { type: "text"; text: string }).text = text;
		const event: AssistantMessageEvent = { type: "text_delta", contentIndex: 0, delta, partial: message };
		if (observed) transaction.stageAssistantMessageEvent(message, event);
		transaction.push({ type: "message_update", message, assistantMessageEvent: event });
	};
	return { mock, stream, transaction, message, update, events, callbacks, order };
}

function messageText(message: AssistantMessage): string {
	return (message.content[0] as { type: "text"; text: string }).text;
}

/** Pins Date.now() for tests that assert staging, so the visible-hold window never elapses. */
function frozenClock(): Disposable {
	const now = Date.now();
	const spy = spyOn(Date, "now").mockReturnValue(now);
	return { [Symbol.dispose]: () => spy.mockRestore() };
}

describe("managed compact ledger", () => {
	for (const observed of [false, true]) {
		it(`retains 1,000 cumulative 49-byte updates losslessly (observer=${observed})`, () => {
			// Ledger accounting, not timing: freeze the clock so a slow runner cannot
			// hit the visible-hold window and publish mid-stream.
			using _clock = frozenClock();
			const fixture = ledgerFixture(observed);
			const { transaction, message, update, events, callbacks, order } = fixture;
			transaction.push({ type: "turn_start" });
			transaction.push({ type: "message_start", message });
			let text = "";
			const expected: string[] = [];
			for (let index = 0; index < 1_000; index++) {
				const delta = `${String(index).padStart(4, "0")}${"x".repeat(45)}`;
				text += delta;
				expected.push(text);
				update(text, delta);
			}
			transaction.push({ type: "message_end", message });
			const inventory = transaction.ownedInventory();
			expect(inventory.recordCount).toBe(observed ? 2_003 : 1_003);
			expect(inventory.totalBytes).toBe(inventory.structuralBytes + inventory.payloadBytes);
			expect(inventory.totalBytes).toBeLessThanOrEqual(1_040_768);
			expect(inventory.peakBytes).toBeLessThan(1_048_576);
			expect(
				inventory.strings.reduce((sum, owner) => sum + owner.bytes, 0) +
					inventory.buffers.reduce((sum, owner) => sum + owner.bytes, 0),
			).toBe(inventory.payloadBytes);
			expect(
				inventory.buffers.filter(owner => owner.kind === "suffix").reduce((sum, owner) => sum + owner.bytes, 0),
			).toBe(98_000);
			if (observed) expect(inventory.totalBytes - 950_768).toBeLessThanOrEqual(90_000);
			expect(events).toHaveLength(0);
			expect(callbacks).toHaveLength(0);
			transaction.flush();
			const updates = events.filter(
				(event): event is Extract<AgentEvent, { type: "message_update" }> => event.type === "message_update",
			);
			expect(updates).toHaveLength(1_000);
			expect(callbacks).toHaveLength(observed ? 1_000 : 0);
			for (const [index, event] of updates.entries()) {
				expect(messageText(event.message as AssistantMessage)).toBe(expected[index]);
				expect(
					messageText(
						(event.assistantMessageEvent as Extract<AssistantMessageEvent, { type: "text_delta" }>).partial,
					),
				).toBe(expected[index]);
				if (observed) {
					expect(messageText(callbacks[index]!.message)).toBe(expected[index]);
					expect(
						messageText(
							(callbacks[index]!.event as Extract<AssistantMessageEvent, { type: "text_delta" }>).partial,
						),
					).toBe(expected[index]);
				}
			}
			expect(order.slice(2, -1)).toEqual(
				Array.from({ length: 1_000 }, () => (observed ? ["callback", "update"] : ["update"])).flat(),
			);
			const final = events.at(-1) as Extract<AgentEvent, { type: "message_end" }>;
			expect(new TextEncoder().encode(messageText(final.message as AssistantMessage)).byteLength).toBe(49_000);
			(message.content[0] as { type: "text"; text: string }).text = "provider mutation";
			expect(messageText(updates[0]!.message as AssistantMessage)).toBe(expected[0]);
			expect(transaction.ownedInventory().totalBytes).toBe(0);
		});
	}

	it("preserves lone code units, split pairs, non-prefix replacements and large suffixes", () => {
		const { transaction, message, update, events, callbacks } = ledgerFixture();
		transaction.push({ type: "message_start", message });
		const expected = ["\uD83D", "\uD83D\uDE00", "\uDE00", "\uD83Dx", `${"z".repeat(100_000)}\uD800`];
		for (const text of expected) update(text, "not an append hint");
		transaction.push({ type: "message_end", message });
		transaction.flush();
		const updates = events.filter(
			(event): event is Extract<AgentEvent, { type: "message_update" }> => event.type === "message_update",
		);
		for (const [index, text] of expected.entries()) {
			expect(messageText(callbacks[index]!.message)).toBe(text);
			expect(
				messageText((callbacks[index]!.event as Extract<AssistantMessageEvent, { type: "text_delta" }>).partial),
			).toBe(text);
			expect(messageText(updates[index]!.message as AssistantMessage)).toBe(text);
			expect(
				messageText(
					(updates[index]!.assistantMessageEvent as Extract<AssistantMessageEvent, { type: "text_delta" }>)
						.partial,
				),
			).toBe(text);
		}
		expect(messageText(callbacks[0]!.message)).toBe("\uD83D");
	});

	it("commits observed responses past the former 10,000-record cap", () => {
		expect(MANAGED_ATTEMPT_MAX_STAGED_EVENTS).toBe(100_000);
		using _clock = frozenClock();
		// 6,000 observed deltas stage 12,000+ records: the old cap rejected them.
		const observed = ledgerFixture();
		observed.transaction.push({ type: "turn_start" });
		observed.transaction.push({ type: "message_start", message: observed.message });
		let text = "";
		for (let index = 0; index < 6_000; index++) {
			text += "t ";
			observed.update(text, "t ");
		}
		observed.transaction.push({ type: "message_end", message: observed.message });
		expect(observed.transaction.ownedInventory().recordCount).toBe(12_003);
		observed.transaction.flush();
		expect(observed.events.filter(event => event.type === "message_update")).toHaveLength(6_000);
		expect(observed.callbacks).toHaveLength(6_000);
		expect(messageText(observed.callbacks.at(-1)!.message)).toBe(text);
	});

	it("uses actual string multiplicity and a uniquely owned one-byte typed residual", () => {
		const measure = (text: string, bytes = 0) => {
			const fixture = ledgerFixture();
			fixture.transaction.push({ type: "turn_start", probe: new Uint8Array(bytes) } as AgentEvent);
			fixture.transaction.push({ type: "message_start", message: fixture.message });
			fixture.update(text, text);
			return fixture;
		};
		const base = measure("x");
		const inventory = base.transaction.ownedInventory();
		// Independent owners: latest full string, copied suffix, canonical delta.
		const slope = measure("xx").transaction.ownedInventory().totalBytes - inventory.totalBytes;
		expect(slope).toBe(6);
		for (const text of ["é", "\uD800", "\uDC00"])
			expect(measure(text).transaction.ownedInventory().totalBytes).toBe(inventory.totalBytes);
		expect(measure("😀").transaction.ownedInventory().totalBytes - inventory.totalBytes).toBe(slope);
		expect(MANAGED_ATTEMPT_MAX_STAGED_BYTES).toBe(16_777_216);
		const fixed = inventory.totalBytes - slope;
		const n = Math.floor((MANAGED_ATTEMPT_MAX_STAGED_BYTES - fixed) / slope);
		const text = "x".repeat(n);
		const unpadded = measure(text).transaction.ownedInventory();
		const residual = MANAGED_ATTEMPT_MAX_STAGED_BYTES - unpadded.totalBytes;
		expect(residual).toBeGreaterThanOrEqual(0);
		const exact = measure(text, residual);
		const owners = exact.transaction.ownedInventory();
		expect(owners.totalBytes).toBe(16_777_216);
		expect(owners.buffers.filter(owner => owner.kind === "typed")).toHaveLength(1);
		expect(owners.buffers.find(owner => owner.kind === "typed")!.bytes).toBe(residual);
		const raw = {
			message: exact.message,
			event: { type: "text_delta", contentIndex: 0, delta: text, partial: exact.message },
		};
		expect(new TextEncoder().encode(JSON.stringify(raw)).byteLength).toBeLessThan(16_777_216);
		expect(
			new TextEncoder().encode(
				JSON.stringify({ type: "message_update", message: exact.message, assistantMessageEvent: raw.event }),
			).byteLength,
		).toBeLessThan(16_777_216);
		exact.transaction.flush();
		expect(exact.callbacks).toHaveLength(1);
		// One unit over the cap no longer kills the attempt: it publishes instead.
		const over = measure(text, residual + 1);
		expect(over.transaction.committed).toBeTrue();
		expect(over.transaction.ownedInventory().totalBytes).toBe(0);
		expect(over.callbacks).toHaveLength(1);
		expect(over.events.map(event => event.type)).toEqual(["turn_start", "message_start", "message_update"]);
	});

	it("preserves nested replacement, deletion, array order and typed metadata at every observation", () => {
		const fixture = ledgerFixture();
		const { transaction, message, update, callbacks, events } = fixture;
		message.content.push({
			type: "toolCall",
			id: "call",
			name: "inspect",
			arguments: { keep: undefined, remove: 1, list: [1, 2] },
		});
		const metadata = message as unknown as Record<string, unknown>;
		metadata.probe = {
			date: new Date(NaN),
			bytes: new Uint16Array([0xd800, 17]),
			absentLater: undefined,
			negativeZero: -0,
		};
		Object.defineProperty(metadata.probe as object, "__proto__", {
			value: { safe: true },
			enumerable: true,
			writable: true,
			configurable: true,
		});
		transaction.push({ type: "message_start", message });
		update("prefix", "prefix");
		const args = (message.content[1] as Extract<AssistantMessage["content"][number], { type: "toolCall" }>).arguments;
		delete args.remove;
		args.list = [2, 1];
		args.nested = { present: undefined };
		const probe = metadata.probe as { date: Date; bytes: Uint16Array; absentLater?: undefined; negativeZero: number };
		probe.date = new Date(1234);
		probe.bytes[0] = 3;
		delete probe.absentLater;
		probe.negativeZero = 0;
		update("non-prefix", "not used to infer a patch");
		transaction.push({ type: "message_end", message });
		expect(transaction.ownedInventory().totalBytes).toBeGreaterThan(0);
		transaction.flush();
		const updates = events.filter(
			(event): event is Extract<AgentEvent, { type: "message_update" }> => event.type === "message_update",
		);
		for (const held of [callbacks[0]!.message, updates[0]!.message as AssistantMessage]) {
			const heldArgs = (held.content[1] as Extract<AssistantMessage["content"][number], { type: "toolCall" }>)
				.arguments;
			expect(Object.hasOwn(heldArgs, "keep")).toBe(true);
			expect(heldArgs.keep).toBeUndefined();
			expect(heldArgs.remove).toBe(1);
			expect(heldArgs.list).toEqual([1, 2]);
			const heldProbe = (held as unknown as Record<string, unknown>).probe as typeof probe;
			expect(Number.isNaN(heldProbe.date.getTime())).toBe(true);
			expect(heldProbe.bytes).toEqual(new Uint16Array([0xd800, 17]));
			expect(Object.hasOwn(heldProbe, "absentLater")).toBe(true);
			expect(Object.is(heldProbe.negativeZero, -0)).toBe(true);
			expect(Object.hasOwn(heldProbe, "__proto__")).toBe(true);
			expect(Object.getPrototypeOf(heldProbe)).toBe(Object.prototype);
		}
		for (const held of [callbacks[1]!.message, updates[1]!.message as AssistantMessage]) {
			const heldArgs = (held.content[1] as Extract<AssistantMessage["content"][number], { type: "toolCall" }>)
				.arguments;
			expect(Object.hasOwn(heldArgs, "remove")).toBe(false);
			expect(heldArgs.list).toEqual([2, 1]);
			expect(heldArgs.nested).toEqual({ present: undefined });
			const heldProbe = (held as unknown as Record<string, unknown>).probe as typeof probe;
			expect(heldProbe.date.getTime()).toBe(1234);
			expect(heldProbe.bytes).toEqual(new Uint16Array([3, 17]));
			expect(Object.hasOwn(heldProbe, "absentLater")).toBe(false);
			expect(Object.is(heldProbe.negativeZero, 0)).toBe(true);
		}
	});

	it("samples callback/update separately and preserves callback cycles versus event sanitizer placeholders", () => {
		const { transaction, message, callbacks, events } = ledgerFixture();
		const cycle: Record<string, unknown> = { value: 1 };
		cycle.self = cycle;
		(message as unknown as Record<string, unknown>).probe = cycle;
		const callback: AssistantMessageEvent = { type: "text_delta", contentIndex: 0, delta: "same", partial: message };
		(message.content[0] as { text: string }).text = "callback-time";
		transaction.stageAssistantMessageEvent(message, callback);
		(message.content[0] as { text: string }).text = "update-time";
		cycle.value = 2;
		transaction.push({ type: "message_update", message, assistantMessageEvent: callback });
		transaction.ownedInventory();
		transaction.flush();
		expect(messageText(callbacks[0]!.message)).toBe("callback-time");
		const probe = (callbacks[0]!.message as unknown as Record<string, unknown>).probe as Record<string, unknown>;
		expect(probe.value).toBe(1);
		expect(probe.self).toBe(probe);
		const update = events[0] as Extract<AgentEvent, { type: "message_update" }>;
		expect(messageText(update.message as AssistantMessage)).toBe("update-time");
		expect((update.message as unknown as Record<string, unknown>).probe).toEqual({ value: 2, self: "[Circular]" });
		expect(Object.getPrototypeOf(callbacks[0]!.message)).toBe(Object.prototype);
		expect(Object.getPrototypeOf(probe)).toBe(Object.prototype);
		expect(Object.getPrototypeOf(update)).toBeNull();
		expect(Object.getPrototypeOf(update.message)).toBeNull();
		expect(Object.getPrototypeOf((update.message as unknown as Record<string, unknown>).probe)).toBeNull();
		expect(Object.getPrototypeOf(update.assistantMessageEvent)).toBeNull();
		expect(
			Object.getPrototypeOf(
				(update.assistantMessageEvent as Extract<AssistantMessageEvent, { type: "text_delta" }>).partial,
			),
		).toBeNull();
	});

	for (const failAt of [1, 7]) {
		it(`prevalidates the entire log before dispatch when replay clone ${failAt} fails`, () => {
			const { transaction, update, callbacks, events } = ledgerFixture();
			update("one");
			update("two");
			const original = globalThis.structuredClone;
			let clones = 0;
			const clone = spyOn(globalThis, "structuredClone").mockImplementation(value => {
				if (++clones === failAt) throw new Error("replay clone failure");
				return original(value);
			});
			try {
				expect(() => transaction.flush()).toThrow("snapshot");
			} finally {
				clone.mockRestore();
			}
			expect(clones).toBe(failAt);
			expect(callbacks).toHaveLength(0);
			expect(events).toHaveLength(0);
			expect(transaction.ownedInventory().totalBytes).toBe(0);
			expect(transaction.flush()).toBe(false);
		});
	}

	for (const failAt of [1, 2]) {
		it(`retains only the committed prefix when callback ${failAt} throws`, () => {
			const fixture = ledgerFixture(true, (_message, _event, count) => {
				if (count === failAt)
					throw Object.assign(new Error("observer failure"), {
						transportFailure: { kind: "transport", status: 429 },
					});
			});
			fixture.transaction.push({ type: "message_start", message: fixture.message });
			for (const text of ["one", "two", "three"]) fixture.update(text);
			expect(() => fixture.transaction.flush()).toThrow("committed output observer failed");
			expect(fixture.callbacks).toHaveLength(failAt);
			expect(fixture.events.filter(event => event.type === "message_update")).toHaveLength(failAt - 1);
			expect(fixture.transaction.ownedInventory().totalBytes).toBe(0);
			expect(fixture.transaction.flush()).toBe(true);
		});

		it(`stops after synchronous abort in callback ${failAt} without rolling back its prefix`, () => {
			const controller = new AbortController();
			const fixture = ledgerFixture(true, (_message, _event, count) => {
				if (count === failAt) controller.abort();
			});
			fixture.transaction.push({ type: "message_start", message: fixture.message });
			for (const text of ["one", "two", "three"]) fixture.update(text);
			expect(fixture.transaction.flush(controller.signal)).toBe(false);
			expect(fixture.callbacks).toHaveLength(failAt);
			expect(fixture.events.filter(event => event.type === "message_update")).toHaveLength(failAt - 1);
			expect(fixture.transaction.ownedInventory().totalBytes).toBe(0);
		});
	}

	it("releases all provisional ownership when already aborted before commit", () => {
		const controller = new AbortController();
		const fixture = ledgerFixture();
		fixture.update("never visible");
		controller.abort();
		expect(fixture.transaction.flush(controller.signal)).toBe(false);
		expect(fixture.callbacks).toHaveLength(0);
		expect(fixture.events).toHaveLength(0);
		expect(fixture.transaction.ownedInventory().totalBytes).toBe(0);
	});

	it("charges and reconstructs directly staged terminal lifecycle message arrays", () => {
		const { transaction, message, events, update } = ledgerFixture(false);
		update("terminal");
		transaction.push({ type: "turn_end", message, toolResults: [] });
		transaction.push({ type: "agent_end", messages: [message, { role: "user", content: "user", timestamp: 0 }] });
		expect(transaction.ownedInventory().recordCount).toBe(3);
		transaction.flush();
		expect(events.map(event => event.type)).toEqual(["message_update", "turn_end", "agent_end"]);
		const terminal = events[2] as Extract<AgentEvent, { type: "agent_end" }>;
		expect(messageText(terminal.messages[0] as AssistantMessage)).toBe("terminal");
		expect(terminal.messages[1]).toEqual({ role: "user", content: "user", timestamp: 0 });
	});

	it("publishes raw multibyte UTF-8 input over the cap independently of owned UTF-16 storage", () => {
		const fixture = ledgerFixture(false);
		const probe = "\u0800".repeat(Math.ceil(MANAGED_ATTEMPT_MAX_STAGED_BYTES / 3));
		expect(2 * probe.length).toBeLessThan(MANAGED_ATTEMPT_MAX_STAGED_BYTES);
		expect(new TextEncoder().encode(JSON.stringify({ type: "turn_start", probe })).byteLength).toBeGreaterThan(
			MANAGED_ATTEMPT_MAX_STAGED_BYTES,
		);
		const input = { type: "turn_start", probe } as AgentEvent;
		fixture.transaction.push(input);
		expect(fixture.transaction.committed).toBeTrue();
		expect(fixture.transaction.ownedInventory().totalBytes).toBe(0);
		expect(fixture.events).toEqual([input]);
	});

	it("never stages callbacks when no real observer exists", () => {
		const fixture = ledgerFixture(false);
		fixture.transaction.stageAssistantMessageEvent(fixture.message, {
			type: "text_delta",
			contentIndex: 0,
			delta: "ignored",
			partial: fixture.message,
		});
		expect(fixture.transaction.ownedInventory().recordCount).toBe(0);
		fixture.update("accepted");
		expect(fixture.transaction.ownedInventory().recordCount).toBe(1);
		fixture.transaction.flush();
		expect(fixture.callbacks).toHaveLength(0);
		expect(
			messageText(
				(fixture.events[0] as Extract<AgentEvent, { type: "message_update" }>).message as AssistantMessage,
			),
		).toBe("accepted");
	});

	it("isolates observer mutation from matching updates and later snapshots", () => {
		const fixture = ledgerFixture(true, message => {
			(message.content[0] as { text: string }).text = "observer-mutated";
		});
		fixture.update("first");
		fixture.update("second");
		fixture.transaction.flush();
		expect(fixture.callbacks.map(callback => messageText(callback.message))).toEqual([
			"observer-mutated",
			"observer-mutated",
		]);
		expect(
			fixture.events.map(event =>
				messageText((event as Extract<AgentEvent, { type: "message_update" }>).message as AssistantMessage),
			),
		).toEqual(["first", "second"]);
	});

	it("keeps an emitted prefix terminal when unexpected postcommit replay fails", () => {
		let committed = false;
		const fixture = ledgerFixture(true, () => {
			committed = true;
		});
		fixture.update("first");
		fixture.update("second");
		const original = globalThis.structuredClone;
		const clone = spyOn(globalThis, "structuredClone").mockImplementation(value => {
			if (committed) throw new Error("postcommit replay failure");
			return original(value);
		});
		try {
			expect(() => fixture.transaction.flush()).toThrow("snapshot");
		} finally {
			clone.mockRestore();
		}
		expect(fixture.callbacks).toHaveLength(1);
		expect(fixture.events).toHaveLength(0);
		expect(fixture.transaction.ownedInventory().totalBytes).toBe(0);
		expect(fixture.transaction.flush()).toBe(true);
	});

	it("retains cross-field atomic aliases as one detached owned graph", () => {
		const fixture = ledgerFixture(false);
		const shared = new Uint8Array([1, 2, 3]);
		fixture.transaction.push({ type: "turn_start", left: shared, right: shared } as AgentEvent);
		const inventory = fixture.transaction.ownedInventory();
		expect(inventory.buffers.filter(owner => owner.kind === "typed").map(owner => owner.bytes)).toEqual([3]);
		shared[0] = 9;
		fixture.transaction.flush();
		const output = fixture.events[0] as unknown as { left: Uint8Array; right: Uint8Array };
		expect(output.left).toEqual(new Uint8Array([1, 2, 3]));
		expect(output.right).toEqual(new Uint8Array([1, 2, 3]));
		expect(output.left.buffer).not.toBe(shared.buffer);
		expect(output.right).toBe(output.left);
		expect(output.right.buffer).toBe(output.left.buffer);
	});

	it("preserves distinct typed views of one independently owned backing buffer", () => {
		const fixture = ledgerFixture(false);
		const backing = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
		fixture.transaction.push({
			type: "turn_start",
			left: new Uint8Array(backing, 1, 3),
			right: new Uint16Array(backing, 2, 2),
		} as AgentEvent);
		expect(
			fixture.transaction
				.ownedInventory()
				.buffers.filter(owner => owner.kind === "typed")
				.map(owner => owner.bytes),
		).toEqual([8]);
		new Uint8Array(backing).fill(99);
		fixture.transaction.flush();
		const output = fixture.events[0] as unknown as { left: Uint8Array; right: Uint16Array };
		expect(output.left).toBeInstanceOf(Uint8Array);
		expect(output.right).toBeInstanceOf(Uint16Array);
		expect(output.left.byteOffset).toBe(1);
		expect(output.right.byteOffset).toBe(2);
		expect(output.left).toEqual(new Uint8Array([2, 3, 4]));
		expect(output.left.buffer).toBe(output.right.buffer);
		expect(output.left.buffer).not.toBe(backing);
		expect(new Uint8Array(output.left.buffer)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
	});

	it("preserves Map/Set aliases across opaque fields without aliasing separately staged records", () => {
		const fixture = ledgerFixture(false);
		const key = { value: 1 };
		const map = new Map([[key, key]]);
		const set = new Set([key]);
		const input = { type: "turn_start", key, map, set } as AgentEvent;
		fixture.transaction.push(input);
		fixture.transaction.push(input);
		key.value = 99;
		fixture.transaction.ownedInventory();
		fixture.transaction.flush();
		const outputs = fixture.events as unknown as Array<{
			key: { value: number };
			map: Map<object, object>;
			set: Set<object>;
		}>;
		for (const output of outputs) {
			const [heldKey, heldValue] = [...output.map][0]!;
			expect(heldKey).toBe(output.key);
			expect(heldValue).toBe(output.key);
			expect([...output.set][0]).toBe(output.key);
			expect(output.key.value).toBe(1);
			expect(output.key).not.toBe(key);
		}
		expect(outputs[0]!.key).not.toBe(outputs[1]!.key);
		expect(fixture.transaction.ownedInventory().totalBytes).toBe(0);
	});

	for (const crossField of [false, true]) {
		it(`preserves repeated non-assistant terminal slots with cross-field alias ${crossField}`, () => {
			const fixture = ledgerFixture(false);
			const user = { role: "user" as const, content: "before", timestamp: 1 };
			const input = {
				type: "agent_end",
				messages: [user, user],
				...(crossField ? { highlighted: user } : {}),
			} as AgentEvent;
			fixture.transaction.push(input);
			user.content = "after";
			fixture.transaction.ownedInventory();
			fixture.transaction.flush();
			const output = fixture.events[0] as Extract<AgentEvent, { type: "agent_end" }> & {
				highlighted?: AgentMessage;
			};
			expect(output.messages[0]).toBe(output.messages[1]);
			expect(output.messages[0]).not.toBe(user);
			const held = output.messages[0];
			expect(held?.role).toBe("user");
			if (held?.role !== "user") throw new Error("Expected retained user message");
			expect(held.content).toBe("before");
			if (crossField) expect(output.highlighted).toBe(output.messages[0]);
			expect(fixture.transaction.ownedInventory().totalBytes).toBe(0);
		});
	}

	it("publishes exact raw four-byte Unicode cap and raw cap+1 without killing the attempt", () => {
		const headerBytes = new TextEncoder().encode(JSON.stringify({ type: "turn_start", probe: "" })).byteLength;
		const pairs = Math.floor((MANAGED_ATTEMPT_MAX_STAGED_BYTES - headerBytes) / 4);
		const remainder = MANAGED_ATTEMPT_MAX_STAGED_BYTES - headerBytes - 4 * pairs;
		const base = `${"😀".repeat(pairs)}${"x".repeat(remainder)}`;
		for (const extra of [0, 1]) {
			const fixture = ledgerFixture(false);
			const input = { type: "turn_start", probe: `${base}${"x".repeat(extra)}` } as AgentEvent;
			expect(new TextEncoder().encode(JSON.stringify(input)).byteLength).toBe(
				MANAGED_ATTEMPT_MAX_STAGED_BYTES + extra,
			);
			const original = globalThis.structuredClone;
			let clones = 0;
			const clone = spyOn(globalThis, "structuredClone").mockImplementation(value => {
				clones++;
				return original(value);
			});
			try {
				fixture.transaction.push(input);
			} finally {
				clone.mockRestore();
			}
			// Exact raw cap reaches normalization, then exceeds L through its
			// retained structural charge and is published from the ledger. Raw
			// cap+1 never reaches transaction-owned duplication: it is forwarded live.
			expect(clones).toBe(extra === 0 ? 1 : 0);
			expect(fixture.transaction.committed).toBeTrue();
			expect(fixture.events).toHaveLength(1);
			expect((fixture.events[0] as unknown as { probe: string }).probe).toBe(
				(input as unknown as { probe: string }).probe,
			);
			expect(fixture.transaction.ownedInventory().totalBytes).toBe(0);
		}
	});

	it("does not alias equal-valued topology flips and preserves Map/Set/RegExp snapshots", () => {
		const fixture = ledgerFixture();
		const meta = fixture.message as unknown as Record<string, unknown>;
		const shared = { value: 1 };
		meta.probe = { left: shared, right: shared };
		fixture.update("shared");
		meta.probe = { left: { value: 1 }, right: { value: 1 } };
		fixture.update("distinct");
		const key = { value: 3 };
		const regex = /a+b/giu;
		regex.lastIndex = 9;
		meta.probe = { map: new Map([[key, key]]), set: new Set([key]), regex };
		fixture.update("intrinsics");
		fixture.transaction.ownedInventory();
		fixture.transaction.flush();
		const updates = fixture.events as Array<Extract<AgentEvent, { type: "message_update" }>>;
		for (const messages of [
			fixture.callbacks.map(callback => callback.message),
			updates.map(event => event.message as AssistantMessage),
		]) {
			const first = (messages[0] as unknown as Record<string, unknown>).probe as { left: object; right: object };
			const second = (messages[1] as unknown as Record<string, unknown>).probe as typeof first;
			expect(first.left).toBe(first.right);
			expect(second.left).not.toBe(second.right);
			expect(first.left).toEqual(second.left);
			const third = (messages[2] as unknown as Record<string, unknown>).probe as {
				map: Map<object, object>;
				set: Set<object>;
				regex: RegExp;
			};
			const [heldKey, heldValue] = [...third.map.entries()][0]!;
			expect(heldKey).toBe(heldValue);
			expect([...third.set][0]).toBe(heldKey);
			expect(heldKey).toEqual({ value: 3 });
			expect(third.regex).toBeInstanceOf(RegExp);
			expect(third.regex.source).toBe("a+b");
			expect(third.regex.flags).toBe("giu");
			// Existing structured-clone normalization resets RegExp.lastIndex.
			expect(third.regex.lastIndex).toBe(0);
		}
	});

	it("fails an unsupported deep owned graph locally before admission", () => {
		const fixture = ledgerFixture();
		let probe: Record<string, unknown> = { leaf: true };
		for (let depth = 0; depth < 600; depth++) probe = { child: probe };
		(fixture.message as unknown as Record<string, unknown>).probe = probe;
		let error: unknown;
		try {
			fixture.update("unobservable");
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).name).toBe("ManagedAttemptSnapshotError");
		expect((error as Record<string, unknown>).errorStatus).toBeUndefined();
		expect((error as Record<string, unknown>).transportFailure).toBeUndefined();
		expect(fixture.callbacks).toHaveLength(0);
		expect(fixture.events).toHaveLength(0);
		expect(fixture.transaction.ownedInventory().totalBytes).toBe(0);
	});

	it("preserves Bun's detached shared-buffer normalization without retaining live provider backing", () => {
		const fixture = ledgerFixture();
		const backing = new SharedArrayBuffer(8);
		new Uint8Array(backing)[0] = 7;
		(fixture.message as unknown as Record<string, unknown>).probe = backing;
		fixture.update("accepted");
		new Uint8Array(backing)[0] = 99;
		fixture.transaction.ownedInventory();
		fixture.transaction.flush();
		const normalized = (fixture.callbacks[0]!.message as unknown as Record<string, unknown>).probe;
		// Bun 1.3.14's existing structuredClone boundary converts SAB to a
		// detached ArrayBuffer. It must not be mistaken for shared live memory.
		expect(normalized).toBeInstanceOf(ArrayBuffer);
		expect(new Uint8Array(normalized as ArrayBuffer)[0]).toBe(7);
		expect((normalized as ArrayBuffer).byteLength).toBe(8);
		expect(fixture.transaction.ownedInventory().totalBytes).toBe(0);
	});
});

describe("managed attempt transaction", () => {
	for (const failure of ["abort", "prevalidation"] as const) {
		it(`restores shared context and queued user input on precommit ${failure}`, async () => {
			const mock = createMockModel({ responses: [{ content: ["unpublished"] }] });
			const queued = { role: "user" as const, content: "queued steering", timestamp: 1 };
			const context: AgentContext = {
				systemPrompt: ["test"],
				tools: [],
				messages: [{ role: "user", content: "run", timestamp: 0 }],
			};
			const controller = new AbortController();
			const events: AgentEvent[] = [];
			let callbacks = 0;
			let cancelled = 0;
			const original = ManagedAttemptTransaction.prototype.flush;
			const flush = spyOn(ManagedAttemptTransaction.prototype, "flush").mockImplementationOnce(function (
				this: ManagedAttemptTransaction,
				signal,
			) {
				if (failure === "abort") {
					controller.abort();
					return original.call(this, signal);
				}
				const clone = spyOn(globalThis, "structuredClone").mockImplementationOnce(() => {
					throw new Error("replay validation");
				});
				try {
					return original.call(this, signal);
				} finally {
					clone.mockRestore();
				}
			});
			try {
				const stream = agentLoopContinue(
					context,
					{
						model: mock.model,
						fallbackManaged: true,
						convertToLlm: messages => messages as Message[],
						getSteeringMessages: async () => [queued],
						onAssistantMessageEvent: () => {
							callbacks++;
						},
						onManagedAttemptOutcome: outcome => {
							if (outcome.type === "run_terminal") cancelled++;
							return { type: "terminal", terminal: { stopReason: "exhausted" } };
						},
					},
					controller.signal,
					mock.stream,
				);
				let error: unknown;
				try {
					for await (const event of stream) events.push(event);
				} catch (caught) {
					error = caught;
				}
				if (failure === "prevalidation") expect((error as Error).message).toContain("snapshot");
				else {
					expect(error).toBeUndefined();
					expect(await stream.result()).toEqual([queued]);
				}
				expect(cancelled).toBe(failure === "abort" ? 1 : 0);
				expect(callbacks).toBe(0);
				expect(events.filter(event => "message" in event && event.message.role === "assistant")).toHaveLength(0);
				expect(context.messages).toEqual([{ role: "user", content: "run", timestamp: 0 }, queued]);
			} finally {
				flush.mockRestore();
			}
		});
	}
	for (const fallbackManaged of [false, true]) {
		for (const delayed of [false, true]) {
			it(`delivers exact 49KB/1,000-update public-loop snapshots (managed=${fallbackManaged}, delayed=${delayed})`, async () => {
				const mock = createMockModel();
				const callbacks: AssistantMessage[] = [];
				const streamFn = () => {
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() => {
						const message = assistantMessage(mock.model);
						message.content = [{ type: "text", text: "" }];
						stream.push({ type: "start", partial: structuredClone(message) });
						for (let index = 0; index < 1_000; index++) {
							const delta = `${String(index).padStart(4, "0")}${"x".repeat(45)}`;
							(message.content[0] as { text: string }).text += delta;
							stream.push({ type: "text_delta", contentIndex: 0, delta, partial: structuredClone(message) });
						}
						stream.push({ type: "done", reason: "stop", message });
					});
					return stream;
				};
				const context: AgentContext = {
					systemPrompt: ["test"],
					tools: [],
					messages: [{ role: "user", content: "run", timestamp: 0 }],
				};
				const config: AgentLoopConfig = {
					model: mock.model,
					fallbackManaged,
					convertToLlm: messages => messages as Message[],
					onAssistantMessageEvent: message => callbacks.push(message),
				};
				const stream = agentLoopContinue(context, config, undefined, streamFn);
				if (delayed) await stream.result();
				const updates: Array<Extract<AgentEvent, { type: "message_update" }>> = [];
				for await (const event of stream) if (event.type === "message_update") updates.push(event);
				const result = await stream.result();
				expect(callbacks).toHaveLength(1_000);
				expect(updates).toHaveLength(1_000);
				let expected = "";
				for (let index = 0; index < 1_000; index++) {
					expected += `${String(index).padStart(4, "0")}${"x".repeat(45)}`;
					expect(messageText(callbacks[index]!)).toBe(expected);
					expect(messageText(updates[index]!.message as AssistantMessage)).toBe(expected);
				}
				expect(messageText(result[0] as AssistantMessage)).toBe(expected);
				expect(new TextEncoder().encode(expected).byteLength).toBe(49_000);
				expect((result[0] as AssistantMessage).stopReason).toBe("stop");
			});
		}
	}

	for (const failure of ["throw", "abort"] as const) {
		for (const failAt of [1, 2]) {
			it(`never executes tools or retries after ${failure} at committed callback ${failAt}`, async () => {
				const mock = createMockModel();
				let calls = 0;
				let outcomes = 0;
				let toolCalls = 0;
				let callbacks = 0;
				const updates: AgentEvent[] = [];
				const controller = new AbortController();
				const streamFn = () => {
					calls++;
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() => {
						const message = assistantMessage(mock.model);
						message.content = [
							{ type: "text", text: "" },
							{ type: "toolCall", id: "call", name: "inspect", arguments: {} },
						];
						message.stopReason = "toolUse";
						stream.push({ type: "start", partial: structuredClone(message) });
						for (const text of ["one", "two", "three"]) {
							(message.content[0] as { text: string }).text = text;
							stream.push({
								type: "text_delta",
								contentIndex: 0,
								delta: text,
								partial: structuredClone(message),
							});
						}
						stream.push({ type: "done", reason: "toolUse", message });
					});
					return stream;
				};
				const context: AgentContext = {
					systemPrompt: ["test"],
					messages: [{ role: "user", content: "run", timestamp: 0 }],
					tools: [
						{
							name: "inspect",
							label: "Inspect",
							description: "inspect",
							parameters: { type: "object", properties: {} },
							execute: async () => {
								toolCalls++;
								return { content: [{ type: "text", text: "ran" }], details: {} };
							},
						},
					],
				};
				const config: AgentLoopConfig = {
					model: mock.model,
					fallbackManaged: true,
					convertToLlm: messages => messages as Message[],
					onAssistantMessageEvent: () => {
						if (++callbacks !== failAt) return;
						if (failure === "abort") controller.abort();
						else
							throw Object.assign(new Error("observer-local"), {
								transportFailure: { kind: "transport", status: 429 },
							});
					},
					onManagedAttemptOutcome: outcome => {
						if (outcome.type === "retryable_discarded") outcomes++;
						return { type: "terminal", terminal: { stopReason: "exhausted" } };
					},
				};
				const stream = agentLoopContinue(context, config, controller.signal, streamFn);
				let error: unknown;
				try {
					for await (const event of stream) if (event.type === "message_update") updates.push(event);
				} catch (caught) {
					error = caught;
				}
				if (failure === "throw") {
					expect(error).toBeInstanceOf(Error);
					expect((error as Error).message).toContain("committed output observer failed");
					expect((error as Record<string, unknown>).transportFailure).toBeUndefined();
				} else expect(error).toBeUndefined();
				expect(calls).toBe(1);
				expect(outcomes).toBe(0);
				expect(toolCalls).toBe(0);
				expect(callbacks).toBe(failAt);
				expect(updates).toHaveLength(failAt - 1);
				const published = context.messages.find(message => message.role === "assistant") as AssistantMessage;
				expect(messageText(published)).toBe(failAt === 1 ? "one" : "two");
				expect(published.stopReason).toBe(failure === "throw" ? "error" : "aborted");
				expect(context.messages[0]).toEqual({ role: "user", content: "run", timestamp: 0 });
				if (failure === "abort") {
					const result = await stream.result();
					expect(messageText(result[0] as AssistantMessage)).toBe(failAt === 1 ? "one" : "two");
					expect((result[0] as AssistantMessage).stopReason).toBe("aborted");
					expect(result[1]?.role).toBe("toolResult");
				}
			});
		}
	}

	it("flushes a successful assistant lifecycle once and in provider order", async () => {
		const mock = createMockModel({ responses: [{ content: ["accepted"] }] });
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const events: string[] = [];
		agent.subscribe(event => events.push(event.type));

		await agent.prompt("run", { fallbackManaged: true });

		const assistantStart = events.lastIndexOf("message_start");
		const assistantBatch = events.slice(assistantStart);
		expect(assistantBatch[0]).toBe("message_start");
		expect(assistantBatch.filter(type => type === "message_update").length).toBeGreaterThan(0);
		expect(assistantBatch.slice(-3)).toEqual(["message_end", "turn_end", "agent_end"]);
		expect(agent.state.messages.filter(message => message.role === "assistant")).toHaveLength(1);
		expectManagedRunStart(events);
	});

	it("commits a long observed managed response that exceeds 5,000 deltas", async () => {
		const mock = createMockModel();
		const deltas = 6_000;
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			void (async () => {
				const partial = assistantMessage(mock.model);
				stream.push({ type: "start", partial });
				partial.content.push({ type: "text", text: "" });
				stream.push({ type: "text_start", contentIndex: 0, partial });
				for (let index = 0; index < deltas; index++) {
					(partial.content[0] as { type: "text"; text: string }).text += "token ";
					stream.push({ type: "text_delta", contentIndex: 0, delta: "token ", partial });
					if (index % 500 === 0) await Bun.sleep(0);
				}
				stream.push({ type: "text_end", contentIndex: 0, content: "token ".repeat(deltas), partial });
				stream.push({ type: "done", reason: "stop", message: partial });
			})();
			return stream;
		};
		const context: AgentContext = {
			systemPrompt: ["test"],
			messages: [{ role: "user", content: "run", timestamp: Date.now() }],
			tools: [],
		};
		let callbacks = 0;
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: messages => messages as Message[],
			fallbackManaged: true,
			onAssistantMessageEvent: () => {
				callbacks += 1;
			},
		};
		const stream = agentLoopContinue(context, config, undefined, streamFn);
		const events: AgentEvent[] = [];
		for await (const event of stream) events.push(event);
		await stream.result();
		const final = context.messages.at(-1) as AssistantMessage;
		expect(final.stopReason).toBe("stop");
		expect(messageText(final)).toBe("token ".repeat(deltas));
		expect(events.filter(event => event.type === "message_update")).toHaveLength(deltas + 2);
		expect(callbacks).toBe(deltas + 2);
	});

	it("publishes streamed content after the visible-hold window and keeps it on a later failure", async () => {
		const mock = createMockModel();
		let releaseTail: (() => void) | undefined;
		const tail = new Promise<void>(resolve => {
			releaseTail = resolve;
		});
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			void (async () => {
				const partial = assistantMessage(mock.model);
				stream.push({ type: "start", partial });
				partial.content.push({ type: "text", text: "" });
				stream.push({ type: "text_start", contentIndex: 0, partial });
				(partial.content[0] as { type: "text"; text: string }).text = "visible";
				stream.push({ type: "text_delta", contentIndex: 0, delta: "visible", partial });
				await Bun.sleep(MANAGED_ATTEMPT_MAX_VISIBLE_HOLD_MS + 50);
				(partial.content[0] as { type: "text"; text: string }).text += " more";
				stream.push({ type: "text_delta", contentIndex: 0, delta: " more", partial });
				await tail;
				// A provider failure after publication: typed transport facts that
				// would normally authorize a silent model fallback.
				const failed: AssistantMessage = {
					...partial,
					stopReason: "error",
					errorMessage: "529 overloaded",
					errorStatus: 529,
					transportFailure: { kind: "transport", status: 529 },
				} as AssistantMessage;
				stream.push({ type: "error", reason: "error", error: failed });
			})();
			return stream;
		};
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn,
		});
		const updates: string[] = [];
		agent.subscribe(event => {
			if (event.type === "message_update") updates.push(messageText(event.message as AssistantMessage));
		});
		let outcomeCalls = 0;
		const run = agent.prompt("run", {
			fallbackManaged: true,
			onManagedAttemptOutcome: () => {
				outcomeCalls += 1;
				return { type: "terminal", terminal: { stopReason: "exhausted" } };
			},
		} as any);
		for (let i = 0; i < 100 && !updates.includes("visible more"); i++) await Bun.sleep(50);
		// Visible while the provider is still streaming: not held until the end.
		expect(updates).toContain("visible");
		expect(updates).toContain("visible more");
		releaseTail!();
		await run;
		await agent.waitForIdle();
		// Published output is never silently discarded for a model fallback.
		expect(outcomeCalls).toBe(0);
		const final = agent.state.messages.at(-1) as AssistantMessage;
		expect(final.stopReason).toBe("error");
		expect(messageText(final)).toBe("visible more");
	});

	it("keeps short managed attempts discardable for silent fallback", async () => {
		const transaction = new ManagedAttemptTransaction(
			new EventStream<AgentEvent, AgentMessage[]>(
				event => event.type === "agent_end",
				() => [],
			),
			() => {},
			createMockModel().model,
		);
		transaction.push({ type: "turn_start" });
		expect(transaction.committed).toBeFalse();
	});

	it("aborts the provider request when a provider invocation fails locally", async () => {
		const mock = createMockModel();
		let providerSignal: AbortSignal | undefined;
		const streamFn = (_model: unknown, _context: unknown, options?: { signal?: AbortSignal }) => {
			providerSignal = options?.signal;
			const stream = new AssistantMessageEventStream();
			void (async () => {
				const partial = assistantMessage(mock.model);
				stream.push({ type: "start", partial });
				await Bun.sleep(0);
				// Over the cap: the attempt is published, and the observer then fails.
				partial.content.push({ type: "text", text: "x".repeat(9 * 1024 * 1024) });
				stream.push({ type: "text_start", contentIndex: 0, partial });
				// Never completes: only an abort can release the provider stream.
			})();
			return stream;
		};
		const context: AgentContext = {
			systemPrompt: ["test"],
			messages: [{ role: "user", content: "run", timestamp: Date.now() }],
			tools: [],
		};
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: messages => messages as Message[],
			fallbackManaged: true,
			onAssistantMessageEvent: () => {
				throw new Error("observer exploded");
			},
		};
		const stream = agentLoopContinue(context, config, undefined, streamFn);
		let failure: unknown;
		try {
			for await (const _event of stream) {
				// drain
			}
			await stream.result();
		} catch (error) {
			failure = error;
		}
		expect(String(failure ?? "")).toContain("observer exploded");
		expect(providerSignal).toBeDefined();
		expect(providerSignal!.aborted).toBeTrue();
	});

	it("commits a detached accepted message when a managed partial is not structured-cloneable", async () => {
		const mock = createMockModel();
		let liveMessage: AssistantMessage | undefined;
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			void (async () => {
				const partial = assistantMessage(mock.model);
				liveMessage = partial;
				(partial as unknown as Record<string, unknown>).probe = () => {};
				stream.push({ type: "start", partial });
				await Bun.sleep(0);
				partial.content.push({ type: "text", text: "accepted" });
				stream.push({ type: "text_start", contentIndex: 0, partial });
				await Bun.sleep(0);
				stream.push({ type: "done", reason: "stop", message: partial });
			})();
			return stream;
		};
		const context: AgentContext = {
			systemPrompt: ["test"],
			messages: [{ role: "user", content: "run", timestamp: Date.now() }],
			tools: [],
		};
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: messages =>
				messages.filter(
					message => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
				) as Message[],
			fallbackManaged: true,
		};
		const stream = agentLoopContinue(context, config, undefined, streamFn);
		const events: AgentEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();
		const messageUpdate = events.find(
			(event): event is Extract<AgentEvent, { type: "message_update" }> => event.type === "message_update",
		);
		const messageEnd = events.find(
			(event): event is Extract<AgentEvent, { type: "message_end" }> =>
				event.type === "message_end" && event.message.role === "assistant",
		);
		const turnEnd = events.find(
			(event): event is Extract<AgentEvent, { type: "turn_end" }> => event.type === "turn_end",
		);
		const agentEnd = events.find(
			(event): event is Extract<AgentEvent, { type: "agent_end" }> => event.type === "agent_end",
		);
		const committed = context.messages.at(-1) as AssistantMessage;

		expect(messageUpdate).toBeDefined();
		expect(messageEnd).toBeDefined();
		expect(turnEnd).toBeDefined();
		expect(agentEnd).toBeDefined();
		expect(result).toHaveLength(1);
		const accepted = turnEnd!.message;
		expect(accepted).toBe(committed);
		expect(agentEnd!.messages[0]).toBe(accepted);
		expect(result[0]).toBe(accepted);
		expect(messageUpdate!.message).toEqual(accepted);
		expect(messageEnd!.message).toEqual(accepted);
		for (const message of [messageUpdate!.message, messageEnd!.message, accepted, agentEnd!.messages[0], result[0]]) {
			expect(() => structuredClone(message)).not.toThrow();
			expect(() => JSON.stringify(message)).not.toThrow();
			expect(message).toMatchObject({ role: "assistant", content: [{ type: "text", text: "accepted" }] });
		}

		(liveMessage!.content[0] as { type: "text"; text: string }).text = "mutated after commit";
		(liveMessage as unknown as Record<string, unknown>).probe = () => "mutated";
		for (const message of [messageUpdate!.message, messageEnd!.message, accepted, agentEnd!.messages[0], result[0]]) {
			expect((message as AssistantMessage).content[0]).toEqual({ type: "text", text: "accepted" });
		}
	});

	it("replays mutating provider partials as event-time snapshots with callbacks first", async () => {
		const mock = createMockModel();
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			void (async () => {
				const partial = assistantMessage(mock.model);
				stream.push({ type: "start", partial });
				await Bun.sleep(0);
				partial.content.push({ type: "text", text: "" });
				stream.push({ type: "text_start", contentIndex: 0, partial });
				await Bun.sleep(0);
				(partial.content[0] as { type: "text"; text: string }).text = "a";
				stream.push({ type: "text_delta", contentIndex: 0, delta: "a", partial });
				await Bun.sleep(0);
				(partial.content[0] as { type: "text"; text: string }).text = "ab";
				stream.push({ type: "text_delta", contentIndex: 0, delta: "b", partial });
				await Bun.sleep(0);
				stream.push({ type: "done", reason: "stop", message: partial });
			})();
			return stream;
		};
		const order: string[] = [];
		const eventContents: string[] = [];
		const startContentLengths: number[] = [];
		const callbackContents: string[] = [];
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn,
			onAssistantMessageEvent: (message, event) => {
				const text = (message.content[0] as { type: "text"; text: string } | undefined)?.text ?? "";
				callbackContents.push(text);
				order.push(`callback:${event.type}:${text}`);
			},
		});
		agent.subscribe(event => {
			if (event.type === "message_start" && event.message.role === "assistant") {
				startContentLengths.push(event.message.content.length);
				return;
			}
			if (event.type !== "message_update") return;
			const text =
				((event.message as AssistantMessage).content[0] as { type: "text"; text: string } | undefined)?.text ?? "";
			eventContents.push(text);
			order.push(`event:${event.assistantMessageEvent.type}:${text}`);
		});

		await agent.prompt("run", { fallbackManaged: true });

		expect(startContentLengths).toEqual([0]);
		expect(eventContents).toEqual(["", "a", "ab"]);
		expect(callbackContents).toEqual(["", "a", "ab"]);
		for (const [index, text] of ["", "a", "ab"].entries()) {
			expect(order.indexOf(`callback:${index === 0 ? "text_start" : "text_delta"}:${text}`)).toBeLessThan(
				order.indexOf(`event:${index === 0 ? "text_start" : "text_delta"}:${text}`),
			);
		}
	});

	it("discards a cancelled provisional assistant lifecycle and settles once", async () => {
		const mock = createMockModel();
		const pending = new AssistantMessageEventStream();
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: () => pending,
		});
		const events: Array<{ type: string; stopReason?: string }> = [];
		agent.subscribe(event =>
			events.push({ type: event.type, stopReason: event.type === "agent_end" ? event.stopReason : undefined }),
		);

		const run = agent.prompt("run", { fallbackManaged: true });
		for (let i = 0; i < 20 && !agent.state.isStreaming; i += 1) await Bun.sleep(1);
		agent.abort();
		await run;

		expect(events.filter(event => event.type === "agent_end")).toEqual([
			{ type: "agent_end", stopReason: "cancelled" },
		]);
		expectManagedRunStart(events.map(event => event.type));
		expect(events.filter(event => event.type === "message_update")).toHaveLength(0);
		expect(events.filter(event => event.type === "turn_end")).toHaveLength(0);
		expect(agent.state.messages.filter(message => message.role === "assistant")).toHaveLength(0);
		expect(agent.state.isStreaming).toBe(false);
	});

	it("keeps non-managed streaming behavior live", async () => {
		const mock = createMockModel({ responses: [{ content: ["live"] }] });
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const events: string[] = [];
		agent.subscribe(event => events.push(event.type));

		await agent.prompt("run");

		expect(events).toContain("message_update");
		expect(events.at(-1)).toBe("agent_end");
	});

	it("classifies an opaque typed OpenAI overflow as discarded maintenance without leaking a lifecycle", async () => {
		const mock = createMockModel();
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: async () => {
				throw Object.assign(new Error(""), {
					transportFailure: { kind: "transport", status: 400, openaiErrorCode: "context_length_exceeded" },
				});
			},
		});
		const events: AgentEvent[] = [];
		const outcomes: ManagedAttemptOutcome[] = [];
		let maintenanceRuns = 0;
		agent.subscribe(event => events.push(event));

		await agent.prompt("run", {
			fallbackManaged: true,
			onManagedAttemptOutcome: outcome => {
				outcomes.push(outcome);
				return {
					type: "maintenance",
					continuation: () => {
						maintenanceRuns += 1;
					},
				};
			},
		});

		expect(outcomes).toEqual([
			expect.objectContaining({
				type: "context_overflow_discarded",
				message: expect.objectContaining({ errorMessage: "" }),
			}),
		]);
		expect(maintenanceRuns).toBe(1);
		expect(
			events.filter(
				event =>
					event.type === "message_update" ||
					((event.type === "message_start" || event.type === "message_end") &&
						event.message.role === "assistant") ||
					event.type === "turn_end" ||
					event.type === "agent_end",
			),
		).toEqual([]);
		expect(agent.state.messages.filter(message => message.role === "assistant")).toHaveLength(0);
	});

	it("clears managed ownership before terminal observers run", async () => {
		const mock = createMockModel();
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: async () => {
				throw Object.assign(new Error(""), {
					transportFailure: { kind: "transport", status: 400, openaiErrorCode: "context_length_exceeded" },
				});
			},
		});
		let ownerBeforeTerminal: number | undefined;
		let ownerAtMessageEnd: number | undefined;
		let ownerAtAgentEnd: number | undefined;
		agent.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				ownerAtMessageEnd = agent.currentManagedLogicalRunId;
			}
			if (event.type === "agent_end") {
				ownerAtAgentEnd = agent.currentManagedLogicalRunId;
			}
		});

		await agent.prompt("run", {
			fallbackManaged: true,
			onManagedAttemptOutcome: outcome => {
				if (outcome.type !== "context_overflow_discarded") {
					throw new Error(`Expected discarded overflow, received ${outcome.type}`);
				}
				return {
					type: "maintenance",
					continuation: ownership => {
						ownerBeforeTerminal = agent.currentManagedLogicalRunId;
						agent.requestRunTerminal(ownership.logicalRunId, {
							stopReason: "error",
							messages: [outcome.message],
						});
					},
				};
			},
		});

		expect(ownerBeforeTerminal).toBeDefined();
		expect(ownerAtMessageEnd).toBeUndefined();
		expect(ownerAtAgentEnd).toBeUndefined();
		expect(agent.currentManagedLogicalRunId).toBeUndefined();
	});

	it("discards retryable managed failures before any assistant lifecycle escapes", async () => {
		const mock = createMockModel();
		const streamFn = async () => {
			throw Object.assign(new Error("rate limit exceeded"), {
				transportFailure: { kind: "transport", status: 429 },
			});
		};
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn,
		});
		const events: string[] = [];
		const outcomes: string[] = [];
		agent.subscribe(event => {
			if (
				event.type === "agent_end" ||
				event.type === "turn_end" ||
				("message" in event && event.message.role === "assistant")
			) {
				events.push(event.type);
			}
		});

		await agent.prompt("run", {
			fallbackManaged: true,
			onManagedAttemptOutcome: (outcome: ManagedAttemptOutcome) => {
				outcomes.push(
					outcome.type === "run_terminal"
						? outcome.reason
						: outcome.type === "retryable_discarded"
							? (outcome.failure.message.errorMessage ?? "")
							: (outcome.message.errorMessage ?? ""),
				);
				return { type: "retry", continuation: () => {} };
			},
		} as any);

		expect(outcomes).toEqual(["rate limit exceeded"]);
		expect(events).not.toContain("message_start");
		expect(events).not.toContain("message_update");
		expect(events).not.toContain("message_end");
		expect(events).not.toContain("turn_end");
		expect(events).not.toContain("agent_end");
		expect(agent.state.messages.filter(message => message.role === "assistant")).toHaveLength(0);
	});

	it("does not authorize managed fallback from raw status or hostile transport wrappers", async () => {
		const mock = createMockModel();
		const localFailure = Object.assign(new Error("local status only"), { status: 429 });
		Object.defineProperty(localFailure, "transportFailure", {
			get() {
				throw new Error("hostile transport getter");
			},
		});
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: async () => {
				throw localFailure;
			},
		});
		let outcomeCalls = 0;

		await agent.prompt("run", {
			fallbackManaged: true,
			onManagedAttemptOutcome: () => {
				outcomeCalls += 1;
				return { type: "retry", continuation: () => {} };
			},
		} as any);
		await agent.waitForIdle();

		expect(outcomeCalls).toBe(0);
		expect(agent.state.error).toContain("local status only");
		expect(agent.state.messages.find(message => message.role === "assistant")).toBeDefined();
	});

	it("stages a non-cloneable provider failure without masking it as a DataCloneError", async () => {
		// Regression: a provider error message whose payload is not
		// structured-cloneable (e.g. a live `Headers` in `transportFailure`)
		// must not turn into a local "The object can not be cloned." attempt
		// failure that hides the real provider outcome and burns the chain.
		const mock = createMockModel();
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const failure: AssistantMessage = {
					...assistantMessage(mock.model),
					stopReason: "error",
					errorMessage: "rate limited",
					errorStatus: 429,
					transportFailure: {
						kind: "transport",
						status: 429,
						headers: new Headers({ "retry-after": "0" }) as unknown as Record<string, string>,
					},
				};
				stream.push({ type: "error", reason: "error", error: failure });
			});
			return stream;
		};
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn,
		});
		const outcomes: string[] = [];
		const facts: unknown[] = [];

		await agent.prompt("run", {
			fallbackManaged: true,
			onManagedAttemptOutcome: (outcome: ManagedAttemptOutcome) => {
				outcomes.push(
					outcome.type === "run_terminal"
						? outcome.reason
						: outcome.type === "retryable_discarded"
							? (outcome.failure.message.errorMessage ?? "")
							: (outcome.message.errorMessage ?? ""),
				);
				if (outcome.type === "retryable_discarded") facts.push(outcome.failure.transportFailure);
				return { type: "terminal", terminal: { stopReason: "exhausted" } };
			},
		} as any);

		expect(outcomes).toEqual(["rate limited"]);
		// The outcome facts must be the normalized plain-record form (retry
		// delay survives; no live Headers escapes to the fallback controller).
		expect(facts).toHaveLength(1);
		expect(facts[0]).toMatchObject({ kind: "transport", status: 429 });
		expect((facts[0] as { headers?: unknown }).headers).toEqual({ "retry-after": "0" });
		expect(() => structuredClone(facts[0])).not.toThrow();
		expect(agent.state.messages.filter(message => message.role === "assistant")).toHaveLength(0);
	});

	it("keeps degraded snapshots event-time distinct when the partial is not structured-cloneable", async () => {
		// The provider mutates one partial in place while it also carries a
		// non-structured-cloneable leaf (a function). The sanitizing snapshot
		// fallback must still detach every staged value: replaying a live
		// reference would surface "ab" three times instead of "", "a", "ab".
		const mock = createMockModel();
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			void (async () => {
				const partial = assistantMessage(mock.model);
				(partial as unknown as Record<string, unknown>).probe = () => {};
				stream.push({ type: "start", partial });
				await Bun.sleep(0);
				partial.content.push({ type: "text", text: "" });
				stream.push({ type: "text_start", contentIndex: 0, partial });
				await Bun.sleep(0);
				(partial.content[0] as { type: "text"; text: string }).text = "a";
				stream.push({ type: "text_delta", contentIndex: 0, delta: "a", partial });
				await Bun.sleep(0);
				(partial.content[0] as { type: "text"; text: string }).text = "ab";
				stream.push({ type: "text_delta", contentIndex: 0, delta: "b", partial });
				await Bun.sleep(0);
				stream.push({ type: "done", reason: "stop", message: partial });
			})();
			return stream;
		};
		const eventContents: string[] = [];
		const callbackContents: string[] = [];
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn,
			onAssistantMessageEvent: message => {
				callbackContents.push((message.content[0] as { type: "text"; text: string } | undefined)?.text ?? "");
			},
		});
		agent.subscribe(event => {
			if (event.type !== "message_update") return;
			eventContents.push(
				((event.message as AssistantMessage).content[0] as { type: "text"; text: string } | undefined)?.text ?? "",
			);
		});

		await agent.prompt("run", { fallbackManaged: true });

		expect(eventContents).toEqual(["", "a", "ab"]);
		expect(callbackContents).toEqual(["", "a", "ab"]);
	});

	it("stages a cyclic payload without converting it into an over-limit attempt failure", async () => {
		// structuredClone handles cycles, but JSON.stringify does not: the byte
		// accounting gate must fall back to a cycle-safe sanitized snapshot
		// instead of mislabeling the event as a retryable 503 buffer overflow.
		const mock = createMockModel();
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			void (async () => {
				const partial = assistantMessage(mock.model);
				const cyclic: Record<string, unknown> = { note: "cyclic" };
				cyclic.self = cyclic;
				(partial as unknown as Record<string, unknown>).probe = cyclic;
				stream.push({ type: "start", partial });
				await Bun.sleep(0);
				partial.content.push({ type: "text", text: "accepted" });
				stream.push({ type: "text_start", contentIndex: 0, partial });
				await Bun.sleep(0);
				stream.push({ type: "done", reason: "stop", message: partial });
			})();
			return stream;
		};
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn,
		});
		const events: string[] = [];
		agent.subscribe(event => events.push(event.type));

		await agent.prompt("run", { fallbackManaged: true });

		expect(events).toContain("message_end");
		expect(events.at(-1)).toBe("agent_end");
		expect(agent.state.error).toBeUndefined();
		expect(agent.state.messages.filter(message => message.role === "assistant")).toHaveLength(1);
	});

	it("defeats a payload-controlled array map override that returns the live array", async () => {
		// Adversarial regression: if the sanitizer dispatched through
		// `input.map`, this override would hand back the provider's live
		// array and later mutations would rewrite already-staged snapshots.
		const mock = createMockModel();
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			void (async () => {
				const partial = assistantMessage(mock.model);
				(partial as unknown as Record<string, unknown>).probe = () => {};
				const content = partial.content as unknown[];
				Object.defineProperty(content, "map", { value: () => content });
				stream.push({ type: "start", partial });
				await Bun.sleep(0);
				content.push({ type: "text", text: "" });
				stream.push({ type: "text_start", contentIndex: 0, partial });
				await Bun.sleep(0);
				(content[0] as { type: "text"; text: string }).text = "a";
				stream.push({ type: "text_delta", contentIndex: 0, delta: "a", partial });
				await Bun.sleep(0);
				(content[0] as { type: "text"; text: string }).text = "ab";
				stream.push({ type: "text_delta", contentIndex: 0, delta: "b", partial });
				await Bun.sleep(0);
				stream.push({ type: "done", reason: "stop", message: partial });
			})();
			return stream;
		};
		const eventContents: string[] = [];
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn,
		});
		agent.subscribe(event => {
			if (event.type !== "message_update") return;
			eventContents.push(
				((event.message as AssistantMessage).content[0] as { type: "text"; text: string } | undefined)?.text ?? "",
			);
		});

		await agent.prompt("run", { fallbackManaged: true });

		expect(eventContents).toEqual(["", "a", "ab"]);
	});

	it("stages a cyclic array with a map override without throwing or masking the run", async () => {
		// Second adversarial mode: the override returns the same cyclic array,
		// so a map-dispatching sanitizer would re-produce the cycle and the
		// byte-accounting JSON.stringify would throw outside any catch.
		const mock = createMockModel();
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			void (async () => {
				const partial = assistantMessage(mock.model);
				(partial as unknown as Record<string, unknown>).probe = () => {};
				const content = partial.content as unknown[];
				content.push({ type: "text", text: "accepted" });
				content.push(content);
				Object.defineProperty(content, "map", { value: () => content });
				stream.push({ type: "start", partial });
				await Bun.sleep(0);
				stream.push({ type: "text_start", contentIndex: 0, partial });
				await Bun.sleep(0);
				stream.push({ type: "done", reason: "stop", message: partial });
			})();
			return stream;
		};
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn,
		});
		const events: string[] = [];
		agent.subscribe(event => events.push(event.type));

		await agent.prompt("run", { fallbackManaged: true });

		expect(events).toContain("message_end");
		expect(events.at(-1)).toBe("agent_end");
		expect(agent.state.error).toBeUndefined();
	});

	it("replaces throwing accessors with a placeholder instead of invoking or failing", async () => {
		// The degraded snapshot must never invoke accessors (observable side
		// effects) nor let a throwing getter fail the attempt: the property is
		// replaced with "[accessor]" via descriptor inspection.
		const mock = createMockModel();
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			void (async () => {
				const partial = assistantMessage(mock.model);
				const poisoned: Record<string, unknown> = {};
				Object.defineProperty(poisoned, "secret", {
					enumerable: true,
					get() {
						throw new Error("boom");
					},
				});
				(partial as unknown as Record<string, unknown>).probe = poisoned;
				stream.push({ type: "start", partial });
				await Bun.sleep(0);
				partial.content.push({ type: "text", text: "accepted" });
				stream.push({ type: "text_start", contentIndex: 0, partial });
				await Bun.sleep(0);
				stream.push({ type: "done", reason: "stop", message: partial });
			})();
			return stream;
		};
		const replayedProbes: unknown[] = [];
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn,
		});
		agent.subscribe(event => {
			if (event.type !== "message_update") return;
			replayedProbes.push(
				((event.message as unknown as Record<string, unknown>).probe as Record<string, unknown>).secret,
			);
		});

		await agent.prompt("run", { fallbackManaged: true });

		expect(replayedProbes.length).toBeGreaterThan(0);
		expect(replayedProbes.every(probe => probe === "[accessor]")).toBeTrue();
		expect(agent.state.error).toBeUndefined();
	});

	it("bounds sparse and length-poisoned arrays without densifying holes", () => {
		// A sparse array (or a huge `length` with one element) must not force
		// an allocation proportional to its declared length: the degraded
		// clone enumerates only present entries and degrades sparse arrays to
		// a record of their indices. A densifying implementation would blow
		// past this test's timeout allocating millions of slots.
		// (Direct unit test: at the transaction level a measurable sparse
		// event is rejected by the byte cap from its JSON size alone — the
		// same pre-clone measurement upstream always used — so the sanitizer's
		// shape guarantees are asserted on the exported function.)
		const sparse: unknown[] = [];
		sparse[9_999_999] = { note: "sparse-x" };
		const lengthPoisoned: unknown[] = [];
		lengthPoisoned.length = 10_000_000;
		lengthPoisoned[0] = () => {};

		const out = sanitizedDetachedClone({ sparse, lengthPoisoned }) as Record<string, unknown>;

		// Sparse array degrades to a record of present indices only.
		expect(out.sparse).toEqual({ "9999999": { note: "sparse-x" } } as never);
		// Length-poisoned array keeps only its single present element.
		expect(out.lengthPoisoned).toEqual(["[unserializable]"] as never);
		// The degraded form is JSON-safe and small — no hole densification.
		expect(JSON.stringify(out).length).toBeLessThan(200);
	});

	it("charges the budget for every enumerated key, including accessors and shared-object revisits", () => {
		// Round-4 counterexample: N references to one wide accessor-bearing
		// child. Without per-key debits, each revisit would emit its accessor
		// placeholders "for free" (accessors never enter walk()), allowing
		// ~N*M descriptor reads while consuming only ~N budget units.
		const child: Record<string, unknown> = {};
		for (let accessorIndex = 0; accessorIndex < 50; accessorIndex++) {
			Object.defineProperty(child, `accessor${accessorIndex}`, {
				enumerable: true,
				get() {
					throw new Error("must not be invoked");
				},
			});
		}
		const root: Record<string, unknown> = {};
		for (let refIndex = 0; refIndex < 50; refIndex++) root[`ref${refIndex}`] = child;

		const budget = 120;
		const out = sanitizedDetachedClone(root, budget) as Record<string, unknown>;

		// Output is detached, JSON-safe, and bounded by the budget.
		const serialized = JSON.stringify(out);
		expect(serialized.length).toBeGreaterThan(0);
		const accessorCount = serialized.split('"[accessor]"').length - 1;
		const truncatedCount = serialized.split('"[truncated]"').length - 1;
		expect(accessorCount).toBeLessThanOrEqual(budget);
		expect(accessorCount).toBeGreaterThan(0);
		expect(truncatedCount).toBeGreaterThan(0);
	});

	it("collapses proxies before any reflective enumeration", () => {
		let trapDispatches = 0;
		const hostileArrayProxy = new Proxy([] as unknown[], {
			ownKeys() {
				trapDispatches += 1;
				return ["2", "1", "length"];
			},
			getOwnPropertyDescriptor() {
				trapDispatches += 1;
				return { value: "x", enumerable: true, configurable: true };
			},
			get() {
				trapDispatches += 1;
				return 0;
			},
		});
		const { proxy: revoked, revoke } = Proxy.revocable({}, {});
		revoke();

		const out = sanitizedDetachedClone({ hostileArrayProxy, revoked, plain: { ok: true } }) as Record<
			string,
			unknown
		>;

		expect(out.hostileArrayProxy).toBe("[unserializable]");
		expect(out.revoked).toBe("[unserializable]");
		expect(out.plain).toEqual({ ok: true } as never);
		// No ownKeys/descriptor/get trap was ever dispatched.
		expect(trapDispatches).toBe(0);
	});

	it("never walks the prototype chain: a proxy prototype dispatches zero traps", () => {
		// `instanceof Date` would invoke a proxy prototype's getPrototypeOf
		// trap while walking the chain; the brand check must use the internal
		// slot (`util.types.isDate`) instead.
		let getPrototypeDispatches = 0;
		const hostilePrototype: object = new Proxy(
			{},
			{
				getPrototypeOf() {
					getPrototypeDispatches += 1;
					return null;
				},
			},
		);
		const ordinary = Object.create(hostilePrototype) as Record<string, unknown>;
		ordinary.ok = true;

		const out = sanitizedDetachedClone({ ordinary, when: new Date(1234567890) }) as Record<string, unknown>;

		expect(out.ordinary).toEqual({ ok: true } as never);
		expect(out.when).toEqual(new Date(1234567890));
		expect(getPrototypeDispatches).toBe(0);
	});

	it("publishes oversized normalized input without killing the attempt, preserving the upstream getter witness", async () => {
		// Oversized output is published instead of failing the run. The provider
		// getter is still read once at upstream ingress, never by staging.
		const mock = createMockModel();
		let witnessReads = 0;
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const partial = assistantMessage(mock.model);
				partial.content.push({ type: "text", text: "x".repeat(16 * 1024 * 1024 + 1) });
				const witness: Record<string, unknown> = {};
				Object.defineProperty(witness, "read", {
					enumerable: true,
					get() {
						witnessReads += 1;
						return true;
					},
				});
				(partial as unknown as Record<string, unknown>).witness = witness;
				stream.push({ type: "start", partial });
				stream.push({ type: "done", reason: "stop", message: partial });
			});
			return stream;
		};
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn,
		});
		let outcomeCalls = 0;

		await agent.prompt("run", {
			fallbackManaged: true,
			onManagedAttemptOutcome: () => {
				outcomeCalls += 1;
				return { type: "terminal", terminal: { stopReason: "exhausted" } };
			},
		} as any);
		await agent.waitForIdle();

		// Local overflow is not provider evidence: the chain is never consumed,
		// and a healthy oversized response now completes instead of failing.
		expect(outcomeCalls).toBe(0);
		expect(agent.state.error).toBeUndefined();
		expect(witnessReads).toBeGreaterThanOrEqual(1);
		const final = agent.state.messages.at(-1) as AssistantMessage;
		expect(final.stopReason).toBe("stop");
		expect(messageText(final).length).toBe(16 * 1024 * 1024 + 1);
	});

	it("publishes an over-limit provisional batch without consuming the chain", async () => {
		const mock = createMockModel();
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "x".repeat(16 * 1024 * 1024 + 1) }],
					api: mock.model.api,
					provider: mock.model.provider,
					model: mock.model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				};
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn,
		});
		const events: string[] = [];
		let outcomeCalls = 0;
		const surfaced: AssistantMessage[] = [];
		agent.subscribe(event => {
			if (
				event.type === "agent_end" ||
				event.type === "turn_end" ||
				("message" in event && event.message.role === "assistant")
			) {
				events.push(event.type);
			}
			if (event.type === "message_end" && event.message.role === "assistant") {
				surfaced.push(event.message as AssistantMessage);
			}
		});

		await agent.prompt("run", {
			fallbackManaged: true,
			onManagedAttemptOutcome: () => {
				outcomeCalls += 1;
				return { type: "retry", continuation: () => {} };
			},
		} as any);
		await agent.waitForIdle();

		// Exceeding the staging caps is not provider evidence and never consumes
		// the chain; the attempt is published and completes as an ordinary turn.
		expect(outcomeCalls).toBe(0);
		expect(agent.state.error).toBeUndefined();
		expect(surfaced).toHaveLength(1);
		expect(surfaced[0]?.stopReason).toBe("stop");
		expect(surfaced[0]?.errorStatus).toBeUndefined();
		expect(surfaced[0]?.transportFailure).toBeUndefined();
		expect(events.slice(-2)).toEqual(["turn_end", "agent_end"]);
	});

	it("retains queued follow-up input when its managed attempt is discarded for retry", async () => {
		const mock = createMockModel({ responses: [{ content: ["initial"] }, { content: ["retried"] }] });
		let calls = 0;
		const queuedFollowUp = { role: "user" as const, content: "queued follow-up", timestamp: Date.now() };
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: (...args) => {
				calls += 1;
				if (calls === 2)
					throw Object.assign(new Error("limited"), {
						transportFailure: { kind: "transport", status: 429 },
					});
				return mock.stream(...args);
			},
		});
		agent.followUp(queuedFollowUp);
		const options = {
			fallbackManaged: true,
			onManagedAttemptOutcome: () => ({
				type: "retry" as const,
				continuation: async (ownership: { isCurrent(): boolean }) => {
					if (ownership.isCurrent()) await agent.continue(options);
				},
			}),
		};

		await agent.prompt("run", options);

		expect(calls).toBe(3);
		expect(agent.state.messages).toContainEqual(queuedFollowUp);
		expect(
			agent.state.messages.filter(message => message.role === "assistant").map(message => message.content),
		).toHaveLength(2);
	});
	it("repairs a root-proxied managed assistant shell across published surfaces", async () => {
		const mock = createMockModel();
		let live: AssistantMessage | undefined;
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = assistantMessage(mock.model);
				message.content.push({ type: "text", text: "accepted" });
				live = new Proxy(message, {});
				stream.push({ type: "start", partial: live });
				stream.push({ type: "text_start", contentIndex: 0, partial: live });
				stream.push({ type: "done", reason: "stop", message: live });
			});
			return stream;
		};
		const context: AgentContext = {
			systemPrompt: ["test"],
			messages: [{ role: "user", content: "run", timestamp: Date.now() }],
			tools: [],
		};
		const callbacks: AssistantMessageEvent[] = [];
		const stream = agentLoopContinue(
			context,
			{
				model: mock.model,
				convertToLlm: messages => messages as Message[],
				fallbackManaged: true,
				onAssistantMessageEvent: (_message, event) => callbacks.push(event),
			},
			undefined,
			streamFn,
		);
		const events: AgentEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();
		(live!.content[0] as { type: "text"; text: string }).text = "mutated";
		const messages = [
			context.messages.at(-1),
			result[0],
			...events.flatMap(event => {
				if (event.type === "message_start" || event.type === "message_end" || event.type === "turn_end")
					return [event.message];
				if (event.type === "message_update") return [event.message];
				if (event.type === "agent_end") return event.messages;
				return [];
			}),
		];
		for (const message of messages) {
			expect(message).toMatchObject({ role: "assistant", content: [{ type: "text", text: "accepted" }] });
			expect(() => structuredClone(message)).not.toThrow();
		}
		expect(callbacks).toHaveLength(1);
		expect(callbacks[0]).toMatchObject({ type: "text_start", contentIndex: 0, partial: { role: "assistant" } });
	});

	it("fails a collapsed root proxy locally without managed retry authority", async () => {
		const mock = createMockModel();
		const collapsed = new Proxy(assistantMessage(mock.model), {
			get() {
				throw new Error("collapsed root");
			},
		});
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => stream.push({ type: "start", partial: collapsed }));
				return stream;
			},
		});
		let outcomes = 0;
		await agent.prompt("run", {
			fallbackManaged: true,
			onManagedAttemptOutcome: () => {
				outcomes += 1;
				return { type: "retry", continuation: () => {} };
			},
		});
		expect(outcomes).toBe(0);
		expect(agent.state.error).toContain("local snapshot");
		expect(agent.state.messages.filter(message => message.role === "assistant")).toHaveLength(1);
	});
	it("normalizes null and incomplete tool-call blocks before managed dispatch", async () => {
		const mock = createMockModel();
		const malformed = assistantMessage(mock.model) as unknown as { content: unknown[] };
		malformed.content = [null, { type: "toolCall", id: "call", name: "danger" }];
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: malformed as AssistantMessage }));
				return stream;
			},
		});
		await agent.prompt("run", { fallbackManaged: true });
		const message = agent.state.messages.at(-1) as AssistantMessage;
		expect(message.content).toEqual([]);
	});

	it("preserves reasoning summary events through managed replay", async () => {
		const mock = createMockModel();
		const callbacks: AssistantMessageEvent[] = [];
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const partial = assistantMessage(mock.model);
					partial.content.push({ type: "thinking", thinking: "safe summary" });
					stream.push({ type: "start", partial });
					stream.push({ type: "reasoning_summary_start", contentIndex: 0, partial });
					stream.push({
						type: "reasoning_summary_delta",
						contentIndex: 0,
						delta: "safe summary",
						partial,
					});
					stream.push({
						type: "reasoning_summary_end",
						contentIndex: 0,
						content: "safe summary",
						partial,
					});
					stream.push({ type: "done", reason: "stop", message: partial });
				});
				return stream;
			},
			onAssistantMessageEvent: (_message, event) => callbacks.push(event),
		});

		await agent.prompt("run", { fallbackManaged: true });

		expect(agent.state.error).toBeUndefined();
		expect(callbacks.map(event => event.type)).toEqual([
			"reasoning_summary_start",
			"reasoning_summary_delta",
			"reasoning_summary_end",
		]);
		expect(callbacks[0]).toMatchObject({ type: "reasoning_summary_start", contentIndex: 0 });
		expect(callbacks[1]).toMatchObject({
			type: "reasoning_summary_delta",
			contentIndex: 0,
			delta: "safe summary",
		});
		expect(callbacks[2]).toMatchObject({
			type: "reasoning_summary_end",
			contentIndex: 0,
			content: "safe summary",
		});
		expect(agent.state.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "thinking", thinking: "safe summary" }],
		});
	});
	it("preserves a complete detached toolcall_end event", async () => {
		const mock = createMockModel();
		const toolCall = {
			type: "toolCall" as const,
			id: "call",
			name: "safe",
			arguments: { value: 1 },
			thoughtSignature: "signature",
			intent: "inspect safely",
			customWireName: "custom_safe",
			incompleteArguments: true,
		};
		const callbacks: AssistantMessageEvent[] = [];
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const partial = assistantMessage(mock.model);
					stream.push({ type: "start", partial });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
					stream.push({ type: "done", reason: "stop", message: partial });
				});
				return stream;
			},
			onAssistantMessageEvent: (_message, event) => callbacks.push(event),
		});
		await agent.prompt("run", { fallbackManaged: true });
		const ended = callbacks.find(event => event.type === "toolcall_end");
		expect(ended).toMatchObject({ toolCall });
		expect(ended).not.toBeUndefined();
		expect(ended?.type === "toolcall_end" ? ended.toolCall : undefined).toMatchObject({
			thoughtSignature: "signature",
			intent: "inspect safely",
			customWireName: "custom_safe",
			incompleteArguments: true,
		});
	});

	it("rejects managed events with hidden required fields as local failures", async () => {
		const mock = createMockModel();
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const partial = assistantMessage(mock.model);
					stream.push({ type: "start", partial });
					stream.push(
						new Proxy(
							{ type: "text_delta", contentIndex: 0, partial },
							{ get: (target, key) => (key === "delta" ? undefined : Reflect.get(target, key)) },
						) as AssistantMessageEvent,
					);
					stream.push({ type: "done", reason: "stop", message: partial });
				});
				return stream;
			},
		});
		await agent.prompt("run", { fallbackManaged: true });
		expect(agent.state.error).toContain("local snapshot");
	});
	it("normalizes invalid stop reasons and rejects invalid event indices", async () => {
		const mock = createMockModel();
		const invalidMessage = {
			...assistantMessage(mock.model),
			stopReason: "invalid",
			timestamp: Number.POSITIVE_INFINITY,
			errorStatus: Number.NaN,
		} as unknown as AssistantMessage;
		const accepted = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: invalidMessage }));
				return stream;
			},
		});
		const published: AssistantMessage[] = [];
		accepted.subscribe(event => {
			if ((event.type === "message_end" || event.type === "turn_end") && event.message.role === "assistant")
				published.push(event.message as AssistantMessage);
			if (event.type === "agent_end") {
				published.push(...(event.messages.filter(message => message.role === "assistant") as AssistantMessage[]));
			}
		});
		await accepted.prompt("run", { fallbackManaged: true });
		const committed = accepted.state.messages.at(-1) as AssistantMessage;
		expect(committed.stopReason).toBe("stop");
		expect(Number.isFinite(committed.timestamp)).toBe(true);
		expect(committed.errorStatus).toBeUndefined();
		for (const message of published) {
			expect(["stop", "length", "toolUse", "error", "aborted"]).toContain(message.stopReason);
			expect(Number.isFinite(message.timestamp)).toBe(true);
			expect(message.errorStatus).toBeUndefined();
		}

		const rejected = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const partial = assistantMessage(mock.model);
					stream.push({ type: "start", partial });
					stream.push({ type: "text_delta", contentIndex: -1, delta: "x", partial });
					stream.push({ type: "done", reason: "stop", message: partial });
				});
				return stream;
			},
		});
		await rejected.prompt("run", { fallbackManaged: true });
		expect(rejected.state.error).toContain("local snapshot");
	});
});

describe("managed retry ownership", () => {
	it("publishes only the accepted attempt lifecycle after discarded retries", async () => {
		const mock = createMockModel({ responses: [{ content: ["accepted"] }] });
		let attempt = 0;
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: (...args) => {
				attempt++;
				if (attempt < 3)
					throw Object.assign(new Error("limited"), { transportFailure: { kind: "transport", status: 429 } });
				return mock.stream(...args);
			},
		});
		const events: string[] = [];
		agent.subscribe(event => events.push(event.type));
		const options = {
			fallbackManaged: true,
			onManagedAttemptOutcome: () => ({
				type: "retry" as const,
				continuation: async (ownership: { isCurrent(): boolean }) => {
					if (ownership.isCurrent()) await agent.continue(options);
				},
			}),
		};

		await agent.prompt("run", options);

		expect(attempt).toBe(3);
		expect(events.filter(type => type === "agent_start")).toHaveLength(1);
		expect(events.filter(type => type === "turn_start")).toHaveLength(1);
		expectManagedRunStart(events);
	});

	it("preserves one managed logical lifecycle across maintenance continuation", async () => {
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "missing-tool", arguments: {} }] },
				{ content: ["accepted after maintenance"] },
			],
		});
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		let maintenanceCalls = 0;
		agent.setMaintainContext(() => (maintenanceCalls++ === 0 ? "compacted" : "not-needed"));
		const events: Array<{ type: string; stopReason?: string }> = [];
		const resumed = Promise.withResolvers<void>();
		const options = { fallbackManaged: true } as const;
		agent.subscribe(event => {
			events.push({ type: event.type, stopReason: event.type === "agent_end" ? event.stopReason : undefined });
			if (event.type === "agent_end" && event.stopReason === "maintenance") {
				queueMicrotask(() => {
					void agent.continue(options).then(resumed.resolve, resumed.reject);
				});
			}
		});

		await agent.prompt("run", options);
		await resumed.promise;

		expect(events.filter(event => event.type === "agent_start")).toHaveLength(1);
		expect(events.filter(event => event.type === "agent_end" && event.stopReason === "maintenance")).toHaveLength(1);
		expect(events.filter(event => event.type === "agent_end" && event.stopReason !== "maintenance")).toEqual([
			{ type: "agent_end", stopReason: "completed" },
		]);
	});

	it("dedupes a logical terminal request after an accepted retry", async () => {
		const mock = createMockModel({ responses: [{ content: ["accepted"] }] });
		let attempts = 0;
		let logicalRunId: number | undefined;
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: (...args) => {
				attempts++;
				if (attempts === 1)
					throw Object.assign(new Error("limited"), { transportFailure: { kind: "transport", status: 429 } });
				return mock.stream(...args);
			},
		});
		const terminalEvents: Array<{ stopReason?: string }> = [];
		agent.subscribe(event => {
			if (event.type === "agent_end") terminalEvents.push({ stopReason: event.stopReason });
		});
		const options = {
			fallbackManaged: true,
			onManagedAttemptOutcome: () => ({
				type: "retry" as const,
				continuation: async (ownership: { isCurrent(): boolean }) => {
					logicalRunId = agent.currentManagedLogicalRunId;
					if (ownership.isCurrent()) await agent.continue(options);
				},
			}),
		};

		await agent.prompt("run", options);

		expect(attempts).toBe(2);
		expect(logicalRunId).toBeDefined();
		expect(agent.requestRunTerminal(logicalRunId!, { stopReason: "cancelled" })).toBeFalse();
		expect(terminalEvents).toEqual([{ stopReason: "completed" }]);
	});

	it("starts and settles a superseding managed prompt while a discarded retry continuation is pending", async () => {
		const mock = createMockModel({ responses: [{ content: ["accepted"] }] });
		let attempts = 0;
		const continuationStarted = Promise.withResolvers<void>();
		const rejectContinuation = Promise.withResolvers<void>();
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: (...args) => {
				attempts++;
				if (attempts === 1)
					throw Object.assign(new Error("limited"), { transportFailure: { kind: "transport", status: 429 } });
				return mock.stream(...args);
			},
		});
		const terminalEvents: Array<{ type: "agent_start" | "agent_end"; stopReason?: string }> = [];
		agent.subscribe(event => {
			if (event.type === "agent_start" || event.type === "agent_end") {
				terminalEvents.push({
					type: event.type,
					...(event.type === "agent_end" && event.stopReason ? { stopReason: event.stopReason } : {}),
				});
			}
		});
		const options = {
			fallbackManaged: true,
			onManagedAttemptOutcome: () => ({
				type: "retry" as const,
				continuation: async () => {
					continuationStarted.resolve();
					await rejectContinuation.promise;
				},
			}),
		};

		const firstRun = agent.prompt("first", options);
		await continuationStarted.promise;
		await agent.prompt("second", options);
		rejectContinuation.reject(new Error("displaced retry failed"));
		await firstRun;

		expect(terminalEvents).toEqual([
			{ type: "agent_start" },
			{ type: "agent_end", stopReason: "cancelled" },
			{ type: "agent_start" },
			{ type: "agent_end", stopReason: "completed" },
		]);
	});

	it("does not terminalize a displaced continuation after its run id is evicted", async () => {
		const mock = createMockModel({ responses: Array.from({ length: 257 }, () => ({ content: ["accepted"] })) });
		let attempts = 0;
		const continuationStarted = Promise.withResolvers<void>();
		const rejectContinuation = Promise.withResolvers<void>();
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: (...args) => {
				attempts++;
				if (attempts === 1)
					throw Object.assign(new Error("limited"), { transportFailure: { kind: "transport", status: 429 } });
				return mock.stream(...args);
			},
		});
		const ends: Array<{ stopReason?: string }> = [];
		agent.subscribe(event => {
			if (event.type === "agent_end") ends.push({ stopReason: event.stopReason });
		});
		const options = {
			fallbackManaged: true,
			onManagedAttemptOutcome: () => ({
				type: "retry" as const,
				continuation: async () => {
					continuationStarted.resolve();
					await rejectContinuation.promise;
				},
			}),
		};

		const firstRun = agent.prompt("first", options);
		await continuationStarted.promise;
		for (let i = 0; i < 257; i++) await agent.prompt(`superseding ${i}`, options);
		const endsBeforeRejection = ends.length;
		expect(endsBeforeRejection).toBe(258);

		rejectContinuation.reject(new Error("displaced retry failed"));
		await firstRun;

		expect(ends).toHaveLength(endsBeforeRejection);
		expect(agent.state.error).toBeUndefined();
	});

	it("passes provider-code transport facts and emits a run start before a simulated resolution-context terminal", async () => {
		const mock = createMockModel();
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: async () => {
				throw Object.assign(new Error("quota"), {
					transportFailure: {
						kind: "transport",
						providerCode: "insufficient_quota",
						headers: { "retry-after": "2" },
					},
				});
			},
		});
		const events: string[] = [];
		agent.subscribe(event => events.push(event.type));
		let facts: unknown;
		await agent.prompt("run", {
			fallbackManaged: true,
			onManagedAttemptOutcome: outcome => {
				if (outcome.type === "retryable_discarded") facts = outcome.failure.transportFailure;
				return { type: "terminal", terminal: { stopReason: "exhausted" } };
			},
		});
		expect(facts).toEqual({ kind: "transport", providerCode: "insufficient_quota", headers: { "retry-after": "2" } });
		expectManagedRunStart(events);
	});

	it("suppresses a force-aborted continuation and settles a throwing continuation once", async () => {
		const mock = createMockModel();
		let continued = 0;
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: async () => {
				throw Object.assign(new Error("limited"), { transportFailure: { kind: "transport", status: 429 } });
			},
		});
		const ends: string[] = [];
		agent.subscribe(event => {
			if (event.type === "agent_end") ends.push(event.type);
		});
		await agent.prompt("run", {
			fallbackManaged: true,
			onManagedAttemptOutcome: () => {
				agent.forceAbort();
				return {
					type: "retry",
					continuation: () => {
						continued++;
						throw new Error("must not run");
					},
				};
			},
		});
		await agent.waitForIdle();
		expect(continued).toBe(0);
		expect(ends).toHaveLength(1);
	});

	it("settles a rejected continuation with one terminal completion", async () => {
		const mock = createMockModel();
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: async () => {
				throw Object.assign(new Error("limited"), { transportFailure: { kind: "transport", status: 429 } });
			},
		});
		const ends: string[] = [];
		agent.subscribe(event => {
			if (event.type === "agent_end") ends.push(event.type);
		});
		await agent.prompt("run", {
			fallbackManaged: true,
			onManagedAttemptOutcome: () => ({
				type: "retry",
				continuation: async () => {
					throw new Error("retry failed");
				},
			}),
		});
		await agent.waitForIdle();
		expect(ends).toHaveLength(1);
	});
});

it("emits an exhaustion diagnostic lifecycle once before terminal completion", async () => {
	const mock = createMockModel();
	const agent = new Agent({
		initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
		streamFn: async () => {
			throw Object.assign(new Error("overloaded"), {
				transportFailure: { kind: "transport", status: 503 },
			});
		},
	});
	const events: string[] = [];
	agent.subscribe(event => events.push(event.type));
	const diagnostic = {
		...assistantMessage(mock.model),
		stopReason: "error" as const,
		errorMessage: "fallback chain exhausted",
	};

	await agent.prompt("run", {
		fallbackManaged: true,
		onManagedAttemptOutcome: () => ({
			type: "terminal",
			terminal: { stopReason: "exhausted", messages: [diagnostic] },
		}),
	});

	expect(events.filter(type => type === "agent_end")).toEqual(["agent_end"]);
	expect(events.slice(-3)).toEqual(["message_start", "message_end", "agent_end"]);
	expect(agent.state.messages).toContainEqual(diagnostic);
	expectManagedRunStart(events);
});
