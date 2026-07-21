import { describe, expect, it } from "bun:test";
import {
	resolvePythonIntegrationGate,
	resolvePythonIpcTrace,
	resolvePythonSkipCheck,
} from "@sayknow-cli/coding-agent/tools";
import {
	resolvePythonIntegrationGate as resolveKernelIntegrationGate,
	resolvePythonIpcTrace as resolveKernelIpcTrace,
	resolvePythonSkipCheck as resolveKernelSkipCheck,
} from "../../src/eval/py/env";

const RESOLVERS = [
	{
		kernel: resolveKernelSkipCheck,
		tool: resolvePythonSkipCheck,
		skc: "SKC_PYTHON_SKIP_CHECK",
		pi: "PI_PYTHON_SKIP_CHECK",
	},
	{
		kernel: resolveKernelIpcTrace,
		tool: resolvePythonIpcTrace,
		skc: "SKC_PYTHON_IPC_TRACE",
		pi: "PI_PYTHON_IPC_TRACE",
	},
	{
		kernel: resolveKernelIntegrationGate,
		tool: resolvePythonIntegrationGate,
		skc: "SKC_PYTHON_INTEGRATION",
		pi: "PI_PYTHON_INTEGRATION",
	},
] as const;

describe("Python environment flag resolvers", () => {
	it("shares the kernel resolver with tool exports for hostile SKC/PI values", () => {
		for (const { kernel, tool, skc, pi } of RESOLVERS) {
			expect(tool).toBe(kernel);
			expect(tool({ [skc]: "0", [pi]: "1" })).toBe(true);
			expect(tool({ [skc]: " \tYeS\n" })).toBe(true);
			expect(tool({ [skc]: "false", [pi]: " 0 " })).toBe(false);
		}
	});
});
