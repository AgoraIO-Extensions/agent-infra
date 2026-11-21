import { expect, it, vi } from "vitest";
import {
	observeNativeMetadataRpcV1,
	withNativeMetadataTraceV1,
} from "./native-metadata-telemetry.js";

it("records bounded RPC timing and original concurrent traces without native contents", async () => {
	const log = vi.spyOn(console, "info").mockImplementation(() => {});
	try {
		const traces = [
			"11111111-1111-1111-1111-111111111111",
			"22222222-2222-2222-2222-222222222222",
		];
		await Promise.all(
			traces.map((trace) =>
				withNativeMetadataTraceV1(trace, () =>
					observeNativeMetadataRpcV1("thread/read", async () => ({
						content: "PRIVATE_CANARY",
					})),
				),
			),
		);
		await expect(
			withNativeMetadataTraceV1(traces[0], () =>
				observeNativeMetadataRpcV1("skills/list", async () => {
					throw Error("PRIVATE_CANARY");
				}),
			),
		).rejects.toThrow("PRIVATE_CANARY");
		const rows = log.mock.calls.map(([line]) => JSON.parse(String(line)));
		expect(rows).toHaveLength(3);
		expect(rows.map((r) => r.traceId)).toEqual([...traces, traces[0]]);
		expect(rows[2]).toMatchObject({
			method: "skills/list",
			outcome: "unavailable",
		});
		for (const row of rows) {
			expect(Object.keys(row).sort()).toEqual([
				"elapsedMs",
				"event",
				"method",
				"outcome",
				"traceId",
			]);
			expect(row.elapsedMs).toBeGreaterThanOrEqual(0);
		}
		expect(JSON.stringify(rows)).not.toContain("PRIVATE_CANARY");
		const count = log.mock.calls.length;
		await withNativeMetadataTraceV1(traces[0], () =>
			observeNativeMetadataRpcV1("PRIVATE_CANARY" as never, async () => null),
		);
		expect(log.mock.calls).toHaveLength(count);
		await withNativeMetadataTraceV1("PRIVATE_CANARY", () =>
			observeNativeMetadataRpcV1("thread/read", async () => null),
		);
		expect(log.mock.calls).toHaveLength(count);
	} finally {
		log.mockRestore();
	}
});
