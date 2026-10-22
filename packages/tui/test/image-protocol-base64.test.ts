import { describe, expect, it } from "bun:test";
import { encodeITerm2, encodeKitty, encodeKittyTransmit, isRfc4648Base64 } from "../src/terminal-capabilities";

const ESCAPE_PAYLOAD = "AAAA\x1b\\\x1b]0;owned\x07";

describe("image protocol base64 guard", () => {
	it("accepts RFC 4648 base64 including padding", () => {
		for (const value of ["", "AAAA", "AA==", "AAA=", Buffer.from("hello world").toString("base64")]) {
			expect(isRfc4648Base64(value), value).toBe(true);
		}
	});

	it("accepts a multi-megabyte payload", () => {
		const payload = Buffer.from(new Uint8Array(3 * 1024 * 1024)).toString("base64");
		expect(isRfc4648Base64(payload)).toBe(true);
	});

	it("rejects payloads that could terminate an escape early", () => {
		for (const value of [ESCAPE_PAYLOAD, "AAA\x07", "AA\x1b\\", "AAAAA", "AA=A", "A===", "AA-_"]) {
			expect(isRfc4648Base64(value), JSON.stringify(value)).toBe(false);
		}
	});

	it("refuses to encode a non-base64 kitty or iTerm2 payload", () => {
		expect(() => encodeKitty(ESCAPE_PAYLOAD)).toThrow("Invalid RFC 4648 base64");
		expect(() => encodeKittyTransmit(ESCAPE_PAYLOAD, 7)).toThrow("Invalid RFC 4648 base64");
		expect(() => encodeITerm2(ESCAPE_PAYLOAD)).toThrow("Invalid RFC 4648 base64");
	});

	it("still encodes a valid payload", () => {
		const payload = Buffer.from("png-bytes").toString("base64");
		expect(encodeKitty(payload)).toContain(payload);
		expect(encodeKittyTransmit(payload, 7)).toContain(payload);
		expect(encodeITerm2(payload)).toContain(payload);
	});
});
