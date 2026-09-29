import { describe, expect, it } from "vitest";
import {
	AuditReadError,
	loadAuditDetail,
	loadAuditPage,
} from "./audit-query.js";
import { auditPage, auditRecord } from "./audit-test-fixtures.js";

function transportFor(
	handler: (request: Request) => Response | Promise<Response>,
) {
	const requests: Request[] = [];
	return {
		requests,
		transport: async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			requests.push(request);
			return handler(request);
		},
	};
}

describe("Scoped audit browser transport", () => {
	it.each(["own", "administrator"] as const)(
		"uses the %s route, stable filters, and separate list/detail requests",
		async (scope) => {
			const { requests, transport } = transportFor((request) =>
				new URL(request.url).pathname.endsWith("/audit-a")
					? Response.json(auditRecord())
					: Response.json(auditPage("audit-a", "cursor-a")),
			);
			const filters = {
				from: "2026-09-27T00:00:00Z",
				until: "2026-09-29T00:00:00Z",
				principalKind: "user" as const,
				principalId: "user-a",
				agentId: "agent-a",
				action: "task.api.access" as const,
				result: "accepted" as const,
				executionId: "execution-a",
			};
			const input = {
				scope,
				filters,
				transport,
				baseUrl: "https://platform.example.test",
				signal: new AbortController().signal,
			};
			expect((await loadAuditPage(input)).items).toHaveLength(1);
			expect(
				(await loadAuditDetail({ ...input, auditId: "audit-a" })).auditId,
			).toBe("audit-a");
			const base = scope === "own" ? "/api/v1/audit" : "/api/v3/admin/audit";
			expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
				base,
				`${base}/audit-a`,
			]);
			for (const [index, request] of requests.entries()) {
				expect(Object.fromEntries(new URL(request.url).searchParams)).toEqual(
					index === 0 ? { ...filters, limit: "25" } : filters,
				);
				expect(request.method).toBe("GET");
				expect(request.credentials).toBe("same-origin");
			}
		},
	);

	it.each([
		[401, "authorization"],
		[403, "authorization"],
		[404, "authorization"],
		[503, "service"],
		[400, "http"],
	] as const)("reduces HTTP %s to safe %s failure", async (status, kind) => {
		const { transport } = transportFor(() =>
			Response.json({ message: "PRIVATE_DATABASE_DETAIL" }, { status }),
		);
		const error = await loadAuditPage({
			scope: "own",
			transport,
			signal: new AbortController().signal,
		}).catch((value: unknown) => value);
		expect(error).toBeInstanceOf(AuditReadError);
		expect(error).toMatchObject({ failure: { kind } });
		expect(String(error)).not.toContain("PRIVATE");
	});

	it("rejects incomplete principal filters before sending a request", async () => {
		const { requests, transport } = transportFor(() =>
			Response.json(auditPage()),
		);
		await expect(
			loadAuditPage({
				scope: "own",
				filters: { principalKind: "user" },
				transport,
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({ failure: { kind: "invalid" } });
		expect(requests).toHaveLength(0);
	});

	it.each(["oversize", "cycle", "detail-mismatch"] as const)(
		"rejects invalid %s response",
		async (kind) => {
			const { transport } = transportFor((_request) => {
				if (kind === "detail-mismatch")
					return Response.json(auditRecord("different-audit"));
				return Response.json(
					kind === "oversize"
						? {
								items: Array.from({ length: 26 }, () => auditRecord()),
								nextCursor: null,
							}
						: { items: [auditRecord()], nextCursor: "cursor-a" },
				);
			});
			const input = {
				scope: "own" as const,
				transport,
				baseUrl: "https://platform.example.test",
				signal: new AbortController().signal,
			};
			const promise =
				kind === "detail-mismatch"
					? loadAuditDetail({ ...input, auditId: "audit-a" })
					: loadAuditPage({ ...input, cursor: "cursor-a" });
			await expect(promise).rejects.toMatchObject({
				failure: { kind: "invalid" },
			});
		},
	);

	it("rejects a late response after cancellation", async () => {
		const controller = new AbortController();
		const { transport } = transportFor(async () => {
			controller.abort();
			return Response.json(auditPage());
		});
		await expect(
			loadAuditPage({
				scope: "own",
				transport,
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ name: "AbortError" });
	});
});
