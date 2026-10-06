/** Wrapper → the tool it forwards to. Only wrappers built by applyToolProxy are recorded. */
const proxiedTools = new WeakMap<object, object>();

/** The innermost tool behind any chain of applyToolProxy wrappers. */
export function unwrapProxiedTool(tool: object): object {
	let current = tool;
	for (let next = proxiedTools.get(current); next !== undefined; next = proxiedTools.get(current)) current = next;
	return current;
}

/**
 * Defines lazy proxy properties on a wrapper so it forwards to the underlying tool.
 */
export function applyToolProxy<TTool extends object>(tool: TTool, wrapper: object): void {
	proxiedTools.set(wrapper, tool);
	const visited = new Set<PropertyKey>();
	let current: object | null = tool;

	while (current && current !== Object.prototype) {
		for (const key of Reflect.ownKeys(current)) {
			if (key === "constructor" || visited.has(key) || key in wrapper) {
				continue;
			}
			visited.add(key);
			Object.defineProperty(wrapper, key, {
				get() {
					const value = (tool as Record<PropertyKey, unknown>)[key];
					return typeof value === "function" ? value.bind(tool) : value;
				},
				enumerable: true,
				configurable: true,
			});
		}
		current = Object.getPrototypeOf(current);
	}
}
