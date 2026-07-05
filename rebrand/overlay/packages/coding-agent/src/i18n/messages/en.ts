// English message catalog. This is the source of truth: every translatable
// key MUST exist here. Other languages are Partial and fall back to these.
export const en = {
	// ── Languages (self-names, intentionally NOT translated per-locale) ──
	"lang.auto": "Auto (system)",
	"lang.en": "English",
	"lang.ko": "한국어",
	"lang.zh": "中文 (简体)",
	"lang.ja": "日本語",
	"lang.es": "Español",
	"lang.fr": "Français",
	"lang.de": "Deutsch",

	// ── Welcome surface ──
	"welcome.tagline": "Coding should feel like thinking.",
	"welcome.workflows": "Workflows",
	"welcome.wf.deepInterview": "scope · interview → spec",
	"welcome.wf.ralplan": "consensus plan",
	"welcome.wf.ultragoal": "autonomous build",
	"welcome.wf.team": "parallel agents",
	"welcome.flowKeys": "Flow keys",
	"welcome.commands": "commands",
	"welcome.actions": "actions",
	"welcome.shell": "shell",
	"welcome.python": "python",
	"welcome.keymap": "keymap",
	"welcome.model": "model",
	"welcome.reasoning": "reasoning",
	"welcome.projectPulse": "Project pulse",
	"welcome.noLsp": "No LSP servers",
	"welcome.sessionTrail": "Session trail",
	"welcome.noSessions": "No saved trails",
	"welcome.chooseModel": "choose a model",
	"welcome.modelHint": "ctrl+l to pick · / for commands",

	// ── Settings tabs ──
	"settings.tab.appearance": "Appearance",
	"settings.tab.model": "Model",
	"settings.tab.interaction": "Interaction",
	"settings.tab.context": "Context",
	"settings.tab.memory": "Memory",
	"settings.tab.editing": "Editing",
	"settings.tab.tools": "Tools",
	"settings.tab.tasks": "Tasks",
	"settings.tab.providers": "Providers",
	"settings.tab.integrations": "Integrations",

	// ── Language setting ──
	"settings.language.label": "Language",
	"settings.language.desc": "Interface language. Auto follows your system locale.",

	// ── Help ──
	"help.usage": "USAGE",
	"help.flags": "FLAGS",
	"help.commands": "COMMANDS",
	"help.examples": "EXAMPLES",
	"help.envVars": "ENVIRONMENT VARIABLES",
	"help.tools": "AVAILABLE TOOLS",
	"help.usefulCommands": "USEFUL COMMANDS",
	"help.appDescription": "Sayknow-CLI — an AI coding assistant",

	// ── Status line ──
	"statusline.plan": "Plan",
	"statusline.goal": "Goal",
	"statusline.paused": "paused",

	// ── Common UI ──
	"common.yes": "Yes",
	"common.no": "No",
	"nav.hint": "up/down navigate  enter select  esc cancel",

	// ── GitHub star reminder ──
	"star.title": "Enjoying Sayknow-CLI?",
	"star.message": "Star {repo} on GitHub to support the project?",

	// ── Common slash command descriptions (fall back to English elsewhere) ──
	"cmd.settings": "Open settings menu",
	"cmd.theme": "Open theme selector",
	"cmd.model": "Select model (opens selector UI)",
	"cmd.help": "Show help",
	"cmd.export": "Export session to HTML file",
	"cmd.session": "Session management commands",
	"cmd.clear": "Clear the conversation",
	"cmd.quit": "Exit Sayknow-CLI",
	"modelSelector.presets": "Model presets",
	"modelSelector.createCustom": "Create custom preset",
	"modelSelector.browseAll": "Browse all models",
	"modelSelector.applySession": "Apply for this session",
	"modelSelector.setDefault": "Set as default",
	"modelSelector.pressEnterApply": "Press Enter to apply this preset",
	"modelSelector.presetPreview": "Preset preview: {name}",
	"modelSelector.showingScoped": "Showing models from --models scope",
	"modelSelector.modelsTab": "Models",
	"modelSelector.noMatching": "No matching models.",
	"modelSelector.modelName": "Model Name: {value}",
	"modelSelector.actionFor": "Action for: {id}",
	"modelSelector.reasoningFor": "Reasoning for {target}: {id}",
	"modelSelector.temporaryModel": "temporary model",
} as const;

export type MsgKey = keyof typeof en;
