import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { registerConnectionInstallationRoutesV1 } from "./connection-installation-routes.js";

function fixture(withAuthorizationUrl = false, callbackEnabled = false) {
	const execute = vi.fn(async (input) => ({
		schemaVersion: 1 as const,
		authorizationId: "authorization-a",
		confirmationRevision: "confirmation-a",
		principal: { kind: "user" as const, id: input.userId },
		reference: {
			agentId: "agent-a",
			conversationId: "conversation-a",
			executionId: "execution-a",
			sessionGeneration: 1,
		},
		scope: {
			agentId: "agent-a",
			sandboxId: "sandbox-a",
			podUid: "pod-a",
			sessionGeneration: 1,
			configFingerprint: "a".repeat(64),
			source: { ref: "profile", revision: "r1" },
			oauthConfiguration: { ref: "oauth", revision: "r1" },
		},
		status: "awaiting_confirmation" as const,
		expiresAt: 123000,
		...(withAuthorizationUrl
			? {
					authorizationUrl: `https://connection.test/oauth/authorize?state=${"a".repeat(64)}`,
				}
			: {}),
	}));
	const app = new Hono();
	registerConnectionInstallationRoutesV1(app, {
		publicOrigin: "https://platform.test",
		identity: {
			resolve: async () => ({
				schemaVersion: 1,
				userId: "alice",
				displayName: "Alice",
				accountStatus: "active",
				organizationIds: ["eng"],
				roles: ["employee"],
				authorizationRevision: "identity-r1",
			}),
			hydrateUsers: async () => [],
		},
		installation: { execute, authorize: async () => null },
		callbackEnabled: () => callbackEnabled,
	});
	const post = (
		body: unknown = { schemaVersion: 1, executionId: "execution-a" },
		headers: Record<string, string | undefined> = {},
	) =>
		app.request("https://platform.test/api/connection-installations", {
			method: "POST",
			headers: {
				origin: "https://platform.test",
				"x-platform-csrf": "1",
				"sec-fetch-site": "same-origin",
				"idempotency-key": "key-a",
				"content-type": "application/json",
				...Object.fromEntries(
					Object.entries(headers).filter(
						(entry): entry is [string, string] => typeof entry[1] === "string",
					),
				),
			},
			body: JSON.stringify(body),
		});
	return { app, post, execute };
}
it("uses resolved browser identity and only the original Execution selector", async () => {
	const f = fixture();
	const response = await f.post();
	expect(response.status).toBe(202);
	expect(await response.json()).toEqual({
		schemaVersion: 1,
		authorizationId: "authorization-a",
		status: "awaiting_confirmation",
		expiresAt: 123000,
	});
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(f.execute.mock.calls[0]?.[0]).toMatchObject({
		userId: "alice",
		identityRevision: "identity-r1",
		executionId: "execution-a",
		command: "begin",
	});
});
it("projects only the stored authorization URL, never a credential", async () => {
	const f = fixture(true, true);
	const response = await f.post();
	expect(await response.json()).toMatchObject({
		authorizationUrl: `https://connection.test/oauth/authorize?state=${"a".repeat(64)}`,
	});
});
it("hides an authorization URL while the callback receiver is unavailable", async () => {
	const f = fixture(true, false);
	const response = await f.post();
	expect(await response.json()).not.toHaveProperty("authorizationUrl");
});
it.each(["confirm", "status"] as const)(
	"uses the same browser gates for %s",
	async (command) => {
		const f = fixture();
		const path = `https://platform.test/api/connection-installations/authorization-a${command === "confirm" ? "/confirm" : ""}`;
		const trusted = {
			origin: "https://platform.test",
			"x-platform-csrf": "1",
			"sec-fetch-site": "same-origin",
			"idempotency-key": "confirm-key",
			"content-type": "application/json",
		};
		for (const headers of [
			{ origin: "https://foreign.test" },
			{ "x-platform-csrf": "0" },
			{ "sec-fetch-site": "cross-site" },
		]) {
			expect(
				(
					await f.app.request(path, {
						method: "POST",
						headers: { ...trusted, ...headers },
						...(command === "confirm"
							? { body: JSON.stringify({ schemaVersion: 1 }) }
							: {}),
					})
				).status,
			).toBe(403);
		}
		expect(f.execute).not.toHaveBeenCalled();
		const response = await f.app.request(path, {
			method: "POST",
			headers: trusted,
			...(command === "confirm"
				? { body: JSON.stringify({ schemaVersion: 1 }) }
				: {}),
		});
		expect(response.status).toBe(command === "confirm" ? 202 : 200);
		expect(await response.json()).toEqual({
			schemaVersion: 1,
			authorizationId: "authorization-a",
			status: "awaiting_confirmation",
			expiresAt: 123000,
		});
		expect(f.execute.mock.calls[0]?.[0]).toMatchObject({
			command,
			userId: "alice",
			authorizationId: "authorization-a",
		});
	},
);
it.each([
	{ authorization: "Bearer credential" },
	{ origin: "https://foreign.test" },
	{ "x-platform-csrf": "0" },
	{ "sec-fetch-site": "cross-site" },
	{ "x-principal-id": "other" },
])(
	"rejects an untrusted channel before accepting installation (%#)",
	async (headers) => {
		const f = fixture();
		expect((await f.post(undefined, headers)).status).toBeGreaterThanOrEqual(
			400,
		);
		expect(f.execute).not.toHaveBeenCalled();
	},
);
it.each([
	"token",
	"code",
	"verifier",
	"secret",
	"principal",
	"scope",
	"runtimeOrigin",
])("rejects %s in a browser command", async (field) => {
	const f = fixture();
	expect(
		(
			await f.post({
				schemaVersion: 1,
				executionId: "execution-a",
				[field]: "caller",
			})
		).status,
	).toBe(400);
	expect(f.execute).not.toHaveBeenCalled();
});
