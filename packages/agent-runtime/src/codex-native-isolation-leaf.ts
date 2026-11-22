/**
 * Engineering Spec §18.5.2 原生验证叶子 and #4358 AC-3 ("或如实 UNPROVEN"): Codex has no
 * verifiable seam in M1 that runs a fixed helper inside the original native tool's execution
 * domain and joins its result to one native item and operation/attempt. The Codex native leaf
 * is therefore always UNPROVEN/unsupported: no helper is installed, no result channel exists
 * and no Codex code path can produce `allowed`, `denied` or `isolation_violation`.
 *
 * A future positive leaf first needs its own Spec/HLD change (producer execution domain,
 * protected result channel, unique native item/attempt join, replay protection).
 */
export type CodexNativeIsolationResourceClassV1 =
	| "file"
	| "env"
	| "proc"
	| "workspace"
	| "memory_file";

export const codexNativeIsolationLeafV1 = Object.freeze({
	adapter: "codex",
	status: "unsupported",
} as const);

export function codexNativeIsolationLeafResultV1(
	resourceClass: CodexNativeIsolationResourceClassV1,
): {
	readonly resourceClass: CodexNativeIsolationResourceClassV1;
	readonly resultClass: "unproven";
	readonly failureClass: "unsupported";
	readonly nativeObserved: false;
} {
	return Object.freeze({
		resourceClass,
		resultClass: "unproven",
		failureClass: "unsupported",
		nativeObserved: false,
	});
}
