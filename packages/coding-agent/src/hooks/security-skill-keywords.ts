/**
 * Automatic routing for the bundled security review skill (see
 * `defaults/skc-security-skills.ts`).
 *
 * Same shape as the UI skill routing in `ui-skill-keywords.ts`: a matching
 * prompt gets a directive naming the skill to load for this turn, and no
 * workflow state is seeded. The pattern is deliberately narrow. A miss costs
 * nothing, because the system prompt still names the skill, while a wrong match
 * loads a 40 KB review method onto unrelated work.
 *
 * Patterns cover every language SKC ships a UI for; other languages still reach
 * the skill through the system prompt's routing rule.
 */

import type { BundledSkcSecuritySkillName } from "../defaults/skc-security-skills";

const SECURITY_REVIEW_SKILL = "security-review" satisfies BundledSkcSecuritySkillName;

/**
 * Review intent or a vulnerability, never the bare word "security": "update the
 * security group" and "secure cookie flag" are ordinary implementation work.
 *
 * One entry per language in `SUPPORTED_LANGUAGES` (`i18n/index.ts`). `\b` is
 * ASCII-only in JS, so no entry puts it next to an accented or CJK character.
 */
const SECURITY_REVIEW_PATTERNS: readonly RegExp[] = [
	// en
	/\bsecurity[- ](review|audit|scan|check|assessment|analysis|test(ing)?)\b|\b(review|audit|scan|analy[sz]e|assess)\b[^.?!]{0,40}\bsecurity\b|\bsecurity (issue|hole|flaw|bug|risk|problem)s?\b/,
	// "vulnerability" in en, fr, it, es and pt, plus tool and standard names that are the same everywhere.
	/\bvuln[eé]rabilit(y|ies|[eé]s?|à)|\bvulnerabilidad(es?)?|\b(owasp|sast|pen[- ]?test(ing|s)?|penetration[- ]test(ing|s)?|strix)\b/,
	// ko
	/보안\s*(검사|점검|리뷰|검토|감사|진단|스캔|분석|테스트|체크|이슈|문제|결함|구멍|허점)|취약점|모의\s*해킹|침투\s*테스트|스트릭스/,
	// ja
	/セキュリティ(の|を|上の)?\s*(レビュー|監査|診断|チェック|テスト|スキャン|検査|点検|分析|評価|問題|ホール)|脆弱性|ペネトレーション\s*テスト|ペンテスト|侵入テスト/,
	// zh, simplified and traditional. 类型安全 and 线程安全 are type and thread safety, not security.
	/(?<!类型|類型|线程|線程|執行緒)安全性?\s*(审查|审计|审核|检查|检测|测试|扫描|评估|分析|隐患|審查|審計|審核|檢查|檢測|測試|掃描|評估|隱患)|漏洞|渗透测试|滲透測試/,
	// es ("copia de seguridad" is a backup, so the noun before "de seguridad" is required)
	/\b(revisi[oó]n|auditor[ií]a|an[aá]lisis|escaneo|pruebas?|evaluaci[oó]n|fallos?|problemas?|brechas?|agujeros?)\s+de\s+seguridad\b|\bpruebas?\s+de\s+penetraci[oó]n/,
	// fr
	/\b(revue|audit|analyse|scan|tests?|v[eé]rification|examen|failles?|probl[eè]mes?)\s+de\s+s[eé]curit[eé]|\btests?\s+d['’]intrusion/,
	// de
	/\bsicherheits[- ]?(([uü]|ue)berpr[uü]fung|pr[uü]fung|audit|analyse|tests?|check|scan|review|l[uü]cken?|probleme?|bewertung)|\bschwachstelle|\bpenetrationstest/,
];

const SECURITY_REVIEW_PATTERN = new RegExp(SECURITY_REVIEW_PATTERNS.map(pattern => pattern.source).join("|"), "i");

/** The matched phrase, or null when the prompt is not security review work. */
export function detectSecurityReviewKeyword(text: string): string | null {
	return text.match(SECURITY_REVIEW_PATTERN)?.[0] ?? null;
}

/**
 * Build the `UserPromptSubmit` directive that makes the agent load the bundled
 * security review skill for this turn. Returns null when the prompt is not
 * security review work.
 */
export function buildSecuritySkillActivationContext(text: string): string | null {
	const keyword = detectSecurityReviewKeyword(text);
	if (!keyword) return null;
	return [
		`SKC detected security review work in this prompt (matched "${keyword}").`,
		`Before reviewing or fixing, load \`${SECURITY_REVIEW_SKILL}\` with the \`skill\` tool and follow its scope rules: review only code the user owns or is authorized to assess, stay read-only unless a fix was requested, and never send test input to a system you were not told to test.`,
		"The skill is bundled with SKC: never tell the user to install it.",
		"It is not a workflow skill and has no `skc state` mode state.",
	].join(" ");
}
