import { readFileSync } from "node:fs";
import { observeProviderFetch } from "@agent-infra/connection-core";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import {
	createFixedOriginFetch,
	createGithubOAuthDirectFetch,
	createGithubOAuthFetcherSelector,
	createPreSubmitGithubOAuthAdapter,
	createReadFallbackFetch,
} from "./runtime-app";

const tokenUrl = "https://github.com/login/oauth/access_token";
const profileUrl = "https://api.github.com/user";

it("production assembly uses registered diagnostic service names", () => {
	const source = ts.createSourceFile(
		"runtime-app.ts",
		readFileSync(new URL("./runtime-app.ts", import.meta.url), "utf8"),
		ts.ScriptTarget.Latest,
		true,
	);
	const services: string[] = [];
	const visit = (node: ts.Node) => {
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === "observeProviderFetch"
		) {
			const service = node.arguments[0];
			if (!service || !ts.isStringLiteral(service))
				throw new Error("Runtime diagnostic service must be fixed");
			services.push(service.text);
			expect(() => observeProviderFetch(service.text, vi.fn())).not.toThrow();
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	expect(services).toContain("datalego");
	expect(() => observeProviderFetch("unregistered-service", vi.fn())).toThrow(
		"Unknown diagnostic service",
	);
});

describe("GitHub OAuth pre-submit egress", () => {
	it("uses the approved request scopes instead of catalog-wide defaults", () => {
		const adapter = createPreSubmitGithubOAuthAdapter(
			{ clientId: "client", clientSecret: "secret" },
			vi.fn<typeof fetch>(),
			async () => vi.fn<typeof fetch>(),
		);
		const input = {
			codeChallenge: "challenge",
			redirectUri: "https://connection.test/oauth/callback",
			state: "state",
		};
		const limited = new URL(
			adapter.getAuthorizationUrl({
				...input,
				requestedScopes: ["repo", "read:user"],
			}),
		);
		expect(limited.searchParams.get("scope")).toBe("read:user repo");
		const shared = new URL(adapter.getAuthorizationUrl(input));
		expect(shared.searchParams.get("scope")).toBe(
			"read:user user:email repo delete_repo workflow",
		);
	});

	it("keeps the proxy after an HTTP response, even an error status", async () => {
		const primary = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response(null, { status: 503 }));
		const direct = vi.fn<typeof fetch>();
		const onDirect = vi.fn();
		expect(
			await createGithubOAuthFetcherSelector(
				primary,
				direct,
				onDirect,
			)(tokenUrl),
		).toBe(primary);
		expect(primary).toHaveBeenCalledWith(
			tokenUrl,
			expect.objectContaining({ method: "HEAD" }),
		);
		expect(onDirect).not.toHaveBeenCalled();
	});

	it("selects direct before submission only for proxy transport failures", async () => {
		const failure = new TypeError("fetch failed", {
			cause: Object.assign(new Error(), { code: "ECONNRESET" }),
		});
		const primary = vi.fn<typeof fetch>().mockRejectedValue(failure);
		const direct = vi.fn<typeof fetch>();
		const onDirect = vi.fn();
		const select = createGithubOAuthFetcherSelector(primary, direct, onDirect);
		expect(await select(tokenUrl)).toBe(direct);
		expect(onDirect).toHaveBeenCalledOnce();
		expect(await select("https://other.example/token")).toBe(primary);
		expect(primary).toHaveBeenCalledOnce();
	});

	it("does not switch routes for an unexpected preflight error", async () => {
		const primary = vi
			.fn<typeof fetch>()
			.mockRejectedValue(new Error("policy rejected"));
		const direct = vi.fn<typeof fetch>();
		await expect(
			createGithubOAuthFetcherSelector(primary, direct)(tokenUrl),
		).rejects.toThrow("policy rejected");
		expect(direct).not.toHaveBeenCalled();
	});

	it("uses one selected direct route for token and profile without replaying a failed POST", async () => {
		const failure = new TypeError("fetch failed", {
			cause: Object.assign(new Error(), { code: "ECONNRESET" }),
		});
		const primary = vi.fn<typeof fetch>().mockRejectedValue(failure);
		const transport = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				Response.json({
					access_token: "token",
					scope: "read:user",
					token_type: "bearer",
				}),
			)
			.mockResolvedValueOnce(Response.json({ id: 42, login: "octocat" }));
		const direct = createGithubOAuthDirectFetch(transport);
		const adapter = createPreSubmitGithubOAuthAdapter(
			{ clientId: "client", clientSecret: "secret" },
			primary,
			() => createGithubOAuthFetcherSelector(primary, direct)(tokenUrl),
		);
		const input = {
			code: "code",
			codeVerifier: "verifier",
			redirectUri: "https://connection.test/oauth/callback",
		};
		const stages: string[] = [];
		expect(
			(await adapter.exchangeCode(input, (stage) => stages.push(stage)))
				.externalAccount,
		).toBe("42");
		expect(stages).toEqual(["token_exchange", "profile_lookup"]);
		expect(primary).toHaveBeenCalledOnce();
		expect(transport.mock.calls.map(([url]) => String(url))).toEqual([
			tokenUrl,
			profileUrl,
		]);

		transport.mockRejectedValueOnce(failure);
		stages.length = 0;
		await expect(
			adapter.exchangeCode(input, (stage) => stages.push(stage)),
		).rejects.toThrow("OAuth token request failed");
		expect(stages).toEqual(["token_exchange"]);
		expect(primary).toHaveBeenCalledTimes(2);
		expect(transport).toHaveBeenCalledTimes(3);
	});

	it("does not retry direct if the proxy fails after the code POST starts", async () => {
		const failure = new TypeError("fetch failed", {
			cause: Object.assign(new Error(), { code: "ECONNRESET" }),
		});
		const primary = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(null, { status: 404 }))
			.mockRejectedValueOnce(failure);
		const direct = vi.fn<typeof fetch>();
		const adapter = createPreSubmitGithubOAuthAdapter(
			{ clientId: "client", clientSecret: "secret" },
			primary,
			() => createGithubOAuthFetcherSelector(primary, direct)(tokenUrl),
		);
		await expect(
			adapter.exchangeCode({
				code: "code",
				codeVerifier: "verifier",
				redirectUri: "https://connection.test/oauth/callback",
			}),
		).rejects.toThrow("OAuth token request failed");
		expect(primary).toHaveBeenCalledTimes(2);
		expect(primary.mock.calls[1]?.[1]?.method).toBe("POST");
		expect(direct).not.toHaveBeenCalled();
	});

	it("restricts direct traffic to exact OAuth endpoints and rejects redirects", async () => {
		const transport = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(null, {
				status: 302,
				headers: { location: "https://other.example/" },
			}),
		);
		const direct = createGithubOAuthDirectFetch(transport);
		await expect(
			direct("https://api.github.com/repos/owner/repo"),
		).rejects.toThrow("direct target is not allowed");
		await expect(direct(`${profileUrl}?token=leak`)).rejects.toThrow(
			"direct target is not allowed",
		);
		await expect(direct(tokenUrl, { method: "GET" })).rejects.toThrow(
			"direct target is not allowed",
		);
		expect(transport).not.toHaveBeenCalled();
		await expect(direct(tokenUrl, { method: "POST" })).rejects.toThrow(
			"direct redirect is not allowed",
		);
		expect(transport).toHaveBeenCalledWith(
			tokenUrl,
			expect.objectContaining({ method: "POST", redirect: "manual" }),
		);
	});
});

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
