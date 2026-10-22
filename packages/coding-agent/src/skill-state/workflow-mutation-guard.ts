import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@sayknow-cli/agent-core";
import { logger } from "@sayknow-cli/utils";
import { canonicalEnvKey, type ProjectEnvSnapshot, projectEnvSnapshot } from "@sayknow-cli/utils/env-file";
import { expandApplyPatchToEntries } from "../edit/modes/apply-patch";
import { LocalProtocolHandler, resolveLocalUrlToPath } from "../internal-urls/local-protocol";
import {
	SKC_SESSION_PREFIX,
	sessionDirName,
	modeStatePath as sessionModeStatePath,
} from "../skc-runtime/session-layout";
import { resolveSkcSessionForRead } from "../skc-runtime/session-resolution";
import { ModeStateSchema } from "../skc-runtime/state-schema";
import { workflowEnvelopeChecksumStatus } from "../skc-runtime/state-writer";
import { getSkillManifest } from "../skc-runtime/workflow-manifest";
import { isGithubReadOnlyArgs } from "../tools/github-side-effect";
import { resolveToCwd } from "../tools/path-utils";
import { ToolError } from "../tools/tool-errors";
import { listActiveSkills, readVisibleSkillActiveState, type SkillActiveEntry } from "./active-state";
import {
	type CanonicalSkcWorkflowSkill,
	sanctionedWorkflowStateCommand,
	workflowModeStateFileName,
} from "./workflow-state-contract";

export const DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE =
	"Deep-interview phase boundary: continue gathering context/questions/risks and emit a handoff/spec before code edits. Mutation tools and patch execution are blocked while deep-interview is active; finalize specs through `skc deep-interview --write --stage final` or hand off to an execution phase.";
export const WORKFLOW_STATE_MUTATION_BLOCK_MESSAGE =
	".skc workflow state and artifacts are runtime-owned. Agent mutation tools cannot edit `.skc/**`; use the sanctioned `skc` CLI instead.";
export const RALPLAN_MUTATION_BLOCK_MESSAGE =
	"Ralplan planning phase boundary: keep refining the consensus plan and persist plan artifacts through `skc ralplan --write` (stage scratch files under a temp dir if needed). Product-code mutation tools and patch execution are blocked while ralplan is active; mutate only after the plan is approved and execution begins.";
export const ULTRAGOAL_GOAL_PLANNING_MUTATION_BLOCK_MESSAGE =
	"Ultragoal goal-planning phase boundary: finish goal planning and record goals through `skc ultragoal` before editing code. Product-code mutation tools and patch execution are blocked until goal planning completes and execution begins.";

/** Resolve the phase-boundary block message for the active planning skill. */
function planningPhaseBlockMessage(skill: CanonicalSkcWorkflowSkill): string {
	if (skill === "ralplan") return RALPLAN_MUTATION_BLOCK_MESSAGE;
	if (skill === "ultragoal") return ULTRAGOAL_GOAL_PLANNING_MUTATION_BLOCK_MESSAGE;
	return DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE;
}

/**
 * Tools whose execute path can mutate product state. `github` is included so
 * side-effect ops share this guard. `eval` and `python` run code that can write
 * files without going through edit, write, or bash.
 */
export const WORKFLOW_MUTATION_TOOL_NAMES = ["edit", "write", "ast_edit", "bash", "github", "eval", "python"] as const;

const BLOCKED_TOOL_NAMES = new Set<string>(WORKFLOW_MUTATION_TOOL_NAMES);

export function isWorkflowMutationTool(name: string): boolean {
	return BLOCKED_TOOL_NAMES.has(name);
}
/**
 * Only `/dev/null` is exempt. `/dev/stdout`, `/dev/stderr`, and `/dev/fd/<n>` are descriptor
 * aliases: `exec 1<>src/product.ts; printf x >/dev/stdout` reaches a real repository file
 * through a rebound descriptor, so they must stay blocked.
 */
const DEVICE_SINK_PATHS = new Set(["/dev/null"]);
/** Bash write forms the plain `>`/`>>` scanner misses: clobber, dup-to-path, and read-write open. */
const BASH_EXTENDED_WRITE_RE = /(?:>\||<>|>&(?![\s;&|]*(?:\d+|-)(?:[\s;&|]|$)))\s*([^\s;&|]+)/g;
/** Descriptor rebinding is not statically resolvable; any `exec` redirection forces a fail-closed verdict. */
const BASH_EXEC_REDIRECT_RE = /(?:^|[;&|\n])\s*(?:sudo\s+)?exec\b[^;&|\n]*[<>]/i;

const ARCHIVE_OR_SQLITE_BASE_RE = /^(.+?\.(?:tar\.gz|sqlite3|sqlite|db3|zip|tgz|tar|db))(?:$|:)/i;
const INTERNAL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const VIM_FILE_SWITCH_RE = /^\s*:(?:e|e!|edit|edit!)(?:\s+([^<\r\n]+))?(?:<CR>|\r|\n|$)/i;
const BASH_MUTATION_COMMAND_RE =
	/(?:^|[;&|\n])\s*(?:\w+=[^\s]+\s+)*(?:sudo\s+)?(?:[^\s;&|]*\/)?(?:tee|touch|rm|mkdir|cp|mv|install|truncate)\b([^;&|\n]*)|(?:^|[^<>])(?:>>?|\d>>?)\s*([^\s;&|]+)/gi;
const BASH_IN_PLACE_MUTATION_COMMAND_RE = /(?:^|[;&|\n])\s*(?:\w+=[^\s]+\s+)*(?:sudo\s+)?(?:sed|perl)\b([^;&|\n]*)/gi;
const BASH_OPAQUE_INTERPRETER_WRITE_RE =
	/(?:^|[;&|\n])\s*(?:\w+=[^\s]+\s+)*(?:sudo\s+)?(?:python3?|node|ruby)\b[^;&|\n]*(?:-c|-e)\b[^;&|\n]*(?:open\s*\(|writeFile(?:Sync)?\s*\(|\.write\s*\()/i;
const BASH_HEREDOC_OPAQUE_INTERPRETER_WRITE_RE =
	/(?:^|[;&|\n])\s*(?:\w+=[^\s]+\s+)*(?:sudo\s+)?(?:python3?|node|ruby)\b[^;&|\n]*(?:<<[-]?\s*['"]?\w+['"]?)[\s\S]*(?:open\s*\(|writeFile(?:Sync)?\s*\(|\.write\s*\()/i;
const BASH_DD_OUTPUT_RE = /(?:^|[;&|\n])\s*(?:\w+=[^\s]+\s+)*(?:sudo\s+)?(?:[^\s;&|]*\/)?dd\b([^;&|\n]*)/gi;
/** Literal `sh|bash|zsh -c '<script>'` payloads whose nested script must also be scanned. */
const BASH_NESTED_SHELL_RE =
	/(?:^|[;&|\n])\s*(?:\w+=[^\s]+\s+)*(?:sudo\s+)?(?:[^\s;&|]*\/)?(?:ba|z|da)?sh\s+(?:-[A-Za-z]+\s+)*-[A-Za-z]*c\s+(?:(')([^']*)'|(")([^"]*)")/g;

type ToolWithEditMode = AgentTool & {
	mode?: unknown;
	customWireName?: unknown;
};

export interface WorkflowMutationGuardInput {
	cwd: string;
	sessionId?: string;
	threadId?: string;
	tool: ToolWithEditMode;
	args: unknown;
	forceOverride?: boolean;
	enforceWorkflowState?: boolean;
	guardContext?: WorkflowGuardContext;
}

interface ExtractedTargets {
	paths: string[];
	unknown: boolean;
	/**
	 * Set when a bash command was recognized as performing a filesystem write.
	 * During a planning phase an unrecognized bash command is allowed (reading
	 * and inspection must not be blocked); only a recognized mutation blocks.
	 */
	explicitMutation?: boolean;
}

export interface WorkflowMutationDecision {
	blocked: boolean;
	message?: string;
	targets: string[];
	reason?: string;
	command?: string;
}

export interface WorkflowGuardContext {
	sessionId: string | null;
	activeState: Awaited<ReturnType<typeof readVisibleSkillActiveState>>;
	modeStates: ReadonlyMap<string, ModeState | null>;
}

interface ModeState {
	active?: boolean;
	current_phase?: string;
	session_id?: string;
	thread_id?: string;
	[key: string]: unknown;
}

function safeString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

async function resolveBoundarySessionId(cwd: string, sessionId?: string): Promise<string | null> {
	const normalizedSessionId = sessionId?.trim();
	if (normalizedSessionId) return normalizedSessionId;
	try {
		return (await resolveSkcSessionForRead(cwd, { envSessionId: process.env.SKC_SESSION_ID })).skcSessionId;
	} catch {
		return null;
	}
}

function modeStatePath(cwd: string, skill: string, sessionId: string): string {
	return sessionModeStatePath(cwd, sessionId, skill);
}

function warnInvalidModeState(filePath: string, error: string): void {
	logger.warn(`skc skill-state: invalid mode-state at ${filePath}: ${error}`);
}

async function readValidatedModeState(filePath: string): Promise<ModeState | null> {
	let raw: string;
	try {
		raw = await Bun.file(filePath).text();
	} catch {
		return null;
	}
	let state: ModeState;
	try {
		state = JSON.parse(raw) as ModeState;
	} catch (error) {
		warnInvalidModeState(filePath, `invalid JSON: ${(error as Error).message}`);
		return null;
	}
	const parsed = ModeStateSchema.safeParse(state);
	if (!parsed.success) {
		warnInvalidModeState(filePath, parsed.error.message);
		return null;
	}
	return state;
}

export async function readWorkflowGuardContext(
	cwd: string,
	options: { sessionId?: string; threadId?: string } = {},
): Promise<WorkflowGuardContext> {
	const sessionId = await resolveBoundarySessionId(cwd, options.sessionId);
	if (!sessionId) return { sessionId: null, activeState: null, modeStates: new Map() };
	const activeState = await readVisibleSkillActiveState(cwd, sessionId, { tier: "security" });
	const skills = activeState ? [...new Set(listActiveSkills(activeState).map(entry => entry.skill))] : [];
	const modeStates = new Map(
		await Promise.all(
			skills.map(
				async skill => [skill, await readValidatedModeState(modeStatePath(cwd, skill, sessionId))] as const,
			),
		),
	);
	return { sessionId, activeState, modeStates };
}

/**
 * Phases that genuinely finish a workflow skill. Mirrors the Stop hook's
 * `STOP_RELEASING_PHASES` (`hooks/skill-state.ts`): `handoff` is intentionally
 * absent so a handoff-required planning skill (deep-interview/ralplan) keeps
 * blocking through its handoff/ask window until it is demoted or cleared.
 */

function entryMatchesContext(entry: SkillActiveEntry, sessionId?: string, threadId?: string): boolean {
	if (sessionId && entry.session_id && entry.session_id !== sessionId) return false;
	if (threadId && entry.thread_id && entry.thread_id !== threadId) return false;
	return true;
}

function modeStateMatchesContext(state: ModeState, sessionId?: string, threadId?: string): boolean {
	if (sessionId && state.session_id && state.session_id !== sessionId) return false;
	if (threadId && state.thread_id && state.thread_id !== threadId) return false;
	return true;
}

/** Workflow skills that have a pre-approval planning posture this guard enforces. `team` never does. */
function isPlanningSkill(skill: string): skill is "deep-interview" | "ralplan" | "ultragoal" {
	return skill === "deep-interview" || skill === "ralplan" || skill === "ultragoal";
}

/**
 * Whether `skill` in `phase` is a pre-approval planning posture that must block
 * product-code mutation. `deep-interview` and `ralplan` are wholly pre-approval
 * (every phase blocks except a genuinely-finished one — `handoff` and ralplan's
 * `final` keep blocking until execution is approved and the skill is demoted).
 * `ultragoal` only blocks during `goal-planning`; once goals are created it is an
 * executor and mutates freely.
 */
function isBlockingPlanningPhase(skill: "deep-interview" | "ralplan" | "ultragoal", phase: string): boolean {
	const normalized = phase.trim().toLowerCase();
	if (skill === "ultragoal") return normalized === "goal-planning";
	return !getSkillManifest(skill).stopReleasingPhases.includes(normalized);
}

interface ActivePlanningSkill {
	skill: "deep-interview" | "ralplan" | "ultragoal";
	phase: string;
}

/**
 * Pick the single CURRENT workflow entry among active entries.
 *
 * Steady state has exactly one active workflow skill (handoff demotes the prior
 * to `active:false`, which `listActiveSkills` already filters out). If several
 * are momentarily active, prefer the most-recently-updated entry so a stale
 * planning row (e.g. a still-active ralplan `final`) can never be selected over a
 * newer executor (ultragoal/team), and a planning *return* (newer `updated_at`)
 * reliably wins. Ties fall back to the resolved top-level `skill`, then to the
 * first entry, matching how the HUD/chain guard pick `activeSkills[0]`.
 */
function resolveCurrentWorkflowEntry(entries: SkillActiveEntry[], topLevelSkill: string): SkillActiveEntry {
	const ts = (entry: SkillActiveEntry): number => {
		const value = Date.parse(safeString(entry.updated_at) || safeString(entry.activated_at));
		return Number.isNaN(value) ? -1 : value;
	};
	let best = entries[0];
	for (const entry of entries) {
		const delta = ts(entry) - ts(best);
		if (delta > 0) best = entry;
		else if (delta === 0 && topLevelSkill && entry.skill === topLevelSkill) best = entry;
	}
	return best;
}

/**
 * Resolve the single active pre-approval planning skill for this context, or null.
 *
 * Transition/return safety: this keys off the ONE canonical current workflow
 * skill (the resolved top-level `skill` that the HUD and the skill-tool chain
 * guard treat as active), not an independent scan of every skill. A handoff
 * atomically demotes the prior skill and promotes the callee, and a return
 * (e.g. re-entering ralplan/deep-interview after an ultragoal goal completes)
 * re-activates the planning skill — in every case "whatever skill is current"
 * governs, so a stale planning entry can never block while an executor runs and
 * a resumed planning phase reliably re-blocks.
 *
 * Fail-open contract: a missing or invalid durable mode-state releases the block
 * (a corrupt state file must not lock all mutation), matching the guard's
 * historical behavior — this is intentionally looser than the Stop hook, which
 * fails closed for handoff-required skills.
 */
async function getActivePlanningSkill(
	cwd: string,
	sessionId?: string,
	threadId?: string,
	context?: WorkflowGuardContext,
): Promise<ActivePlanningSkill | null> {
	const guardContext = context ?? (await readWorkflowGuardContext(cwd, { sessionId, threadId }));
	const resolvedSessionId = guardContext.sessionId;
	if (!resolvedSessionId) return null;
	const skillState = guardContext.activeState;

	if (!skillState) return null;
	const activeEntries = listActiveSkills(skillState).filter(entry =>
		entryMatchesContext(entry, resolvedSessionId, threadId),
	);
	if (activeEntries.length === 0) return null;
	const current = resolveCurrentWorkflowEntry(activeEntries, safeString(skillState.skill).trim());
	if (!isPlanningSkill(current.skill)) return null;
	const modeState = guardContext.modeStates.get(current.skill) ?? null;

	if (!modeState) return null;
	const activePhase = String(current.phase ?? "").trim();
	const posture = planningPostureFromModeState(current.skill, activePhase, modeState, resolvedSessionId, threadId);
	if (posture.tampered) {
		warnInvalidModeState(
			modeStatePath(cwd, current.skill, resolvedSessionId),
			"out-of-band edit detected (content_sha256 mismatch)",
		);
	}
	if (!posture.blocking) return null;
	return { skill: current.skill, phase: posture.phase };
}

/**
 * Decide whether `modeState` may release the planning block.
 *
 * The active entry is the seal. A mode-state file releases that seal only when
 * its writer-stamped `content_sha256` matches and its session context matches,
 * or when an unsigned file in the same context does not claim a looser posture
 * than the entry. An unsigned file may still impose a stricter blocking phase.
 * Checksum mismatch ignores the file. A context mismatch does not release the
 * entry's block: the file was read from this session's path.
 */
function planningPostureFromModeState(
	skill: "deep-interview" | "ralplan" | "ultragoal",
	activePhase: string,
	modeState: ModeState,
	sessionId?: string,
	threadId?: string,
): { blocking: boolean; phase: string; tampered: boolean } {
	const status = workflowEnvelopeChecksumStatus(modeState);
	if (status === "mismatch") {
		return {
			blocking: isBlockingPlanningPhase(skill, activePhase),
			phase: activePhase,
			tampered: true,
		};
	}
	if (!modeStateMatchesContext(modeState, sessionId, threadId)) {
		return {
			blocking: isBlockingPlanningPhase(skill, activePhase),
			phase: activePhase,
			tampered: false,
		};
	}
	if (status === "match") {
		if (modeState.active !== true) return { blocking: false, phase: activePhase, tampered: false };
		const phase = String(modeState.current_phase ?? activePhase).trim();
		return { blocking: isBlockingPlanningPhase(skill, phase), phase, tampered: false };
	}
	if (!isBlockingPlanningPhase(skill, activePhase)) {
		const stricterPhase = String(modeState.current_phase ?? "").trim();
		if (modeState.active === true && stricterPhase && isBlockingPlanningPhase(skill, stricterPhase)) {
			return { blocking: true, phase: stricterPhase, tampered: false };
		}
		return { blocking: false, phase: activePhase, tampered: false };
	}
	if (modeState.active !== true) return { blocking: true, phase: activePhase, tampered: false };
	const modePhase = String(modeState.current_phase ?? "").trim();
	if (
		modePhase &&
		!isBlockingPlanningPhase(skill, modePhase) &&
		modePhase.trim().toLowerCase() !== activePhase.trim().toLowerCase()
	) {
		return { blocking: true, phase: activePhase, tampered: false };
	}
	const phase = modePhase || activePhase;
	return { blocking: isBlockingPlanningPhase(skill, phase), phase, tampered: false };
}

function normalizePosix(value: string): string {
	return value.replace(/\\/g, "/");
}

function addPath(targets: ExtractedTargets, value: unknown): void {
	if (typeof value === "string" && value.trim().length > 0) {
		targets.paths.push(value.trim());
	}
}

function getRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function extractWriteTargets(args: unknown): ExtractedTargets {
	const record = getRecord(args);
	const targets: ExtractedTargets = { paths: [], unknown: false };
	addPath(targets, record?.path);
	if (targets.paths.length === 0) targets.unknown = true;
	return targets;
}

function extractAstEditTargets(args: unknown): ExtractedTargets {
	const record = getRecord(args);
	const targets: ExtractedTargets = { paths: [], unknown: false };
	const paths = record?.paths;
	if (Array.isArray(paths)) {
		for (const entry of paths) addPath(targets, entry);
	}
	if (targets.paths.length === 0) targets.unknown = true;
	return targets;
}

function extractVimSwitchTargets(steps: unknown, targets: ExtractedTargets): void {
	if (!Array.isArray(steps)) return;
	for (const step of steps) {
		const record = getRecord(step);
		const keys = record?.kbd;
		if (!Array.isArray(keys)) continue;
		for (const key of keys) {
			if (typeof key !== "string") continue;
			const match = key.match(VIM_FILE_SWITCH_RE);
			if (!match) continue;
			const targetPath = match[1]?.trim();
			if (!targetPath) {
				targets.unknown = true;
				continue;
			}
			targets.paths.push(targetPath);
		}
	}
}

function extractApplyPatchTargets(args: unknown, targets: ExtractedTargets): boolean {
	const record = getRecord(args);
	const input = record?.input;
	if (typeof input !== "string") return false;
	try {
		for (const entry of expandApplyPatchToEntries({ input })) {
			addPath(targets, entry.path);
			addPath(targets, entry.rename);
		}
	} catch {
		targets.unknown = true;
	}
	return true;
}

function extractEditTargets(args: unknown, tool: ToolWithEditMode): ExtractedTargets {
	const record = getRecord(args);
	const targets: ExtractedTargets = { paths: [], unknown: false };
	const customWireName = safeString(tool.customWireName);
	const mode = safeString(tool.mode);

	const isApplyPatchMode = customWireName === "apply_patch" || mode === "apply_patch";
	const hasApplyPatchInput = typeof record?.input === "string";
	if (isApplyPatchMode || hasApplyPatchInput) {
		extractApplyPatchTargets(args, targets);
		if (targets.paths.length === 0) targets.unknown = true;
		return targets;
	}

	addPath(targets, record?.path);
	addPath(targets, record?.file);
	const edits = record?.edits;
	if (Array.isArray(edits)) {
		for (const edit of edits) {
			const editRecord = getRecord(edit);
			addPath(targets, editRecord?.rename);
			addPath(targets, editRecord?.path);
		}
	}
	if (record?.file !== undefined || mode === "vim") {
		extractVimSwitchTargets(record?.steps, targets);
	}
	if (targets.paths.length === 0) targets.unknown = true;
	return targets;
}
function shellWords(argsText: string): string[] {
	return argsText.match(/(?:[^\s'"\\]+|'[^']*'|"[^"]*")+/g) ?? [];
}

function cleanShellWord(value: string): string {
	return value.replace(/^['"]|['"]$/g, "");
}

/**
 * Blank out single-quoted spans so shell metacharacters inside a literal
 * argument value (e.g. `--value 'uses `x`; a > b'`) are not misread as
 * redirections or separators. Single quotes suppress every expansion in POSIX
 * shells, so their contents are always inert data. Double-quoted spans are left
 * intact because they still expand `$(...)` and backticks.
 */
function maskSingleQuotedSpans(command: string): string {
	let masked = "";
	let inSingle = false;
	for (const character of command) {
		if (character === "'") {
			inSingle = !inSingle;
			masked += character;
			continue;
		}
		masked += inSingle && character !== "\n" ? " " : character;
	}
	// An unbalanced quote means the parse is unreliable; keep the original text
	// so the scanner stays fail-closed rather than blind.
	return inSingle ? command : masked;
}

function isDeviceSinkPath(value: string): boolean {
	return DEVICE_SINK_PATHS.has(cleanShellWord(value));
}

function extractBashTargets(args: unknown, depth = 0): ExtractedTargets {
	const record = getRecord(args);
	const command = safeString(record?.command);
	const targets: ExtractedTargets = { paths: [], unknown: false };
	if (!command.trim()) {
		targets.unknown = true;
		return targets;
	}
	// A literal `sh|bash|zsh -c '<script>'` payload is a real command list. Its
	// mutations never match the top-level patterns, so recurse into it; anything
	// deeper than a bounded depth is not statically analyzable and fails closed.
	for (const match of command.matchAll(BASH_NESTED_SHELL_RE)) {
		if (depth >= 2) {
			targets.explicitMutation = true;
			targets.unknown = true;
			break;
		}
		const nested = extractBashTargets({ command: match[2] ?? match[4] ?? "" }, depth + 1);
		for (const nestedPath of nested.paths) addPath(targets, nestedPath);
		if (nested.unknown) targets.unknown = true;
		if (nested.explicitMutation) targets.explicitMutation = true;
	}
	// Nested scripts were read from the raw text above; every scanner below works
	// on the masked view so quoted argument data cannot look like a redirection.
	const scanned = maskSingleQuotedSpans(command);
	if (BASH_OPAQUE_INTERPRETER_WRITE_RE.test(command) || BASH_HEREDOC_OPAQUE_INTERPRETER_WRITE_RE.test(command)) {
		targets.explicitMutation = true;
		targets.unknown = true;
	}
	// `exec 1<>file` rebinds a descriptor, so a later `>/dev/null` may not reach the device at all.
	if (BASH_EXEC_REDIRECT_RE.test(scanned)) {
		targets.explicitMutation = true;
		targets.unknown = true;
	}
	for (const match of scanned.matchAll(BASH_EXTENDED_WRITE_RE)) {
		targets.explicitMutation = true;
		const cleaned = cleanShellWord(match[1] ?? "");
		if (!cleaned) targets.unknown = true;
		else if (!isDeviceSinkPath(cleaned)) addPath(targets, cleaned);
	}
	for (const match of scanned.matchAll(BASH_DD_OUTPUT_RE)) {
		targets.explicitMutation = true;
		const parts = shellWords(match[1] ?? "").map(cleanShellWord);
		// Every `of=` counts: GNU dd honors the last one, so `of=/dev/null of=real.ts` writes real.ts.
		const outputs = parts.filter(part => part.startsWith("of="));
		if (outputs.length === 0) targets.unknown = true;
		for (const output of outputs) {
			const outputPath = cleanShellWord(output.slice(3));
			if (!outputPath) targets.unknown = true;
			else if (!isDeviceSinkPath(outputPath)) addPath(targets, outputPath);
		}
	}
	for (const match of scanned.matchAll(BASH_IN_PLACE_MUTATION_COMMAND_RE)) {
		const parts = shellWords(match[1] ?? "").map(cleanShellWord);
		const hasInPlaceFlag = parts.some(part => /^-.*i/.test(part));
		if (!hasInPlaceFlag) continue;
		targets.explicitMutation = true;
		const target = [...parts].reverse().find(part => part && !part.startsWith("-"));
		if (target) addPath(targets, target);
		else targets.unknown = true;
	}
	for (const match of scanned.matchAll(BASH_MUTATION_COMMAND_RE)) {
		targets.explicitMutation = true;
		const redirected = match[2]?.trim();
		if (redirected) {
			const cleaned = cleanShellWord(redirected);
			// A capture that dequotes to nothing (e.g. `>" src.ts"`) is a truncated parse, not a safe no-op.
			if (!cleaned) targets.unknown = true;
			else if (!isDeviceSinkPath(cleaned)) addPath(targets, cleaned);
			continue;
		}
		const parts = shellWords(match[1] ?? "");
		const commandName = match[0]
			?.match(
				/(?:^|[;&|\n])\s*(?:\w+=[^\s]+\s+)*(?:sudo\s+)?(?:[^\s;&|]*\/)?(tee|touch|rm|mkdir|cp|mv|install|truncate)\b/i,
			)?.[1]
			?.toLowerCase();
		const targetParts =
			commandName === "cp" || commandName === "mv" || commandName === "install" || commandName === "truncate"
				? parts.slice(-1)
				: parts;
		for (const part of targetParts) {
			const cleaned = cleanShellWord(part);
			if (!cleaned || cleaned.startsWith("-")) continue;
			addPath(targets, cleaned);
		}
	}
	return targets;
}
/**
 * Read-only github ops extract no mutation. Every other op fails closed during
 * planning: remote push, PR creation, and worktree/config writes are not a
 * filesystem path the planning allowlist can clear.
 */
function extractGithubTargets(args: unknown): ExtractedTargets {
	if (isGithubReadOnlyArgs(args)) return { paths: [], unknown: false };
	return { paths: [], unknown: true, explicitMutation: true };
}

function simpleLiteral(raw: string): string | null {
	const trimmed = raw.trim();
	const quote = trimmed[0];
	if ((quote !== "'" && quote !== '"') || trimmed.length < 2 || trimmed[trimmed.length - 1] !== quote) return null;
	const body = trimmed.slice(1, -1);
	return /[\\\n${]/.test(body) || body.includes(quote) ? null : body;
}

function skipNoise(code: string, index: number, language: "py" | "js"): number {
	if (language === "py" && (code.startsWith('"""', index) || code.startsWith("'''", index))) {
		const quote = code.slice(index, index + 3);
		const end = code.indexOf(quote, index + 3);
		return end < 0 ? code.length : end + 3;
	}
	const character = code[index] ?? "";
	if (character === "'" || character === '"') {
		let cursor = index + 1;
		while (cursor < code.length && code[cursor] !== character) cursor += code[cursor] === "\\" ? 2 : 1;
		return Math.min(code.length, cursor + 1);
	}
	if (
		(language === "py" && character === "#") ||
		(language === "js" && character === "/" && code[index + 1] === "/")
	) {
		const end = code.indexOf("\n", index);
		return end < 0 ? code.length : end;
	}
	if (language === "js" && character === "/" && code[index + 1] === "*") {
		const end = code.indexOf("*/", index + 2);
		return end < 0 ? code.length : end + 2;
	}
	return index;
}

function readArg(code: string, index: number): { raw: string; end: number } | null {
	let cursor = index;
	while (/\s/.test(code[cursor] ?? "")) cursor += 1;
	if (cursor >= code.length || code[cursor] === ")") return null;
	const start = cursor;
	let depth = 0;
	while (cursor < code.length) {
		const character = code[cursor];
		if (character === "(") depth += 1;
		else if ((character === "," || character === ")") && depth === 0) break;
		else if (character === ")") depth -= 1;
		else if (character === "'" || character === '"') {
			const quote = character;
			cursor += 1;
			while (cursor < code.length && code[cursor] !== quote) cursor += code[cursor] === "\\" ? 2 : 1;
		}
		cursor += 1;
	}
	const raw = code.slice(start, cursor).trim();
	return raw.length > 0 ? { raw, end: cursor } : null;
}

/** Omitted mode is Python's default `"r"`. A non-literal mode cannot be proved read-only. */
function modeWrites(raw: string | undefined): boolean | null {
	if (raw === undefined) return false;
	const literal = simpleLiteral(raw);
	return literal === null ? null : /[wax+]/.test(literal);
}

const PY_OS_MUTATORS = new Set("remove unlink rename replace rmtree move copy copy2 copyfile".split(" "));
/** Copy and rename write the destination, not only the source. */
const TWO_ARG_MUTATORS = new Set("rename replace move copy copy2 copyfile renameSync copyFileSync".split(" "));
const JS_FS_MUTATORS = new Set(
	"writeFileSync writeFile appendFileSync appendFile rmSync unlinkSync renameSync copyFileSync mkdirSync openSync".split(
		" ",
	),
);

function nextCallArg(code: string, end: number): { raw: string; end: number } | null {
	let cursor = end;
	while (/\s/.test(code[cursor] ?? "")) cursor += 1;
	if (code[cursor] !== ",") return null;
	return readArg(code, cursor + 1);
}

function openModeWrites(code: string, first: { raw: string; end: number }): boolean | null {
	let cursor = first.end;
	let positionalIndex = 1;
	let mode: string | undefined;
	let unknownMode = false;
	while (cursor < code.length) {
		while (/\s/.test(code[cursor] ?? "")) cursor += 1;
		if (code[cursor] !== ",") break;
		const argument = readArg(code, cursor + 1);
		if (!argument) break;
		const raw = argument.raw.trim();
		if (raw.startsWith("*") || raw.startsWith("**")) {
			unknownMode = true;
		} else {
			const keyword = /^([A-Za-z_]\w*)\s*=\s*([\s\S]*)$/.exec(raw);
			if (keyword?.[1] === "mode") {
				if (mode !== undefined) unknownMode = true;
				else mode = keyword[2];
			} else if (!keyword && positionalIndex === 1) {
				if (mode !== undefined) unknownMode = true;
				else mode = raw;
			}
		}
		positionalIndex += 1;
		cursor = argument.end;
	}
	if (unknownMode) return null;
	return modeWrites(mode);
}

/** Whitespace or a backslash-newline may sit before an attribute (`shutil .copy`). */
function skipCallGap(code: string, index: number): number {
	let cursor = index;
	while (cursor < code.length) {
		const character = code[cursor] ?? "";
		if (/\s/.test(character)) {
			cursor += 1;
			continue;
		}
		if (character === "\\" && code[cursor + 1] === "\n") {
			cursor += 2;
			continue;
		}
		if (character === "\\" && code[cursor + 1] === "\r" && code[cursor + 2] === "\n") {
			cursor += 3;
			continue;
		}
		break;
	}
	return cursor;
}

function literalWrite(targets: ExtractedTargets, raw: string | undefined, write: boolean | null): void {
	if (write === false) return;
	targets.explicitMutation = true;
	const literal = raw === undefined ? null : simpleLiteral(raw);
	if (write === null || literal === null || literal.length === 0) {
		targets.unknown = true;
		return;
	}
	addPath(targets, literal);
}

/** Arguments of one Path() call, through its own closing parenthesis. */
function readPathConstructor(code: string, argAt: number): { parts: string[]; after: number } | null {
	let cursor = argAt;
	const parts: string[] = [];
	while (cursor < code.length) {
		while (/\s/.test(code[cursor] ?? "")) cursor += 1;
		if (code[cursor] === ")") return { parts, after: cursor + 1 };
		const argument = readArg(code, cursor);
		if (!argument) return null;
		parts.push(argument.raw);
		cursor = argument.end;
		while (/\s/.test(code[cursor] ?? "")) cursor += 1;
		if (code[cursor] === ",") {
			cursor += 1;
			continue;
		}
		if (code[cursor] === ")") return { parts, after: cursor + 1 };
		return null;
	}
	return null;
}

/** pathlib keeps the last absolute segment. A non-literal segment is an unresolved receiver. */
function literalPathReceiver(parts: string[]): string | null {
	if (parts.length === 0) return ".";
	let joined = "";
	for (const part of parts) {
		const literal = simpleLiteral(part);
		if (literal === null) return null;
		if (path.isAbsolute(literal)) joined = literal;
		else joined = joined ? path.join(joined, literal) : literal;
	}
	return joined.length === 0 ? "." : joined;
}

/** Calls inside strings or comments are skipped. A non-literal write path fails closed. */
function scanInterpreterWrites(code: string, language: "py" | "js", targets: ExtractedTargets): void {
	let index = 0;
	while (index < code.length) {
		const trivia = skipNoise(code, index, language);
		if (trivia !== index) {
			index = trivia;
			continue;
		}
		const previous = index === 0 ? "" : (code[index - 1] ?? "");
		if ((index > 0 && /[\w]/.test(previous)) || !/[A-Za-z_]/.test(code[index] ?? "")) {
			index += 1;
			continue;
		}
		const ident = /^[A-Za-z_]\w*/.exec(code.slice(index));
		if (!ident) {
			index += 1;
			continue;
		}
		const name = ident[0];
		if ((name === "write" || name === "append") && previous === ".") {
			index += name.length;
			continue;
		}
		let cursor = skipCallGap(code, index + name.length);
		let dotted = "";
		if (code[cursor] === ".") {
			const methodAt = skipCallGap(code, cursor + 1);
			const dot = /^\w+/.exec(code.slice(methodAt));
			dotted = dot?.[0] ?? "";
			cursor = methodAt + dotted.length;
		}
		const paren = /^\s*\(/.exec(code.slice(cursor));
		const helper = (name === "write" || name === "append") && dotted === "";
		const open = (name === "open" && language === "py") || (name === "openSync" && language === "js");
		const pathCtor = name === "Path" && dotted === "";
		const osCall =
			language === "py" &&
			((name === "os" && PY_OS_MUTATORS.has(dotted)) || (name === "shutil" && PY_OS_MUTATORS.has(dotted)));
		const jsCall =
			language === "js" && ((JS_FS_MUTATORS.has(name) && dotted === "") || (name === "Bun" && dotted === "write"));
		if (!paren || (!helper && !(open && dotted === "") && !pathCtor && !osCall && !jsCall)) {
			index += name.length;
			continue;
		}
		const argAt = cursor + paren[0].length;
		const first = readArg(code, argAt);
		if (pathCtor) {
			const ctor = readPathConstructor(code, argAt);
			if (!ctor) {
				index += 1;
				continue;
			}
			const method = /^\s*\.\s*(write_text|write_bytes)\b/.exec(code.slice(ctor.after));
			if (method) {
				targets.explicitMutation = true;
				const receiver = literalPathReceiver(ctor.parts);
				if (receiver === null || receiver.length === 0) targets.unknown = true;
				else addPath(targets, receiver);
			}
			// Extra segments stay in the argument walk so a nested mutator is still recorded.
			index =
				ctor.parts.length > 1 ? index + name.length : Math.max(ctor.after + (method?.[0].length ?? 0), index + 1);
			continue;
		}
		if (!first) {
			literalWrite(targets, undefined, null);
			index = Math.max(argAt, index + 1);
			continue;
		}
		if (open && dotted === "") {
			literalWrite(targets, first.raw, openModeWrites(code, first));
			index = Math.max(first.end, index + 1);
			continue;
		}
		literalWrite(targets, first.raw, true);
		let end = first.end;
		if (TWO_ARG_MUTATORS.has(dotted || name)) {
			const second = nextCallArg(code, first.end);
			if (!second) literalWrite(targets, undefined, null);
			else {
				literalWrite(targets, second.raw, true);
				end = second.end;
			}
		}
		index = Math.max(end, index + 1);
	}
}

function extractCodeToolTargets(toolName: string, args: unknown): ExtractedTargets {
	const targets: ExtractedTargets = { paths: [], unknown: false };
	const record = getRecord(args);
	if (!record) {
		targets.unknown = true;
		targets.explicitMutation = true;
		return targets;
	}
	if (toolName === "python") {
		if ((safeString(record.action) || "execute") === "clear") return targets;
		if (typeof record.code !== "string" || record.code.trim() === "") return targets;
		scanInterpreterWrites(record.code, "py", targets);
		return targets;
	}
	if (!Array.isArray(record.cells)) {
		targets.unknown = true;
		targets.explicitMutation = true;
		return targets;
	}
	for (const cell of record.cells) {
		const cellRecord = getRecord(cell);
		if (typeof cellRecord?.code !== "string") {
			targets.unknown = true;
			targets.explicitMutation = true;
			continue;
		}
		if (cellRecord.language === "py") scanInterpreterWrites(cellRecord.code, "py", targets);
		else if (cellRecord.language === "js") scanInterpreterWrites(cellRecord.code, "js", targets);
		else {
			targets.unknown = true;
			targets.explicitMutation = true;
		}
	}
	return targets;
}

function extractTargets(tool: ToolWithEditMode, args: unknown): ExtractedTargets {
	if (tool.name === "write") return extractWriteTargets(args);
	if (tool.name === "ast_edit") return extractAstEditTargets(args);
	if (tool.name === "edit") return extractEditTargets(args, tool);
	if (tool.name === "bash") return extractBashTargets(args);
	if (tool.name === "github") return extractGithubTargets(args);
	if (tool.name === "python" || tool.name === "eval") return extractCodeToolTargets(tool.name, args);
	return { paths: [], unknown: true };
}

function stripSelectorBase(rawPath: string): string {
	const archiveOrSqlite = rawPath.match(ARCHIVE_OR_SQLITE_BASE_RE);
	if (archiveOrSqlite?.[1]) return archiveOrSqlite[1];
	return rawPath;
}

function resolveRawPath(cwd: string, rawPath: string): { absolutePath?: string; unknown: boolean } {
	const normalized = rawPath.trim();
	if (!normalized) return { unknown: true };
	if (normalized === ".") return { absolutePath: path.resolve(cwd), unknown: false };
	if (normalized.startsWith("local://") || normalized.startsWith("local:/")) {
		const options = LocalProtocolHandler.resolveOptions();
		if (!options) return { unknown: true };
		try {
			return { absolutePath: resolveLocalUrlToPath(normalized, options), unknown: false };
		} catch {
			return { unknown: true };
		}
	}
	if (INTERNAL_SCHEME_RE.test(normalized)) return { unknown: true };

	const basePath = stripSelectorBase(normalized);
	try {
		return { absolutePath: resolveToCwd(basePath, cwd), unknown: false };
	} catch {
		return { unknown: true };
	}
}

function relativeSkcSegments(cwd: string, rawPath: string): string[] | null {
	const { absolutePath, unknown } = resolveRawPath(cwd, rawPath);
	if (unknown || !absolutePath) return null;
	const relative = path.relative(path.resolve(cwd), path.resolve(absolutePath));
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
	return normalizePosix(relative).split("/").filter(Boolean);
}

function blockedWorkflowStateSkill(cwd: string, rawPath: string): CanonicalSkcWorkflowSkill | null {
	const segments = relativeSkcSegments(cwd, rawPath);
	if (segments?.[0] !== ".skc") return null;
	const generatedRoot = segments[1]?.startsWith(SKC_SESSION_PREFIX) ? segments[2] : segments[1];
	if (generatedRoot === "specs" || generatedRoot === "plans") return null;
	if (generatedRoot !== "state") return null;
	const fileName = segments.at(-1) ?? "";
	for (const skillName of ["deep-interview", "ralplan", "ultragoal", "team"] as const) {
		if (fileName === workflowModeStateFileName(skillName)) return skillName;
	}
	if (fileName === "skill-active-state.json") return "deep-interview";
	return null;
}

function firstBlockedWorkflowStateSkill(cwd: string, targets: ExtractedTargets): CanonicalSkcWorkflowSkill | null {
	for (const rawPath of targets.paths) {
		const skill = blockedWorkflowStateSkill(cwd, rawPath);
		if (skill) return skill;
	}
	return null;
}

function planningSessionDirName(sessionId: string | null | undefined): string | undefined {
	const trimmed = sessionId?.trim();
	if (!trimmed) return undefined;
	return sessionDirName(trimmed);
}

/** Specs and plans are planning-writable. A `_session-` directory must be this session's encoded name. */
function isAllowlistedPath(cwd: string, rawPath: string, sessionId?: string | null): boolean {
	const segments = relativeSkcSegments(cwd, rawPath);
	if (segments?.[0] !== ".skc") return false;
	const head = segments[1];
	if (head?.startsWith(SKC_SESSION_PREFIX)) {
		const bound = planningSessionDirName(sessionId);
		if (!bound || head !== bound) return false;
		return segments[2] === "specs" || segments[2] === "plans";
	}
	return head === "specs" || head === "plans";
}
function isBlockedSkcPath(cwd: string, rawPath: string): boolean {
	const segments = relativeSkcSegments(cwd, rawPath);
	return segments?.[0] === ".skc";
}

function hasBlockedSkcTarget(cwd: string, targets: ExtractedTargets): boolean {
	return targets.paths.some(rawPath => isBlockedSkcPath(cwd, rawPath));
}

function allTargetsAllowlisted(cwd: string, targets: ExtractedTargets, sessionId?: string | null): boolean {
	return (
		!targets.unknown &&
		targets.paths.length > 0 &&
		targets.paths.every(rawPath => isAllowlistedPath(cwd, rawPath, sessionId))
	);
}

/** POSIX directories that are temp roots even when `TMPDIR` is unset or poisoned. */
const POSIX_SYSTEM_TEMP_ROOTS = ["/tmp", "/var/tmp", "/private/tmp", "/private/var/tmp"];

/**
 * `os.tmpdir()` follows `TMPDIR`, and Bun copies `cwd/.env` into the environment
 * when that variable was unset. A repository can therefore name an arbitrary
 * directory. Declarations below are not neutral scratch roots.
 */
function tempEnvNames(): readonly string[] {
	return process.platform === "win32" ? ["TEMP", "TMP", "TMPDIR"] : ["TMPDIR"];
}

const PROJECT_TEMP_DOTENV_MAX_FILE_BYTES = 64 * 1024;

// The snapshot is the cwd at module import, not a directory created later or a chdir before this module is imported.
const startupTempSnapshot = projectEnvSnapshot(process.cwd(), {
	maxFileBytes: PROJECT_TEMP_DOTENV_MAX_FILE_BYTES,
});

function projectTempSnapshots(cwd: string): ProjectEnvSnapshot[] {
	// Check both the cwd's .env and the startup snapshot (for module-import-time cwd).
	// The cwd's .env catches project-declared TMPDIR in the current working directory.
	// The startup snapshot is a fallback for when the cwd's .env is deleted or inaccessible
	// (e.g., after unlink or chdir), and also handles the case where cwd differs from the
	// module-import-time cwd. These workspace-controlled files are read as bounded regular files.
	const snapshots: ProjectEnvSnapshot[] = [
		projectEnvSnapshot(cwd, { maxFileBytes: PROJECT_TEMP_DOTENV_MAX_FILE_BYTES }),
		startupTempSnapshot,
	];
	return snapshots;
}

/** macOS account temp directory. `getconf` does not read `TMPDIR`. */
let darwinUserTempDirCache: string | undefined | null = null;
function darwinUserTempDir(): string | undefined {
	if (process.platform !== "darwin") return undefined;
	if (darwinUserTempDirCache !== null) return darwinUserTempDirCache;
	darwinUserTempDirCache = undefined;
	try {
		const result = Bun.spawnSync({
			cmd: ["/usr/bin/getconf", "DARWIN_USER_TEMP_DIR"],
			env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
			stdout: "pipe",
			stderr: "ignore",
		});
		if (result.exitCode !== 0) return undefined;
		const value = new TextDecoder().decode(result.stdout).trim();
		if (value) darwinUserTempDirCache = value;
	} catch {
		// Fixed `/tmp` roots still cover the POSIX default.
	}
	return darwinUserTempDirCache ?? undefined;
}

function addResolvedTempRoot(roots: Set<string>, value: string | undefined): void {
	const trimmed = value?.trim();
	if (trimmed) roots.add(path.resolve(trimmed));
}

function isPlatformTempPath(resolved: string): boolean {
	for (const root of POSIX_SYSTEM_TEMP_ROOTS) {
		const resolvedRoot = path.resolve(root);
		if (resolved === resolvedRoot || isPathWithin(resolvedRoot, resolved)) return true;
	}
	const darwin = darwinUserTempDir();
	if (!darwin) return false;
	const resolvedDarwin = path.resolve(darwin);
	return resolved === resolvedDarwin || isPathWithin(resolvedDarwin, resolved);
}

/** True when `live` is declared, or cannot be trusted because a dotenv layer was unsafe to read. */
function projectDeclaresTempPath(snapshots: readonly ProjectEnvSnapshot[], live: string): boolean {
	const trimmedLive = live.trim();
	if (!trimmedLive) return false;
	const resolvedLive = path.resolve(trimmedLive);
	for (const snapshot of snapshots) {
		if (snapshot.incomplete && !isPlatformTempPath(resolvedLive)) return true;
		for (const name of tempEnvNames()) {
			const key = canonicalEnvKey(name);
			const declared = snapshot.values[key];
			if (declared === undefined) continue;
			if (snapshot.dynamic.has(key)) {
				// Expansion is not comparable. A dynamic value that landed on a
				// real system temp dir is already allowed through those roots.
				if (!isPlatformTempPath(resolvedLive)) return true;
				continue;
			}
			const trimmedDeclared = declared.trim();
			if (trimmedDeclared && path.resolve(trimmedDeclared) === resolvedLive) return true;
		}
	}
	return false;
}

function neutralTempRoots(cwd: string): string[] {
	const roots = new Set<string>();
	for (const fixed of POSIX_SYSTEM_TEMP_ROOTS) addResolvedTempRoot(roots, fixed);
	addResolvedTempRoot(roots, darwinUserTempDir());
	const candidates = [os.tmpdir(), process.env.TMPDIR];
	if (process.platform === "win32") candidates.push(process.env.TEMP, process.env.TMP);
	const snapshots = projectTempSnapshots(cwd);
	for (const candidate of candidates) {
		if (!candidate || projectDeclaresTempPath(snapshots, candidate)) continue;
		addResolvedTempRoot(roots, candidate);
	}
	return [...roots];
}

function isPathWithin(root: string, target: string): boolean {
	const rel = path.relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function realpathOrSelf(target: string): Promise<string> {
	try {
		return await fs.realpath(target);
	} catch {
		return target;
	}
}

/**
 * Canonicalize a target whose leaf may not exist yet (we are about to write it):
 * realpath the nearest existing ancestor and re-append the not-yet-existing
 * suffix, so a symlinked ancestor (or macOS `/tmp` → `/private/tmp` alias) is
 * resolved to its real location.
 */
async function canonicalizeForContainment(absolutePath: string): Promise<string> {
	const suffix: string[] = [];
	let current = absolutePath;
	for (let depth = 0; depth < 64; depth++) {
		try {
			const real = await fs.realpath(current);
			return suffix.length > 0 ? path.join(real, ...suffix.reverse()) : real;
		} catch {
			const parent = path.dirname(current);
			if (parent === current) break;
			suffix.push(path.basename(current));
			current = parent;
		}
	}
	return absolutePath;
}

/**
 * A neutral scratch path the planning-phase block tolerates: it resolves to a
 * system temp directory and lives OUTSIDE the project cwd. Files inside the
 * project tree (product code, `.skc/**`) are never neutral, even when the cwd
 * itself is rooted under a temp dir. The lexical checks run first; a canonical
 * (symlink/alias-resolved) re-check then ensures the REAL target is still outside
 * the project and inside a real temp root, defeating a temp symlink that points
 * back into the repo or `.skc/`.
 */
async function isNeutralTempPath(cwd: string, rawPath: string): Promise<boolean> {
	const { absolutePath, unknown } = resolveRawPath(cwd, rawPath);
	if (unknown || !absolutePath) return false;
	const resolvedCwd = path.resolve(cwd);
	if (isPathWithin(resolvedCwd, absolutePath)) return false;
	const roots = neutralTempRoots(cwd);
	const realRoots = await Promise.all(roots.map(realpathOrSelf));
	// Accept both spellings (`/var/folders` and `/private/var/folders`) before the
	// canonical re-check. The re-check still rejects a temp path whose real
	// target is inside the project.
	const lexicalRoots = new Set([...roots, ...realRoots]);
	if (![...lexicalRoots].some(root => isPathWithin(root, absolutePath))) return false;
	const realTarget = await canonicalizeForContainment(absolutePath);
	if (isPathWithin(await realpathOrSelf(resolvedCwd), realTarget)) return false;
	return realRoots.some(root => isPathWithin(root, realTarget));
}

/** realpath cannot expose another name for the same inode outside a writable root. */
async function hasUnsharedFileTarget(cwd: string, rawPath: string): Promise<boolean> {
	const { absolutePath, unknown } = resolveRawPath(cwd, rawPath);
	if (unknown || !absolutePath) return false;
	try {
		const target = await fs.stat(absolutePath);
		return !target.isFile() || target.nlink === 1;
	} catch (error) {
		// New scratch files remain writable; inaccessible or unresolvable targets fail closed.
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}

/** Targets that remain disallowed during a planning phase (excludes neutral temp scratch). */
async function planningBlockedTargets(
	cwd: string,
	targets: ExtractedTargets,
	sessionId?: string | null,
): Promise<string[]> {
	const blocked: string[] = [];
	for (const rawPath of targets.paths) {
		if (!(await hasUnsharedFileTarget(cwd, rawPath))) {
			blocked.push(rawPath);
			continue;
		}
		if (isAllowlistedPath(cwd, rawPath, sessionId)) continue;
		if (!(await isNeutralTempPath(cwd, rawPath))) blocked.push(rawPath);
	}
	return blocked;
}
export async function assertWorkflowMutationRawPathsAllowed(input: {
	cwd: string;
	sessionId?: string;
	threadId?: string;
	rawPaths: string[];
	forceOverride?: boolean;
	guardContext?: WorkflowGuardContext;
}): Promise<void> {
	const targets: ExtractedTargets = { paths: input.rawPaths, unknown: input.rawPaths.length === 0 };
	// Always-on `.skc/**` runtime-owned block, ahead of forceOverride.
	// A deferred ast_edit apply must not reach `.skc/**` either.
	if (hasBlockedSkcTarget(input.cwd, targets)) {
		const stateSkill = firstBlockedWorkflowStateSkill(input.cwd, targets);
		const command = stateSkill ? sanctionedWorkflowStateCommand(stateSkill) : "skc <workflow-command>";
		throw new ToolError(`${WORKFLOW_STATE_MUTATION_BLOCK_MESSAGE}\nUse: ${command}`);
	}
	if (input.forceOverride) return;
	const guardContext =
		input.guardContext ??
		(await readWorkflowGuardContext(input.cwd, { sessionId: input.sessionId, threadId: input.threadId }));
	const planning = await getActivePlanningSkill(input.cwd, input.sessionId, input.threadId, guardContext);

	if (!planning) return;
	const message = planningPhaseBlockMessage(planning.skill);
	if (input.rawPaths.length === 0) throw new ToolError(message);
	const blocked = await planningBlockedTargets(input.cwd, targets, guardContext.sessionId);
	if (blocked.length > 0) throw new ToolError(message);
}

export async function getWorkflowMutationDecision(
	input: WorkflowMutationGuardInput,
): Promise<WorkflowMutationDecision> {
	if (!BLOCKED_TOOL_NAMES.has(input.tool.name)) return { blocked: false, targets: [] };
	const targets = extractTargets(input.tool, input.args);
	if (input.tool.name !== "bash" && input.enforceWorkflowState !== false && hasBlockedSkcTarget(input.cwd, targets)) {
		const stateSkill = firstBlockedWorkflowStateSkill(input.cwd, targets);
		const command = stateSkill ? sanctionedWorkflowStateCommand(stateSkill) : "skc <workflow-command>";
		return {
			blocked: true,
			message: `${WORKFLOW_STATE_MUTATION_BLOCK_MESSAGE}\nUse: ${command}`,
			targets: targets.paths,
			reason: stateSkill ? "workflow-state-target" : "skc-target",
			command,
		};
	}
	const guardContext =
		input.guardContext ??
		(await readWorkflowGuardContext(input.cwd, { sessionId: input.sessionId, threadId: input.threadId }));
	const planning = await getActivePlanningSkill(input.cwd, input.sessionId, input.threadId, guardContext);
	if (!planning) {
		return { blocked: false, targets: [] };
	}
	if (input.forceOverride) return { blocked: false, targets: [] };
	const message = planningPhaseBlockMessage(planning.skill);
	// Bash during a planning phase blocks only when a filesystem mutation was
	// actually recognized. Inspection, reads, and CLI invocations the scanner does
	// not model stay usable; other tools keep failing closed on unknown targets.
	if (targets.unknown && (input.tool.name !== "bash" || targets.explicitMutation)) {
		return {
			blocked: true,
			message,
			targets: targets.paths,
			reason: "unknown-target",
		};
	}
	// Neutral temp scratch (outside the project tree) stays writable so agents can
	// stage artifacts and feed their path to the sanctioned `skc ... --write` CLIs.
	// Read-only / `skc` bash extract no targets and fall through to allowed here.
	const blockedTargets = await planningBlockedTargets(input.cwd, targets, guardContext.sessionId);
	if (blockedTargets.length === 0) {
		return { blocked: false, targets: targets.paths };
	}
	return {
		blocked: true,
		message,
		targets: targets.paths,
		reason: allTargetsAllowlisted(input.cwd, targets, guardContext.sessionId)
			? "handoff-artifact-tool-target"
			: "phase-boundary",
	};
}

export async function assertWorkflowMutationAllowed(input: WorkflowMutationGuardInput): Promise<void> {
	const decision = await getWorkflowMutationDecision(input);
	if (decision.blocked) throw new ToolError(decision.message ?? DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE);
}
