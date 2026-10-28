import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { PostgresEvaluationDataStoreV1 } from "./evaluation-data.js";
import { migratePlatformDatabase } from "./migrate.js";
import { createPostgresOutboxStore } from "./outbox.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";

let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let store: PostgresEvaluationDataStoreV1;
let outbox: ReturnType<typeof createPostgresOutboxStore>;
beforeAll(async () => {
	database = await startPostgresTestDatabase("eval-delete-eligibility");
	await migratePlatformDatabase(database);
	sql = postgres(database.databaseUrl, { max: 1 });
	store = new PostgresEvaluationDataStoreV1(database);
	outbox = createPostgresOutboxStore(database);
}, 120_000);
beforeEach(async () => {
	await sql`delete from platform.outbox_items`;
});
afterAll(async () => {
	await store?.close();
	await outbox?.close();
	await sql?.end();
	await database?.stop();
});
async function insert(
	id: string,
	state: "pending" | "retry_scheduled" | "processing",
	due: boolean,
	lease: "active" | "expired" | null = null,
) {
	await sql`insert into platform.outbox_items(id,scope_type,scope_id,operation,payload,trace_id,status,available_at,lease_owner,lease_expires_at,delivery_fence)
 values(${id},'evaluation',${id},'evaluation.content.delete.v1','{}',${randomUUID()},${state},
 ${due ? "2020-01-01T00:00:00Z" : "2099-01-01T00:00:00Z"}::timestamptz,
 ${lease ? "original-worker" : null},${lease === "active" ? "2099-01-01T00:00:00Z" : lease === "expired" ? "2020-01-01T00:00:00Z" : null}::timestamptz,7)`;
}
it.each(["future-retry", "active-lease"] as const)(
	"does not let %s occupy a one-item ready deletion batch",
	async (kind) => {
		const blocked = `a-${randomUUID()}`;
		const ready = `b-${randomUUID()}`;
		await insert(
			blocked,
			kind === "future-retry" ? "retry_scheduled" : "processing",
			false,
			kind === "active-lease" ? "active" : null,
		);
		await insert(ready, "pending", true);
		for (let round = 0; round < 3; round++)
			expect(await store.expired(1)).toEqual([ready]);
		expect(
			await outbox.claim({
				itemId: blocked,
				leaseOwner: "test-worker",
				leaseDurationMs: 60000,
			}),
		).toBeNull();
		const claim = await outbox.claim({
			itemId: ready,
			leaseOwner: "test-worker",
			leaseDurationMs: 60000,
		});
		expect(claim?.deliveryFence).toBe(8n);
		expect(await store.expired(1)).toEqual([]);
		const [original] =
			await sql`select delivery_fence,lease_owner,status from platform.outbox_items where id=${blocked}`;
		expect(original).toMatchObject({
			delivery_fence: "7",
			lease_owner: kind === "active-lease" ? "original-worker" : null,
			status: kind === "active-lease" ? "processing" : "retry_scheduled",
		});
	},
);
it("admits an expired processing lease independently of its future available_at and still fences the old worker", async () => {
	const id = randomUUID();
	await insert(id, "processing", false, "expired");
	expect(await store.expired(1)).toEqual([id]);
	const claim = await outbox.claim({
		itemId: id,
		leaseOwner: "replacement",
		leaseDurationMs: 60000,
	});
	expect(claim?.deliveryFence).toBe(8n);
	expect(
		await outbox.markSucceeded({
			itemId: id,
			leaseOwner: "original-worker",
			deliveryFence: 7n,
		}),
	).toBeNull();
	expect(await store.expired(1)).toEqual([]);
});
it("orders eligible deletion obligations by due time then id before applying the limit", async () => {
	const prefix = randomUUID();
	const first = `${prefix}-a`;
	const second = `${prefix}-b`;
	const later = `${prefix}-c`;
	await insert(second, "retry_scheduled", true);
	await insert(first, "pending", true);
	await insert(later, "pending", true);
	await sql`update platform.outbox_items set available_at='2021-01-01'::timestamptz where id=${later}`;
	const other = randomUUID();
	await insert(other, "pending", true);
	await sql`update platform.outbox_items set operation='other.operation',available_at='2019-01-01'::timestamptz where id=${other}`;
	expect(await store.expired(2)).toEqual([first, second]);
	const claim = await outbox.claim({
		itemId: first,
		leaseOwner: "test-worker",
		leaseDurationMs: 60000,
	});
	expect(claim).not.toBeNull();
	expect(await store.expired(2)).toEqual([second, later]);
});
