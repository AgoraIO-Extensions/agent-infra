import { describe, expect, it, vi } from "vitest";
import {
	getOwnExecutionAudit,
	listOwnExecutionAudit,
} from "./generated/sdk.gen.js";
import { listAgentsV2 } from "./generated-v2/sdk.gen.js";

const credential = `papi_${"s".repeat(43)}`;

function transport() {
	let request: Request | undefined;
	const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
		request = input as Request;
		return Response.json({ items: [], nextCursor: null });
	});
	return { fetch, request: () => request };
}

describe("generated GET Agents authentication selection", () => {
	it("uses string auth as Bearer and omits ambient session Cookies", async () => {
		const http = transport();
		const result = await listAgentsV2({
			baseUrl: "https://platform.example.test",
			auth: credential,
			credentials: "include",
			fetch: http.fetch,
		});
		expect(result.data).toEqual({ items: [], nextCursor: null });
		expect(http.request()?.headers.get("Authorization")).toBe(
			`Bearer ${credential}`,
		);
		expect(http.request()?.headers.has("Cookie")).toBe(false);
		expect(http.request()?.credentials).toBe("omit");
	});

	it("keeps explicit Cookie selection without adding Bearer", async () => {
		const http = transport();
		await listAgentsV2({
			baseUrl: "https://platform.example.test",
			auth: (scheme) =>
				scheme.in === "cookie" ? "controlled-session" : undefined,
			security: [
				{ type: "apiKey", in: "cookie", name: "__Host-platform-session" },
			],
			fetch: http.fetch,
		});
		expect(http.request()?.headers.get("Cookie")).toBe(
			"__Host-platform-session=controlled-session",
		);
		expect(http.request()?.headers.has("Authorization")).toBe(false);
	});

	it("supports the standard explicit Bearer security option", async () => {
		const http = transport();
		await listAgentsV2({
			baseUrl: "https://platform.example.test",
			auth: credential,
			security: [{ type: "http", scheme: "bearer" }],
			fetch: http.fetch,
		});
		expect(http.request()?.headers.get("Authorization")).toBe(
			`Bearer ${credential}`,
		);
		expect(http.request()?.headers.has("Cookie")).toBe(false);
		expect(http.request()?.credentials).toBe("omit");
	});

	it("rejects a callback supplying both schemes without exposing their values", async () => {
		const http = transport();
		await expect(
			listAgentsV2({
				baseUrl: "https://platform.example.test",
				auth: () => credential,
				security: [
					{ type: "apiKey", in: "cookie", name: "__Host-platform-session" },
					{ type: "http", scheme: "bearer" },
				],
				fetch: http.fetch,
				throwOnError: true,
			}),
		).rejects.toThrow("Select one read authentication scheme");
		expect(http.fetch).not.toHaveBeenCalled();
	});

	it.each([credential, "controlled-session"])(
		"rejects an explicitly supplied Cookie with string Bearer auth",
		async (cookie) => {
			const http = transport();
			await expect(
				listAgentsV2({
					baseUrl: "https://platform.example.test",
					auth: credential,
					headers: { Cookie: `__Host-platform-session=${cookie}` },
					fetch: http.fetch,
					throwOnError: true,
				}),
			).rejects.toThrow("Select one read authentication scheme");
			expect(http.fetch).not.toHaveBeenCalled();
		},
	);

	it("preserves the browser's ambient Cookie credentials when no Bearer is selected", async () => {
		const http = transport();
		await listAgentsV2({
			baseUrl: "https://platform.example.test",
			credentials: "include",
			fetch: http.fetch,
		});
		expect(http.request()?.credentials).toBe("include");
		expect(http.request()?.headers.has("Authorization")).toBe(false);
	});
});

function queryAudit(
	mode: "list" | "detail",
	options: NonNullable<Parameters<typeof listOwnExecutionAudit>[0]>,
) {
	return mode === "list"
		? listOwnExecutionAudit(options)
		: getOwnExecutionAudit({ ...options, path: { auditId: "audit_1" } });
}

describe("generated own-audit authentication selection", () => {
	it.each(["list", "detail"] as const)(
		"uses string Bearer without explicit or ambient Cookies (%s)",
		async (mode) => {
			const http = transport();
			await queryAudit(mode, {
				baseUrl: "https://platform.example.test",
				auth: credential,
				credentials: "include",
				fetch: http.fetch,
			});
			expect(http.request()?.headers.get("Authorization")).toBe(
				`Bearer ${credential}`,
			);
			expect(http.request()?.headers.has("Cookie")).toBe(false);
			expect(http.request()?.credentials).toBe("omit");
			expect(new URL(http.request()?.url ?? "").pathname).toBe(
				mode === "list" ? "/api/v1/audit" : "/api/v1/audit/audit_1",
			);
		},
	);
	it.each(["list", "detail"] as const)(
		"retains explicit native Cookie selection without Bearer (%s)",
		async (mode) => {
			const http = transport();
			await queryAudit(mode, {
				baseUrl: "https://platform.example.test",
				auth: (scheme) =>
					scheme.in === "cookie" ? "controlled-session" : undefined,
				security: [
					{ type: "apiKey", in: "cookie", name: "__Host-platform-session" },
				],
				fetch: http.fetch,
			});
			expect(http.request()?.headers.get("Cookie")).toBe(
				"__Host-platform-session=controlled-session",
			);
			expect(http.request()?.headers.has("Authorization")).toBe(false);
		},
	);
	it.each(["list", "detail"] as const)(
		"retains ambient browser Cookie credentials without selecting Bearer (%s)",
		async (mode) => {
			const http = transport();
			await queryAudit(mode, {
				baseUrl: "https://platform.example.test",
				credentials: "include",
				fetch: http.fetch,
			});
			expect(http.request()?.credentials).toBe("include");
			expect(http.request()?.headers.has("Authorization")).toBe(false);
		},
	);
	it.each(["list", "detail"] as const)(
		"rejects explicit Cookie plus Bearer before fetch (%s)",
		async (mode) => {
			const http = transport();
			await expect(
				queryAudit(mode, {
					baseUrl: "https://platform.example.test",
					auth: credential,
					headers: { Cookie: "__Host-platform-session=controlled-session" },
					fetch: http.fetch,
					throwOnError: true,
				}),
			).rejects.toThrow("Select one read authentication scheme");
			expect(http.fetch).not.toHaveBeenCalled();
		},
	);
});
