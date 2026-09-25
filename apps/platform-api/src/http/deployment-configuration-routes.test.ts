import { DeploymentConfigurationProjectionV2Schema } from "@agent-infra/contracts/pilot";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createDeploymentConfigurationProjectionV2 } from "../deployment-admissions.js";
import { HttpProtocolError } from "./common.js";
import { registerDeploymentConfigurationRoutes } from "./deployment-configuration-routes.js";

const identity = {
	schemaVersion: 1 as const,
	userId: "user-1",
	displayName: "User",
	accountStatus: "active" as const,
	organizationIds: ["org-1"],
	roles: ["employee" as const],
	authorizationRevision: "authorization-1",
};

const digest = `sha256:${"a".repeat(64)}`;
const template = {
	templateId: "template-standard",
	displayName: "Standard Agent",
	imageDigest: digest,
	imageReference: `registry.example.test/agents/standard@${digest}`,
	allowedEnvironmentKeys: ["LOG_LEVEL"],
	allowedSecretKeys: ["MODEL_API_KEY"],
	platformManagedKeys: [],
	connectionEnabled: false,
};

const snapshot = (validUntil: number, endpoints = true) => ({
	schemaVersion: 1,
	revision: "catalog-a",
	validUntil,
	endpoints: endpoints
		? [
				{
					endpointId: "endpoint-prod",
					baseUrl: "https://secret.example.test/v1",
					origin: "https://secret.example.test",
					protocol: "openai-responses-v1",
					security: { tls: "verify-peer", redirects: "reject" },
					capabilities: {
						streaming: true,
						tools: true,
						reasoningLevels: ["balanced", "deep"],
					},
					allowedModels: ["model-a"],
					available: true,
				},
			]
		: [],
});

function createApp(read: () => Promise<unknown>) {
	const app = new Hono();
	app.onError((error, context) =>
		error instanceof HttpProtocolError
			? context.json(error.body, error.status)
			: context.json({ error: "internal" }, 500),
	);
	registerDeploymentConfigurationRoutes(app, {
		identity: {
			resolve: vi.fn().mockResolvedValue(identity),
			hydrateUsers: vi.fn(),
		},
		read,
	});
	return app;
}

describe("deployment configuration projection", () => {
	it("projects choices without endpoint or image sensitive material", async () => {
		const read = createDeploymentConfigurationProjectionV2({
			templates: [template],
			modelCatalog: {
				revision: "catalog-a",
				load: async () => snapshot(Date.now() + 60_000),
			},
		});
		const response = await createApp(read).request(
			"/api/v2/deployment/configuration",
		);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(DeploymentConfigurationProjectionV2Schema.parse(body)).toEqual({
			schemaVersion: 2,
			status: "populated",
			templates: [
				{
					templateId: "template-standard",
					displayName: "Standard Agent",
					connectionEnabled: false,
					allowedEnvironmentKeys: ["LOG_LEVEL"],
					allowedSecretKeys: ["MODEL_API_KEY"],
				},
			],
			modelCatalog: {
				status: "populated",
				revision: "catalog-a",
				endpoints: [
					{
						endpointId: "endpoint-prod",
						displayName: "endpoint-prod",
						models: [
							{
								modelId: "model-a",
								reasoningLevels: ["balanced", "deep"],
							},
						],
					},
				],
			},
		});
		const text = JSON.stringify(body);
		expect(text).not.toContain("secret.example.test");
		expect(text).not.toContain(digest);
	});

	it("marks a catalog empty when available endpoints have no selectable models", async () => {
		const empty = snapshot(Date.now() + 60_000);
		const endpoint = empty.endpoints[0];
		if (!endpoint) throw new Error("fixture endpoint missing");
		const read = createDeploymentConfigurationProjectionV2({
			templates: [template],
			modelCatalog: {
				revision: "catalog-a",
				load: async () => ({
					...empty,
					endpoints: [{ ...endpoint, allowedModels: null }],
				}),
			},
		});

		const response = await createApp(read).request(
			"/api/v2/deployment/configuration",
		);
		const body = DeploymentConfigurationProjectionV2Schema.parse(
			await response.json(),
		);

		expect(body.status).toBe("populated");
		expect(body.modelCatalog.status).toBe("empty");
	});

	it.each([
		["empty", snapshot(Date.now() + 60_000, false)],
		["stale", snapshot(Date.now() - 1)],
		["unavailable", new Error("catalog unavailable")],
	] as const)("returns a stable %s catalog state", async (status, value) => {
		const read = createDeploymentConfigurationProjectionV2({
			templates: [],
			modelCatalog: {
				revision: "catalog-a",
				load: async () => {
					if (value instanceof Error) throw value;
					return value;
				},
			},
		});
		const response = await createApp(read).request(
			"/api/v2/deployment/configuration",
		);

		expect(response.status).toBe(200);
		const body = DeploymentConfigurationProjectionV2Schema.parse(
			await response.json(),
		);
		expect(body.status).toBe(status);
		expect(body.modelCatalog.status).toBe(status);
		expect(body.templates).toEqual([]);
		expect(body.modelCatalog.endpoints).toEqual([]);
	});

	it("marks a loader revision mismatch stale before presenting choices", async () => {
		const read = createDeploymentConfigurationProjectionV2({
			templates: [],
			modelCatalog: {
				revision: "catalog-current",
				load: async () => snapshot(Date.now() + 60_000),
			},
		});
		const response = await createApp(read).request(
			"/api/v2/deployment/configuration",
		);

		expect(response.status).toBe(200);
		const body = DeploymentConfigurationProjectionV2Schema.parse(
			await response.json(),
		);
		expect(body.status).toBe("stale");
		expect(body.modelCatalog.status).toBe("stale");
		expect(body.modelCatalog.endpoints).toEqual([]);
	});
});
