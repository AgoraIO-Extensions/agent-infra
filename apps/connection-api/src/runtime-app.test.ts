import { describe, expect, it, vi } from "vitest";

import { createFixedOriginFetch, createReadFallbackFetch } from "./runtime-app";

describe("GitHub regional egress fallback", () => {
	it("falls back only for transport-failed READ requests", async () => {
		const primary = vi
			.fn<typeof fetch>()
			.mockRejectedValue(new TypeError("offline"));
		const fallback = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json({ ok: true }));
		const fetcher = createReadFallbackFetch(primary, fallback);

		expect(await (await fetcher("https://api.github.com/meta")).json()).toEqual(
			{
				ok: true,
			},
		);
		expect(fallback).toHaveBeenCalledOnce();

		await expect(
			fetcher("https://api.github.com/repos/acme/widgets/issues", {
				body: "{}",
				method: "POST",
			}),
		).rejects.toThrow("offline");
		expect(fallback).toHaveBeenCalledOnce();
	});

	it("does not fallback after the primary returns an HTTP response", async () => {
		const primary = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response("unavailable", { status: 503 }));
		const fallback = vi.fn<typeof fetch>();
		const response = await createReadFallbackFetch(
			primary,
			fallback,
		)("https://api.github.com/meta");
		expect(response.status).toBe(503);
		expect(fallback).not.toHaveBeenCalled();
	});
});

describe("Jenkins deployment route", () => {
	it("rewrites only the fixed public origin to the fixed internal origin", async () => {
		const requests: Request[] = [];
		const fetcher = createFixedOriginFetch(
			"http://114.94.148.35:8010",
			"http://10.80.1.129:8080",
			async (input) => {
				requests.push(new Request(input));
				return new Response("ok");
			},
		);
		await fetcher(
			"http://114.94.148.35:8010/job/EP/job/build_all/901/api/json?tree=result",
		);
		expect(requests[0]?.url).toBe(
			"http://10.80.1.129:8080/job/EP/job/build_all/901/api/json?tree=result",
		);
		await expect(fetcher("http://attacker.example/api/json")).rejects.toThrow(
			/fixed route/,
		);
	});
});
