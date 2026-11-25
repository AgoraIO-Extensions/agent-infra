import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import {
	openPostgresTestClient,
	startPostgresTestDatabase,
} from "./postgres-test.ts";

it("preserves the last Pod sample and first failure across retries and an empty recovery", async () => {
	const db = await startPostgresTestDatabase("grafana-query-status");
	const sql = openPostgresTestClient(db, 1);
	try {
		await sql.unsafe(
			await readFile(
				new URL(
					"../../../deploy/observability/grafana/query-status.sql",
					import.meta.url,
				),
				"utf8",
			),
		);
		const at = (m: number) => new Date(Date.UTC(2026, 0, 1, 0, m));
		const record = (m: number, result: string, sample: Date | null) =>
			sql`select platform_ops_dashboard.record_ack_query('ack','cluster','ns',${at(m)},${result},${sample})`;
		const state = async () =>
			(
				await sql`select last_sample,failed_at,recovered_at,result from platform_ops_dashboard.ack_query_status`
			)[0];
		await record(1, "samples", at(0));
		await record(2, "failed", null);
		await record(3, "failed", null);
		expect(await state()).toEqual({
			last_sample: at(0),
			failed_at: at(2),
			recovered_at: null,
			result: "failed",
		});
		await record(4, "empty", null);
		await record(2, "failed", null);
		expect(await state()).toEqual({
			last_sample: at(0),
			failed_at: at(2),
			recovered_at: at(4),
			result: "empty",
		});
		await record(5, "samples", at(5));
		await record(6, "failed", null);
		expect(await state()).toEqual({
			last_sample: at(5),
			failed_at: at(6),
			recovered_at: null,
			result: "failed",
		});
	} finally {
		await sql.end();
		await db.stop();
	}
}, 120000);
