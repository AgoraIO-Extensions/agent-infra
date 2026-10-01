import type postgres from "postgres";
import { TaskAuthorizationStoreError } from "./task-authorization.js";

/** Abort cancels the real SQL; callers await this and then their original begin rollback. */
export async function awaitTaskAuthorizationQueryV1<
	T extends readonly (object | undefined)[],
>(
	query: postgres.PendingQuery<T>,
	signal: AbortSignal,
): Promise<postgres.RowList<T>> {
	if (signal.aborted) throw new TaskAuthorizationStoreError();
	const cancel = () => query.cancel();
	signal.addEventListener("abort", cancel, { once: true });
	if (signal.aborted) cancel();
	try {
		const rows = await query;
		if (signal.aborted) throw new TaskAuthorizationStoreError();
		return rows;
	} catch {
		throw new TaskAuthorizationStoreError();
	} finally {
		signal.removeEventListener("abort", cancel);
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
