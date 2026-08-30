import {
	afterAll,
	beforeAll,
	describe,
	expect,
	expectTypeOf,
	it,
} from "vitest";
import type { PlatformIdempotencyBoundScope } from "./idempotency.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";

const builtStore: typeof import("./index.ts") = await import(
	new URL("../dist/index.mjs", import.meta.url).href
);

const baseScope = {
	resourceType: "agent",
	resourceId: "agent_01",
	actorId: "user_01",
	operation: "platform.update-agent",
} as const;
const acceptedResult = {
	schemaVersion: 1 as const,
	outcome: "accepted" as const,
	references: [
		{
			resourceType: "agent" as const,
			resourceId: "agent_01",
			revision: 2,
		},
	],
};

let testDatabase: PostgresTestDatabase | undefined;
let databaseUrl = "";

function openStore(scope: PlatformIdempotencyBoundScope = baseScope) {
	return builtStore.openPostgresPlatformIdempotencyStore({
		databaseUrl,
		scope,
	});
}

beforeAll(async () => {
	testDatabase = await startPostgresTestDatabase("platform-store-idempotency");
	databaseUrl = testDatabase.databaseUrl;
	await builtStore.migratePlatformDatabase({ databaseUrl });
}, 120_000);

afterAll(async () => testDatabase?.stop());

describe("Platform PostgreSQL idempotency store", () => {
	it("canonicalizes requests before the Store receives only their digest", async () => {
		const firstDigest = builtStore.canonicalPlatformIdempotencyRequestDigest({
			model: { name: "gpt", reasoning: "medium" },
			revision: 2,
		});
		const equivalentDigest =
			builtStore.canonicalPlatformIdempotencyRequestDigest({
				revision: 2,
				model: { reasoning: "medium", name: "gpt" },
			});
		const differentDigest =
			builtStore.canonicalPlatformIdempotencyRequestDigest({
				revision: 3,
				model: { reasoning: "medium", name: "gpt" },
			});
		expect(equivalentDigest).toBe(firstDigest);
		expect(differentDigest).not.toBe(firstDigest);
		expect(firstDigest).toMatch(/^[a-f0-9]{64}$/);

		const store = openStore();
		expectTypeOf<Parameters<typeof store.reserve>[0]>().toEqualTypeOf<{
			readonly key: string;
			readonly requestDigest: string;
		}>();
		const reserved = await store.reserve({
			key: "Retry_A",
			requestDigest: firstDigest,
		});
		if (reserved.state !== "reserved") throw new Error("Expected reservation");
		expect(
			await store.complete({
				reservationId: reserved.reservationId,
				result: acceptedResult,
			}),
		).toEqual({ state: "completed", result: acceptedResult });
		expect(
			await store.complete({
				reservationId: reserved.reservationId,
				result: {
					...acceptedResult,
					outcome: "completed",
					references: [
						{
							resourceType: "agent",
							resourceId: "agent_01",
							revision: 99,
						},
					],
				},
			}),
		).toEqual({ state: "completed", result: acceptedResult });
		expect(
			await store.reserve({
				key: "Retry_A",
				requestDigest: equivalentDigest,
			}),
		).toEqual({ state: "completed", result: acceptedResult });
		await store.close();
	});

	it("returns conflict without replacing the original digest or result", async () => {
		const store = openStore({ ...baseScope, resourceId: "agent_02" });
		const originalDigest = builtStore.canonicalPlatformIdempotencyRequestDigest(
			{
				revision: 1,
			},
		);
		const differentDigest =
			builtStore.canonicalPlatformIdempotencyRequestDigest({
				revision: 2,
			});
		const first = await store.reserve({
			key: "Mismatch_A",
			requestDigest: originalDigest,
		});
		if (first.state !== "reserved") throw new Error("Expected reservation");
		expect(
			await store.reserve({
				key: "Mismatch_A",
				requestDigest: differentDigest,
			}),
		).toEqual({ state: "conflict" });

		await store.complete({
			reservationId: first.reservationId,
			result: acceptedResult,
		});
		expect(
			await store.reserve({
				key: "Mismatch_A",
				requestDigest: originalDigest,
			}),
		).toEqual({ state: "completed", result: acceptedResult });
		await store.close();
	});

	it("binds Platform scope outside retry input and rejects other domains", async () => {
		const digest = builtStore.canonicalPlatformIdempotencyRequestDigest({
			revision: 3,
		});
		const store = openStore({ ...baseScope, resourceId: "agent_scope" });
		await expect(
			store.reserve({
				key: "Bound_A",
				requestDigest: digest,
				actorId: "attacker",
				operation: "runtime.submit",
				resourceType: "connection",
				resourceId: "connection_01",
			} as never),
		).rejects.toMatchObject({ code: "invalid_input" });
		expect(
			(await store.reserve({ key: "Bound_A", requestDigest: digest })).state,
		).toBe("reserved");
		expect(
			await store.reserve({ key: "Bound_A", requestDigest: digest }),
		).toEqual({ state: "in_progress" });

		const independentStores = [
			openStore({
				...baseScope,
				resourceId: "agent_scope",
				actorId: "user_02",
			}),
			openStore({
				...baseScope,
				resourceId: "agent_scope",
				operation: "platform.restart-agent",
			}),
			openStore({ ...baseScope, resourceId: "agent_other" }),
		];
		const independent = await Promise.all(
			independentStores.map((candidate) =>
				candidate.reserve({ key: "Bound_A", requestDigest: digest }),
			),
		);
		expect(independent.map((decision) => decision.state)).toEqual([
			"reserved",
			"reserved",
			"reserved",
		]);

		for (const invalidScope of [
			{ ...baseScope, resourceType: "connection" },
			{ ...baseScope, resourceType: "runtime_session" },
			{ ...baseScope, operation: "connection.invoke" },
			{ ...baseScope, operation: "runtime.submit" },
		]) {
			expect(() =>
				builtStore.openPostgresPlatformIdempotencyStore({
					databaseUrl,
					scope: invalidScope as never,
				}),
			).toThrow(expect.objectContaining({ code: "invalid_input" }));
		}

		await store.close();
		await Promise.all(independentStores.map((candidate) => candidate.close()));
	});

	it("keeps case-sensitive keys independent", async () => {
		const store = openStore({ ...baseScope, resourceId: "agent_case" });
		const requestDigest = builtStore.canonicalPlatformIdempotencyRequestDigest({
			revision: 4,
		});
		expect(
			(
				await Promise.all([
					store.reserve({ key: "Case_A", requestDigest }),
					store.reserve({ key: "case_A", requestDigest }),
				])
			).map((decision) => decision.state),
		).toEqual(["reserved", "reserved"]);
		await store.close();
	});

	it("selects one durable reservation across concurrent connections", async () => {
		const stores = [
			openStore({ ...baseScope, resourceId: "agent_concurrent" }),
			openStore({ ...baseScope, resourceId: "agent_concurrent" }),
		];
		const input = {
			key: "Concurrent_A",
			requestDigest: builtStore.canonicalPlatformIdempotencyRequestDigest({
				revision: 5,
			}),
		};
		const decisions = await Promise.all(
			stores.map((store) => store.reserve(input)),
		);
		expect(decisions.map((decision) => decision.state).toSorted()).toEqual([
			"in_progress",
			"reserved",
		]);
		await Promise.all(stores.map((store) => store.close()));
	});

	it("keeps crash state fail-closed without granting a second side effect", async () => {
		const input = {
			key: "Crash_A",
			requestDigest: builtStore.canonicalPlatformIdempotencyRequestDigest({
				revision: 6,
			}),
		};
		let sideEffects = 0;
		const crashedStore = openStore({ ...baseScope, resourceId: "agent_crash" });
		const original = await crashedStore.reserve(input);
		if (original.state === "reserved") sideEffects += 1;
		await crashedStore.close();

		const retryStores = [
			openStore({ ...baseScope, resourceId: "agent_crash" }),
			openStore({ ...baseScope, resourceId: "agent_crash" }),
		];
		const retries = await Promise.all(
			retryStores.map((store) => store.reserve(input)),
		);
		for (const retry of retries) {
			if (retry.state === "reserved") sideEffects += 1;
		}
		expect(retries).toEqual([
			{ state: "in_progress" },
			{ state: "in_progress" },
		]);
		expect(sideEffects).toBe(1);
		await Promise.all(retryStores.map((store) => store.close()));
	});

	it("accepts only the versioned allowlisted Platform result shape", async () => {
		const store = openStore({ ...baseScope, resourceId: "agent_result" });
		const reserved = await store.reserve({
			key: "Result_A",
			requestDigest: builtStore.canonicalPlatformIdempotencyRequestDigest({
				revision: 7,
			}),
		});
		if (reserved.state !== "reserved") throw new Error("Expected reservation");

		for (const result of [
			{ ...acceptedResult, accessToken: "credential-value" },
			{ ...acceptedResult, providerResponse: { body: { remoteId: "remote" } } },
			{ ...acceptedResult, sqlError: { query: "select secret" } },
			new Error("database detail"),
			{ ...acceptedResult, schemaVersion: 2 },
			{ ...acceptedResult, references: [] },
			{
				...acceptedResult,
				references: Object.assign([...acceptedResult.references], {
					providerResponse: { body: { remoteId: "remote" } },
				}),
			},
			{
				...acceptedResult,
				references: [
					{
						resourceType: "connection",
						resourceId: "connection_01",
						revision: null,
					},
				],
			},
		]) {
			await expect(
				store.complete({
					reservationId: reserved.reservationId,
					result: result as never,
				}),
			).rejects.toMatchObject({
				name: "PlatformIdempotencyError",
				code: "invalid_input",
				message: "Invalid idempotency input",
			});
		}

		expect(
			await store.complete({
				reservationId: reserved.reservationId,
				result: acceptedResult,
			}),
		).toEqual({ state: "completed", result: acceptedResult });
		await store.close();
	});

	it("bounds canonical request input and rejects malformed digests", async () => {
		expect(() =>
			builtStore.canonicalPlatformIdempotencyRequestDigest({
				value: "x".repeat(64 * 1024),
			}),
		).toThrow(expect.objectContaining({ code: "invalid_input" }));
		const store = openStore({ ...baseScope, resourceId: "agent_bounds" });
		await expect(
			store.reserve({ key: "Bound_A", requestDigest: "not-a-digest" }),
		).rejects.toMatchObject({ code: "invalid_input" });
		await store.close();
	});

	it("sanitizes PostgreSQL failures at the public interface", async () => {
		const store = builtStore.openPostgresPlatformIdempotencyStore({
			databaseUrl:
				"postgres://platform_user:database-secret@127.0.0.1:1/platform",
			scope: baseScope,
		});
		let failure: unknown;
		try {
			await store.reserve({
				key: "Failure_A",
				requestDigest: builtStore.canonicalPlatformIdempotencyRequestDigest({
					revision: 8,
				}),
			});
		} catch (error) {
			failure = error;
		}
		expect(failure).toMatchObject({
			name: "PlatformIdempotencyError",
			code: "unavailable",
			message: "Idempotency store unavailable",
		});
		expect(String(failure)).not.toMatch(
			/database-secret|127\.0\.0\.1|insert|sql/i,
		);
		await store.close().catch(() => {});
	});
});
