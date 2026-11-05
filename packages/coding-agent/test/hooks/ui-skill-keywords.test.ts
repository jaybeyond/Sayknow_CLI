import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BUNDLED_SKC_UI_SKILL_NAMES, getEmbeddedSkcUiSkills } from "@sayknow-cli/coding-agent/defaults/skc-ui-skills";
import { dispatchSkcNativeSkillHook } from "@sayknow-cli/coding-agent/hooks/native-skill-hook";
import {
	buildExternalUiSkillContext,
	buildUiSkillActivationContext,
	buildUiSkillDirectiveForSkill,
	detectExternalUiSkills,
	detectUiSkillKeywords,
} from "@sayknow-cli/coding-agent/hooks/ui-skill-keywords";

// The native hook seeds real workflow state for canonical keywords, so every
// dispatch runs against a throwaway cwd. Pointing it at the repository would
// activate a live ralplan state in the running session.
const hookRoots: string[] = [];

async function makeHookRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "skc-ui-skill-hook-"));
	hookRoots.push(root);
	return root;
}

async function dispatchIsolatedHook(prompt: string) {
	const cwd = await makeHookRoot();
	return dispatchSkcNativeSkillHook(
		{
			hook_event_name: "UserPromptSubmit",
			prompt,
			cwd,
			session_id: `ui-skill-hook-${path.basename(cwd)}`,
		},
		{
			cwd,
			home: await makeHookRoot(),
			stateDir: path.join(cwd, ".skc"),
		},
	);
}

function hookContext(result: Awaited<ReturnType<typeof dispatchSkcNativeSkillHook>>): string {
	const output = result.outputJson as { hookSpecificOutput?: { additionalContext?: string } } | null;
	return output?.hookSpecificOutput?.additionalContext ?? "";
}

afterAll(async () => {
	await Promise.all(hookRoots.map(root => fs.rm(root, { recursive: true, force: true })));
});

/** The specialized skill; index 0 is always the `stageshow` design center. */
function leadSkill(text: string): string | undefined {
	return detectUiSkillKeywords(text)[1]?.skill;
}

describe("automatic frontend UI skill routing", () => {
	it("routes specialized frontend intents to their skill", () => {
		expect(leadSkill("add a toast when the upload finishes")).toBe("ask-sonner");
		expect(leadSkill("which library should I use for drag and drop?")).toBe("pick-ui-library");
		expect(leadSkill("build three prototype versions of the pricing card")).toBe("prototype");
		expect(leadSkill("audit the animations in this app")).toBe("improve-animations");
		expect(leadSkill("review the animations in this diff")).toBe("review-animations");
		expect(leadSkill("animate the dropdown open")).toBe("animate");
		expect(leadSkill("the web app feels like a website on my phone")).toBe("mobile-native");
	});

	it("routes generic frontend work to the craft baseline", () => {
		expect(leadSkill("clean up the button component styling")).toBe("emil-design-eng");
		expect(detectUiSkillKeywords("clean up the button component styling").map(match => match.skill)).toEqual([
			"stageshow",
			"emil-design-eng",
		]);
	});

	it("leads every frontend match with the stageshow design center", () => {
		for (const prompt of [
			"add a toast when the upload finishes",
			"clean up the button component styling",
			"build the onboarding screen in Expo",
			"add a cursor trail",
			"the web app feels like a website on my phone",
			"랜딩 히어로에 들어갈 제품 데모 만들어줘",
			"버튼 컴포넌트 스타일링 정리해줘",
		]) {
			expect(detectUiSkillKeywords(prompt)[0]?.skill).toBe("stageshow");
		}
	});

	it("bundles the full Stageshow skill with its references inlined", () => {
		for (const prompt of [
			"a small looping hero demo for our homepage: someone assigns an issue",
			"make a dark bento grid of four tiles for Kanso",
			"build a mocked dashboard for the docs page",
		]) {
			expect(detectUiSkillKeywords(prompt).map(match => match.skill)).toEqual(["stageshow", "emil-design-eng"]);
		}
		const stageshow = getEmbeddedSkcUiSkills().find(skill => skill.name === "stageshow")?.content ?? "";
		expect(stageshow).toContain("## SKC: the design center — mandatory for all frontend work");
		expect(stageshow).toContain("**It reads as a real product, simplified to what the viewer needs");
		for (const reference of ["craft", "framing", "motion", "verify", "kit", "rehearse"]) {
			expect(stageshow).toContain(`## Appendix: ${reference}.md`);
		}
		expect(stageshow).toContain("npx -y skills@latest add benjitaylor/skills --skill stageshow -a universal -y");
		const base = getEmbeddedSkcUiSkills().find(skill => skill.name === "emil-design-eng")?.content ?? "";
		expect(base).toContain("## Stageshow is the design center — mandatory");
		expect(base).not.toContain("## Faux product UI (Stageshow)");
	});

	it("pairs a specialized match with the design center and the craft baseline", () => {
		const matches = detectUiSkillKeywords("animate the modal in our react component");
		expect(matches.map(match => match.skill)).toEqual(["stageshow", "animate", "emil-design-eng"]);
	});

	it("routes native app screen work to the app design skill", () => {
		expect(leadSkill("build the onboarding screen in Expo")).toBe("appllama-app-design-skill");
		expect(leadSkill("wire up the paywall flow")).toBe("appllama-app-design-skill");
		expect(leadSkill("polish this react native tab bar")).toBe("appllama-app-design-skill");
		expect(leadSkill("앱 화면 온보딩 만들어줘")).toBe("appllama-app-design-skill");
	});

	it("keeps the native app skill off the web baseline but under the design center", () => {
		const matches = detectUiSkillKeywords("build the expo paywall screen with animation");
		expect(matches.map(match => match.skill)).toEqual(["stageshow", "appllama-app-design-skill"]);
	});

	it("separates native app screens from web-app-on-a-phone work", () => {
		expect(leadSkill("our web app feels like a website on my phone")).toBe("mobile-native");
		expect(leadSkill("build the settings screen in react native")).toBe("appllama-app-design-skill");
	});

	it("routes animated React component work to the react-bits registry skill", () => {
		expect(leadSkill("add an animated gradient background to the hero")).toBe("react-bits");
		expect(leadSkill("I want a glitch text heading")).toBe("react-bits");
		expect(leadSkill("add a cursor trail")).toBe("react-bits");
		expect(leadSkill("텍스트 애니메이션 넣어줘")).toBe("react-bits");
	});

	it("bundles react-bits guidance without vendoring any component source", () => {
		const skill = getEmbeddedSkcUiSkills().find(entry => entry.name === "react-bits");
		expect(skill?.content).toContain("npx shadcn@latest add @react-bits/");
		expect(skill?.content).toContain("components.json");
		expect(skill?.content).toContain("MIT + Commons Clause");
		// Catalog is names only — never component implementations.
		expect(skill?.content).toContain("BlurText");
		expect(skill?.content).not.toContain("export default function");
		expect(skill?.content).not.toContain("useEffect(");
	});

	it("routes transition-shaped prompts to the user-installed transitions-dev skill", () => {
		expect(detectExternalUiSkills("add a skeleton loader")[0]?.skill).toBe("transitions-dev");
		expect(detectExternalUiSkills("shimmer text while it loads")[0]?.skill).toBe("transitions-dev");
		expect(detectExternalUiSkills("스켈레톤 로더 넣어줘")[0]?.skill).toBe("transitions-dev");
		expect(detectExternalUiSkills("fix the session import regex")).toEqual([]);
	});

	it("loads transitions-dev when the user installed it", async () => {
		const cwd = await makeHookRoot();
		const home = await makeHookRoot();
		await fs.mkdir(path.join(cwd, ".claude", "skills", "transitions-dev"), { recursive: true });
		await Bun.write(
			path.join(cwd, ".claude", "skills", "transitions-dev", "SKILL.md"),
			"---\nname: transitions-dev\n---\n",
		);

		const context = await buildExternalUiSkillContext({ cwd, home, text: "add a skeleton loader" });
		expect(context).toContain("Load the installed `transitions-dev`");
		expect(context).not.toContain("Install it yourself now");
	});

	it("installs the skill itself instead of asking the user", async () => {
		const context = await buildExternalUiSkillContext({
			cwd: await makeHookRoot(),
			home: await makeHookRoot(),
			text: "add a skeleton loader",
		});
		expect(context).toContain("Install it yourself now");
		expect(context).toContain("`bash` tool");
		expect(context).toContain("-a universal");
		expect(context).toContain("Do not ask the user to run it");
	});

	it("does not report a skill installed in a root SKC never loads", async () => {
		const cwd = await makeHookRoot();
		const home = await makeHookRoot();
		// SKC ignores user-home Claude/Codex directories by design.
		await fs.mkdir(path.join(home, ".claude", "skills", "transitions-dev"), { recursive: true });
		await Bun.write(path.join(home, ".claude", "skills", "transitions-dev", "SKILL.md"), "---\nname: x\n---\n");

		const context = await buildExternalUiSkillContext({ cwd, home, text: "add a skeleton loader" });
		expect(context).toContain("Install it yourself now");
	});

	it("resolves a skill installed where npx skills actually writes it", async () => {
		const cwd = await makeHookRoot();
		const home = await makeHookRoot();
		await fs.mkdir(path.join(cwd, ".agents", "skills", "transitions-dev"), { recursive: true });
		await Bun.write(path.join(cwd, ".agents", "skills", "transitions-dev", "SKILL.md"), "---\nname: x\n---\n");

		const context = await buildExternalUiSkillContext({ cwd, home, text: "add a skeleton loader" });
		expect(context).toContain("Load the installed `transitions-dev`");
		expect(context).not.toContain("Install it yourself now");
	});

	it("never vendors transitions.dev content into the bundle", () => {
		expect(BUNDLED_SKC_UI_SKILL_NAMES as readonly string[]).not.toContain("transitions-dev");
	});

	it("detects Korean frontend prompts", () => {
		expect(leadSkill("버튼 컴포넌트 스타일링 정리해줘")).toBe("emil-design-eng");
		expect(leadSkill("모달 애니메이션 추가해줘")).toBe("animate");
		expect(leadSkill("토스트 알림 붙여줘")).toBe("ask-sonner");
		expect(leadSkill("이 화면 모바일에서 네이티브 느낌 나게 해줘")).toBe("mobile-native");
	});

	it("stays silent for non-frontend prompts", () => {
		expect(detectUiSkillKeywords("fix the session import redaction regex")).toEqual([]);
		expect(detectUiSkillKeywords("why did CI fail on shard 16?")).toEqual([]);
		expect(buildUiSkillActivationContext("bump the package version")).toBeNull();
	});

	it("does not hijack SKC's own terminal UI work", () => {
		expect(detectUiSkillKeywords("fix the tmux TUI transcript rendering")).toEqual([]);
		// A terminal prompt that also names a web surface still routes.
		expect(leadSkill("the terminal dashboard and its web page both need layout work")).toBe("emil-design-eng");
	});

	it("builds a directive that names the skills and forbids install prompts", () => {
		const context = buildUiSkillActivationContext("animate the drawer");
		expect(context).toContain("load `stageshow` then `animate` then `emil-design-eng` with the `skill` tool");
		expect(context).toContain('matched "animate"');
		expect(context).toContain("real product UI included");
		expect(context).toContain("never tell the user to install them");
	});

	it("never lists the design center twice when the semantic stage picks it", () => {
		expect(buildUiSkillDirectiveForSkill("stageshow")).toContain(
			"load `stageshow` then `emil-design-eng` with the `skill` tool",
		);
		expect(buildUiSkillDirectiveForSkill("appllama-app-design-skill")).toContain(
			"load `stageshow` then `appllama-app-design-skill` with the `skill` tool",
		);
	});

	it("injects the directive through the native UserPromptSubmit hook", async () => {
		const result = await dispatchIsolatedHook("animate the dropdown open");
		const context = hookContext(result);
		expect(context).toContain("`animate`");
		expect(context).toContain("`stageshow`");
	});

	it("fires even when a workflow keyword already matched", async () => {
		const result = await dispatchIsolatedHook("consensus plan for the new dropdown animation");
		const context = hookContext(result);
		expect(context).toContain("ralplan");
		expect(context).toContain("`animate`");
	});

	it("stays out of the prompt when the work is not frontend", async () => {
		const result = await dispatchIsolatedHook("bump the package version");
		const context = hookContext(result);
		expect(context).not.toContain("emil-design-eng");
		expect(context).not.toContain("stageshow");
	});
});
