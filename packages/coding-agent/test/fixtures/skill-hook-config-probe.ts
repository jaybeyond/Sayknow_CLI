/**
 * Prints the skill `customDirectories` the native skill hook resolves for the
 * current working directory. Bun loads `cwd/.env` into `process.env` before any
 * module runs, so this must be a child process started with the scenario's cwd.
 */
import { resolveSkcNativeSkillConfigForTesting } from "../../src/hooks/native-skill-hook";

const config = (await resolveSkcNativeSkillConfigForTesting({ cwd: process.cwd() })) as {
	skillsSettings?: { customDirectories?: string[] };
};
console.log(JSON.stringify(config.skillsSettings?.customDirectories ?? []));
