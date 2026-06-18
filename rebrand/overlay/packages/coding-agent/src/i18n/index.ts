// Lightweight i18n for Sayknow-CLI.
//
// - `t(key, params?)` looks up the active language, falling back to English,
//   then to the raw key. `{name}`-style placeholders are interpolated.
// - The active language is resolved once at startup from the `language`
//   setting ("auto" follows the system locale) and can be switched live via
//   `setLanguage()` when the user changes the setting.
import { de } from "./messages/de";
import { deMsgs } from "./messages/de.messages";
import { deSettings } from "./messages/de.settings";
import { en, type MsgKey } from "./messages/en";
import { es } from "./messages/es";
import { esMsgs } from "./messages/es.messages";
import { esSettings } from "./messages/es.settings";
import { fr } from "./messages/fr";
import { frMsgs } from "./messages/fr.messages";
import { frSettings } from "./messages/fr.settings";
import { ja } from "./messages/ja";
import { jaMsgs } from "./messages/ja.messages";
import { jaSettings } from "./messages/ja.settings";
import { ko } from "./messages/ko";
import { koMsgs } from "./messages/ko.messages";
import { koSettings } from "./messages/ko.settings";
import { zh } from "./messages/zh";
import { zhMsgs } from "./messages/zh.messages";
import { zhSettings } from "./messages/zh.settings";

export type Lang = "en" | "ko" | "zh" | "ja" | "es" | "fr" | "de";
/** The value stored in settings — `auto` resolves to a concrete Lang. */
export type LanguagePref = "auto" | Lang;

export const SUPPORTED_LANGUAGES: readonly Lang[] = ["en", "ko", "zh", "ja", "es", "fr", "de"] as const;

const CATALOGS: Record<Lang, Partial<Record<MsgKey, string>>> = {
	en,
	ko,
	zh,
	ja,
	es,
	fr,
	de,
};

// Bulk settings/command translations, keyed by setting-path / command-name (not
// MsgKey). English is the source-of-truth in the schema, so there is no `en` map
// here — `td()` falls back to the caller-supplied English when a key is missing.
const SETTINGS_CATALOGS: Partial<Record<Lang, Record<string, string>>> = {
	ko: koSettings,
	zh: zhSettings,
	ja: jaSettings,
	es: esSettings,
	fr: frSettings,
	de: deSettings,
};

// Status/error/warning messages, keyed by the English message (or its static
// prefix). `tMessage()` matches a runtime string exactly, else by longest prefix
// (so interpolated tails — paths, ids, error text — pass through untranslated).
const MESSAGE_CATALOGS: Partial<Record<Lang, Record<string, string>>> = {
	ko: koMsgs,
	zh: zhMsgs,
	ja: jaMsgs,
	es: esMsgs,
	fr: frMsgs,
	de: deMsgs,
};
// Per-language prefix keys, sorted longest-first for greedy matching. Built lazily.
const messagePrefixCache: Partial<Record<Lang, string[]>> = {};
function messagePrefixes(lang: Lang): string[] {
	let keys = messagePrefixCache[lang];
	if (!keys) {
		keys = Object.keys(MESSAGE_CATALOGS[lang] ?? {}).sort((a, b) => b.length - a.length);
		messagePrefixCache[lang] = keys;
	}
	return keys;
}

let activeLang: Lang = "en";

/** Map a raw locale string (e.g. "ko_KR.UTF-8", "zh-Hans") to a supported Lang. */
function localeToLang(locale: string): Lang | undefined {
	const code = locale.toLowerCase().replace(/_/g, "-").split(/[-.]/)[0];
	if (code === "ko") return "ko";
	if (code === "zh") return "zh";
	if (code === "ja") return "ja";
	if (code === "en") return "en";
	if (code === "es") return "es";
	if (code === "fr") return "fr";
	if (code === "de") return "de";
	return undefined;
}

let macLocaleCache: string | null | undefined;
/** Read the real macOS UI locale (AppleLocale), which is more reliable than $LANG. */
function macOSLocale(): string | undefined {
	if (process.platform !== "darwin") return undefined;
	if (macLocaleCache !== undefined) return macLocaleCache ?? undefined;
	try {
		const out = Bun.spawnSync(["defaults", "read", "-g", "AppleLocale"]).stdout.toString().trim();
		macLocaleCache = out || null;
		return out || undefined;
	} catch {
		macLocaleCache = null;
		return undefined;
	}
}

/**
 * Detect the user's language, defaulting to English.
 *
 * macOS often exports a misleading `LANG=en_US` even for non-English users, so:
 *   1. an explicit non-English env locale wins (honors a deliberate override),
 *   2. otherwise the real macOS UI locale (AppleLocale) is consulted,
 *   3. otherwise the env locale (English) or Intl default is used.
 */
export function detectSystemLanguage(): Lang {
	const env = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || process.env.LANGUAGE || "";
	const fromEnv = env ? localeToLang(env.split(":")[0]) : undefined;
	if (fromEnv && fromEnv !== "en") return fromEnv;

	const mac = macOSLocale();
	const fromMac = mac ? localeToLang(mac) : undefined;
	if (fromMac) return fromMac;

	if (fromEnv) return fromEnv; // env was English
	try {
		const intl = Intl.DateTimeFormat().resolvedOptions().locale;
		const fromIntl = intl ? localeToLang(intl) : undefined;
		if (fromIntl) return fromIntl;
	} catch {
		// Intl may be unavailable in minimal runtimes; ignore.
	}
	return "en";
}

/** Resolve a stored preference ("auto" | Lang) to a concrete Lang. */
export function resolveLanguage(pref: LanguagePref): Lang {
	return pref === "auto" ? detectSystemLanguage() : pref;
}

/** Set the active UI language. Accepts "auto" to follow the system locale. */
export function setLanguage(pref: LanguagePref): void {
	activeLang = resolveLanguage(pref);
}

export function getLanguage(): Lang {
	return activeLang;
}

/**
 * Translate `key` for the active language. Falls back: active → English → key.
 * `params` interpolates `{name}` placeholders.
 */
export function t(key: MsgKey, params?: Record<string, string | number>): string {
	const raw = CATALOGS[activeLang]?.[key] ?? en[key] ?? key;
	if (!params) return raw;
	return raw.replace(/\{(\w+)\}/g, (_, name: string) => (name in params ? String(params[name]) : `{${name}}`));
}

/**
 * Translate a settings/command string by its path-derived `key`, falling back to
 * the supplied English `fallback` (the schema's source value). For English (or any
 * missing translation) the fallback is returned unchanged.
 */
export function td(key: string, fallback: string): string {
	return SETTINGS_CATALOGS[activeLang]?.[key] ?? fallback;
}

/**
 * Translate a runtime status/error/warning message. Tries an exact catalog match,
 * then the longest known static prefix (translating the prefix and keeping the
 * dynamic tail — a path, id, or error text — verbatim). Returns the original when
 * nothing matches or the active language is English.
 */
export function tMessage(message: string): string {
	const catalog = MESSAGE_CATALOGS[activeLang];
	if (!catalog) return message;
	const exact = catalog[message];
	if (exact !== undefined) return exact;
	for (const prefix of messagePrefixes(activeLang)) {
		if (message.length > prefix.length && message.startsWith(prefix)) {
			return catalog[prefix] + message.slice(prefix.length);
		}
	}
	return message;
}

export type { MsgKey };
