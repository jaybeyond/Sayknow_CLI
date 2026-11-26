import { getSkcWorkflowPublicName, resolveSkcWorkflowId } from "../skill-state/canonical-skills";

export function createSkillNameFilter(
	include: readonly string[],
	ignored: readonly string[],
): (name: string) => boolean {
	const includes = include.map(pattern => new Bun.Glob(pattern));
	const excludes = ignored.map(pattern => new Bun.Glob(pattern));
	return name => {
		const id = resolveSkcWorkflowId(name);
		const names = id ? [id, getSkcWorkflowPublicName(id)] : [name];
		const matches = (glob: Bun.Glob) => names.some(spelling => glob.match(spelling));
		return !excludes.some(matches) && (includes.length === 0 || includes.some(matches));
	};
}
