import { AsyncLocalStorage } from "node:async_hooks";

const trace = new AsyncLocalStorage<string | undefined>();
/** Diagnostic correlation only; it never supplies execution authority. */
export function withNativeMetadataTraceV1<T>(value: unknown, work: () => T): T {
	return trace.run(
		typeof value === "string" &&
			/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)
			? value
			: undefined,
		work,
	);
}
export async function observeNativeMetadataRpcV1<T>(
	method: "thread/read" | "skills/list",
	work: () => Promise<T>,
): Promise<T> {
	const traceId = trace.getStore();
	const began = performance.now();
	let outcome = "unavailable";
	try {
		const result = await work();
		outcome = "ok";
		return result;
	} finally {
		if (traceId && (method === "thread/read" || method === "skills/list"))
			try {
				console.info(
					JSON.stringify({
						event: "native_metadata_rpc",
						traceId,
						method,
						outcome,
						elapsedMs: Math.max(0, Math.round(performance.now() - began)),
					}),
				);
			} catch {
				/* Logging must never affect the native result. */
			}
	}
}
