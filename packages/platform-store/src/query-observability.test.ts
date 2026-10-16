import type postgres from "postgres";
import { expect, it, vi } from "vitest";
import {
	observePostgresClient,
	runStoreQueryOperation,
} from "./query-observability.js";

it("emits only a bounded fixed summary after the configured threshold", async () => {
	const record = vi.fn();
	const client = Object.assign(
		vi.fn(
			() =>
				new Promise((resolve) =>
					setTimeout(() => resolve([{ secret: "PRIVATE_SENTINEL" }]), 5),
				),
		),
		{ begin: vi.fn() },
	) as unknown as postgres.Sql;
	const observed = observePostgresClient(client, {
		observability: { record },
		slowQueryThresholdMs: 1,
	});
	await observed`select ${"PRIVATE_SENTINEL"}`;
	expect(record).toHaveBeenCalledWith(
		expect.objectContaining({
			stage: "dependency",
			outcome: "completed",
			operationRef: "store.query",
		}),
	);
	expect(JSON.stringify(record.mock.calls)).not.toContain("PRIVATE_SENTINEL");
});

it("keeps query failures unchanged when telemetry recording throws", async () => {
	const client = Object.assign(
		vi.fn(() => Promise.reject(new Error("query failure"))),
		{ begin: vi.fn() },
	) as unknown as postgres.Sql;
	const observed = observePostgresClient(client, {
		observability: {
			record: () => {
				throw new Error("telemetry failure");
			},
		},
		slowQueryThresholdMs: 1,
	});
	await expect(observed`select 1`).rejects.toThrow("query failure");
});

it("records bounded SQLSTATE and operation stage for failed Store queries", async () => {
	const record = vi.fn();
	const client = Object.assign(
		vi.fn(() =>
			Promise.reject(
				Object.assign(new Error("PRIVATE_SQL_AND_PARAMS"), {
					code: "40P01",
				}),
			),
		),
		{ begin: vi.fn() },
	) as unknown as postgres.Sql;
	const observed = observePostgresClient(client, {
		observability: { record },
	});
	await expect(
		runStoreQueryOperation(
			"store.management_transaction",
			() => observed`select 1`,
		),
	).rejects.toMatchObject({ code: "40P01" });
	expect(record).toHaveBeenCalledWith({
		stage: "dependency",
		outcome: "failed",
		durationMs: expect.any(Number),
		operationRef: "store.management_transaction",
		errorClass: "Error",
		sqlState: "40P01",
	});
	expect(JSON.stringify(record.mock.calls)).not.toContain(
		"PRIVATE_SQL_AND_PARAMS",
	);
});
