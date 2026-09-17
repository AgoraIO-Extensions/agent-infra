import { describe, expect, it, vi } from "vitest";

import { createReadFallbackFetch } from "./runtime-app";

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
