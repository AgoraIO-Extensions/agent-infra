import {
	ConnectionApplicationService,
	ConnectionError,
	type ConnectionOAuthService,
	type ConnectionRepository,
	OAuthProtocolError,
} from "@agent-infra/connection-core";
import type { PostgresConnectionApprovalRepository } from "@agent-infra/connection-store";
import { expect, it, vi } from "vitest";
import { createConnectionOAuthApp } from "./oauth-routes";

it("reads current settings but restricts switches to same-origin administrators and validated revisions", async () => {
	const repository = {
		authorizeConnectionAdministration: async (id: string) => id === "admin",
	} as unknown as ConnectionRepository;
	const oauth = {
		getBrowserAccount: async (token?: string) => {
			if (!token) throw new OAuthProtocolError("invalid_token", "denied", 401);
			return {
				principalId: token === "admin" ? "admin" : "user",
				displayName: "Test",
			};
		},
	} as unknown as ConnectionOAuthService;
	const update = vi.fn(async (input: unknown) => ({
		...(input as object),
		revision: "2",
	}));
	const catalog = {
		listProviderAccessSettings: vi.fn(async () => [
			{ providerId: "github", approvalRequired: false, revision: "1" },
		]),
		updateProviderAccessSettings: update,
	} as unknown as PostgresConnectionApprovalRepository;
	const app = createConnectionOAuthApp({
		issuer: "https://connection.example",
		resource: "https://connection.example/mcp",
		service: oauth,
		management: {
			service: new ConnectionApplicationService(repository, {} as never),
			githubRedirectUri: "https://connection.example/callback",
			approvalCatalog: catalog,
			catalogs: [
				{ provider: "github", providerReleaseId: "github-v1", actions: [] },
			] as never,
		},
	});
	const readPath = "/api/v1/connection/provider-access-settings";
	expect((await app.request(readPath)).status).toBe(401);
	const read = await app.request(readPath, {
		headers: { cookie: "connection_session=user" },
	});
	expect(read.status).toBe(200);
	expect(read.headers.get("cache-control")).toBe("no-store");
	expect(await read.json()).toMatchObject({
		settings: [{ providerId: "github", approvalRequired: false }],
	});
	const path = "/api/v1/connection/admin/provider-access-settings/github";
	const headers = {
		cookie: "connection_session=admin",
		origin: "https://connection.example",
		"content-type": "application/json",
		"idempotency-key": "settings-key",
	};
	const body = { approvalRequired: true, expectedRevision: "1" };
	const post = (value: unknown, override = {}, url = path) =>
		app.request(url, {
			method: "POST",
			headers: { ...headers, ...override },
			body: JSON.stringify(value),
		});
	expect((await post(body, { cookie: "connection_session=user" })).status).toBe(
		404,
	);
	expect((await post(body, { origin: "https://evil.example" })).status).toBe(
		400,
	);
	expect((await post({ ...body, actorPrincipalId: "admin" })).status).toBe(400);
	expect((await post({ ...body, expectedRevision: "-1" })).status).toBe(400);
	expect(
		(
			await post(
				body,
				{},
				"/api/v1/connection/admin/provider-access-settings/unknown",
			)
		).status,
	).toBe(404);
	expect(update).not.toHaveBeenCalled();
	expect((await post(body)).status).toBe(200);
	expect(update).toHaveBeenCalledWith({
		actorPrincipalId: "admin",
		providerId: "github",
		...body,
	});
	update.mockRejectedValueOnce(
		new ConnectionError("IDEMPOTENCY_CONFLICT", "changed"),
	);
	expect((await post(body, { "idempotency-key": "other-key" })).status).toBe(
		409,
	);
});
