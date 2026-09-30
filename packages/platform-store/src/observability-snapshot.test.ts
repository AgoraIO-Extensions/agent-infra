import type postgres from "postgres";
import { expect, it, vi } from "vitest";
import { readPlatformQueueResourceSnapshot } from "./index.js";

function client(query: Promise<unknown[]>) {
	const cancellable = <T>(value: Promise<T>) =>
		Object.assign(value, { cancel: vi.fn() });
	const transaction = vi.fn((statement: TemplateStringsArray) =>
		statement.join("").includes("set local")
			? cancellable(Promise.resolve([]))
			: cancellable(query),
	);
	const begin = vi.fn(async (_mode, read) => read(transaction));
	const sql = Object.assign(vi.fn(), { begin }) as unknown as postgres.Sql;
	return { sql, transaction, begin };
}

it("returns one bounded durable snapshot without inspecting business payloads", async () => {
	const { sql, transaction, begin } = client(
		Promise.resolve([{ task_waiting: "2", outbox_pending: "3" }]),
	);
	await expect(
		readPlatformQueueResourceSnapshot(sql, new AbortController().signal),
	).resolves.toEqual({ taskWaiting: 2, outboxPending: 3 });
	expect(begin.mock.calls[0]?.[0]).toBe("read only");
	const statement = transaction.mock.calls[1]?.[0];
	const query = statement?.join("");
	expect(query).toContain("platform.conversation_executions");
	expect(query).toContain("platform.outbox_items");
	expect(query).toContain("count(distinct e.execution_id)");
	expect(query).toContain("conversation.turn.submit.v1");
	expect(query).toContain("conversation.turn.regenerate.v1");
	expect(query).toContain("platform.conversation_messages");
	expect(query).toContain("platform.conversation_stops");
	expect(query).toContain("platform.task_authorization_records");
	expect(query).toContain("platform.conversation_generation_tombstones");
	expect(query).toContain("metadataRecovery");
	// The query only compares payload bindings and never selects business text.
	expect(query).not.toContain("m.text");
	expect(query).not.toContain("payload,");
});

it.each([
	{ rows: [] },
	{ rows: [{ task_waiting: "0", outbox_pending: "-1" }] },
	{ rows: [{ task_waiting: "9007199254740992", outbox_pending: "0" }] },
	{ rows: [{ task_waiting: null, outbox_pending: "0" }] },
])(
	"rejects incomplete or unsafe counts instead of fabricating zero",
	async ({ rows }) => {
		const { sql } = client(Promise.resolve(rows));
		await expect(
			readPlatformQueueResourceSnapshot(sql, new AbortController().signal),
		).rejects.toThrow("Platform resource snapshot is unavailable");
	},
);

it("does not issue a query after cancellation", async () => {
	const { sql, begin } = client(
		Promise.resolve([{ task_waiting: "1", outbox_pending: "1" }]),
	);
	const controller = new AbortController();
	controller.abort();
	await expect(
		readPlatformQueueResourceSnapshot(sql, controller.signal),
	).rejects.toBeDefined();
	expect(sql).not.toHaveBeenCalled();
	expect(begin).not.toHaveBeenCalled();
});

it("redacts a synchronous client failure before query creation", async () => {
	const sql = Object.assign(vi.fn(), {
		begin: vi.fn(() => {
			throw new Error("PRIVATE_DATABASE_SENTINEL");
		}),
	}) as unknown as postgres.Sql;
	await expect(
		readPlatformQueueResourceSnapshot(sql, new AbortController().signal),
	).rejects.toThrow(/^Platform resource snapshot is unavailable$/);
});

it("rejects late query results after cancellation without cancelling a shared connection", async () => {
	let resolve: (rows: unknown[]) => void = () => {};
	const query = new Promise<unknown[]>((done) => {
		resolve = done;
	});
	const { sql, transaction } = client(query);
	const controller = new AbortController();
	const pending = readPlatformQueueResourceSnapshot(sql, controller.signal);
	await vi.waitFor(() => expect(transaction).toHaveBeenCalledTimes(2));
	controller.abort();
	resolve([{ task_waiting: "1", outbox_pending: "1" }]);
	await expect(pending).rejects.toThrow(
		"Platform resource snapshot is unavailable",
	);
});

it("rejects while waiting for a pooled connection", async () => {
	let resolveBegin: (() => void) | undefined;
	const begin = vi.fn(() => {
		if (begin.mock.calls.length > 1) return Promise.resolve();
		return new Promise<void>((resolve) => {
			resolveBegin = resolve;
		});
	});
	const sql = Object.assign(vi.fn(), { begin }) as unknown as postgres.Sql;
	const controller = new AbortController();
	const pending = readPlatformQueueResourceSnapshot(sql, controller.signal);
	await vi.waitFor(() => expect(begin).toHaveBeenCalledTimes(1));
	controller.abort();
	await expect(pending).rejects.toThrow(
		"Platform resource snapshot is unavailable",
	);
	await expect(
		readPlatformQueueResourceSnapshot(sql, new AbortController().signal),
	).rejects.toThrow("Platform resource snapshot is unavailable");
	expect(begin).toHaveBeenCalledTimes(1);
	resolveBegin?.();
	await Promise.resolve();
	await expect(
		readPlatformQueueResourceSnapshot(sql, new AbortController().signal),
	).resolves.toBeUndefined();
	expect(begin).toHaveBeenCalledTimes(2);
});

it("cancels an active snapshot query on abort", async () => {
	let rejectCount: ((error: Error) => void) | undefined;
	const setQuery = Object.assign(Promise.resolve([]), { cancel: vi.fn() });
	const cancelCount = vi.fn(() => rejectCount?.(new Error("query cancelled")));
	const countQuery = Object.assign(
		new Promise<unknown[]>((_, reject) => {
			rejectCount = reject;
		}),
		{ cancel: cancelCount },
	);
	const transaction = vi.fn((statement: TemplateStringsArray) =>
		statement.join("").includes("set local") ? setQuery : countQuery,
	);
	const begin = vi.fn(
		async (
			_mode: "read only",
			read: (sql: postgres.TransactionSql) => Promise<unknown>,
		) => read(transaction as unknown as postgres.TransactionSql),
	);
	const sql = Object.assign(vi.fn(), { begin }) as unknown as postgres.Sql;
	const controller = new AbortController();
	const pending = readPlatformQueueResourceSnapshot(sql, controller.signal);
	await vi.waitFor(() => expect(transaction).toHaveBeenCalledTimes(2));
	controller.abort();
	await expect(pending).rejects.toThrow(
		"Platform resource snapshot is unavailable",
	);
	expect(cancelCount).toHaveBeenCalledTimes(1);
	expect(setQuery.cancel).not.toHaveBeenCalled();
});

it("bounds a queued connection wait by the operation deadline", async () => {
	vi.useFakeTimers();
	try {
		let resolveBegin: (() => void) | undefined;
		const begin = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveBegin = resolve;
				}),
		);
		const sql = Object.assign(vi.fn(), { begin }) as unknown as postgres.Sql;
		const pending = readPlatformQueueResourceSnapshot(
			sql,
			new AbortController().signal,
		);
		const rejection = expect(pending).rejects.toThrow(
			"Platform resource snapshot is unavailable",
		);
		await vi.advanceTimersByTimeAsync(2000);
		await rejection;
		resolveBegin?.();
		await Promise.resolve();
	} finally {
		vi.useRealTimers();
	}
});
