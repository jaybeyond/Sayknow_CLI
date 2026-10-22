import { describe, expect, it } from "bun:test";
import { sanitizeHeaderComponent } from "@sayknow-cli/utils";

describe("sanitizeHeaderComponent", () => {
	it("passes ordinary printable ASCII through unchanged", () => {
		expect(sanitizeHeaderComponent("linux")).toBe("linux");
		expect(sanitizeHeaderComponent("6.8.0-51-generic")).toBe("6.8.0-51-generic");
		expect(sanitizeHeaderComponent("x64")).toBe("x64");
	});

	it("strips the non-ASCII Android kernel release characters", () => {
		expect(sanitizeHeaderComponent("4.4.302-Minimal™-EAS-QTI_Haptic-R26")).toBe("4.4.302-Minimal-EAS-QTI_Haptic-R26");
	});

	it("strips control characters", () => {
		expect(sanitizeHeaderComponent("linux\n")).toBe("linux");
		expect(sanitizeHeaderComponent("6.8.0\t-generic")).toBe("6.8.0-generic");
		expect(sanitizeHeaderComponent("arm64\r")).toBe("arm64");
	});

	it("strips lone surrogates", () => {
		expect(sanitizeHeaderComponent("ab\uD800cd\uDC00ef")).toBe("abcdef");
	});

	it("returns an empty string when nothing survives", () => {
		expect(sanitizeHeaderComponent("™\n")).toBe("");
	});

	it("keeps the sanitized value a legal header value", () => {
		const sanitized = sanitizeHeaderComponent("4.4.302-Minimal™-EAS-QTI_Haptic-R26");
		const headers = new Headers({ "User-Agent": `pi/0.14.0 (linux ${sanitized}; arm64)` });
		expect(headers.get("User-Agent")).toBe("pi/0.14.0 (linux 4.4.302-Minimal-EAS-QTI_Haptic-R26; arm64)");
	});
});
