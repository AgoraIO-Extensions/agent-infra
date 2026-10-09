import {
	ConnectionApplicationService,
	ConnectionError,
	type ConnectionOAuthService,
	type ConnectionRepository,
	OAuthProtocolError,
} from "@agent-infra/connection-core";
import { expect, it } from "vitest";
import { createConnectionOAuthApp } from "./oauth-routes";

it("lifecycle management derives actor from admin session and preserves failures", async () => {
	const repository = {
		authorizeConnectionAdministration: async (id: string) => id === "admin",
	} as unknown as ConnectionRepository;
	const service = new ConnectionApplicationService(repository, {} as never);
	const oauth = {
		getBrowserAccount: async (token?: string) => {
			if (!token) throw new OAuthProtocolError("invalid_token", "denied", 401);
			return {
				principalId: token === "admin" ? "admin" : "user",
				displayName: "Test",
			};
		},
	} as unknown as ConnectionOAuthService;
	let writes = 0;
	let reject = false;
	const app = createConnectionOAuthApp({
		issuer: "https://connection.example",
		resource: "https://connection.example/mcp",
		service: oauth,
		management: {
			service,
			githubRedirectUri: "https://connection.example/callback",
			providerLifecycle: {
				getProviderReleaseLifecycle: async (actor) => {
					expect(actor).toBe("admin");
					return {} as never;
				},
				changeProviderReleaseLifecycle: async (input) => {
					writes++;
					expect(input.actorPrincipalId).toBe("admin");
					expect(input.expectedRevision).toBe("3");
					if (reject)
						throw new ConnectionError(
							"INVALID_REQUEST",
							"ProviderRelease still has dependencies",
						);
					return { releaseId: input.releaseId, operation: input.operation };
				},
			},
		},
	});
	const path = "/api/v1/connection/admin/provider-releases/old/lifecycle";
	expect((await app.request(path)).status).toBe(401);
	expect(
		(
			await app.request(path, {
				headers: { cookie: "connection_session=user" },
			})
		).status,
	).toBe(404);
	const headers = {
		cookie: "connection_session=admin",
		origin: "https://connection.example",
		"content-type": "application/json",
		"idempotency-key": "lifecycle-key",
		"if-match": '"3"',
	};
	expect(
		(await app.request(path, { headers })).headers.get("cache-control"),
	).toBe("no-store");
	const post = (body: unknown, extra = {}) =>
		app.request(path, {
			method: "POST",
			headers: { ...headers, ...extra },
			body: JSON.stringify(body),
		});
	expect(
		(
			await post({
				operation: "retire",
				reason: "Migrated",
				actorPrincipalId: "forged",
			})
		).status,
	).toBe(400);
	expect(
		(
			await post(
				{ operation: "retire", reason: "Migrated" },
				{ origin: "https://evil.example" },
			)
		).status,
	).toBe(400);
	expect(
		(
			await post(
				{ operation: "retire", reason: "Migrated" },
				{ "if-match": "" },
			)
		).status,
	).toBe(400);
	expect(writes).toBe(0);
	expect((await post({ operation: "retire", reason: "Migrated" })).status).toBe(
		200,
	);
	reject = true;
	expect((await post({ operation: "retire", reason: "Migrated" })).status).toBe(
		400,
	);
});
