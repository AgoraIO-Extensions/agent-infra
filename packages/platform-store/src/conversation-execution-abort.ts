import type postgres from "postgres";
import { awaitTaskAuthorizationQueryV1 } from "./personal-api-task-durable-use.js";

// Only the trusted existing-transaction constructor attaches an admission signal.
// Keep aborted bindings until the transaction object is collected: a late await
// must never lose its cancellation guard and continue SQL after rollback.
const signals = new WeakMap<postgres.TransactionSql, AbortSignal>();

export function bindConversationExecutionSignalV1(
	transaction: postgres.TransactionSql,
	signal: AbortSignal | undefined,
): void {
	if (!signal) return;
	signal.throwIfAborted();
	const existing = signals.get(transaction);
	if (existing && existing !== signal)
		throw new Error("Conversation transaction signal changed");
	signals.set(transaction, signal);
}

export async function awaitConversationExecutionQueryV1<
	T extends readonly (object | undefined)[],
>(
	transaction: postgres.TransactionSql,
	query: postgres.PendingQuery<T>,
): Promise<postgres.RowList<T>> {
	const signal = signals.get(transaction);
	signal?.throwIfAborted();
	return signal ? awaitTaskAuthorizationQueryV1(query, signal) : query;
}
