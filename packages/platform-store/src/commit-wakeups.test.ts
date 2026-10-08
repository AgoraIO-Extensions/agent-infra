import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	ConversationEventWakeHubV1,
	outboxWakeChannelV1,
	PostgresCommitWakeupListenerV1,
} from "./commit-wakeups.ts";
import { migratePlatformDatabase } from "./migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

let database: PostgresTestDatabase | undefined;
let client: ReturnType<typeof postgres>;

beforeAll(async () => {
	database = await startPostgresTestDatabase("commit-wakeups");
	client = postgres(database.databaseUrl, { max: 2 });
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
});

afterAll(async () => {
	await client?.end();
	await database?.stop();
});

describe("outbox commit wakeups (#1561)", () => {
	let next = 0;
	const insert = (
		availableAt: "now" | "infinity" | Date,
		status = "pending",
	) => {
		const id = `conversation:turn:wake-${next++}`;
		const at =
			availableAt === "now"
				? client`now()`
				: availableAt === "infinity"
					? client`'infinity'::timestamptz`
					: availableAt;
		return client`
			insert into platform.outbox_items
				(id, scope_type, scope_id, operation, payload, status, trace_id,
				 request_id, available_at, created_at, updated_at)
			values (${id}, 'conversation', 'conversation-wake',
				'conversation.turn.submit.v1', ${client.json({ schemaVersion: 1 })},
				${status}, 'trace-wake', 'request-wake', ${at},
				now(), now())
			returning id
		`;
	};
	const quiet = () => client`select pg_sleep(0.3)`;

	it("wakes after a committed available item, never before commit or for later work", async () => {
		const woken: string[] = [];
		const listener = new PostgresCommitWakeupListenerV1({
			databaseUrl: database?.databaseUrl ?? "",
			channel: outboxWakeChannelV1,
			onWake: (payload) => woken.push(payload),
		});
		await listener.start();
		try {
			await expect(
				client.begin(async (transaction) => {
					await transaction`
						insert into platform.outbox_items
							(id, scope_type, scope_id, operation, payload, trace_id,
							 request_id, available_at, created_at, updated_at)
						values ('conversation:turn:wake-rollback', 'conversation',
							'conversation-wake', 'conversation.turn.submit.v1',
							${transaction.json({ schemaVersion: 1 })}, 'trace', 'request',
							now(), now(), now())`;
					throw new Error("rollback");
				}),
			).rejects.toThrow("rollback");
			// A waiting task and a delayed retry are not available yet.
			await insert("infinity");
			const [delayed] = await insert(
				new Date("2999-01-01T00:00:00Z"),
				"retry_scheduled",
			);
			await quiet();
			expect(woken).toEqual([]);
			// A retry that becomes due wakes once, as does a new pending item.
			await client`
				update platform.outbox_items set available_at = now()
				where id = ${delayed?.id ?? ""}`;
			await expect.poll(() => woken, { timeout: 5_000 }).toEqual([""]);
			await insert("now");
			await expect.poll(() => woken, { timeout: 5_000 }).toEqual(["", ""]);
		} finally {
			await listener.close();
		}
	});
});

describe("Conversation event wake hub (#1561)", () => {
	it("returns the first wait at once, then waits for that Conversation only", async () => {
		const hub = new ConversationEventWakeHubV1();
		const watcher = hub.watch("conversation-a");
		const signal = new AbortController().signal;
		await expect(watcher.wait(10_000, signal)).resolves.toBe("woken");
		const pending = watcher.wait(10_000, signal);
		hub.notify("conversation-b");
		hub.notify("conversation-a");
		await expect(pending).resolves.toBe("woken");
		await expect(watcher.wait(5, signal)).resolves.toBe("timeout");
		watcher.close();
		expect(hub.watchedConversations).toBe(0);
	});

	it("keeps a wakeup that arrives between waits and rejects on abort", async () => {
		const hub = new ConversationEventWakeHubV1();
		const watcher = hub.watch("conversation-a");
		const controller = new AbortController();
		await watcher.wait(10_000, controller.signal);
		hub.notify("conversation-a");
		await expect(watcher.wait(10_000, controller.signal)).resolves.toBe(
			"woken",
		);
		const aborted = watcher.wait(10_000, controller.signal);
		controller.abort(new Error("stream closed"));
		await expect(aborted).rejects.toThrow("stream closed");
		watcher.close();
	});
});
