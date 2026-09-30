import type postgres from "postgres";

export interface PlatformQueueResourceSnapshot {
	readonly taskWaiting: number;
	readonly outboxPending: number;
}

function count(value: unknown): number {
	if (typeof value !== "string" || !/^\d+$/.test(value))
		throw new Error("Platform resource snapshot is unavailable");
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed))
		throw new Error("Platform resource snapshot is unavailable");
	return parsed;
}

/** Read one count SELECT in a read-only transaction with a local query deadline. */
export async function readPlatformQueueResourceSnapshot(
	client: postgres.Sql,
	signal: AbortSignal,
): Promise<PlatformQueueResourceSnapshot> {
	if (signal.aborted)
		throw new Error("Platform resource snapshot is unavailable");
	try {
		return await client.begin("read only", async (transaction) => {
			if (signal.aborted)
				throw new Error("Platform resource snapshot is unavailable");
			await transaction`set local statement_timeout = '2000ms'`;
			if (signal.aborted)
				throw new Error("Platform resource snapshot is unavailable");
			const rows = await transaction<
				{ task_waiting: string; outbox_pending: string }[]
			>`
		select
			(select count(*)::text from platform.conversation_executions
				where status = 'submitted') as task_waiting,
			(select count(*)::text from platform.outbox_items
				where status in ('pending', 'retry_scheduled')) as outbox_pending
	`;
			if (signal.aborted)
				throw new Error("Platform resource snapshot is unavailable");
			if (rows.length !== 1)
				throw new Error("Platform resource snapshot is unavailable");
			return {
				taskWaiting: count(rows[0]?.task_waiting),
				outboxPending: count(rows[0]?.outbox_pending),
			};
		});
	} catch {
		// Sampling errors never expose driver messages, connection details or raw data.
		throw new Error("Platform resource snapshot is unavailable");
	}
}
