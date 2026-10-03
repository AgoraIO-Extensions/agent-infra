import type postgres from "postgres";
import { TaskAuthorizationStoreError } from "./task-authorization.js";

/** The original runner owns backend cancellation; await its SQL outcome and rollback. */
export async function awaitTaskAuthorizationQueryV1<
	T extends readonly (object | undefined)[],
>(
	query: postgres.PendingQuery<T>,
	signal: AbortSignal,
): Promise<postgres.RowList<T>> {
	if (signal.aborted) throw new TaskAuthorizationStoreError();
	try {
		const rows = await query;
		if (signal.aborted) throw new TaskAuthorizationStoreError();
		return rows;
	} catch {
		throw new TaskAuthorizationStoreError();
	}
}

/** The bounded signal comes from the original transaction runner, never a caller field. */
export async function awaitTaskAuthorizationDependencyV1<T>(
	read: () => Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	if (signal.aborted) throw new TaskAuthorizationStoreError();
	let abort: (() => void) | undefined;
	try {
		const cancelled = new Promise<never>((_, reject) => {
			abort = () => reject(new TaskAuthorizationStoreError());
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
		});
		const result = await Promise.race([read(), cancelled]);
		if (signal.aborted) throw new TaskAuthorizationStoreError();
		return result;
	} catch {
		throw new TaskAuthorizationStoreError();
	} finally {
		if (abort) signal.removeEventListener("abort", abort);
	}
}
