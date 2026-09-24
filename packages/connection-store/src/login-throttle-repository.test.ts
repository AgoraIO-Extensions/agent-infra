import { LoginRateLimitedError } from "@agent-infra/connection-core";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createConnectionDatabase } from "./database.js";
import { createPostgresLoginThrottle } from "./login-throttle-repository.js";
import { migrateConnectionDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";

let testDatabase: PostgresTestDatabase | undefined;

beforeAll(async () => {
	testDatabase = await startPostgresTestDatabase("connection-login-throttle");
	await migrateConnectionDatabase(testDatabase.databaseUrl);
}, 120_000);

afterAll(async () => {
	await testDatabase?.stop();
});

function input(environment: string, source: string, account: string) {
	return {
		environment,
		sourceMarker: source.repeat(64),
		accountMarker: account.repeat(64),
	};
}

async function withReplicas(
	work: (
		first: ReturnType<typeof createPostgresLoginThrottle>,
		second: ReturnType<typeof createPostgresLoginThrottle>,
		inspect: ReturnType<typeof postgres>,
	) => Promise<void>,
) {
	if (!testDatabase) throw new Error("PostgreSQL test database unavailable");
	const firstHandle = createConnectionDatabase(testDatabase.databaseUrl);
	const secondHandle = createConnectionDatabase(testDatabase.databaseUrl);
	const inspect = postgres(testDatabase.databaseUrl);
	try {
		await work(
			createPostgresLoginThrottle(firstHandle.db),
			createPostgresLoginThrottle(secondHandle.db),
			inspect,
		);
	} finally {
		await Promise.all([
			firstHandle.close(),
			secondHandle.close(),
			inspect.end(),
		]);
	}
}

it("atomically admits only two concurrent attempts for an account across API replicas", async () => {
	await withReplicas(async (first, second, inspect) => {
		const bound = input("account-concurrency", "a", "b");
		const outcomes = await Promise.allSettled([
			first.begin(bound),
			second.begin(bound),
			first.begin(bound),
		]);
		expect(
			outcomes.filter((result) => result.status === "fulfilled"),
		).toHaveLength(2);
		expect(
			outcomes.filter((result) => result.status === "rejected"),
		).toHaveLength(1);
		expect(
			outcomes.find((result) => result.status === "rejected"),
		).toMatchObject({
			reason: expect.any(LoginRateLimitedError),
		});
		for (const outcome of outcomes)
			if (outcome.status === "fulfilled") await outcome.value("succeeded");
		const [count] = await inspect`
			select count(*)::integer as count from connection.login_throttle_attempts
			where environment = 'account-concurrency'
		`;
		expect(count?.count).toBe(0);
	});
}, 120_000);

it("shares source backoff, keeps it bounded, and restores admission after expiry", async () => {
	await withReplicas(async (first, second, inspect) => {
		const bound = input("source-backoff", "c", "d");
		for (const [throttle, account] of [
			[first, "d"],
			[second, "e"],
			[first, "f"],
		] as const) {
			const finish = await throttle.begin(
				input("source-backoff", "c", account),
			);
			await finish("rejected");
		}
		await expect(
			second.begin(input("source-backoff", "c", "g")),
		).rejects.toBeInstanceOf(LoginRateLimitedError);
		const [row] = await inspect`
			select failures, next_allowed_at from connection.login_throttle_failures
			where environment = 'source-backoff' and kind = 'source'
		`;
		expect(row?.failures).toBe(3);
		expect(row?.next_allowed_at).toBeTruthy();
		await inspect`
			update connection.login_throttle_failures set next_allowed_at = now() - interval '1 second'
			where environment = 'source-backoff'
		`;
		const finish = await second.begin(bound);
		await finish("succeeded");
		const [account] = await inspect`
			select count(*)::integer as count from connection.login_throttle_failures
			where environment = 'source-backoff' and kind = 'account'
			and marker = ${"d".repeat(64)}
		`;
		expect(account?.count).toBe(0);
	});
}, 120_000);

it("releases an unavailable attempt without punishing the account", async () => {
	await withReplicas(async (first, second, inspect) => {
		const bound = input("unavailable", "a", "b");
		const finish = await first.begin(bound);
		await finish("unavailable");
		await finish("rejected");
		const [count] = await inspect`
			select count(*)::integer as count from connection.login_throttle_failures
			where environment = 'unavailable'
		`;
		expect(count?.count).toBe(0);
		await (await second.begin(bound))("succeeded");
	});
}, 120_000);

it("backs off the environment after its bounded failure threshold across sources", async () => {
	await withReplicas(async (first, second, inspect) => {
		await (await first.begin(input("environment-backoff", "a", "b")))(
			"rejected",
		);
		await inspect`
			update connection.login_throttle_failures set failures = 999
			where environment = 'environment-backoff' and kind = 'environment'
		`;
		await (await second.begin(input("environment-backoff", "c", "d")))(
			"rejected",
		);
		const [row] = await inspect`
			select failures, next_allowed_at from connection.login_throttle_failures
			where environment = 'environment-backoff' and kind = 'environment'
		`;
		expect(row?.failures).toBe(1_000);
		expect(row?.next_allowed_at).toBeTruthy();
		await expect(
			first.begin(input("environment-backoff", "e", "f")),
		).rejects.toBeInstanceOf(LoginRateLimitedError);
		await inspect`
			update connection.login_throttle_failures set next_allowed_at = now() - interval '1 second'
			where environment = 'environment-backoff' and kind = 'environment'
		`;
		await (await second.begin(input("environment-backoff", "e", "f")))(
			"succeeded",
		);
	});
}, 120_000);

it("enforces source and environment capacity and recovers abandoned leases", async () => {
	await withReplicas(async (first, second, inspect) => {
		const sourceFinishes = await Promise.all(
			["a", "b", "c", "d"].map((account) =>
				first.begin(input("source-capacity", "e", account)),
			),
		);
		await expect(
			second.begin(input("source-capacity", "e", "f")),
		).rejects.toBeInstanceOf(LoginRateLimitedError);
		for (const finish of sourceFinishes) await finish("succeeded");

		const finishes = [];
		for (let index = 0; index < 50; index += 1) {
			const account = index.toString(16).padStart(64, "0");
			const source = (index + 100).toString(16).padStart(64, "0");
			finishes.push(
				await (index % 2 === 0 ? first : second).begin({
					environment: "environment-capacity",
					accountMarker: account,
					sourceMarker: source,
				}),
			);
		}
		await expect(
			first.begin(input("environment-capacity", "f", "e")),
		).rejects.toBeInstanceOf(LoginRateLimitedError);
		await inspect`
			update connection.login_throttle_attempts set expires_at = now() - interval '1 second'
			where environment = 'environment-capacity'
		`;
		const recovered = await second.begin(
			input("environment-capacity", "f", "e"),
		);
		await recovered("succeeded");
		for (const finish of finishes) await finish("succeeded");
	});
}, 120_000);
