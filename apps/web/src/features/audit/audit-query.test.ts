import { describe, expect, it } from "vitest";
import { createClient } from "../../pilot/generated/client/index.js";
import {
	AuditReadError,
	loadAuditDetail,
	loadAuditPage,
} from "./audit-query.js";
import { auditRecord } from "./audit-test-fixtures.js";

describe("Scoped audit generated client boundary", () => {
	it.each(["own", "administrator"] as const)(
		"uses the %s endpoint and all six server filters for page and detail",
		async (scope) => {
			const requests: Request[] = [];
			const client = createClient({
				baseUrl: "https://platform.example.test",
				fetch: async (input, init) => {
					const request = new Request(input, init);
					requests.push(request);
					return Response.json(
						new URL(request.url).pathname.endsWith("/audit-a")
							? auditRecord()
							: { items: [auditRecord()], nextCursor: "cursor-a" },
					);
				},
			});
			const filters = {
				from: "2026-09-27T00:00:00Z",
				until: "2026-09-29T00:00:00Z",
				principalKind: "user" as const,
				principalId: "user-a",
				agentId: "agent-a",
				action: "task.api.submit.result" as const,
				result: "succeeded" as const,
				executionId: "execution-a",
			};
			const input = {
				scope,
				filters,
				client,
				signal: new AbortController().signal,
			};
			expect((await loadAuditPage(input)).items[0].operation).toBeNull();
			expect(
				(await loadAuditDetail({ ...input, auditId: "audit-a" })).auditId,
			).toBe("audit-a");
			const base = scope === "own" ? "/api/v1/audit" : "/api/v3/admin/audit";
			expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
				base,
				`${base}/audit-a`,
			]);
			for (const [index, request] of requests.entries()) {
				const query = Object.fromEntries(new URL(request.url).searchParams);
				expect(query).toEqual(
					index === 0 ? { ...filters, limit: "25" } : filters,
				);
				expect(request.method).toBe("GET");
				expect(request.body).toBeNull();
			}
		},
	);

	it.each([
		[401, "authorization"],
		[403, "authorization"],
		[404, "authorization"],
		[503, "service"],
		[400, "http"],
	])("reduces HTTP %s errors to safe %s failures", async (status, kind) => {
		const client = createClient({
			baseUrl: "https://platform.example.test",
			fetch: async () =>
				Response.json(
					{
						message: "private-database-detail",
						credentials: "synthetic-private-value",
					},
					{ status: status as number },
				),
		});
		const error = await loadAuditPage({
			scope: "own",
			signal: new AbortController().signal,
			client,
		}).catch((error: unknown) => error);
		expect(error).toBeInstanceOf(AuditReadError);
		expect(error).toMatchObject({ failure: { kind } });
		expect(String(error)).not.toContain("private");
		expect(JSON.stringify(error)).not.toContain("private");
	});

	it.each(["extra", "mismatch", "cycle", "oversize"])(
		"rejects invalid %s responses without retaining raw payloads",
		async (kind) => {
			const client = createClient({
				baseUrl: "https://platform.example.test",
				fetch: async () =>
					Response.json(
						kind === "mismatch"
							? auditRecord("different-audit")
							: {
									items: Array.from(
										{ length: kind === "oversize" ? 26 : 1 },
										() => ({
											...auditRecord(),
											...(kind === "extra"
												? { body: "synthetic-private-content" }
												: {}),
										}),
									),
									nextCursor: kind === "cycle" ? "cursor-a" : null,
								},
					),
			});
			const input = {
				scope: "own" as const,
				client,
				signal: new AbortController().signal,
			};
			const promise =
				kind === "mismatch"
					? loadAuditDetail({ ...input, auditId: "audit-a" })
					: loadAuditPage({ ...input, cursor: "cursor-a" });
			await expect(promise).rejects.toMatchObject({
				failure: { kind: "invalid" },
			});
		},
	);

	it("rejects a late response even when the transport ignores cancellation", async () => {
		const controller = new AbortController();
		const client = createClient({
			baseUrl: "https://platform.example.test",
			fetch: async () => {
				controller.abort();
				return Response.json({ items: [auditRecord()], nextCursor: null });
			},
		});
		await expect(
			loadAuditPage({ scope: "own", signal: controller.signal, client }),
		).rejects.toMatchObject({ name: "AbortError" });
	});
});
