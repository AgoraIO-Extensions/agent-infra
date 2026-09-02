import { createHash } from "node:crypto";

import { AgentProjectionV1Schema } from "@agent-infra/contracts/pilot";
import { AgentConfigurationError } from "@agent-infra/platform-core";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { HttpProtocolError } from "./common.js";
import { registerConfigurationRoutes } from "./configuration-routes.js";

const agentProjection = {
	schemaVersion: 1 as const,
	agentId: "agent-1",
	name: "Release assistant",
	description: "Helps the release team",
	source: { kind: "standard" as const, templateId: "template-1" },
	managementStatus: "available" as const,
	serviceAvailability: "ready" as const,
	configuration: {
		owners: [
			{ userId: "user-1", displayName: "Ada", roles: ["employee" as const] },
		],
		availability: [{ kind: "organization" as const, organizationId: "org-1" }],
		modelOptions: [],
		defaultModelOptionId: null,
		defaultReasoningLevel: null,
		actions: [],
		environment: [],
		channels: [{ kind: "web" as const, status: "available" as const }],
		secrets: [{ name: "MODEL_API_KEY", isSet: true, version: 2 }],
	},
	capabilities: {
		modelSelection: false,
		attachments: false,
		resultFiles: false,
		connection: false,
		supplementaryInstruction: false,
	},
	interactionUrl: null,
};

function createApp(overrides: Record<string, unknown> = {}) {
	const app = new Hono();
	app.onError((error, context) =>
		error instanceof HttpProtocolError
			? context.json(error.body, error.status)
			: context.json({ error: "internal" }, 500),
	);
	const update = vi.fn().mockResolvedValue({
		schemaVersion: 1,
		agentId: "agent-1",
		revision: 2,
		changedFields: ["secrets"],
	});
	const readConfiguration = vi.fn().mockResolvedValue({
		outcome: "found",
		configuration: { revision: 1, ownerIds: ["user-1"] },
	});
	const readAgentProjection = vi.fn().mockResolvedValue(agentProjection);
	const prepareSecretReplacements = vi
		.fn()
		.mockImplementation(async (input) => ({
			secrets: input.secrets.map(({ name }: { name: string }) => ({
				name,
				replace: true,
			})),
			modelCredentialOptionIds: input.modelCredentials.map(
				({ optionId }: { optionId: string }) => optionId,
			),
		}));
	registerConfigurationRoutes(app, {
		identity: {
			resolve: vi.fn().mockResolvedValue({
				schemaVersion: 1,
				userId: "user-1",
				displayName: "Ada",
				accountStatus: "active",
				organizationIds: ["org-1"],
				roles: ["employee"],
				authorizationRevision: "authorization-1",
			}),
			hydrateUsers: vi.fn().mockResolvedValue([]),
		},
		configuration: { update },
		configurationQuery: { read: readConfiguration },
		readAgentProjection,
		prepareSecretReplacements,
		...overrides,
	});
	return {
		app,
		update,
		readConfiguration,
		readAgentProjection,
		prepareSecretReplacements,
	};
}

describe("configuration routes", () => {
	it("updates through Core and returns only the authoritative projection", async () => {
		const { app, update, readAgentProjection, prepareSecretReplacements } =
			createApp();
		const body = {
			schemaVersion: 1,
			secrets: [{ name: "MODEL_API_KEY", value: "plaintext-never-returned" }],
		};
		const response = await app.request("/api/v1/agents/agent-1/configuration", {
			method: "PUT",
			headers: {
				"content-type": "application/json",
				"Idempotency-Key": "configuration-1",
				"x-request-id": "caller-request-must-not-be-trusted",
				"x-trace-id": "caller-trace-must-not-be-trusted",
			},
			body: JSON.stringify(body),
		});

		expect(response.status).toBe(200);
		const json = await response.json();
		expect(AgentProjectionV1Schema.parse(json)).toEqual(agentProjection);
		expect(JSON.stringify(json)).not.toContain("plaintext-never-returned");
		expect(update).toHaveBeenCalledOnce();
		const [command, actor] = update.mock.calls[0] as [
			Record<string, unknown>,
			Record<string, unknown>,
		];
		expect(command).toEqual({
			schemaVersion: 1,
			agentId: "agent-1",
			idempotencyKey: "configuration-1",
			requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
			traceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
			changes: {
				secrets: [{ name: "MODEL_API_KEY", replace: true }],
			},
		});
		expect(command.requestId).not.toBe("caller-request-must-not-be-trusted");
		expect(command.traceId).not.toBe("caller-trace-must-not-be-trusted");
		expect(actor).toEqual({
			schemaVersion: 1,
			actorId: "user-1",
			rawRequestDigest: createHash("sha256")
				.update(JSON.stringify(body))
				.digest("hex"),
		});
		expect(prepareSecretReplacements).toHaveBeenCalledWith({
			agentId: "agent-1",
			configurationRevision: 1,
			identityAuthorizationRevision: "authorization-1",
			identity: expect.objectContaining({ userId: "user-1" }),
			secrets: [{ name: "MODEL_API_KEY", value: "plaintext-never-returned" }],
			modelCredentials: [],
			requestId: command.requestId,
			traceId: command.traceId,
		});
		expect(JSON.stringify(update.mock.calls)).not.toContain(
			"plaintext-never-returned",
		);
		expect(readAgentProjection).toHaveBeenCalledWith({
			agentId: "agent-1",
			identity: expect.objectContaining({ userId: "user-1" }),
			requestId: command.requestId,
			traceId: command.traceId,
		});
	});

	it("refreshes account and organization context on every request", async () => {
		const identity = {
			resolve: vi
				.fn()
				.mockResolvedValueOnce({
					schemaVersion: 1,
					userId: "user-1",
					displayName: "Ada",
					accountStatus: "active",
					organizationIds: ["org-old"],
					roles: ["employee"],
					authorizationRevision: "authorization-1",
				})
				.mockResolvedValueOnce({
					schemaVersion: 1,
					userId: "user-1",
					displayName: "Ada",
					accountStatus: "active",
					organizationIds: ["org-new"],
					roles: ["employee"],
					authorizationRevision: "authorization-2",
				}),
			hydrateUsers: vi.fn().mockResolvedValue([]),
		};
		const { app, readAgentProjection, prepareSecretReplacements } = createApp({
			identity,
		});
		for (const key of ["configuration-refresh-1", "configuration-refresh-2"]) {
			const response = await app.request(
				"/api/v1/agents/agent-1/configuration",
				{
					method: "PUT",
					headers: {
						"content-type": "application/json",
						"Idempotency-Key": key,
					},
					body: JSON.stringify({ schemaVersion: 1, environment: [] }),
				},
			);
			expect(response.status).toBe(200);
		}
		expect(identity.resolve).toHaveBeenCalledTimes(2);
		expect(prepareSecretReplacements).not.toHaveBeenCalled();
		expect(
			readAgentProjection.mock.calls.map(
				([input]) => input.identity.organizationIds,
			),
		).toEqual([["org-old"], ["org-new"]]);
	});

	it("passes co-Owner input to Core without resolving access policy", async () => {
		const { app, update, readConfiguration } = createApp();
		const response = await app.request("/api/v1/agents/agent-1/configuration", {
			method: "PUT",
			headers: {
				"content-type": "application/json",
				"Idempotency-Key": "configuration-owners",
			},
			body: JSON.stringify({
				schemaVersion: 1,
				coOwnerIds: ["user-2"],
			}),
		});

		expect(response.status).toBe(200);
		expect(readConfiguration).not.toHaveBeenCalled();
		expect(update.mock.calls[0]?.[0]).toMatchObject({
			changes: { coOwnerIds: ["user-2"] },
		});
	});

	it("fails closed for denied authorization and secret preparation errors", async () => {
		const denied = createApp({
			configuration: {
				update: vi
					.fn()
					.mockRejectedValue(new AgentConfigurationError("not_authorized")),
			},
		});
		const deniedResponse = await denied.app.request(
			"/api/v1/agents/other-agent/configuration",
			{
				method: "PUT",
				headers: {
					"content-type": "application/json",
					"Idempotency-Key": "configuration-denied",
				},
				body: JSON.stringify({ schemaVersion: 1, environment: [] }),
			},
		);
		expect(deniedResponse.status).toBe(404);
		expect(denied.readAgentProjection).not.toHaveBeenCalled();

		const preparation = createApp({
			prepareSecretReplacements: vi
				.fn()
				.mockRejectedValue(new Error("plaintext-never-returned")),
		});
		const unavailableResponse = await preparation.app.request(
			"/api/v1/agents/agent-1/configuration",
			{
				method: "PUT",
				headers: {
					"content-type": "application/json",
					"Idempotency-Key": "configuration-secret-failure",
				},
				body: JSON.stringify({
					schemaVersion: 1,
					secrets: [
						{ name: "MODEL_API_KEY", value: "plaintext-never-returned" },
					],
				}),
			},
		);
		expect(unavailableResponse.status).toBe(503);
		expect(await unavailableResponse.text()).not.toContain(
			"plaintext-never-returned",
		);
		expect(preparation.update).not.toHaveBeenCalled();

		const unauthorized = createApp({
			configurationQuery: {
				read: vi.fn().mockResolvedValue({ outcome: "unavailable" }),
			},
		});
		const attackResponse = await unauthorized.app.request(
			"/api/v1/agents/other-agent/configuration",
			{
				method: "PUT",
				headers: {
					"content-type": "application/json",
					"Idempotency-Key": "configuration-secret-attack",
				},
				body: JSON.stringify({
					schemaVersion: 1,
					secrets: [
						{ name: "MODEL_API_KEY", value: "plaintext-never-returned" },
					],
				}),
			},
		);
		expect(attackResponse.status).toBe(404);
		expect(unauthorized.prepareSecretReplacements).not.toHaveBeenCalled();
		expect(unauthorized.update).not.toHaveBeenCalled();
	});
});
