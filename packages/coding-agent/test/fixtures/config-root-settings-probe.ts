/**
 * Prints the workflow settings resolved for the current working directory.
 * `SKC_CONFIG_DIR` is read at module load, so this must be a child process.
 */
import { resolveRalplanMaxIterations } from "../../src/skc-runtime/ralplan-runtime";
import { resolveUltragoalNudgeBudget } from "../../src/skc-runtime/ultragoal-runtime";

const cwd = process.cwd();
console.log(
	JSON.stringify({
		ralplan: await resolveRalplanMaxIterations(cwd),
		ultragoal: await resolveUltragoalNudgeBudget(cwd),
	}),
);
