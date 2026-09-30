import type postgres from "postgres";
import { expect, it, vi } from "vitest";
import { readPlatformQueueResourceSnapshot } from "./observability-snapshot.js";

function client(rows: unknown[]) {
	const query = Object.assign(Promise.resolve(rows), { cancel: vi.fn() });
	const sql = vi.fn(() => query) as unknown as postgres.Sql;
	return { sql, query };
}

it("returns one bounded durable snapshot without inspecting business payloads", async () => {
	const { sql } = client([{ task_waiting: "2", outbox_pending: "3" }]);
	await expect(
		readPlatformQueueResourceSnapshot(sql, new AbortController().signal),
	).resolves.toEqual({ taskWaiting: 2, outboxPending: 3 });
	const statement = (sql as unknown as ReturnType<typeof vi.fn>).mock
		.calls[0]?.[0];
	expect(statement.join("")).toContain("platform.conversation_executions");
	expect(statement.join("")).toContain("platform.outbox_items");
	expect(statement.join("")).not.toContain("payload");
});

it.each([
	{ rows: [] },
	{ rows: [{ task_waiting: "0", outbox_pending: "-1" }] },
	{ rows: [{ task_waiting: "9007199254740992", outbox_pending: "0" }] },
	{ rows: [{ task_waiting: null, outbox_pending: "0" }] },
])(
	"rejects incomplete or unsafe counts instead of fabricating zero",
	async ({ rows }) => {
		const { sql } = client(rows);
		await expect(
			readPlatformQueueResourceSnapshot(sql, new AbortController().signal),
		).rejects.toThrow("Platform resource snapshot is unavailable");
	},
);

it("does not issue a query after cancellation", async () => {
	const { sql } = client([{ task_waiting: "1", outbox_pending: "1" }]);
	const controller = new AbortController();
	controller.abort();
	await expect(
		readPlatformQueueResourceSnapshot(sql, controller.signal),
	).rejects.toBeDefined();
	expect(sql).not.toHaveBeenCalled();
});

it("redacts a synchronous client failure before query creation", async () => {
	const sql = vi.fn(() => {
		throw new Error("PRIVATE_DATABASE_SENTINEL");
	}) as unknown as postgres.Sql;
	await expect(
		readPlatformQueueResourceSnapshot(sql, new AbortController().signal),
	).rejects.toThrow(/^Platform resource snapshot is unavailable$/);
});

it("cancels an active query and reports a bounded unavailable error", async () => {
	let reject: (error: Error) => void = () => {};
	const cancel = vi.fn(() => reject(new Error("PRIVATE_DATABASE_SENTINEL")));
	const query = Object.assign(
		new Promise((_, fail) => {
			reject = fail;
		}),
		{ cancel },
	);
	const sql = vi.fn(() => query) as unknown as postgres.Sql;
	const controller = new AbortController();
	const pending = readPlatformQueueResourceSnapshot(sql, controller.signal);
	controller.abort();
	await expect(pending).rejects.toThrow(
		"Platform resource snapshot is unavailable",
	);
	expect(cancel).toHaveBeenCalledOnce();
});
