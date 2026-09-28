/**
 * Which language to answer in, detected from the script of the user's message.
 *
 * Long tool-heavy turns drift into English: tool output, logs, skill text and context
 * summaries are English, and the final report follows them. The system prompt states
 * the rule once; this adds a one-line reminder at the start of each turn, naming the
 * language, when the message is clearly written in a non-Latin script. Latin-script
 * languages (English, Spanish, French, German, …) cannot be told apart by script alone,
 * so they get no reminder and rely on the system prompt rule.
 */

export interface DetectedLanguage {
	/** BCP 47 code. */
	code: string;
	/** English name, as used in the reminder. */
	name: string;
}

/** Scripts that name one language well enough for a reminder. Kana wins over Han: Japanese mixes both. */
const SCRIPTS: ReadonlyArray<{ pattern: RegExp; language: DetectedLanguage }> = [
	{ pattern: /\p{Script=Hangul}/gu, language: { code: "ko", name: "Korean" } },
	{ pattern: /[\p{Script=Hiragana}\p{Script=Katakana}]/gu, language: { code: "ja", name: "Japanese" } },
	{ pattern: /\p{Script=Han}/gu, language: { code: "zh", name: "Chinese" } },
	{ pattern: /\p{Script=Cyrillic}/gu, language: { code: "ru", name: "Russian" } },
	{ pattern: /\p{Script=Arabic}/gu, language: { code: "ar", name: "Arabic" } },
	{ pattern: /\p{Script=Hebrew}/gu, language: { code: "he", name: "Hebrew" } },
	{ pattern: /\p{Script=Thai}/gu, language: { code: "th", name: "Thai" } },
	{ pattern: /\p{Script=Devanagari}/gu, language: { code: "hi", name: "Hindi" } },
	{ pattern: /\p{Script=Greek}/gu, language: { code: "el", name: "Greek" } },
];

/** Code, quoted output and links say nothing about the language the user writes in. */
function proseOnly(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`\n]*`/g, " ")
		.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ")
		.replace(/https?:\/\/\S+/g, " ")
		.split("\n")
		.filter(line => !/^\s*>/.test(line))
		.join("\n");
}

/**
 * The language of `text` when its prose is clearly in a non-Latin script, else
 * undefined. "Clearly": at least two characters of the script, and — since one CJK
 * character carries about a word — at least a quarter as many as Latin letters, so a
 * pasted English log with one Korean word does not count.
 */
export function detectResponseLanguage(text: string): DetectedLanguage | undefined {
	const prose = proseOnly(text);
	const latin = prose.match(/\p{Script=Latin}/gu)?.length ?? 0;
	const kana = prose.match(SCRIPTS[1]!.pattern)?.length ?? 0;
	for (const { pattern, language } of SCRIPTS) {
		let count = prose.match(pattern)?.length ?? 0;
		if (language.code === "zh" && kana > 0) continue;
		// Japanese needs kana to be told from Chinese; with it, its kanji count too.
		if (language.code === "ja" && kana > 0) count += prose.match(/\p{Script=Han}/gu)?.length ?? 0;
		if (count >= 2 && count * 4 >= latin) return language;
	}
	return undefined;
}

/** The per-turn reminder for a detected language. */
export function buildResponseLanguageReminder(language: DetectedLanguage): string {
	return [
		"<system-reminder>",
		`The user wrote in ${language.name}. Write every user-facing message this turn in ${language.name} — progress notes and the final report after tool work included — unless they asked for another language. Keep code, commands, paths and identifiers as they are.`,
		"</system-reminder>",
	].join("\n");
}
