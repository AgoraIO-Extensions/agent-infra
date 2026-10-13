import { describe, expect, it, vi } from "vitest";
import { CompanyOAuthIdentityClient } from "./company-oauth";

describe("company OAuth identity transport", () => {
	it("uses fixed endpoints, Basic code exchange and Bearer profile without refresh or redirects", async () => {
		const calls: { url: string; init?: RequestInit }[] = [];
		const fetcher = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				calls.push({ url: String(input), init });
				return Response.json(
					calls.length === 1
						? {
								access_token: "synthetic-token",
								token_type: "Bearer",
								refresh_token: "discard-me",
							}
						: { id: 1, uid: "test-user" },
				);
			},
		);
		const client = new CompanyOAuthIdentityClient({
			clientId: "test-client",
			clientSecret: "test-secret",
			fetch: fetcher as typeof fetch,
		});
		expect(
			await client.readIdentity("code", "https://connection.example/callback"),
		).toEqual({ id: 1, uid: "test-user" });
		expect(calls.map((c) => c.url)).toEqual([
			"https://oauth.agoralab.co/oauth/token",
			"https://oauth.agoralab.co/api/v2/userInfo",
		]);
		expect(calls.every((c) => c.init?.redirect === "manual")).toBe(true);
		expect(calls[0]?.init?.body).toContain("grant_type=authorization_code");
		expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(
			`Basic ${Buffer.from("test-client:test-secret").toString("base64")}`,
		);
		expect(new Headers(calls[1]?.init?.headers).get("authorization")).toBe(
			"Bearer synthetic-token",
		);
		expect(calls[0]?.init?.signal).toBe(calls[1]?.init?.signal);
	});

	it("bounds responses and rejects redirects, invalid token types and private upstream error text", async () => {
		for (const response of [
			new Response("upstream-secret", { status: 302 }),
			Response.json({ access_token: "test", token_type: "Basic" }),
			new Response("x".repeat(65_537)),
		]) {
			const fetcher = vi.fn(async () => response);
			const client = new CompanyOAuthIdentityClient({
				clientId: "test",
				clientSecret: "test",
				fetch: fetcher as typeof fetch,
			});
			await expect(
				client.readIdentity("code", "https://connection.example/callback"),
			).rejects.toThrow(/Company OAuth/);
			expect(fetcher).toHaveBeenCalledTimes(1);
		}
	});
});
