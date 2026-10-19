import postgres from "postgres";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { migratePlatformDatabase } from "./migrate.ts";
import { configureStoreQueryObservability } from "./observed-postgres.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";
import { observePostgresClient } from "./query-observability.ts";
import { PostgresWecomConnectionsV1 } from "./wecom-connections.ts";

let db: PostgresTestDatabase;

beforeAll(async () => {
	db = await startPostgresTestDatabase("query-observability");
	await migratePlatformDatabase(db);
}, 120_000);
afterAll(async () => {
	await db?.stop();
});
afterEach(() => {
	configureStoreQueryObservability(undefined);
});

/** 收集测试期间的未处理拒绝：观测包装不能留下没人等待的查询 Promise（#2892）。 */
function collectUnhandledRejections() {
	const reasons: unknown[] = [];
	const listener = (reason: unknown) => {
		reasons.push(reason);
	};
	process.on("unhandledRejection", listener);
	return {
		reasons,
		async stop() {
			// 让被提前执行的片段有机会失败并冒泡。
			await new Promise((resolve) => setTimeout(resolve, 200));
			process.off("unhandledRejection", listener);
		},
	};
}

it("keeps fragments from the observed client lazy so they embed into the outer query (#2892)", async () => {
	const record = vi.fn();
	const sql = observePostgresClient(postgres(db.databaseUrl, { max: 1 }), {
		observability: { record },
		slowQueryThresholdMs: 2_000,
	});
	const rejections = collectUnhandledRejections();
	try {
		const condition = sql`${2}::int > ${1}::int`;
		const rows = await sql<{ ok: number }[]>`select 1 as ok where ${condition}`;
		await rejections.stop();
		expect(rows.map((row) => row.ok)).toEqual([1]);
		expect(rejections.reasons).toEqual([]);
		expect(record).not.toHaveBeenCalledWith(
			expect.objectContaining({ outcome: "failed" }),
		);
	} finally {
		await rejections.stop();
		await sql.end();
	}
});

it("records a slow executed query once even when the same query is awaited twice", async () => {
	const record = vi.fn();
	const sql = observePostgresClient(postgres(db.databaseUrl, { max: 1 }), {
		observability: { record },
		slowQueryThresholdMs: 1,
	});
	try {
		const query = sql<{ ok: number }[]>`select 1 as ok from pg_sleep(0.01)`;
		expect((await query).map((row) => row.ok)).toEqual([1]);
		expect((await query).map((row) => row.ok)).toEqual([1]);
		expect(record.mock.calls).toEqual([
			[
				expect.objectContaining({
					stage: "dependency",
					outcome: "completed",
					operationRef: "store.query",
				}),
			],
		]);
	} finally {
		await sql.end();
	}
});

it("records an executed failure once and still rejects to the caller", async () => {
	const record = vi.fn();
	const sql = observePostgresClient(postgres(db.databaseUrl, { max: 1 }), {
		observability: { record },
	});
	const rejections = collectUnhandledRejections();
	try {
		const query = sql`select * from platform.no_such_table`;
		// 只给成功回调的 then 也必须把错误继续交给调用方；再次等待同一查询不能重复记录。
		await expect(query.then((rows) => rows)).rejects.toMatchObject({
			code: "42P01",
		});
		await expect(query).rejects.toMatchObject({ code: "42P01" });
		await rejections.stop();
		expect(rejections.reasons).toEqual([]);
		expect(
			record.mock.calls.filter(([event]) => event.outcome === "failed"),
		).toEqual([
			[
				expect.objectContaining({
					stage: "dependency",
					operationRef: "store.query",
					sqlState: "42P01",
				}),
			],
		]);
	} finally {
		await rejections.stop();
		await sql.end();
	}
});

it("claims, checks and renews WeCom connection leases while Store query observability is configured (#2892)", async () => {
	const record = vi.fn();
	configureStoreQueryObservability({ observability: { record } });
	const leases = new PostgresWecomConnectionsV1(db);
	const rejections = collectUnhandledRejections();
	try {
		const input = {
			botId: "wecom-observed-bot",
			agentId: "agent_observed_missing",
			bindingReference: "observed-missing-binding",
			holderId: "observed-holder",
		};
		await expect(leases.claim(input)).resolves.toBeNull();
		const claim = {
			...input,
			fence: 1,
			leaseUntil: new Date(Date.now() + 30_000),
		};
		await expect(leases.current(claim)).resolves.toBe(false);
		await expect(leases.renew(claim)).resolves.toBe(false);
		await rejections.stop();
		expect(rejections.reasons).toEqual([]);
		expect(record).not.toHaveBeenCalledWith(
			expect.objectContaining({ outcome: "failed" }),
		);
	} finally {
		await rejections.stop();
		await leases.close();
	}
});
