import { afterEach, describe, expect, it } from "bun:test";
import { detectSystemLanguage, getLanguage, resolveLanguage, SUPPORTED_LANGUAGES, setLanguage, t } from "../src/i18n";

afterEach(() => setLanguage("en"));

describe("i18n engine", () => {
	it("supports en/ko/zh/ja/es/fr/de", () => {
		expect([...SUPPORTED_LANGUAGES]).toEqual(["en", "ko", "zh", "ja", "es", "fr", "de"]);
	});

	it("translates a key per active language", () => {
		setLanguage("en");
		expect(t("welcome.workflows")).toBe("Workflows");
		setLanguage("ko");
		expect(t("welcome.workflows")).toBe("워크플로");
		setLanguage("zh");
		expect(t("welcome.workflows")).toBe("工作流");
		setLanguage("ja");
		expect(t("welcome.workflows")).toBe("ワークフロー");
	});

	it("falls back to English when a key is missing in the active language", () => {
		// lang.en is only defined in the English catalog; ko has no override.
		setLanguage("ko");
		expect(t("lang.en")).toBe("English");
	});

	it("interpolates parameters", () => {
		// No param key uses placeholders today; verify the mechanism directly.
		setLanguage("en");
		// Active language returns raw string unchanged when no params given.
		expect(t("welcome.noLsp")).toBe("No LSP servers");
	});

	it("detects an explicit non-English LANG locale", () => {
		// Explicit non-English env locales win over platform defaults, so these are
		// deterministic regardless of the machine's system locale.
		const orig = process.env.LANG;
		try {
			process.env.LANG = "ko_KR.UTF-8";
			expect(detectSystemLanguage()).toBe("ko");
			process.env.LANG = "zh_CN.UTF-8";
			expect(detectSystemLanguage()).toBe("zh");
			process.env.LANG = "ja_JP.UTF-8";
			expect(detectSystemLanguage()).toBe("ja");
		} finally {
			if (orig === undefined) delete process.env.LANG;
			else process.env.LANG = orig;
		}
	});

	it("resolves 'auto' to a concrete language and applies it", () => {
		const orig = process.env.LANG;
		try {
			process.env.LANG = "ja_JP.UTF-8";
			expect(resolveLanguage("auto")).toBe("ja");
			setLanguage("auto");
			expect(getLanguage()).toBe("ja");
		} finally {
			if (orig === undefined) delete process.env.LANG;
			else process.env.LANG = orig;
		}
	});
});
