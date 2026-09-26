import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
	newCallDiagnostics,
	observeProviderFetch,
	projectCallDiagnostics,
	withCallDiagnostics,
} from "./call-diagnostics";

describe("call HTTP diagnostics", () => {
	it("records real HTTP requests without consuming bodies or crossing concurrent calls", async () => {
		let received = 0;
		const server = createServer((req, res) => {
			received++;
			res.setHeader("x-request-id", "123e4567-e89b-12d3-a456-426614174000");
			res.setHeader("x-correlation-id", "TOKEN-CANARY");
			res.setHeader("set-cookie", "SECRET-CANARY");
			res.end(JSON.stringify({ body: "BODY-CANARY", method: req.method }));
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		try {
			const observed = observeProviderFetch("bitbucket", fetch);
			const a = newCallDiagnostics("EXECUTE");
			const b = newCallDiagnostics("RECONCILE");
			await Promise.all([
				withCallDiagnostics(a, async () => {
					for (let n = 0; n < 2; n++) {
						const r = await observed(
							`${origin}/rest/api/1.0/users/SECRET-CANARY?q=QUERY-CANARY#FRAGMENT-CANARY`,
							{
								method: "POST",
								headers: { authorization: "Bearer TOKEN-CANARY" },
								body: "BODY-CANARY",
							},
						);
						expect(await r.json()).toMatchObject({
							body: "BODY-CANARY",
							method: "POST",
						});
					}
				}),
				withCallDiagnostics(b, async () => {
					const r = await observed(`${origin}/whoami`);
					await r.text();
				}),
			]);
			expect(received).toBe(3);
			expect(a.requests).toHaveLength(2);
			expect(b.requests).toHaveLength(1);
			expect(a.requests[0]).toMatchObject({
				sequence: 1,
				method: "POST",
				pathTemplate: "/rest/api/1.0/users/{segment}",
				status: 200,
				outcome: "RESPONSE_HEADERS",
				requestIds: [
					{
						name: "x-request-id",
						value: "123e4567-e89b-12d3-a456-426614174000",
					},
				],
			});
			expect(a.requests[0]?.durationMs).toBeGreaterThanOrEqual(0);
			expect(JSON.stringify(projectCallDiagnostics(a))).not.toContain("CANARY");
			const outside = await observed(`${origin}/whoami`);
			await outside.text();
			expect(a.requests).toHaveLength(2);
			expect(b.requests).toHaveLength(1);
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});
	it("does not retry failures or reflect messages, and marks bounded capture", async () => {
		let calls = 0;
		const error = new DOMException("SECRET-CANARY", "TimeoutError");
		const observed = observeProviderFetch("github", (async () => {
			calls++;
			throw error;
		}) as typeof fetch);
		const diagnostic = newCallDiagnostics("EXECUTE");
		await expect(
			withCallDiagnostics(diagnostic, () =>
				observed(
					"https://user:SECRET-CANARY@example.invalid/issues/SECRET-CANARY?token=SECRET-CANARY",
				),
			),
		).rejects.toBe(error);
		expect(calls).toBe(1);
		expect(diagnostic.requests[0]).toMatchObject({
			origin: "https://example.invalid",
			pathTemplate: "/issues/{segment}",
			outcome: "TRANSPORT_ERROR",
			errorCategory: "TIMEOUT",
			status: null,
		});
		expect(JSON.stringify(diagnostic)).not.toContain("CANARY");
		const ok = observeProviderFetch(
			"github",
			(async () => new Response(null, { status: 204 })) as typeof fetch,
		);
		const bounded = newCallDiagnostics("EXECUTE");
		await withCallDiagnostics(bounded, async () => {
			for (let n = 0; n < 35; n++) await ok("https://example.invalid/user");
		});
		expect(bounded.requests).toHaveLength(32);
		expect(bounded.droppedRequests).toBe(3);
		expect(
			projectCallDiagnostics({
				...bounded,
				secret: "CANARY",
				requests: bounded.requests.map((r) => ({ ...r, body: "CANARY" })),
			}),
		).toEqual(bounded);
	});
});
