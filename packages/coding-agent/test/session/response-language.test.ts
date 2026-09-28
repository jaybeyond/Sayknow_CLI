import { describe, expect, it } from "bun:test";
import { buildResponseLanguageReminder, detectResponseLanguage } from "../../src/session/response-language";

const code = (text: string) => detectResponseLanguage(text)?.code;

describe("detectResponseLanguage", () => {
	it("names the language of prose in a non-Latin script", () => {
		expect(code("웅 ai 가 대답할때 자꾸 영어로 답변 하거든")).toBe("ko");
		expect(code("このバグを直してください")).toBe("ja");
		// Kanji-heavy Japanese still counts as Japanese once kana appear.
		expect(code("設定画面の表示を修正して")).toBe("ja");
		expect(code("请帮我修复这个问题")).toBe("zh");
		expect(code("Почему тест падает?")).toBe("ru");
	});

	it("keeps Korean when the message is full of English identifiers", () => {
		expect(code("feat/auto-fallback-settings 브랜치에서 ci:check:full 돌려서 locate 테스트 확인해줘")).toBe("ko");
	});

	it("does not guess for Latin scripts, and ignores code, quotes and links", () => {
		expect(detectResponseLanguage("Fix the failing test in the broker")).toBeUndefined();
		expect(detectResponseLanguage("Arregla el test que falla")).toBeUndefined();
		expect(detectResponseLanguage("Why does this fail?\n```\nconst 이름 = '값';\n```")).toBeUndefined();
		expect(detectResponseLanguage("Explain `확인` in this log")).toBeUndefined();
		expect(detectResponseLanguage("> 원문 인용입니다 한국어\nPlease summarize the quote above")).toBeUndefined();
	});

	it("does not flip on a stray word in a pasted English log", () => {
		const log = `${"error: connection refused while fetching the provider catalog ".repeat(4)}확인`;
		expect(detectResponseLanguage(log)).toBeUndefined();
	});
});

describe("buildResponseLanguageReminder", () => {
	it("names the language, covers the whole turn, and leaves room for an explicit request", () => {
		const reminder = buildResponseLanguageReminder({ code: "ko", name: "Korean" });
		expect(reminder).toStartWith("<system-reminder>");
		expect(reminder).toContain("Write every user-facing message this turn in Korean");
		expect(reminder).toContain("the final report after tool work");
		expect(reminder).toContain("unless they asked for another language");
	});
});
