import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";

const builtStore: typeof import("./index.ts") = await import(
	new URL("../dist/index.mjs", import.meta.url).href
);

let testDatabase: PostgresTestDatabase | undefined;

beforeAll(async () => {
	testDatabase = await startPostgresTestDatabase("platform-store-outbox");
	await builtStore.migratePlatformDatabase({
		databaseUrl: testDatabase.databaseUrl,
	});
}, 120_000);

afterAll(async () => testDatabase?.stop());

describe("PostgreSQL outbox store", () => {
	it("rejects malformed runtime inputs with stable validation errors", async () => {
		if (!testDatabase)
			throw new Error("PostgreSQL test database is unavailable");
		expect(() => builtStore.createPostgresOutboxStore(null as never)).toThrow(
			"input must be an object",
		);
		expect(() =>
			builtStore.createPostgresOutboxStore({ databaseUrl: "https://db" }),
		).toThrow("PLATFORM_DATABASE_URL must be a PostgreSQL URL");

		const store = builtStore.createPostgresOutboxStore({
			databaseUrl: testDatabase.databaseUrl,
		});
		try {
			await expect(
				store.claim({
					itemId: "outbox-input",
					leaseOwner: null,
					now: new Date("2026-08-30T00:00:00.000Z"),
					leaseExpiresAt: new Date("2026-08-30T00:01:00.000Z"),
				} as never),
			).rejects.toThrow("leaseOwner must be a non-empty string");
			await expect(
				store.claim({
					itemId: "outbox-input",
					leaseOwner: "worker-a",
					now: "2026-08-30T00:00:00.000Z",
					leaseExpiresAt: new Date("2026-08-30T00:01:00.000Z"),
				} as never),
			).rejects.toThrow("now must be a valid Date");
			await expect(
				store.renew({
					itemId: "outbox-input",
					leaseOwner: "worker-a",
					deliveryFence: 1,
					now: new Date("2026-08-30T00:00:00.000Z"),
					leaseExpiresAt: new Date("2026-08-30T00:01:00.000Z"),
				} as never),
			).rejects.toThrow("deliveryFence must be a positive bigint");
		} finally {
			await store.close();
		}
	});

	it("gives concurrent claimers one owner and protects its live lease", async () => {
		if (!testDatabase)
			throw new Error("PostgreSQL test database is unavailable");
		const setup = postgres(testDatabase.databaseUrl, { max: 1 });
		await setup`
			insert into platform.outbox_items
				(id, scope_type, scope_id, operation, payload, available_at, trace_id)
			values
				('outbox-race', 'agent', 'agent-1', 'reconcile', ${setup.json({ revision: 3 })},
				 ${new Date("2026-08-30T00:00:00.000Z")}, 'trace-race')
		`;
		await setup.end();

		const first = builtStore.createPostgresOutboxStore({
			databaseUrl: testDatabase.databaseUrl,
		});
		const second = builtStore.createPostgresOutboxStore({
			databaseUrl: testDatabase.databaseUrl,
		});
		try {
			const now = new Date("2026-08-30T00:01:00.000Z");
			const leaseExpiresAt = new Date("2026-08-30T00:02:00.000Z");
			const claims = await Promise.all([
				first.claim({
					itemId: "outbox-race",
					leaseOwner: "worker-a",
					now,
					leaseExpiresAt,
				}),
				second.claim({
					itemId: "outbox-race",
					leaseOwner: "worker-b",
					now,
					leaseExpiresAt,
				}),
			]);
			const winner = claims.find((claim) => claim !== null);
			expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
			expect(winner).toMatchObject({
				itemId: "outbox-race",
				payload: { revision: 3 },
				attemptCount: 1,
				deliveryFence: 1n,
				leaseExpiresAt,
			});

			const losingStore = winner?.leaseOwner === "worker-a" ? second : first;
			expect(
				await losingStore.claim({
					itemId: "outbox-race",
					leaseOwner: "worker-c",
					now: new Date("2026-08-30T00:01:30.000Z"),
					leaseExpiresAt: new Date("2026-08-30T00:03:00.000Z"),
				}),
			).toBeNull();
		} finally {
			await Promise.all([first.close(), second.close()]);
		}
	});

	it("renews a live lease and fences its expired owner after takeover", async () => {
		if (!testDatabase)
			throw new Error("PostgreSQL test database is unavailable");
		const setup = postgres(testDatabase.databaseUrl, { max: 1 });
		await setup`
			insert into platform.outbox_items
				(id, scope_type, scope_id, operation, payload, available_at, trace_id)
			values
				('outbox-takeover', 'agent', 'agent-2', 'reconcile', '{}',
				 ${new Date("2026-08-30T01:00:00.000Z")}, 'trace-takeover')
		`;
		await setup.end();

		const first = builtStore.createPostgresOutboxStore({
			databaseUrl: testDatabase.databaseUrl,
		});
		const second = builtStore.createPostgresOutboxStore({
			databaseUrl: testDatabase.databaseUrl,
		});
		try {
			const firstClaim = await first.claim({
				itemId: "outbox-takeover",
				leaseOwner: "worker-a",
				now: new Date("2026-08-30T01:01:00.000Z"),
				leaseExpiresAt: new Date("2026-08-30T01:02:00.000Z"),
			});
			expect(firstClaim?.deliveryFence).toBe(1n);
			expect(
				await first.renew({
					itemId: "outbox-takeover",
					leaseOwner: "worker-a",
					deliveryFence: 1n,
					now: new Date("2026-08-30T01:01:30.000Z"),
					leaseExpiresAt: new Date("2026-08-30T01:03:00.000Z"),
				}),
			).toMatchObject({
				itemId: "outbox-takeover",
				deliveryFence: 1n,
				leaseExpiresAt: new Date("2026-08-30T01:03:00.000Z"),
			});
			expect(
				await second.claim({
					itemId: "outbox-takeover",
					leaseOwner: "worker-b",
					now: new Date("2026-08-30T01:02:30.000Z"),
					leaseExpiresAt: new Date("2026-08-30T01:04:00.000Z"),
				}),
			).toBeNull();

			const takeover = await second.claim({
				itemId: "outbox-takeover",
				leaseOwner: "worker-b",
				now: new Date("2026-08-30T01:03:00.000Z"),
				leaseExpiresAt: new Date("2026-08-30T01:04:00.000Z"),
			});
			expect(takeover).toMatchObject({
				attemptCount: 2,
				deliveryFence: 2n,
				leaseOwner: "worker-b",
			});
			expect(
				await first.renew({
					itemId: "outbox-takeover",
					leaseOwner: "worker-a",
					deliveryFence: 1n,
					now: new Date("2026-08-30T01:03:01.000Z"),
					leaseExpiresAt: new Date("2026-08-30T01:05:00.000Z"),
				}),
			).toBeNull();
		} finally {
			await Promise.all([first.close(), second.close()]);
		}
	});

	it("schedules one sanitized retry that becomes claimable at its due time", async () => {
		if (!testDatabase)
			throw new Error("PostgreSQL test database is unavailable");
		const setup = postgres(testDatabase.databaseUrl, { max: 1 });
		await setup`
			insert into platform.outbox_items
				(id, scope_type, scope_id, operation, payload, available_at, trace_id)
			values
				('outbox-retry', 'agent', 'agent-3', 'deploy',
				 ${setup.json({ command: "deploy" })},
				 ${new Date("2026-08-30T02:00:00.000Z")}, 'trace-retry')
		`;

		const first = builtStore.createPostgresOutboxStore({
			databaseUrl: testDatabase.databaseUrl,
		});
		const second = builtStore.createPostgresOutboxStore({
			databaseUrl: testDatabase.databaseUrl,
		});
		try {
			await first.claim({
				itemId: "outbox-retry",
				leaseOwner: "worker-a",
				now: new Date("2026-08-30T02:01:00.000Z"),
				leaseExpiresAt: new Date("2026-08-30T02:10:00.000Z"),
			});
			await expect(
				first.scheduleRetry({
					itemId: "outbox-retry",
					leaseOwner: "worker-a",
					deliveryFence: 1n,
					now: new Date("2026-08-30T02:02:00.000Z"),
					availableAt: new Date("2026-08-30T02:05:00.000Z"),
					errorCode: "RUNTIME_UNAVAILABLE",
					message: "raw runtime detail",
				} as never),
			).rejects.toThrow("scheduleRetry input contains unsupported fields");
			await expect(
				first.scheduleRetry({
					itemId: "outbox-retry",
					leaseOwner: "worker-a",
					deliveryFence: 1n,
					now: new Date("2026-08-30T02:02:00.000Z"),
					availableAt: new Date("2026-08-30T02:05:00.000Z"),
					errorCode: "runtime failed with details",
				}),
			).rejects.toThrow("errorCode must be a symbolic code");

			const scheduled = await first.scheduleRetry({
				itemId: "outbox-retry",
				leaseOwner: "worker-a",
				deliveryFence: 1n,
				now: new Date("2026-08-30T02:02:00.000Z"),
				availableAt: new Date("2026-08-30T02:05:00.000Z"),
				errorCode: "RUNTIME_UNAVAILABLE",
			});
			expect(scheduled).toEqual({
				itemId: "outbox-retry",
				status: "retry_scheduled",
				attemptCount: 1,
				deliveryFence: 1n,
				availableAt: new Date("2026-08-30T02:05:00.000Z"),
			});
			expect(
				await first.scheduleRetry({
					itemId: "outbox-retry",
					leaseOwner: "worker-a",
					deliveryFence: 1n,
					now: new Date("2026-08-30T02:02:01.000Z"),
					availableAt: new Date("2026-08-30T02:05:00.000Z"),
					errorCode: "RUNTIME_UNAVAILABLE",
				}),
			).toBeNull();
			expect(
				await second.claim({
					itemId: "outbox-retry",
					leaseOwner: "worker-b",
					now: new Date("2026-08-30T02:04:59.999Z"),
					leaseExpiresAt: new Date("2026-08-30T02:10:00.000Z"),
				}),
			).toBeNull();

			const retryClaim = await second.claim({
				itemId: "outbox-retry",
				leaseOwner: "worker-b",
				now: new Date("2026-08-30T02:05:00.000Z"),
				leaseExpiresAt: new Date("2026-08-30T02:10:00.000Z"),
			});
			expect(retryClaim).toMatchObject({
				payload: { command: "deploy" },
				attemptCount: 2,
				deliveryFence: 2n,
				leaseOwner: "worker-b",
			});

			const events = await setup`
				select event_id, stream_id, sequence::text, stream_cursor::text,
					event_type, payload, trace_id, occurred_at
				from platform.persisted_events
				where stream_id = 'outbox:outbox-retry'
			`;
			expect([...events]).toEqual([
				{
					event_id: "outbox:outbox-retry:1",
					stream_id: "outbox:outbox-retry",
					sequence: "1",
					stream_cursor: "1",
					event_type: "outbox.retry_scheduled",
					payload: {
						attemptCount: 1,
						deliveryFence: "1",
						errorCode: "RUNTIME_UNAVAILABLE",
					},
					trace_id: "trace-retry",
					occurred_at: new Date("2026-08-30T02:02:00.000Z"),
				},
			]);
		} finally {
			await Promise.all([first.close(), second.close(), setup.end()]);
		}
	});

	it("rejects stale completion and records one successful terminal transition", async () => {
		if (!testDatabase)
			throw new Error("PostgreSQL test database is unavailable");
		const setup = postgres(testDatabase.databaseUrl, { max: 1 });
		await setup`
			insert into platform.outbox_items
				(id, scope_type, scope_id, operation, payload, available_at, trace_id)
			values
				('outbox-success', 'agent', 'agent-4', 'deploy', '{}',
				 ${new Date("2026-08-30T03:00:00.000Z")}, 'trace-success')
		`;

		const first = builtStore.createPostgresOutboxStore({
			databaseUrl: testDatabase.databaseUrl,
		});
		const second = builtStore.createPostgresOutboxStore({
			databaseUrl: testDatabase.databaseUrl,
		});
		try {
			await first.claim({
				itemId: "outbox-success",
				leaseOwner: "worker-a",
				now: new Date("2026-08-30T03:01:00.000Z"),
				leaseExpiresAt: new Date("2026-08-30T03:02:00.000Z"),
			});
			await second.claim({
				itemId: "outbox-success",
				leaseOwner: "worker-b",
				now: new Date("2026-08-30T03:02:00.000Z"),
				leaseExpiresAt: new Date("2026-08-30T03:05:00.000Z"),
			});

			expect(
				await first.markSucceeded({
					itemId: "outbox-success",
					leaseOwner: "worker-a",
					deliveryFence: 1n,
					now: new Date("2026-08-30T03:02:01.000Z"),
				}),
			).toBeNull();
			expect(
				await second.markSucceeded({
					itemId: "outbox-success",
					leaseOwner: "worker-b",
					deliveryFence: 2n,
					now: new Date("2026-08-30T03:03:00.000Z"),
				}),
			).toEqual({
				itemId: "outbox-success",
				status: "succeeded",
				attemptCount: 2,
				deliveryFence: 2n,
			});
			expect(
				await second.markSucceeded({
					itemId: "outbox-success",
					leaseOwner: "worker-b",
					deliveryFence: 2n,
					now: new Date("2026-08-30T03:03:01.000Z"),
				}),
			).toBeNull();
			expect(
				await first.claim({
					itemId: "outbox-success",
					leaseOwner: "worker-c",
					now: new Date("2026-08-30T04:00:00.000Z"),
					leaseExpiresAt: new Date("2026-08-30T04:01:00.000Z"),
				}),
			).toBeNull();

			const events = await setup`
				select event_id, stream_id, sequence::text, stream_cursor::text,
					event_type, payload, trace_id, occurred_at
				from platform.persisted_events
				where stream_id = 'outbox:outbox-success'
			`;
			expect([...events]).toEqual([
				{
					event_id: "outbox:outbox-success:2",
					stream_id: "outbox:outbox-success",
					sequence: "2",
					stream_cursor: "2",
					event_type: "outbox.succeeded",
					payload: { attemptCount: 2, deliveryFence: "2" },
					trace_id: "trace-success",
					occurred_at: new Date("2026-08-30T03:03:00.000Z"),
				},
			]);
		} finally {
			await Promise.all([first.close(), second.close(), setup.end()]);
		}
	});

	it("records one sanitized terminal failure and keeps it terminal", async () => {
		if (!testDatabase)
			throw new Error("PostgreSQL test database is unavailable");
		const setup = postgres(testDatabase.databaseUrl, { max: 1 });
		await setup`
			insert into platform.outbox_items
				(id, scope_type, scope_id, operation, payload, available_at, trace_id)
			values
				('outbox-failure', 'agent', 'agent-5', 'deploy', '{}',
				 ${new Date("2026-08-30T04:00:00.000Z")}, 'trace-failure')
		`;

		const store = builtStore.createPostgresOutboxStore({
			databaseUrl: testDatabase.databaseUrl,
		});
		try {
			await store.claim({
				itemId: "outbox-failure",
				leaseOwner: "worker-a",
				now: new Date("2026-08-30T04:01:00.000Z"),
				leaseExpiresAt: new Date("2026-08-30T04:10:00.000Z"),
			});
			await expect(
				store.markFailed({
					itemId: "outbox-failure",
					leaseOwner: "worker-a",
					deliveryFence: 1n,
					now: new Date("2026-08-30T04:02:00.000Z"),
					errorCode: "secret=should-not-persist",
				}),
			).rejects.toThrow("errorCode must be a symbolic code");
			expect(
				await store.markFailed({
					itemId: "outbox-failure",
					leaseOwner: "worker-a",
					deliveryFence: 1n,
					now: new Date("2026-08-30T04:02:00.000Z"),
					errorCode: "DEPLOYMENT_REJECTED",
				}),
			).toEqual({
				itemId: "outbox-failure",
				status: "failed",
				attemptCount: 1,
				deliveryFence: 1n,
			});
			expect(
				await store.markFailed({
					itemId: "outbox-failure",
					leaseOwner: "worker-a",
					deliveryFence: 1n,
					now: new Date("2026-08-30T04:02:01.000Z"),
					errorCode: "DEPLOYMENT_REJECTED",
				}),
			).toBeNull();
			expect(
				await store.markSucceeded({
					itemId: "outbox-failure",
					leaseOwner: "worker-a",
					deliveryFence: 1n,
					now: new Date("2026-08-30T04:02:01.000Z"),
				}),
			).toBeNull();
			expect(
				await store.claim({
					itemId: "outbox-failure",
					leaseOwner: "worker-b",
					now: new Date("2026-08-30T05:00:00.000Z"),
					leaseExpiresAt: new Date("2026-08-30T05:01:00.000Z"),
				}),
			).toBeNull();

			const events = await setup`
				select event_id, stream_id, sequence::text, stream_cursor::text,
					event_type, payload, trace_id, occurred_at
				from platform.persisted_events
				where stream_id = 'outbox:outbox-failure'
			`;
			expect([...events]).toEqual([
				{
					event_id: "outbox:outbox-failure:1",
					stream_id: "outbox:outbox-failure",
					sequence: "1",
					stream_cursor: "1",
					event_type: "outbox.failed",
					payload: {
						attemptCount: 1,
						deliveryFence: "1",
						errorCode: "DEPLOYMENT_REJECTED",
					},
					trace_id: "trace-failure",
					occurred_at: new Date("2026-08-30T04:02:00.000Z"),
				},
			]);
		} finally {
			await Promise.all([store.close(), setup.end()]);
		}
	});

	it("rolls back a transition when its attempt event cannot commit", async () => {
		if (!testDatabase)
			throw new Error("PostgreSQL test database is unavailable");
		const setup = postgres(testDatabase.databaseUrl, { max: 1 });
		await setup`
			insert into platform.outbox_items
				(id, scope_type, scope_id, operation, payload, available_at, trace_id)
			values
				('outbox-crash', 'agent', 'agent-6', 'deploy', '{}',
				 ${new Date("2026-08-30T05:00:00.000Z")}, 'trace-crash')
		`;

		const store = builtStore.createPostgresOutboxStore({
			databaseUrl: testDatabase.databaseUrl,
		});
		try {
			await store.claim({
				itemId: "outbox-crash",
				leaseOwner: "worker-a",
				now: new Date("2026-08-30T05:01:00.000Z"),
				leaseExpiresAt: new Date("2026-08-30T05:10:00.000Z"),
			});
			await setup`
				insert into platform.persisted_events
					(event_id, stream_id, sequence, stream_cursor, event_type,
					 payload, trace_id, occurred_at)
				values
					('outbox:outbox-crash:1', 'outbox:outbox-crash', 1, 1,
					 'outbox.test_collision', '{}', 'trace-crash',
					 ${new Date("2026-08-30T05:01:30.000Z")})
			`;

			const failedTransition = await store
				.scheduleRetry({
					itemId: "outbox-crash",
					leaseOwner: "worker-a",
					deliveryFence: 1n,
					now: new Date("2026-08-30T05:02:00.000Z"),
					availableAt: new Date("2026-08-30T05:05:00.000Z"),
					errorCode: "RUNTIME_UNAVAILABLE",
				})
				.catch((error: unknown) => error);
			expect(failedTransition).toMatchObject({
				name: "OutboxStoreError",
				code: "OUTBOX_STORE_ERROR",
				message: "Outbox store operation failed",
				retryable: false,
			});
			expect(failedTransition).not.toHaveProperty("constraint_name");
			expect(failedTransition).not.toHaveProperty("cause");
			expect(
				await store.renew({
					itemId: "outbox-crash",
					leaseOwner: "worker-a",
					deliveryFence: 1n,
					now: new Date("2026-08-30T05:02:01.000Z"),
					leaseExpiresAt: new Date("2026-08-30T05:20:00.000Z"),
				}),
			).toMatchObject({
				itemId: "outbox-crash",
				deliveryFence: 1n,
				leaseOwner: "worker-a",
			});

			await setup`
				delete from platform.persisted_events
				where event_id = 'outbox:outbox-crash:1'
			`;
			expect(
				await store.scheduleRetry({
					itemId: "outbox-crash",
					leaseOwner: "worker-a",
					deliveryFence: 1n,
					now: new Date("2026-08-30T05:03:00.000Z"),
					availableAt: new Date("2026-08-30T05:05:00.000Z"),
					errorCode: "RUNTIME_UNAVAILABLE",
				}),
			).toMatchObject({ status: "retry_scheduled", deliveryFence: 1n });
		} finally {
			await Promise.all([store.close(), setup.end()]);
		}
	});

	it("classifies an unavailable PostgreSQL connection as safely retryable", async () => {
		const unavailableDatabase = await startPostgresTestDatabase(
			"platform-store-unavailable",
		);
		const store = builtStore.createPostgresOutboxStore({
			databaseUrl: unavailableDatabase.databaseUrl,
		});
		await unavailableDatabase.stop();

		try {
			const failure = await store
				.claim({
					itemId: "outbox-unavailable",
					leaseOwner: "worker-a",
					now: new Date("2026-08-30T06:00:00.000Z"),
					leaseExpiresAt: new Date("2026-08-30T06:01:00.000Z"),
				})
				.catch((error: unknown) => error);
			expect(failure).toMatchObject({
				name: "OutboxStoreError",
				code: "OUTBOX_STORE_ERROR",
				message: "Outbox store operation failed",
				retryable: true,
			});
			expect(failure).not.toHaveProperty("cause");
			expect(String(failure)).not.toContain(unavailableDatabase.databaseUrl);
		} finally {
			await store.close().catch(() => {});
		}
	});
});
