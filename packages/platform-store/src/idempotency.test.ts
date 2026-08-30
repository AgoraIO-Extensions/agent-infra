import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const postgresImage =
	"postgres@sha256:20edbde7749f822887a1a022ad526fde0a47d6b2be9a8364433605cf65099416";
const username = "platform_test";
const password = "platform_test_password";
const database = "platform_test";
const builtStore: typeof import("./index.ts") = await import(
	new URL("../dist/index.mjs", import.meta.url).href
);

let containerName = "";
let databaseUrl = "";

function openStore(clock: () => Date = () => new Date()) {
	return builtStore.openPlatformIdempotencyStore({
		databaseUrl,
		reservationTimeoutMs: 60_000,
		clock,
	});
}

async function removeContainer(): Promise<void> {
	if (containerName) {
		await execFile("docker", ["rm", "--force", containerName]).catch(() => {});
	}
}

async function startPostgres(): Promise<string> {
	containerName = `agent-infra-idempotency-${randomUUID()}`;
	await execFile("docker", [
		"run",
		"--detach",
		"--rm",
		"--name",
		containerName,
		"--env",
		`POSTGRES_USER=${username}`,
		"--env",
		`POSTGRES_PASSWORD=${password}`,
		"--env",
		`POSTGRES_DB=${database}`,
		"--publish",
		"127.0.0.1::5432",
		postgresImage,
	]);
	const { stdout } = await execFile("docker", [
		"port",
		containerName,
		"5432/tcp",
	]);
	const port = stdout.trim().match(/:(\d+)$/)?.[1];
	if (!port) throw new Error("PostgreSQL did not publish a test port");
	const url = `postgres://${username}:${password}@127.0.0.1:${port}/${database}`;

	for (let attempt = 0; attempt < 80; attempt += 1) {
		const client = postgres(url, { connect_timeout: 1, max: 1 });
		try {
			await client`select 1`;
			await client.end();
			return url;
		} catch {
			await client.end({ timeout: 0 });
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	throw new Error("PostgreSQL test container did not become ready");
}

beforeAll(async () => {
	databaseUrl = await startPostgres().catch(async (error) => {
		await removeContainer();
		throw error;
	});
	await builtStore.migratePlatformDatabase({ databaseUrl });
}, 120_000);

afterAll(removeContainer);

describe("Platform PostgreSQL idempotency store", () => {
	it("replays the original result for equivalent canonical input", async () => {
		const store = openStore();
		const scope = {
			resourceType: "agent",
			resourceId: "agent_01",
			actorId: "user_01",
			operation: "update-agent",
		};
		const first = await store.reserve({
			scope,
			key: "Retry_A",
			request: { model: { name: "gpt", reasoning: "medium" }, revision: 2 },
		});
		expect(first.state).toBe("reserved");
		if (first.state !== "reserved") throw new Error("Expected reservation");

		const result = {
			status: "accepted",
			resource: { type: "agent", id: "agent_01", revision: 2 },
		};
		expect(
			await store.complete({ reservation: first.reservation, result }),
		).toEqual({ state: "completed", result });

		expect(
			await store.reserve({
				scope,
				key: "Retry_A",
				request: {
					revision: 2,
					model: { reasoning: "medium", name: "gpt" },
				},
			}),
		).toEqual({ state: "completed", result });

		await store.close();
	});

	it("keeps the original record when the same key has different input", async () => {
		const store = openStore();
		const scope = {
			resourceType: "agent",
			resourceId: "agent_02",
			actorId: "user_01",
			operation: "update-agent",
		};
		const first = await store.reserve({
			scope,
			key: "Mismatch_A",
			request: { revision: 1 },
		});
		if (first.state !== "reserved") throw new Error("Expected reservation");

		expect(
			await store.reserve({
				scope,
				key: "Mismatch_A",
				request: { revision: 2 },
			}),
		).toEqual({ state: "conflict" });

		const originalResult = {
			status: "accepted",
			resource: { type: "agent", id: "agent_02", revision: 1 },
		};
		await store.complete({
			reservation: first.reservation,
			result: originalResult,
		});
		expect(
			await store.reserve({
				scope,
				key: "Mismatch_A",
				request: { revision: 1 },
			}),
		).toEqual({ state: "completed", result: originalResult });

		await store.close();
	});

	it("separates case-sensitive keys and server-derived scope", async () => {
		const store = openStore();
		const scope = {
			resourceType: "agent",
			resourceId: "agent_03",
			actorId: "user_01",
			operation: "update-agent",
		};
		const request = { revision: 3 };
		const original = await store.reserve({
			scope,
			key: "Case_A",
			request,
		});
		if (original.state !== "reserved") throw new Error("Expected reservation");

		const independent = await Promise.all([
			store.reserve({ scope, key: "case_A", request }),
			store.reserve({
				scope: { ...scope, actorId: "user_02" },
				key: "Case_A",
				request,
			}),
			store.reserve({
				scope: { ...scope, operation: "restart-agent" },
				key: "Case_A",
				request,
			}),
			store.reserve({
				scope: { ...scope, resourceId: "agent_04" },
				key: "Case_A",
				request,
			}),
		]);
		expect(independent.map((result) => result.state)).toEqual([
			"reserved",
			"reserved",
			"reserved",
			"reserved",
		]);

		expect(
			await store.complete({
				reservation: {
					...original.reservation,
					scope: { ...scope, actorId: "user_02" },
				},
				result: { status: "accepted" },
			}),
		).toEqual({ state: "conflict" });
		expect(await store.reserve({ scope, key: "Case_A", request })).toEqual({
			state: "in_progress",
		});

		await store.close();
	});

	it("selects one durable reservation across concurrent connections", async () => {
		const stores = [openStore(), openStore()];
		const input = {
			scope: {
				resourceType: "agent",
				resourceId: "agent_05",
				actorId: "user_01",
				operation: "update-agent",
			},
			key: "Concurrent_A",
			request: { revision: 4 },
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

	it("reclaims a timed-out reservation after the original process crashes", async () => {
		let now = new Date("2026-08-30T12:00:00.000Z");
		const clock = () => now;
		const input = {
			scope: {
				resourceType: "agent",
				resourceId: "agent_06",
				actorId: "user_01",
				operation: "update-agent",
			},
			key: "Crash_A",
			request: { revision: 5 },
		};
		const crashedStore = openStore(clock);
		expect((await crashedStore.reserve(input)).state).toBe("reserved");
		await crashedStore.close();

		const recoveringStore = openStore(clock);
		expect(await recoveringStore.reserve(input)).toEqual({
			state: "in_progress",
		});
		now = new Date("2026-08-30T12:01:00.000Z");
		const reclaimed = await recoveringStore.reserve(input);
		if (reclaimed.state !== "reserved") {
			throw new Error("Expected timed-out reservation reclaim");
		}
		const originalResult = {
			status: "accepted",
			resource: { type: "agent", id: "agent_06", revision: 5 },
		};
		expect(
			await recoveringStore.complete({
				reservation: reclaimed.reservation,
				result: originalResult,
			}),
		).toEqual({ state: "completed", result: originalResult });
		expect(
			await recoveringStore.complete({
				reservation: reclaimed.reservation,
				result: { status: "different" },
			}),
		).toEqual({ state: "completed", result: originalResult });
		await recoveringStore.close();

		const replayStore = openStore(clock);
		expect(await replayStore.reserve(input)).toEqual({
			state: "completed",
			result: originalResult,
		});
		await replayStore.close();
	});

	it("selects one reclaim owner and rejects the stale reservation", async () => {
		let now = new Date("2026-08-30T13:00:00.000Z");
		const clock = () => now;
		const input = {
			scope: {
				resourceType: "agent",
				resourceId: "agent_reclaim",
				actorId: "user_01",
				operation: "update-agent",
			},
			key: "Crash_Race_A",
			request: { revision: 6 },
		};
		const originalStore = openStore(clock);
		const original = await originalStore.reserve(input);
		if (original.state !== "reserved") throw new Error("Expected reservation");
		now = new Date("2026-08-30T13:01:00.000Z");
		const recoveringStores = [openStore(clock), openStore(clock)];
		const decisions = await Promise.all(
			recoveringStores.map((store) => store.reserve(input)),
		);
		expect(decisions.map((decision) => decision.state).toSorted()).toEqual([
			"in_progress",
			"reserved",
		]);
		expect(
			await originalStore.complete({
				reservation: original.reservation,
				result: { status: "stale" },
			}),
		).toEqual({ state: "conflict" });

		await originalStore.close();
		await Promise.all(recoveringStores.map((store) => store.close()));
	});

	it("rejects credential-bearing completed results without echoing them", async () => {
		const store = openStore();
		const reserved = await store.reserve({
			scope: {
				resourceType: "agent",
				resourceId: "agent_07",
				actorId: "user_01",
				operation: "update-agent",
			},
			key: "Sanitize_A",
			request: { revision: 6 },
		});
		if (reserved.state !== "reserved") throw new Error("Expected reservation");

		const completion = store.complete({
			reservation: reserved.reservation,
			result: { status: "accepted", accessToken: "credential-value" },
		});
		await expect(completion).rejects.toMatchObject({
			name: "PlatformIdempotencyError",
			code: "invalid_input",
			message: "Invalid idempotency input",
		});
		await expect(completion).rejects.not.toThrow("credential-value");

		await store.close();
	});

	it("rejects raw provider results", async () => {
		const store = openStore();
		const reserved = await store.reserve({
			scope: {
				resourceType: "agent",
				resourceId: "agent_08",
				actorId: "user_01",
				operation: "update-agent",
			},
			key: "Sanitize_B",
			request: { revision: 7 },
		});
		if (reserved.state !== "reserved") throw new Error("Expected reservation");

		await expect(
			store.complete({
				reservation: reserved.reservation,
				result: {
					status: "accepted",
					providerResponse: { headers: {}, body: { remoteId: "remote_01" } },
				},
			}),
		).rejects.toMatchObject({ code: "invalid_input" });

		class ProviderResult {
			readonly remoteId = "remote_01";
		}
		await expect(
			store.complete({
				reservation: reserved.reservation,
				result: {
					status: "accepted",
					providerId: "provider_01",
					providerResult: new ProviderResult(),
				} as never,
			}),
		).rejects.toMatchObject({ code: "invalid_input" });

		await store.close();
	});

	it("bounds canonical requests and completed results", async () => {
		const store = openStore();
		const scope = {
			resourceType: "agent",
			resourceId: "agent_09",
			actorId: "user_01",
			operation: "update-agent",
		};
		const oversized = "x".repeat(64 * 1024);
		await expect(
			store.reserve({
				scope,
				key: "Bound_A",
				request: { value: oversized },
			}),
		).rejects.toMatchObject({ code: "invalid_input" });

		const reserved = await store.reserve({
			scope,
			key: "Bound_B",
			request: { revision: 8 },
		});
		if (reserved.state !== "reserved") throw new Error("Expected reservation");
		await expect(
			store.complete({
				reservation: reserved.reservation,
				result: { value: oversized },
			}),
		).rejects.toMatchObject({ code: "invalid_input" });

		await store.close();
	});

	it("sanitizes PostgreSQL failures at the public interface", async () => {
		const store = builtStore.openPlatformIdempotencyStore({
			databaseUrl:
				"postgres://platform_user:database-secret@127.0.0.1:1/platform",
			reservationTimeoutMs: 60_000,
		});
		let failure: unknown;
		try {
			await store.reserve({
				scope: {
					resourceType: "agent",
					resourceId: "agent_10",
					actorId: "user_01",
					operation: "update-agent",
				},
				key: "Failure_A",
				request: { revision: 9 },
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
