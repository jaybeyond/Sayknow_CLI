// Reports the trusted-home resolution under the launched environment. A
// successful resolution prints {"ok":true,...}; when the resolver marks user
// state unavailable (the fail-closed state), getTrustedHomeDir() throws
// inside the try block and the refusal is printed as {"ok":false,...} on
// stdout so the parent can assert on the child's own outcome.
import { getConfigRootDir, getTrustedHomeDir } from "../../src/dirs";

try {
	console.log(JSON.stringify({ ok: true, trustedHome: getTrustedHomeDir(), configRoot: getConfigRootDir() }));
} catch (error) {
	console.log(JSON.stringify({ ok: false, error: String(error) }));
}
