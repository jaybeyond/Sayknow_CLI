import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	dispatchSkcNativeSkillHook,
	type SkcNativeHookDispatchResult,
} from "@sayknow-cli/coding-agent/hooks/native-skill-hook";
import {
	buildSecuritySkillActivationContext,
	detectSecurityReviewKeyword,
} from "@sayknow-cli/coding-agent/hooks/security-skill-keywords";
import { detectUiSkillKeywords } from "@sayknow-cli/coding-agent/hooks/ui-skill-keywords";

// The native hook seeds real workflow state for canonical keywords, so every
// dispatch runs against a throwaway cwd, never the repository.
const hookRoots: string[] = [];

async function makeHookRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "skc-security-skill-hook-"));
	hookRoots.push(root);
	return root;
}

async function dispatchIsolatedHook(prompt: string): Promise<SkcNativeHookDispatchResult> {
	const cwd = await makeHookRoot();
	return dispatchSkcNativeSkillHook(
		{
			hook_event_name: "UserPromptSubmit",
			prompt,
			cwd,
			session_id: `security-skill-hook-${path.basename(cwd)}`,
		},
		{ cwd, home: await makeHookRoot(), stateDir: path.join(cwd, ".skc") },
	);
}

function hookContext(result: SkcNativeHookDispatchResult): string {
	const output = result.outputJson as { hookSpecificOutput?: { additionalContext?: string } } | null;
	return output?.hookSpecificOutput?.additionalContext ?? "";
}

afterAll(async () => {
	await Promise.all(hookRoots.map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("automatic security review skill routing", () => {
	it("matches review intent and vulnerabilities in English", () => {
		for (const prompt of [
			"do a security review of this repo",
			"run a security-audit on the payments service",
			"audit this PR for security problems",
			"review the upload handler for security",
			"are there any vulnerabilities in the auth module?",
			"fix the security issue in the session cookie code",
			"check this against the OWASP top 10",
			"pentest the API",
			"add strix to our checks",
		]) {
			expect(detectSecurityReviewKeyword(prompt)).not.toBeNull();
		}
	});

	it("matches the Korean phrasings", () => {
		for (const prompt of [
			"자체 보안검사 돌려줘",
			"이 PR 보안 점검 해줘",
			"보안 리뷰 부탁해",
			"취약점 있는지 확인해줘",
			"모의해킹 관점으로 봐줘",
			"스트릭스로 보안테스트 해줘",
			"우리 프로젝트에 strix 실행해줘",
			"스트릭스 돌려줘",
			"보안 체크 해줘",
		]) {
			expect(detectSecurityReviewKeyword(prompt)).not.toBeNull();
		}
	});

	it("matches the other languages SKC ships a UI for", () => {
		for (const prompt of [
			// ja
			"このリポジトリのセキュリティレビューをお願いします",
			"セキュリティをチェックして",
			"認証まわりに脆弱性がないか見て",
			// zh
			"对这个仓库做一次安全审计",
			"帮我做安全检查",
			"看看登录模块有没有漏洞",
			"幫我做安全性檢查",
			// es
			"haz una revisión de seguridad de este repositorio",
			"busca vulnerabilidades en el módulo de autenticación",
			// fr
			"fais un audit de sécurité de ce dépôt",
			"cherche des vulnérabilités dans le module d'authentification",
			// de
			"mach eine Sicherheitsüberprüfung dieses Repos",
			"gibt es Sicherheitslücken im Login?",
			"suche nach Schwachstellen im Auth-Modul",
		]) {
			expect(detectSecurityReviewKeyword(prompt)).not.toBeNull();
		}
	});

	it("leaves ordinary work alone in those languages too", () => {
		for (const prompt of [
			"セキュリティグループの設定を変更して",
			"修改安全组的入站规则",
			"给这个函数加上类型安全检查",
			"修复线程安全测试",
			"actualiza el grupo de seguridad",
			"crea una copia de seguridad de la base de datos",
			"mets à jour le groupe de sécurité",
			"ändere die Sicherheitsgruppe",
			"erstelle eine Sicherheitskopie der Datenbank",
		]) {
			expect(detectSecurityReviewKeyword(prompt)).toBeNull();
		}
	});

	it("leaves ordinary work that only mentions security alone", () => {
		for (const prompt of [
			"update the security group ingress rule",
			"set the Secure flag on the cookie",
			"add a login endpoint",
			"bump the package version",
			"보안 그룹 설정 바꿔줘",
			"소켓 보안 옵션 추가해줘",
			"보안 관련 테스트 파일 이름 바꿔줘",
			"polish the dashboard layout",
		]) {
			expect(detectSecurityReviewKeyword(prompt)).toBeNull();
			expect(buildSecuritySkillActivationContext(prompt)).toBeNull();
		}
	});

	it("names the skill and carries its scope rules in the directive", () => {
		const directive = buildSecuritySkillActivationContext("security review of the checkout service");
		expect(directive).toContain('matched "security review"');
		expect(directive).toContain("`security-review`");
		expect(directive).toContain("stay read-only unless a fix was requested");
		expect(directive).toContain("never send test input to a system you were not told to test");
		expect(directive).toContain("never tell the user to install it");
	});

	it("does not pull the frontend design skills onto a security review", () => {
		expect(detectUiSkillKeywords("security review of the auth module")).toEqual([]);
	});

	it("reaches the prompt through the native hook", async () => {
		const context = hookContext(await dispatchIsolatedHook("보안 검사 해줘"));
		expect(context).toContain("`security-review`");
		expect(context).not.toContain("stageshow");
	});

	it("reaches the prompt through the native hook in a third language", async () => {
		const context = hookContext(await dispatchIsolatedHook("このリポジトリの脆弱性を調べて"));
		expect(context).toContain("`security-review`");
	});

	it("rides alongside a frontend match instead of replacing it", async () => {
		const context = hookContext(await dispatchIsolatedHook("security audit of the login form component"));
		expect(context).toContain("`security-review`");
		expect(context).toContain("`stageshow`");
	});

	it("stays out of the prompt when the work is not a security review", async () => {
		const context = hookContext(await dispatchIsolatedHook("bump the package version"));
		expect(context).not.toContain("security-review");
	});
});
