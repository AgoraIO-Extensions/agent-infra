import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createGrafanaQueryStatusWriter } from "@agent-infra/platform-store";

const config = JSON.parse(
	await readFile("/etc/grafana-query-observer/query-observer.json", "utf8"),
) as { uid: string; cluster: string; namespace: string; expr: string };
const write = createGrafanaQueryStatusWriter({
	ca: await readFile("/etc/grafana/platform-ca/ca.crt", "utf8"),
	host: process.env.PGHOST,
	port: Number(process.env.PGPORT ?? 5432),
	database: process.env.PGDATABASE,
	username: process.env.PGUSER,
	password: process.env.PGPASSWORD,
});
async function probe() {
	const end = Date.now();
	const response = await fetch(
		"http://127.0.0.1:3000/ops-grafana/api/ds/query",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			redirect: "error",
			signal: AbortSignal.timeout(10000),
			body: JSON.stringify({
				from: String(end - 60000),
				to: String(end),
				queries: [
					{
						refId: "A",
						datasource: { type: "prometheus", uid: config.uid },
						expr: config.expr,
						instant: true,
						range: false,
						format: "time_series",
					},
				],
			}),
		},
	);
	if (!response.ok) throw new Error("Query failed");
	const payload = (await response.json()) as {
		results?: {
			A?: {
				error?: string;
				status?: number;
				frames?: {
					schema?: { fields?: { type: string }[] };
					data?: { values?: unknown[][] };
				}[];
			};
		};
	};
	const result = payload.results?.A;
	if (
		!result ||
		result.error ||
		(result.status ?? 200) >= 400 ||
		!Array.isArray(result.frames)
	)
		throw new Error("Invalid query result");
	const values: number[] = [];
	for (const frame of result.frames) {
		const fields = frame.schema?.fields;
		if (!Array.isArray(fields) || !Array.isArray(frame.data?.values))
			throw new Error("Invalid data frame");
		for (const [index, field] of fields.entries()) {
			const column = frame.data.values[index];
			if (!Array.isArray(column)) throw new Error("Invalid frame values");
			if (field.type === "number") {
				for (const value of column) {
					if (typeof value !== "number")
						throw new Error("Invalid numeric sample");
					values.push(value);
				}
			}
		}
	}
	if (values.length === 0) return null;
	const seconds = values[0];
	if (
		values.length !== 1 ||
		typeof seconds !== "number" ||
		!Number.isFinite(seconds) ||
		seconds < 0 ||
		seconds * 1000 > end + 5000
	)
		throw new Error("Invalid sample time");
	const sample = new Date(seconds * 1000);
	return sample;
}
while (true) {
	const checkedAt = new Date();
	let result = "failed";
	let sample: Date | null = null;
	try {
		sample = await probe();
		result = sample ? "samples" : "empty";
	} catch {
		/* The status row records the failed observation. */
	}
	try {
		await write({ ...config, checkedAt, result, sample });
	} catch {
		process.stderr.write("ACK query status write failed\n");
	}
	await delay(Math.max(1000, 60_000 - (Date.now() - checkedAt.getTime())));
}
