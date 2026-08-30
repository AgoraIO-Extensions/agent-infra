import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { transitionTerminalAfterLock } from "./outbox.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";

const builtStore: typeof import("./index.ts") = await import(
	new URL("../dist/index.mjs", import.meta.url).href
);
type PostgresClient = ReturnType<typeof postgres>;

const maximumDelayMs = 86_400_000;
let testDatabase: PostgresTestDatabase | undefined;

beforeAll(async () => {
	testDatabase = await startPostgresTestDatabase("platform-store-outbox");
	await builtStore.migratePlatformDatabase({
		databaseUrl: testDatabase.databaseUrl,
	});
}, 120_000);

afterAll(async () => testDatabase?.stop());

function databaseUrl(): string {
	if (!testDatabase) throw new Error("PostgreSQL test database is unavailable");
	return testDatabase.databaseUrl;
}

async function insertOutboxItem(
	client: PostgresClient,
	itemId: string,
	payload: postgres.JSONValue = {},
): Promise<void> {
	await client`
		insert into platform.outbox_items
			(id, scope_type, scope_id, operation, payload, available_at, trace_id)
		values
			(${itemId}, 'agent', ${`agent-${itemId}`}, 'deploy',
			 ${client.json(payload)}, clock_timestamp(), ${`trace-${itemId}`})
	`;
}

async function readDatabaseTime(client: PostgresClient): Promise<Date> {
	const rows = await client<{ decision_at: Date }[]>`
		select clock_timestamp() as decision_at
	`;
	const decisionAt = rows[0]?.decision_at;
	if (!decisionAt) throw new Error("PostgreSQL did not return its clock");
	return decisionAt;
}

async function forceLeaseExpiry(
	client: PostgresClient,
	itemId: string,
): Promise<void> {
	await client`
		update platform.outbox_items
		set lease_expires_at = clock_timestamp() - interval '1 second'
		where id = ${itemId}
	`;
}

async function forceRetryDue(
	client: PostgresClient,
	itemId: string,
): Promise<void> {
	await client`
		update platform.outbox_items
		set available_at = clock_timestamp() - interval '1 second'
		where id = ${itemId}
	`;
}

function expectDatabaseOrdered(value: Date, before: Date, after: Date): void {
	expect(value.getTime()).toBeGreaterThanOrEqual(before.getTime());
	expect(value.getTime()).toBeLessThanOrEqual(after.getTime());
}

async function expectQueuedOperationExpires(
	blocker: PostgresClient,
	itemId: string,
	leaseExpiresAt: Date,
	operation: () => Promise<unknown>,
): Promise<void> {
	let releaseLock = () => {};
	const released = new Promise<void>((resolve) => {
		releaseLock = resolve;
	});
	let reportRemaining = (_remainingMs: number) => {};
	const ready = new Promise<number>((resolve) => {
		reportRemaining = resolve;
	});
	const lockHolder = blocker.begin(async (transaction) => {
		await transaction`
			select id from platform.outbox_items where id = ${itemId} for update
		`;
		const clockRows = await transaction<{ decision_at: Date }[]>`
			select clock_timestamp() as decision_at
		`;
		const lockedAt = clockRows[0]?.decision_at;
		if (!lockedAt) throw new Error("PostgreSQL did not return its clock");
		reportRemaining(leaseExpiresAt.getTime() - lockedAt.getTime());
		await released;
	});

	const remainingMs = await ready;
	const pendingOperation = operation();
	await new Promise((resolve) =>
		setTimeout(resolve, Math.max(remainingMs + 75, 100)),
	);
	releaseLock();
	await lockHolder;
	expect(remainingMs).toBeGreaterThan(250);
	expect(await pendingOperation).toBeNull();
}

describe("PostgreSQL outbox store", () => {
	it("rejects legacy clocks and invalid durations before database access", async () => {
		const unavailableDatabase = await startPostgresTestDatabase(
			"platform-store-inputs",
		);
		const store = builtStore.createPostgresOutboxStore({
			databaseUrl: unavailableDatabase.databaseUrl,
		});
		await unavailableDatabase.stop();

		try {
			await expect(
				store.claim({
					itemId: "outbox-legacy-claim",
					leaseOwner: "worker-a",
					leaseDurationMs: 1_000,
					now: new Date(),
					leaseExpiresAt: new Date(),
				} as never),
			).rejects.toThrow("claim input contains unsupported fields");
			await expect(
				store.renew({
					itemId: "outbox-legacy-renew",
					leaseOwner: "worker-a",
					deliveryFence: 1n,
					leaseDurationMs: 1_000,
					now: new Date(),
					leaseExpiresAt: new Date(),
				} as never),
			).rejects.toThrow("renew input contains unsupported fields");
			await expect(
				store.scheduleRetry({
					itemId: "outbox-legacy-retry",
					leaseOwner: "worker-a",
					deliveryFence: 1n,
					retryDelayMs: 0,
					errorCode: "RUNTIME_UNAVAILABLE",
					now: new Date(),
					availableAt: new Date(),
				} as never),
			).rejects.toThrow("scheduleRetry input contains unsupported fields");
			await expect(
				store.markSucceeded({
					itemId: "outbox-legacy-terminal",
					leaseOwner: "worker-a",
					deliveryFence: 1n,
					now: new Date(),
				} as never),
			).rejects.toThrow("markSucceeded input contains unsupported fields");

			for (const leaseDurationMs of [0, -1, 1.5, maximumDelayMs + 1]) {
				await expect(
					store.claim({
						itemId: "outbox-invalid-claim",
						leaseOwner: "worker-a",
						leaseDurationMs,
					}),
				).rejects.toThrow(
					"leaseDurationMs must be an integer between 1 and 86400000",
				);
				await expect(
					store.renew({
						itemId: "outbox-invalid-renew",
						leaseOwner: "worker-a",
						deliveryFence: 1n,
						leaseDurationMs,
					}),
				).rejects.toThrow(
					"leaseDurationMs must be an integer between 1 and 86400000",
				);
			}
			for (const retryDelayMs of [-1, 0.5, maximumDelayMs + 1]) {
				await expect(
					store.scheduleRetry({
						itemId: "outbox-invalid-retry",
						leaseOwner: "worker-a",
						deliveryFence: 1n,
						retryDelayMs,
						errorCode: "RUNTIME_UNAVAILABLE",
					}),
				).rejects.toThrow(
					"retryDelayMs must be an integer between 0 and 86400000",
				);
			}

			const failure = await store
				.claim({
					itemId: "outbox-unavailable",
					leaseOwner: "worker-a",
					leaseDurationMs: 1_000,
				})
				.catch((error: unknown) => error);
			expect(failure).toMatchObject({
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

	it("gives one concurrent owner and takes over only after database expiry", async () => {
		const setup = postgres(databaseUrl(), { max: 1 });
		await insertOutboxItem(setup, "outbox-claim", { revision: 3 });
		const first = builtStore.createPostgresOutboxStore({
			databaseUrl: databaseUrl(),
		});
		const second = builtStore.createPostgresOutboxStore({
			databaseUrl: databaseUrl(),
		});
		try {
			const before = await readDatabaseTime(setup);
			const claims = await Promise.all([
				first.claim({
					itemId: "outbox-claim",
					leaseOwner: "worker-a",
					leaseDurationMs: 60_000,
				}),
				second.claim({
					itemId: "outbox-claim",
					leaseOwner: "worker-b",
					leaseDurationMs: 60_000,
				}),
			]);
			const after = await readDatabaseTime(setup);
			const winner = claims.find((claim) => claim !== null);
			expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
			expect(winner).toMatchObject({
				itemId: "outbox-claim",
				payload: { revision: 3 },
				attemptCount: 1,
				deliveryFence: 1n,
			});
			if (!winner) throw new Error("Concurrent claim did not produce a winner");
			expectDatabaseOrdered(winner.updatedAt, before, after);
			expect(winner.leaseExpiresAt.getTime() - winner.updatedAt.getTime()).toBe(
				60_000,
			);

			expect(
				await first.claim({
					itemId: "outbox-claim",
					leaseOwner: "worker-c",
					leaseDurationMs: 60_000,
				}),
			).toBeNull();
			await forceLeaseExpiry(setup, "outbox-claim");
			const takeover = await second.claim({
				itemId: "outbox-claim",
				leaseOwner: "worker-c",
				leaseDurationMs: 30_000,
			});
			expect(takeover).toMatchObject({
				attemptCount: 2,
				deliveryFence: 2n,
				leaseOwner: "worker-c",
			});
		} finally {
			await Promise.all([first.close(), second.close(), setup.end()]);
		}
	});

	it("renews a database-live lease without shortening it", async () => {
		const setup = postgres(databaseUrl(), { max: 1 });
		await insertOutboxItem(setup, "outbox-renew");
		const store = builtStore.createPostgresOutboxStore({
			databaseUrl: databaseUrl(),
		});
		try {
			const claimed = await store.claim({
				itemId: "outbox-renew",
				leaseOwner: "worker-a",
				leaseDurationMs: 60_000,
			});
			if (!claimed) throw new Error("Outbox item was not claimed");
			const unchanged = await store.renew({
				itemId: "outbox-renew",
				leaseOwner: "worker-a",
				deliveryFence: 1n,
				leaseDurationMs: 1,
			});
			expect(unchanged?.leaseExpiresAt).toEqual(claimed.leaseExpiresAt);

			const extended = await store.renew({
				itemId: "outbox-renew",
				leaseOwner: "worker-a",
				deliveryFence: 1n,
				leaseDurationMs: 120_000,
			});
			if (!extended) throw new Error("Live lease was not renewed");
			expect(
				extended.leaseExpiresAt.getTime() - extended.updatedAt.getTime(),
			).toBe(120_000);
		} finally {
			await Promise.all([store.close(), setup.end()]);
		}
	});

	it("schedules retries from database time and preserves private attempt metadata", async () => {
		const setup = postgres(databaseUrl(), { max: 1 });
		await insertOutboxItem(setup, "outbox-retry", { command: "deploy" });
		await insertOutboxItem(setup, "outbox-retry-zero");
		const first = builtStore.createPostgresOutboxStore({
			databaseUrl: databaseUrl(),
		});
		const second = builtStore.createPostgresOutboxStore({
			databaseUrl: databaseUrl(),
		});
		try {
			await first.claim({
				itemId: "outbox-retry",
				leaseOwner: "worker-a",
				leaseDurationMs: 60_000,
			});
			const before = await readDatabaseTime(setup);
			const scheduled = await first.scheduleRetry({
				itemId: "outbox-retry",
				leaseOwner: "worker-a",
				deliveryFence: 1n,
				retryDelayMs: 60_000,
				errorCode: "RUNTIME_UNAVAILABLE",
			});
			const after = await readDatabaseTime(setup);
			if (!scheduled) throw new Error("Retry was not scheduled");
			expectDatabaseOrdered(scheduled.updatedAt, before, after);
			expect(
				scheduled.availableAt.getTime() - scheduled.updatedAt.getTime(),
			).toBe(60_000);
			expect(
				await first.scheduleRetry({
					itemId: "outbox-retry",
					leaseOwner: "worker-a",
					deliveryFence: 1n,
					retryDelayMs: 60_000,
					errorCode: "RUNTIME_UNAVAILABLE",
				}),
			).toBeNull();
			expect(
				await second.claim({
					itemId: "outbox-retry",
					leaseOwner: "worker-b",
					leaseDurationMs: 60_000,
				}),
			).toBeNull();
			const events = await setup`
				select events.event_type, events.payload,
					items.updated_at = events.occurred_at as timestamp_matches
				from platform.persisted_events events
				join platform.outbox_items items
					on items.id = 'outbox-retry'
				where events.stream_id = 'outbox:outbox-retry'
			`;
			expect([...events]).toEqual([
				{
					event_type: "outbox.retry_scheduled",
					payload: {
						attemptCount: 1,
						deliveryFence: "1",
						errorCode: "RUNTIME_UNAVAILABLE",
					},
					timestamp_matches: true,
				},
			]);
			await forceRetryDue(setup, "outbox-retry");
			expect(
				await second.claim({
					itemId: "outbox-retry",
					leaseOwner: "worker-b",
					leaseDurationMs: 60_000,
				}),
			).toMatchObject({
				payload: { command: "deploy" },
				attemptCount: 2,
				deliveryFence: 2n,
			});
			await first.claim({
				itemId: "outbox-retry-zero",
				leaseOwner: "worker-a",
				leaseDurationMs: 60_000,
			});
			const immediate = await first.scheduleRetry({
				itemId: "outbox-retry-zero",
				leaseOwner: "worker-a",
				deliveryFence: 1n,
				retryDelayMs: 0,
				errorCode: "RUNTIME_UNAVAILABLE",
			});
			expect(immediate?.availableAt).toEqual(immediate?.updatedAt);
			expect(
				await second.claim({
					itemId: "outbox-retry-zero",
					leaseOwner: "worker-b",
					leaseDurationMs: 60_000,
				}),
			).toMatchObject({ deliveryFence: 2n });
		} finally {
			await Promise.all([first.close(), second.close(), setup.end()]);
		}
	});

	it("rejects stale terminal writes and records database decision timestamps", async () => {
		const setup = postgres(databaseUrl(), { max: 1 });
		await insertOutboxItem(setup, "outbox-success");
		await insertOutboxItem(setup, "outbox-failure");
		const first = builtStore.createPostgresOutboxStore({
			databaseUrl: databaseUrl(),
		});
		const second = builtStore.createPostgresOutboxStore({
			databaseUrl: databaseUrl(),
		});
		try {
			await first.claim({
				itemId: "outbox-success",
				leaseOwner: "worker-a",
				leaseDurationMs: 60_000,
			});
			await forceLeaseExpiry(setup, "outbox-success");
			await second.claim({
				itemId: "outbox-success",
				leaseOwner: "worker-b",
				leaseDurationMs: 60_000,
			});
			expect(
				await first.markSucceeded({
					itemId: "outbox-success",
					leaseOwner: "worker-a",
					deliveryFence: 1n,
				}),
			).toBeNull();
			const before = await readDatabaseTime(setup);
			const succeeded = await second.markSucceeded({
				itemId: "outbox-success",
				leaseOwner: "worker-b",
				deliveryFence: 2n,
			});
			const after = await readDatabaseTime(setup);
			if (!succeeded)
				throw new Error("Current owner did not complete outbox item");
			expectDatabaseOrdered(succeeded.updatedAt, before, after);
			expect(
				await second.markSucceeded({
					itemId: "outbox-success",
					leaseOwner: "worker-b",
					deliveryFence: 2n,
				}),
			).toBeNull();

			await first.claim({
				itemId: "outbox-failure",
				leaseOwner: "worker-a",
				leaseDurationMs: 60_000,
			});
			await expect(
				first.markFailed({
					itemId: "outbox-failure",
					leaseOwner: "worker-a",
					deliveryFence: 1n,
					errorCode: "DEPLOYMENT_REJECTED",
					message: "raw runtime detail",
				} as never),
			).rejects.toThrow("markFailed input contains unsupported fields");
			const failed = await first.markFailed({
				itemId: "outbox-failure",
				leaseOwner: "worker-a",
				deliveryFence: 1n,
				errorCode: "DEPLOYMENT_REJECTED",
			});
			if (!failed) throw new Error("Current owner did not fail outbox item");
			expect(
				await first.markFailed({
					itemId: "outbox-failure",
					leaseOwner: "worker-a",
					deliveryFence: 1n,
					errorCode: "DEPLOYMENT_REJECTED",
				}),
			).toBeNull();

			const events = await setup`
				select events.stream_id, events.event_type, events.payload,
					items.updated_at = events.occurred_at as timestamp_matches
				from platform.persisted_events events
				join platform.outbox_items items
					on 'outbox:' || items.id = events.stream_id
				where events.stream_id in (
					'outbox:outbox-success', 'outbox:outbox-failure'
				)
				order by events.stream_id
			`;
			expect([...events]).toEqual([
				{
					stream_id: "outbox:outbox-failure",
					event_type: "outbox.failed",
					payload: {
						attemptCount: 1,
						deliveryFence: "1",
						errorCode: "DEPLOYMENT_REJECTED",
					},
					timestamp_matches: true,
				},
				{
					stream_id: "outbox:outbox-success",
					event_type: "outbox.succeeded",
					payload: { attemptCount: 2, deliveryFence: "2" },
					timestamp_matches: true,
				},
			]);
		} finally {
			await Promise.all([first.close(), second.close(), setup.end()]);
		}
	});

	it("rolls back state when its private attempt event cannot commit", async () => {
		const setup = postgres(databaseUrl(), { max: 1 });
		await insertOutboxItem(setup, "outbox-crash");
		const store = builtStore.createPostgresOutboxStore({
			databaseUrl: databaseUrl(),
		});
		try {
			await store.claim({
				itemId: "outbox-crash",
				leaseOwner: "worker-a",
				leaseDurationMs: 60_000,
			});
			await setup`
				insert into platform.persisted_events
					(event_id, stream_id, sequence, stream_cursor, event_type,
					 payload, trace_id, occurred_at)
				values
					('outbox:outbox-crash:1', 'outbox:outbox-crash', 1, 1,
					 'outbox.test_collision', '{}', 'trace-outbox-crash', clock_timestamp())
			`;
			const failure = await store
				.scheduleRetry({
					itemId: "outbox-crash",
					leaseOwner: "worker-a",
					deliveryFence: 1n,
					retryDelayMs: 0,
					errorCode: "RUNTIME_UNAVAILABLE",
				})
				.catch((error: unknown) => error);
			expect(failure).toMatchObject({
				code: "OUTBOX_STORE_ERROR",
				retryable: false,
			});
			expect(failure).not.toHaveProperty("constraint_name");
			expect(
				await store.renew({
					itemId: "outbox-crash",
					leaseOwner: "worker-a",
					deliveryFence: 1n,
					leaseDurationMs: 60_000,
				}),
			).toMatchObject({ deliveryFence: 1n });
			await setup`
				delete from platform.persisted_events
				where event_id = 'outbox:outbox-crash:1'
			`;
			const scheduled = await store.scheduleRetry({
				itemId: "outbox-crash",
				leaseOwner: "worker-a",
				deliveryFence: 1n,
				retryDelayMs: 0,
				errorCode: "RUNTIME_UNAVAILABLE",
			});
			expect(scheduled?.availableAt).toEqual(scheduled?.updatedAt);
		} finally {
			await Promise.all([store.close(), setup.end()]);
		}
	});

	it("decides queued renew and terminal writes only after acquiring the row lock", async () => {
		const setup = postgres(databaseUrl(), { max: 1 });
		const blocker = postgres(databaseUrl(), { max: 1 });
		await insertOutboxItem(setup, "outbox-lock-renew");
		await insertOutboxItem(setup, "outbox-lock-terminal");
		const store = builtStore.createPostgresOutboxStore({
			databaseUrl: databaseUrl(),
		});
		try {
			const renewClaim = await store.claim({
				itemId: "outbox-lock-renew",
				leaseOwner: "worker-a",
				leaseDurationMs: 1_500,
			});
			if (!renewClaim) throw new Error("Renew test item was not claimed");
			await expectQueuedOperationExpires(
				blocker,
				"outbox-lock-renew",
				renewClaim.leaseExpiresAt,
				() =>
					store.renew({
						itemId: "outbox-lock-renew",
						leaseOwner: "worker-a",
						deliveryFence: 1n,
						leaseDurationMs: 60_000,
					}),
			);

			const terminalClaim = await store.claim({
				itemId: "outbox-lock-terminal",
				leaseOwner: "worker-a",
				leaseDurationMs: 1_500,
			});
			if (!terminalClaim) throw new Error("Terminal test item was not claimed");
			await expectQueuedOperationExpires(
				blocker,
				"outbox-lock-terminal",
				terminalClaim.leaseExpiresAt,
				() =>
					store.markSucceeded({
						itemId: "outbox-lock-terminal",
						leaseOwner: "worker-a",
						deliveryFence: 1n,
					}),
			);
		} finally {
			await Promise.all([store.close(), blocker.end(), setup.end()]);
		}
	});

	it("decides terminal ownership inside the mutation after the row is locked", async () => {
		const setup = postgres(databaseUrl(), { max: 1 });
		await insertOutboxItem(setup, "outbox-after-lock");
		const store = builtStore.createPostgresOutboxStore({
			databaseUrl: databaseUrl(),
		});
		try {
			const claimed = await store.claim({
				itemId: "outbox-after-lock",
				leaseOwner: "worker-a",
				leaseDurationMs: 1_000,
			});
			if (!claimed) throw new Error("After-lock test item was not claimed");

			await setup.begin(async (transaction) => {
				await transaction`
					select id from platform.outbox_items
					where id = 'outbox-after-lock' for update
				`;
				const marginMs = 200;
				const beforeRows = await transaction<
					{ database_now: Date; lease_expires_at: Date; remaining_ms: number }[]
				>`
					with test_clock as materialized (
						select clock_timestamp() as database_now
					)
					select test_clock.database_now, items.lease_expires_at,
						(extract(epoch from (
							items.lease_expires_at - test_clock.database_now
						)) * 1000)::double precision as remaining_ms
					from platform.outbox_items items, test_clock
					where items.id = 'outbox-after-lock'
				`;
				const before = beforeRows[0];
				if (!before) throw new Error("Locked outbox item disappeared");
				expect(before.database_now.getTime()).toBeLessThan(
					before.lease_expires_at.getTime(),
				);
				expect(before.remaining_ms).toBeGreaterThan(500);
				await transaction`
					select pg_sleep(
						(${before.remaining_ms}::double precision + ${marginMs}) / 1000
					)
				`;
				const afterRows = await transaction<
					{ database_now: Date; lease_expires_at: Date }[]
				>`
					select clock_timestamp() as database_now, lease_expires_at
					from platform.outbox_items where id = 'outbox-after-lock'
				`;
				const after = afterRows[0];
				if (!after) throw new Error("Locked outbox item disappeared");
				expect(after.database_now.getTime()).toBeGreaterThanOrEqual(
					after.lease_expires_at.getTime(),
				);

				expect(
					await transitionTerminalAfterLock(
						transaction,
						{
							itemId: "outbox-after-lock",
							leaseOwner: "worker-a",
							deliveryFence: 1n,
						},
						"succeeded",
					),
				).toBeNull();
				const state = await transaction`
					select status, lease_owner from platform.outbox_items
					where id = 'outbox-after-lock'
				`;
				expect([...state]).toEqual([
					{ status: "processing", lease_owner: "worker-a" },
				]);
				const events = await transaction`
					select event_id from platform.persisted_events
					where stream_id = 'outbox:outbox-after-lock'
				`;
				expect(events).toHaveLength(0);
			});
		} finally {
			await Promise.all([store.close(), setup.end()]);
		}
	});
});
