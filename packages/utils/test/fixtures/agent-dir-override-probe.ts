// Prints the agent directory and config root twice: once as the process starts,
// and once after the resolved home changes. Spawned as its own process so the
// operator-override assertion never mutates the parent's module-level resolver
// (`setAgentDir` installs an override resolver and cannot install a default one,
// so an in-process "restore" would latch an override on later tests).
//
// `SKC_CODING_AGENT_DIR` decides which lane is under test: set means an explicit
// operator selection that must stay pinned across a home change, absent means the
// default agent dir that must follow the resolved home. The second home is
// supplied by `SKC_PROBE_SECOND_HOME` and installed by mocking `os.homedir()`,
// which is how a home becomes visible only after module load.
import { vi } from "bun:test";
import * as os from "node:os";
import { getAgentDbPath, getAgentDir, getConfigRootDir, getTrustedHomeDir } from "../../src/dirs";

// `agentDb` rides the XDG data category, so it detects an agent directory that
// keeps its path but silently switches storage lanes across a home refresh.
const before = {
	trustedHome: getTrustedHomeDir(),
	agentDir: getAgentDir(),
	configRoot: getConfigRootDir(),
	agentDb: getAgentDbPath(),
};

const secondHome = process.env.SKC_PROBE_SECOND_HOME;
if (!secondHome) throw new Error("SKC_PROBE_SECOND_HOME is required");
vi.spyOn(os, "homedir").mockReturnValue(secondHome);

console.log(
	JSON.stringify({
		overrideDeclared: process.env.SKC_CODING_AGENT_DIR ?? null,
		before,
		after: {
			trustedHome: getTrustedHomeDir(),
			agentDir: getAgentDir(),
			configRoot: getConfigRootDir(),
			agentDb: getAgentDbPath(),
		},
	}),
);
