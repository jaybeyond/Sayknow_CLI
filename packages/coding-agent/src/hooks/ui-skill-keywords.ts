/**
 * Automatic frontend UI/UX skill routing.
 *
 * The bundled UI craft skills (see `defaults/skc-ui-skills.ts`) are compiled
 * into the binary, so the agent can invoke them without any user install. This
 * module decides WHEN: the native `UserPromptSubmit` hook matches the prompt
 * against the patterns below and injects a directive naming the skill to load.
 *
 * Unlike the canonical workflow skills, UI skills have no `skc state` mode
 * state. Detection here never seeds workflow state; it only advertises the
 * skill for the current turn.
 *
 * Patterns cover English and Korean because prompts arrive in both.
 */

import * as path from "node:path";
import type { BundledSkcUiSkillName } from "../defaults/skc-ui-skills";

export interface UiSkillKeywordDefinition {
	skill: BundledSkcUiSkillName;
	/** Higher wins when several patterns match the same prompt. */
	priority: number;
	pattern: RegExp;
}

/** Base craft skill paired with any specialized web frontend match. */
export const UI_SKILL_BASE: BundledSkcUiSkillName = "emil-design-eng";

/**
 * Skills that already carry their own complete craft bar, so pairing them with
 * the web baseline only adds noise. `appllama-app-design-skill` targets native
 * Expo/React Native screens and ships its own motion and fidelity rules.
 */
const SELF_SUFFICIENT_UI_SKILLS = new Set<BundledSkcUiSkillName>(["appllama-app-design-skill"]);

/**
 * Ordered specialized detectors. The first (highest priority) match selects the
 * lead skill; `emil-design-eng` is added as the craft baseline for build and
 * review work.
 */
export const UI_SKILL_KEYWORD_DEFINITIONS: readonly UiSkillKeywordDefinition[] = [
	{
		// Animated React components the React Bits registry already solves.
		// Requires React; the skill itself gates on stack and on the frequency
		// rule before anything is installed.
		skill: "react-bits",
		priority: 110,
		pattern:
			/\b(animated|glitch|shiny|blur|scramble|decrypt|particle|aurora|marquee|dither)\b[^.?!]{0,40}\b(text|background|heading|hero|title)\b|\b(text animation|animated background|cursor (effect|trail)|hover (effect|glow)|scroll (reveal|float|velocity))\b|\breact ?bits\b|애니메이션\s*(텍스트|배경)|텍스트\s*애니메이션|배경\s*애니메이션|커서\s*효과|리액트\s*비츠/i,
	},
	{
		// Native app screens (Expo / React Native), not a web page on a phone.
		// Highest priority: naming the native stack, or an app-screen surface
		// like a paywall or tab bar, is an unambiguous signal.
		skill: "appllama-app-design-skill",
		priority: 100,
		pattern:
			/\b(expo|react[\s-]?native|reanimated|expo[\s-]?router|flashlist)\b|\b(app|mobile)\s+(screen|onboarding|paywall)\b|\b(paywall|tab bar|bottom sheet|app store)\b|\b(build|design|polish)\b[^.?!]{0,40}\b(mobile|ios|android)\s+(app|screen)\b|리액트\s*네이티브|익스포|네이티브\s*앱|앱\s*화면|온보딩|페이월|탭\s*바/i,
	},
	{
		skill: "ask-sonner",
		priority: 95,
		pattern: /\bsonner\b|\btoast(s|er)?\b|토스트/i,
	},
	{
		skill: "pick-ui-library",
		priority: 90,
		pattern:
			/\b(which|what|pick|choose|recommend)\b[^.?!]{0,60}\b(library|package|component|dependency)\b|\b(ui|component)\s+librar(y|ies)\b|라이브러리\s*(추천|선택|골라)|어떤\s*라이브러리/i,
	},
	{
		skill: "prototype",
		priority: 85,
		pattern:
			/\b(prototype|variants?|several versions|different versions|mockups?)\b|프로토타입|시안|여러\s*(버전|안)/i,
	},
	{
		skill: "improve-animations",
		priority: 80,
		pattern: /\b(audit|improve|fix)\b[^.?!]{0,40}\b(animations?|motion)\b|애니메이션\s*(개선|감사|정리)|모션\s*개선/i,
	},
	{
		skill: "review-animations",
		priority: 78,
		pattern:
			/\breview\b[^.?!]{0,40}\b(animations?|motion|transitions?)\b|애니메이션\s*(리뷰|검토)|모션\s*(리뷰|검토)/i,
	},
	{
		skill: "find-animation-opportunities",
		priority: 76,
		pattern: /\bwhat\b[^.?!]{0,40}\b(could|should)\b[^.?!]{0,20}\banimat/i,
	},
	{
		skill: "animation-vocabulary",
		priority: 74,
		pattern:
			/\bwhat'?s? it called\b|\bwhat is it called\b|\bname of (that|the) (effect|animation)\b|뭐라고\s*부르|이름이\s*뭐/i,
	},
	{
		skill: "mobile-native",
		priority: 70,
		pattern:
			/\b(mobile|phone|ios|android|touch|pwa|safe area|100vh|viewport)\b[^.?!]{0,60}\b(web|app|site|feel|native|layout|scroll|tap)\b|\bfeels? like a website\b|모바일\s*(웹|앱)|네이티브\s*(느낌|처럼)/i,
	},
	{
		skill: "apple-design",
		priority: 68,
		pattern:
			/\bapple\b[^.?!]{0,40}\b(design|motion|style|feel|hig)\b|\b(spring|gesture|drag|swipe|sheet)\b[^.?!]{0,40}\b(animation|motion|physics)\b|애플\s*(디자인|스타일|느낌)/i,
	},
	{
		skill: "animate",
		priority: 65,
		pattern:
			/\b(animate|animation|motion|transition|easing|keyframes?|hover effect|micro-?interaction)\b|애니메이션|모션|트랜지션|이징/i,
	},
	{
		skill: UI_SKILL_BASE,
		priority: 40,
		pattern:
			/\b(ui|ux|frontend|front-end|interface|design system|component|css|tailwind|styling|layout|responsive|modal|dropdown|tooltip|popover|drawer|button|spacing|typography)\b|프론트\s*엔드|프론트엔드|디자인\s*(시스템)?|컴포넌트|버튼|모달|드롭다운|툴팁|레이아웃|반응형|스타일링/i,
	},
];

export interface UiSkillKeywordMatch {
	skill: BundledSkcUiSkillName;
	keyword: string;
	priority: number;
}

/** Prompts that are purely about SKC's own terminal UI are not web frontend work. */
const TERMINAL_ONLY_PATTERN = /\b(tui|terminal|ansi|tmux|curses)\b/i;
const WEB_SURFACE_PATTERN =
	/\b(web|browser|css|html|react|vue|svelte|next\.?js|tailwind|dom|mobile|ios|android|page|screen)\b|웹|브라우저|화면|페이지/i;

/**
 * Detect frontend UI/UX intent. Returns matches ordered by priority, most
 * specific first, with `emil-design-eng` appended as the craft baseline.
 */
export function detectUiSkillKeywords(text: string): UiSkillKeywordMatch[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	// A prompt about SKC's own TUI with no web surface mentioned is handled by
	// docs/ui-design-visual-qa.md, not the web craft skills.
	if (TERMINAL_ONLY_PATTERN.test(trimmed) && !WEB_SURFACE_PATTERN.test(trimmed)) return [];

	const matches: UiSkillKeywordMatch[] = [];
	for (const definition of UI_SKILL_KEYWORD_DEFINITIONS) {
		const match = trimmed.match(definition.pattern);
		if (!match) continue;
		matches.push({ skill: definition.skill, keyword: match[0], priority: definition.priority });
	}
	if (matches.length === 0) return [];

	matches.sort((a, b) => b.priority - a.priority || a.skill.localeCompare(b.skill));
	const deduped: UiSkillKeywordMatch[] = [];
	for (const item of matches) {
		if (deduped.some(existing => existing.skill === item.skill)) continue;
		deduped.push(item);
	}
	// Keep the lead skill plus the craft baseline; more than that is noise.
	const lead = deduped[0]!;
	return pairWithBaseline(lead.skill);
}

/**
 * A specialized skill plus the craft baseline, which is the pairing the skills
 * themselves assume. Skills that carry their own complete craft bar stand alone.
 */
function pairWithBaseline(skill: BundledSkcUiSkillName): UiSkillKeywordMatch[] {
	const definition = UI_SKILL_KEYWORD_DEFINITIONS.find(item => item.skill === skill);
	const lead: UiSkillKeywordMatch = { skill, keyword: skill, priority: definition?.priority ?? 0 };
	if (skill === UI_SKILL_BASE || SELF_SUFFICIENT_UI_SKILLS.has(skill)) return [lead];
	const base = UI_SKILL_KEYWORD_DEFINITIONS.find(item => item.skill === UI_SKILL_BASE);
	return [lead, { skill: UI_SKILL_BASE, keyword: UI_SKILL_BASE, priority: base?.priority ?? 0 }];
}

function renderUiSkillDirective(skills: readonly BundledSkcUiSkillName[], evidence: string): string {
	const names = skills.map(skill => `\`${skill}\``).join(" then ");
	return [
		`SKC detected frontend UI/UX work in this prompt (${evidence}).`,
		`Before writing or reviewing that surface, load ${names} with the \`skill\` tool.`,
		"These skills are bundled with SKC: never tell the user to install them, and never skip them because the task looks small.",
		"They are not workflow skills and have no `skc state` mode state.",
	].join(" ");
}

/**
 * Build the `UserPromptSubmit` directive that makes the agent load the matching
 * bundled UI skill for this turn. Returns null when the prompt is not frontend
 * UI/UX work.
 */
export function buildUiSkillActivationContext(text: string): string | null {
	const matches = detectUiSkillKeywords(text);
	if (matches.length === 0) return null;
	return renderUiSkillDirective(
		matches.map(match => match.skill),
		`matched "${matches[0]!.keyword}"`,
	);
}

/**
 * Same directive, for a skill chosen by the semantic stage rather than by a
 * pattern. The regex table caught 5 of 8 real frontend prompts; this is the path
 * for the other three, and it names its source so a wrong pick is traceable to
 * the model rather than to a pattern nobody can find.
 */
export function buildUiSkillDirectiveForSkill(skill: BundledSkcUiSkillName): string {
	return renderUiSkillDirective(
		pairWithBaseline(skill).map(match => match.skill),
		"semantic match",
	);
}

/**
 * What each bundled skill is *for*, in the words a user would recognise.
 *
 * This is the whole contract with the routing model — the skill ids alone carry
 * almost no signal, and `appllama-app-design-skill` carries actively misleading
 * signal. Kept next to the patterns so the two cannot drift apart.
 */
export const BUNDLED_UI_SKILL_MEANINGS: Record<BundledSkcUiSkillName, string> = {
	"emil-design-eng":
		"General web UI/UX craft: building or reviewing components, layout, spacing, typography, design systems, CSS. The default for frontend work with no more specific fit.",
	animate:
		"Adding new motion to a web UI: animations, transitions, easing, keyframes, hover effects, micro-interactions.",
	"review-animations": "Reviewing motion that already exists and judging whether it is good.",
	"improve-animations": "Auditing and fixing motion that already exists and is known to be wrong or cheap-looking.",
	"find-animation-opportunities":
		"Asking where motion could be added to a surface that currently has none, without naming a specific effect.",
	"pick-ui-library": "Choosing between UI libraries, component kits, or frontend packages.",
	prototype: "Exploring several visual variants or mockups of the same screen before committing to one.",
	"mobile-native":
		"Making a web page on a phone feel native: touch targets, safe areas, viewport and scroll behaviour, gestures.",
	"animation-vocabulary": "Naming a motion effect the user described but could not name.",
	"apple-design": "Apple-style motion, materials, and Human Interface Guidelines feel.",
	"ask-sonner": "Toast notifications, specifically the Sonner library.",
	"appllama-app-design-skill": "Native app screens built with Expo or React Native — not a website viewed on a phone.",
	"react-bits": "Pre-built animated React components: animated text, animated backgrounds, cursor and scroll effects.",
};

/**
 * Frontend skills SKC routes to but deliberately does NOT vendor.
 *
 * `transitions.dev` publishes an agent skill, but its terms license only the
 * CLI and Refine tooling under MIT; the transition collection itself carries a
 * separate clause that forbids repackaging or publishing the collection (or a
 * substantial part of it). Compiling it into the SKC binary and shipping that
 * to every user is exactly the prohibited redistribution, while installing it
 * into your own project is explicitly allowed. So SKC routes to a user-owned
 * install and never carries the content.
 */
export interface ExternalUiSkillDefinition {
	skill: string;
	priority: number;
	pattern: RegExp;
	/**
	 * Upstream's own non-interactive install. `-a universal` lands the skill in
	 * `<project>/.agents/skills/`, which SKC's agents provider loads. It is the
	 * agent that runs this through its normal bash tool, so the install stays a
	 * visible, permissioned tool call — never a silent fetch inside the hook.
	 */
	installCommand: string;
	source: string;
}

export const EXTERNAL_UI_SKILL_DEFINITIONS: readonly ExternalUiSkillDefinition[] = [
	{
		skill: "transitions-dev",
		priority: 120,
		pattern:
			/\b(transition|skeleton (loader|reveal)|shimmer|sliding tabs|streaming text|spinning counter|stagger(ed)? (text )?reveal|pop-?in|icon swap|badge (slide|pop))\b|트랜지션|스켈레톤|시머|스트리밍\s*텍스트|스태거/i,
		installCommand: "npx -y skills@latest add Jakubantalik/transitions.dev --skill transitions-dev -a universal -y",
		source: "https://github.com/Jakubantalik/transitions.dev",
	},
];

/**
 * Skill roots SKC actually loads.
 *
 * Project roots are read by the runtime/claude/codex/agents providers. User
 * roots are deliberately narrower: `~/.claude` and `~/.codex` are ignored by
 * design, so treating them as "installed" would report a skill SKC can never
 * load. Only SKC's own user roots and `~/.agent[s]` qualify.
 */
const PROJECT_SKILL_ROOTS = [
	[".skc", "skills"],
	[".claude", "skills"],
	[".codex", "skills"],
	[".agents", "skills"],
	[".agent", "skills"],
] as const;

const USER_SKILL_ROOTS = [
	[".skc", "agent", "skills"],
	[".skc", "skills"],
	[".agents", "skills"],
	[".agent", "skills"],
] as const;

function skillCandidatePaths(cwd: string, home: string, skill: string): string[] {
	const roots: string[] = [];
	// Providers walk up from cwd toward the repo root; mirror a bounded walk.
	let current = path.resolve(cwd);
	const resolvedHome = path.resolve(home);
	for (let depth = 0; depth < 12; depth++) {
		if (current !== resolvedHome) {
			for (const segments of PROJECT_SKILL_ROOTS) {
				roots.push(path.join(current, ...segments, skill, "SKILL.md"));
			}
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	for (const segments of USER_SKILL_ROOTS) {
		roots.push(path.join(resolvedHome, ...segments, skill, "SKILL.md"));
	}
	return roots;
}

async function isSkillInstalled(cwd: string, home: string, skill: string): Promise<boolean> {
	for (const candidate of skillCandidatePaths(cwd, home, skill)) {
		try {
			if (await Bun.file(candidate).exists()) return true;
		} catch {
			// Permission or I/O on a candidate must not fail the prompt hook.
		}
	}
	return false;
}

export function detectExternalUiSkills(text: string): ExternalUiSkillDefinition[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	if (TERMINAL_ONLY_PATTERN.test(trimmed) && !WEB_SURFACE_PATTERN.test(trimmed)) return [];
	return EXTERNAL_UI_SKILL_DEFINITIONS.filter(definition => definition.pattern.test(trimmed)).sort(
		(a, b) => b.priority - a.priority,
	);
}

/**
 * Directive for frontend skills SKC routes to but does not vendor.
 *
 * Installed: load it. Missing: the agent runs upstream's own non-interactive
 * install itself, so the user never types the command. The install runs through
 * the agent's bash tool — visible and permissioned — rather than as a silent
 * network fetch inside this hook.
 */
export async function buildExternalUiSkillContext(input: {
	cwd: string;
	home: string;
	text: string;
}): Promise<string | null> {
	const matches = detectExternalUiSkills(input.text);
	if (matches.length === 0) return null;
	const parts: string[] = [];
	for (const match of matches) {
		if (await isSkillInstalled(input.cwd, input.home, match.skill)) {
			parts.push(
				`Load the installed \`${match.skill}\` skill with the \`skill\` tool before implementing this transition, and prefer its snippets over hand-rolled CSS.`,
			);
			continue;
		}
		parts.push(
			`\`${match.skill}\` (${match.source}) covers this transition and is not installed yet.`,
			`Install it yourself now — run \`${match.installCommand}\` with the \`bash\` tool, then load \`${match.skill}\` with the \`skill\` tool and use its snippets.`,
			"Do not ask the user to run it. SKC routes to this install instead of bundling the skill because its license permits using the transitions but forbids redistributing the collection.",
			"If the install fails (offline, blocked registry), say so once and fall back to the bundled UI skills.",
		);
	}
	return parts.length > 0 ? parts.join(" ") : null;
}
